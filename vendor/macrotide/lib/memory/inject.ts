// Renders the active-preference block injected into the chat system prompt.
//
// Discipline (see docs/explanation/memory.md § Injection):
//   - Loaded once at session start; never mutates mid-stream.
//   - Bounded: a hot-set up to a dual co-primary ceiling injects; the rest is
//     recall-only (the model is told how many more are stored).
//   - Deterministic: identical DB state → identical selection → identical render
//     (stable (category, id) order) → byte-identical output → prefix-cache hits.
//   - Empty active set → returns "" so callers can skip prepending entirely.
import { createHash } from "node:crypto";
import { listActive, type Preference, type PreferenceCategory } from "../db/queries/preferences";

// Model-facing headings (user-visible inside the system prompt). Render order is
// fixed for determinism.
const CATEGORY_HEADINGS: Record<PreferenceCategory, string> = {
  user: "About you",
  advisor: "How to respond",
};

const CATEGORY_ORDER: PreferenceCategory[] = ["user", "advisor"];

// Heading that opens the injected block. Exported so the archive-time extractor
// can strip it back out of any text it feeds to the extraction model
// (recursive-memory-pollution guard — see stripInjectedMemory).
export const MEMORY_BLOCK_HEADING = "## Your stored preferences";

// Confidence floor for *injecting* an auto-extracted preference. Explicit rows
// (source 'advisor_tool', confidence NULL) always inject. Auto-extracted rows
// inject only at confidence >= this threshold; below it they are recall-only.
export const INJECT_CONFIDENCE_THRESHOLD = 0.7;

// ── Injection budget (the bound) — env-configurable, dual CO-PRIMARY ceiling ──
// Inject all hooks while BOTH caps hold (count and chars); whichever binds first
// stops `user` selection. Tuned so the cost budget (chars ≈ CC's 25 KB) binds for
// terse hooks, so a typical store fully injects (never-forgetful). Overflow →
// recall-only. `advisor` is tiny + high-value so its cap is generous.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const USER_CAP = envInt("MEMORY_USER_CAP", 150);
export const USER_CHAR_BUDGET = envInt("MEMORY_USER_CHAR_BUDGET", 24_000);
export const ADVISOR_CAP = envInt("MEMORY_ADVISOR_CAP", 30);

// Invariant (Q4): the char budget must comfortably exceed the per-row content cap
// (tools/extract cap content at ~600) so a single hook can never blow the whole
// budget — making the "oversized row" case impossible by construction. Fail loud
// on misconfig rather than defend at runtime.
if (USER_CHAR_BUDGET < 1_000) {
  throw new Error(
    `MEMORY_USER_CHAR_BUDGET (${USER_CHAR_BUDGET}) must be >= 1000 (several × the ~600 per-row content cap).`,
  );
}

// A preference is injectable unless it's a low-confidence auto-extracted row
// (recall-only). Explicit rows (confidence NULL) always inject.
function isInjectable(row: Preference): boolean {
  if (row.source === "extracted" && row.confidence != null) {
    return row.confidence >= INJECT_CONFIDENCE_THRESHOLD;
  }
  return true;
}

/**
 * Selection comparator (rare fallback — only matters when a category overflows
 * its ceiling). Explicit-first so deliberate/foundational facts outrank
 * inferences regardless of age; then recency by `created_at`; then confidence
 * (within extracted); then `id` for a deterministic total order. Source-blind.
 */
function comparePriority(a: Preference, b: Preference): number {
  const aExplicit = a.confidence == null;
  const bExplicit = b.confidence == null;
  if (aExplicit !== bExplicit) return aExplicit ? -1 : 1; // explicit first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1; // recent first
  const ac = a.confidence ?? 0;
  const bc = b.confidence ?? 0;
  if (ac !== bc) return bc - ac; // higher confidence first
  return a.id - b.id; // deterministic tiebreak
}

/**
 * Greedily take rows by priority up to `maxEntries` AND `maxChars` (content/hook
 * chars). Stops when either binds — except the highest-priority row is always
 * taken even if it alone exceeds `maxChars` (guarantees a non-empty block under
 * any config; the Q4 invariant makes this purely defensive).
 */
function selectWithinBudget(
  rows: Preference[],
  maxEntries: number,
  maxChars: number,
): Preference[] {
  const sorted = [...rows].sort(comparePriority);
  const selected: Preference[] = [];
  let chars = 0;
  for (const row of sorted) {
    if (selected.length >= maxEntries) break;
    const len = row.content.length;
    if (selected.length > 0 && chars + len > maxChars) break;
    selected.push(row);
    chars += len;
  }
  return selected;
}

/**
 * Remove an injected memory block from a chunk of text. Used by the archive-time
 * extractor to strip Advisor's own stored-preferences context out of the
 * transcript before re-feeding it to the extraction model, so the model doesn't
 * "re-learn" (and re-save) facts that were only present because we injected them.
 * Idempotent and safe on text that contains no block.
 */
export function stripInjectedMemory(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === MEMORY_BLOCK_HEADING);
  if (start === -1) return text;
  // Consume the heading and the contiguous block body — blank lines, `###`
  // category subheadings, `- ` bullets, and the trailing `_… more …_` italic
  // line. Stop at the first line that isn't part of the block.
  let end = start + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t === "" || t.startsWith("### ") || t.startsWith("- ") || t.startsWith("_")) {
      end++;
    } else {
      break;
    }
  }
  if (end < lines.length && lines[end].trim() === "") end++;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/^\n+/, "").trimEnd();
}

export interface BuildMemoryBlockOptions {
  // Hook for tests: inject a fixed row set instead of querying the DB. The
  // default (undefined) loads via listActive().
  rows?: Preference[];
}

export function buildMemoryBlock(
  userId: string | null,
  opts: BuildMemoryBlockOptions = {},
): string {
  // userId is carried for call-site symmetry; the query layer scopes to the
  // request user via ownedBy() context (see lib/db/queries/scope.ts).
  void userId;
  // Low-confidence auto-extracted rows are recall-only — keep them out of the
  // always-on injected block.
  const injectable = (opts.rows ?? listActive()).filter(isInjectable);
  if (injectable.length === 0) return "";

  // Partition by category, then select each within its budget (the bound).
  const byCategory = new Map<PreferenceCategory, Preference[]>();
  for (const row of injectable) {
    const bucket = byCategory.get(row.category);
    if (bucket) bucket.push(row);
    else byCategory.set(row.category, [row]);
  }
  const userRows = selectWithinBudget(byCategory.get("user") ?? [], USER_CAP, USER_CHAR_BUDGET);
  const advisorRows = selectWithinBudget(
    byCategory.get("advisor") ?? [],
    ADVISOR_CAP,
    USER_CHAR_BUDGET,
  );
  const selectedByCategory = new Map<PreferenceCategory, Preference[]>([
    ["user", userRows],
    ["advisor", advisorRows],
  ]);
  const selectedCount = userRows.length + advisorRows.length;
  const dropped = injectable.length - selectedCount;

  // Render in STABLE (category, id) order — selection order ≠ render order, so
  // the bytes stay identical for identical DB state even when a weight shifts.
  const lines: string[] = [MEMORY_BLOCK_HEADING, ""];
  for (const cat of CATEGORY_ORDER) {
    const bucket = (selectedByCategory.get(cat) ?? []).slice().sort((a, b) => a.id - b.id);
    if (bucket.length === 0) continue;
    lines.push(`### ${CATEGORY_HEADINGS[cat]}`);
    for (const row of bucket) {
      lines.push(`- ${row.content}`);
    }
    lines.push("");
  }
  // Tell the model the injected set isn't everything, so it will recall the tail.
  // Deterministic (count is frozen with the block) → cache-safe.
  if (dropped > 0) {
    lines.push(
      `_${dropped} more ${dropped === 1 ? "memory is" : "memories are"} stored; use recall_preferences to look them up._`,
    );
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// Stable hash of the rendered block. Exposed for tests verifying the
// frozen-snapshot discipline (turn-N system prompt must be byte-identical to
// turn-1 for prefix cache to hit) and for opt-in route-level logging.
export function memoryBlockHash(block: string): string {
  return createHash("sha256").update(block, "utf8").digest("hex");
}
