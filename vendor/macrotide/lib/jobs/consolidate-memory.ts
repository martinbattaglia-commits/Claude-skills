// Memory consolidation sweep (#221 ⑨). Periodic, off the hot path: removes
// redundancy so the bounded hot-set stays injectable and the Memory tab stays
// clean. Runs ONCE PER USER SCOPE via runWithUserScope.
//
// HOLISTIC by default: the WHOLE of a category's memories is handed to the reasoning
// model each sweep, so it catches duplicates AND contradictions a lexical pre-filter
// would miss — "no individual stocks, funds only" ≈ "I told you no individual stocks"
// share too few tokens to cluster, while "like X" / "not like X" share too many. At a
// distilled-memory scale a pre-filter is a needless scale optimization that also loses
// recall (the whole-set LLM pass is what offline consolidators like Anthropic Dreams
// do; see docs/explanation/research/memory-systems.md § Deduplication). The lexical
// clustering (findNearDupClusters) is
// kept ONLY as a scale FALLBACK: when a category is too large to send whole (payload
// over maxPayloadChars) we batch by near-dup cluster to bound the model payload — and
// accept that non-clustering dups may be missed at that scale until #43 vector recall.
// The model proposes ops; we apply them via the bitemporal layer (reversible,
// explicit-protected). Exact-dup writes are already collapsed upstream by save()'s
// idempotency net, so this only ever sees genuinely distinct rows.
import "server-only";
import { runWithUserScope } from "../db/context";
import { listUserIds } from "../db/queries/admin";
import {
  listActive,
  mergeMemories,
  type Preference,
  type PreferenceCategory,
  update,
} from "../db/queries/preferences";
import { type ConsolidationOp, proposeConsolidation } from "../memory/consolidate";

export type ProposeFn = (
  category: PreferenceCategory,
  rows: Preference[],
) => Promise<ConsolidationOp[] | null>;

export interface ConsolidateOptions {
  /** User scopes to sweep (default: NULL owner + every registered user). */
  scopes?: (string | null)[];
  /** Model proposer — injectable for tests. Defaults to the real model sweep. */
  propose?: ProposeFn;
  /** Cap on ops applied per scope (safety). */
  maxOpsPerScope?: number;
  /**
   * Char budget for the holistic pass: above this (content + detail chars in a
   * category) we fall back to lexical-cluster batching. Defaults to
   * `MEMORY_CONSOLIDATE_MAX_CHARS` env or 32 000.
   */
  maxPayloadChars?: number;
}

export interface ConsolidateResult {
  scopesSwept: (string | null)[];
  /** Scopes where the model ran (a category held ≥2 memories). */
  scopesWorked: number;
  /** Rows merged away (collapsed into a survivor). */
  mergedCount: number;
  /** Rows reshaped (content→detail). */
  reshapedCount: number;
  /** Rows recategorized. */
  recategorizedCount: number;
  /** Stale rows retired by a contradiction (extracted only; reversible). */
  supersededCount: number;
  /** Model proposer invocations. */
  modelCalls: number;
  /** Invocations that returned unparseable output (degraded chain) — see CLI exit. */
  parseFailures: number;
}

const DEFAULT_MAX_OPS = 50;

// Normalize content for lexical comparison: lowercase, strip punctuation,
// collapse whitespace into a token set.
function tokenSet(content: string): Set<string> {
  const toks = content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(toks);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Cheap lexical pre-filter: group rows whose normalized token sets overlap
 * beyond `threshold` (transitive clusters of size ≥ 2). Only these plausible
 * near-dup clusters are worth a model call. Pure — unit-testable.
 */
export function findNearDupClusters(rows: Preference[], threshold = 0.5): Preference[][] {
  const sets = rows.map((r) => tokenSet(r.content));
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (jaccard(sets[i], sets[j]) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Preference[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(rows[i]);
    else groups.set(root, [rows[i]]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

// Total payload a category would send to the model (hook + detail chars).
function payloadChars(rows: Preference[]): number {
  return rows.reduce((sum, r) => sum + r.content.length + (r.detail?.length ?? 0), 0);
}

// Char budget above which the holistic whole-category pass is too large and we fall
// back to lexical-cluster batching. Generous so a normal store (well past the inject
// ceiling) still goes whole; env-overridable.
function maxPayloadCharsDefault(): number {
  const raw = process.env.MEMORY_CONSOLIDATE_MAX_CHARS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 32_000;
}

// Apply one op, returning which counters to bump. Explicit-protected: a merge's
// survivor is forced to an explicit row when the cluster has one (an inference
// can never supersede a user-stated fact).
function applyOp(
  op: ConsolidationOp,
  byId: Map<number, Preference>,
): "merged" | "reshaped" | "recategorized" | "superseded" | null {
  if (op.op === "merge") {
    const rows = op.ids.map((id) => byId.get(id)).filter((r): r is Preference => !!r);
    if (rows.length < 2) return null;
    // Survivor = an explicit row if any (explicit-protected — an inference can
    // never supersede a user-stated fact), else highest confidence then lowest id.
    const survivor =
      rows.find((r) => r.confidence == null) ??
      [...rows].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.id - b.id)[0];
    const losers = rows.filter((r) => r.id !== survivor.id).map((r) => r.id);
    const n = mergeMemories(survivor.id, losers);
    return n > 0 ? "merged" : null;
  }
  if (op.op === "supersede") {
    const stale = byId.get(op.staleId);
    const current = byId.get(op.currentId);
    if (!stale || !current || stale.id === current.id) return null;
    // Explicit-protected: only an EXTRACTED note is ever retired by a contradiction.
    // An inference can't retire a user-stated fact even when the model thinks it's
    // stale — the user changes an explicit note themselves. Reuses the merge path
    // (end-date the stale row, point superseded_by at the current one; reversible).
    if (stale.confidence == null) return null;
    const n = mergeMemories(current.id, [stale.id]);
    return n > 0 ? "superseded" : null;
  }
  if (op.op === "reshape") {
    const row = byId.get(op.id);
    if (!row || !op.content) return null;
    update(String(op.id), op.content, { detail: op.detail });
    return "reshaped";
  }
  // recategorize: keep content, change category.
  const row = byId.get(op.id);
  if (!row || row.category === op.category) return null;
  update(String(op.id), row.content, { category: op.category });
  return "recategorized";
}

const CATEGORIES: PreferenceCategory[] = ["user", "advisor"];

export async function consolidateMemory(
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const scopes = options.scopes ?? [null, ...listUserIds()];
  const propose = options.propose ?? proposeConsolidation;
  const maxOps = options.maxOpsPerScope ?? DEFAULT_MAX_OPS;
  const maxPayload = options.maxPayloadChars ?? maxPayloadCharsDefault();
  const result: ConsolidateResult = {
    scopesSwept: scopes,
    scopesWorked: 0,
    mergedCount: 0,
    reshapedCount: 0,
    recategorizedCount: 0,
    supersededCount: 0,
    modelCalls: 0,
    parseFailures: 0,
  };

  for (const userId of scopes) {
    await runWithUserScope(userId, async () => {
      const active = listActive();
      let applied = 0;
      let worked = false;
      for (const category of CATEGORIES) {
        if (applied >= maxOps) break;
        const rows = active.filter((r) => r.category === category);
        if (rows.length < 2) continue; // nothing to consolidate against
        worked = true;
        // DEFAULT: hand the WHOLE category to the model so it catches dups and
        // contradictions a lexical pre-filter would miss. Only when the payload is
        // too big do we fall back to lexical-cluster batches to bound it (a genuinely
        // large store; non-clustering dups may then slip through until #43).
        const batches = payloadChars(rows) <= maxPayload ? [rows] : findNearDupClusters(rows);
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const batch of batches) {
          if (applied >= maxOps) break;
          const ops = await propose(category, batch);
          result.modelCalls++;
          if (ops === null) {
            result.parseFailures++; // model invoked but returned unparseable output
            continue;
          }
          for (const op of ops) {
            if (applied >= maxOps) break;
            const kind = applyOp(op, byId);
            if (kind === "merged") result.mergedCount++;
            else if (kind === "reshaped") result.reshapedCount++;
            else if (kind === "recategorized") result.recategorizedCount++;
            else if (kind === "superseded") result.supersededCount++;
            if (kind) applied++;
          }
        }
      }
      if (worked) result.scopesWorked++;
    });
  }
  return result;
}
