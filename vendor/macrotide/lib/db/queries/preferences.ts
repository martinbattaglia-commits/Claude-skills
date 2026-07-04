// Long-term memory queries. Bitemporal: updates add a new row and
// supersede; nothing is mutated in place. `valid_until IS NULL` is the
// active set. See docs/explanation/memory.md for the full design.
//
// Row scoping is fail-closed via {@link ownedBy} (reads the request user from
// context — see lib/db/queries/scope.ts), identical to journal/buckets/chat.
import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, lt, sql } from "drizzle-orm";
import { getDb, getDbContext, getUserId } from "../context";
import { memoryLinks, userPreferences } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type Preference = typeof userPreferences.$inferSelect;
export type MemoryLink = typeof memoryLinks.$inferSelect;
export type PreferenceCategory = "user" | "advisor";
export type PreferenceSource = "advisor_tool" | "extracted";

const CATEGORIES: readonly PreferenceCategory[] = ["user", "advisor"] as const;

export function isCategory(value: string): value is PreferenceCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

// The active set for the current request's user: their own rows (or the
// single-owner NULL set when no user is in context), not yet superseded.
function activeScope() {
  return and(ownedBy(userPreferences.userId), isNull(userPreferences.validUntil));
}

export function listActive(category?: PreferenceCategory): Preference[] {
  const conds = [activeScope()];
  if (category) conds.push(eq(userPreferences.category, category));
  return getDb()
    .select()
    .from(userPreferences)
    .where(and(...conds))
    .orderBy(userPreferences.category, userPreferences.id)
    .all();
}

export interface RecallResult {
  /** Top `limit` active rows, most-relevant first (BM25). */
  rows: Preference[];
  /** Total active rows matching the query (≥ rows.length when truncated). */
  total: number;
}

/** Build a safe FTS5 MATCH expression: tokenize on letters/numbers, quote each,
 * append `*` for prefix match, OR-joined so recall stays generous ("any word")
 * while BM25 ranks the best matches first. Returns null when no usable tokens. */
function toFtsMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * Cold-recall complement to the always-on injection: find ACTIVE preferences
 * relevant to a free-text query, ranked by **BM25** over `content` + `detail`
 * (the `user_preferences_fts` external-content index). Best-first, capped at
 * `limit`, with the true `total` so the caller can tell the model when the tail
 * is truncated. Empty/blank queries return no rows.
 */
export function recall(query: string, limit = 50): RecallResult {
  const match = toFtsMatch(query);
  if (match === null) return { rows: [], total: 0 };
  const sqlite = getDbContext().appSqlite;
  const userId = getUserId();
  const ownerClause = userId === null ? "p.user_id IS NULL" : "p.user_id = ?";
  const ownerParams = userId === null ? [] : [userId];
  // FTS ranks + scopes (active rows only, owner-scoped); ids come back best-first.
  const baseFrom = `FROM user_preferences_fts f JOIN user_preferences p ON p.id = f.rowid
     WHERE user_preferences_fts MATCH ? AND p.valid_until IS NULL AND ${ownerClause}`;
  const idRows = sqlite
    .prepare(`SELECT f.rowid AS id ${baseFrom} ORDER BY bm25(user_preferences_fts) LIMIT ?`)
    .all(match, ...ownerParams, limit) as Array<{ id: number }>;
  const totalRow = sqlite
    .prepare(`SELECT COUNT(*) AS n ${baseFrom}`)
    .get(match, ...ownerParams) as { n: number };
  const ids = idRows.map((r) => r.id);
  if (ids.length === 0) return { rows: [], total: totalRow.n };
  // Hydrate to typed rows via drizzle, then restore the BM25 order.
  const fetched = getDb()
    .select()
    .from(userPreferences)
    .where(and(ownedBy(userPreferences.userId), inArray(userPreferences.id, ids)))
    .all();
  const byId = new Map(fetched.map((r) => [r.id, r]));
  const rows = ids.map((id) => byId.get(id)).filter((r): r is Preference => r != null);
  return { rows, total: totalRow.n };
}

// Recently-forgotten = rows the user DELIBERATELY forgot in the last `days`.
// A row superseded by an update/merge also has `valid_until` set, but it is NOT
// a forget — it carries `superseded_by`, so we exclude it (edit-history must not
// surface in the undo queue, and restoring it would double-activate).
export function listRecentlyForgotten(days = 30): Preference[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .select()
    .from(userPreferences)
    .where(
      and(
        ownedBy(userPreferences.userId),
        gt(userPreferences.validUntil, cutoff),
        isNull(userPreferences.supersededBy),
      ),
    )
    .orderBy(desc(userPreferences.validUntil))
    .all();
}

export function getById(id: number): Preference | undefined {
  return getDb()
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.id, id), ownedBy(userPreferences.userId)))
    .get();
}

export interface SaveInput {
  category: PreferenceCategory;
  content: string;
  source: PreferenceSource;
  // Optional longer elaboration, recall-only (never injected).
  detail?: string | null;
  sourceSessionId?: string | null;
  sourceTurnIds?: number[] | null;
  confidence?: number | null;
}

export function save(input: SaveInput): Preference {
  const now = new Date().toISOString();
  // Idempotency guard: if an identical note already exists in this category
  // (trimmed, case-insensitive), return it instead of inserting a duplicate.
  // TRULY-identical only — fuzzy/semantic dedup stays the model's job
  // (update_preference) and the extraction reconcile. This closes the
  // frozen-session blind spot: the injected memory block is frozen per session,
  // so within one chat the Advisor can't see a fact it already saved this
  // session and may re-save the exact same line. Without this, repeated
  // "remember X" in one session piles up identical rows.
  // Normalize for the exact-dup check: trim, lowercase, collapse internal
  // whitespace, strip trailing punctuation. Catches near-EXACT re-saves for free;
  // semantic near-dups stay the consolidation sweep's job.
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?,;:]+$/, "");
  const dup = listActive(input.category).find((r) => norm(r.content) === norm(input.content));
  if (dup) return dup;
  return getDb()
    .insert(userPreferences)
    .values({
      userId: ownerId(),
      category: input.category,
      content: input.content,
      detail: input.detail ?? null,
      source: input.source,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceTurnIds: input.sourceTurnIds ?? null,
      confidence: input.confidence ?? null,
      validFrom: now,
      validUntil: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export interface ResolveResult {
  kind: "match" | "none" | "ambiguous";
  row?: Preference;
  candidates?: Preference[];
}

// Resolve an `id_or_substring` reference against the active set. Tries
// numeric id first, then case-insensitive substring on content. Exactly
// one active row must match for `kind: 'match'`.
export function resolveActive(idOrSubstring: string): ResolveResult {
  const asInt = Number.parseInt(idOrSubstring, 10);
  if (Number.isFinite(asInt) && String(asInt) === idOrSubstring.trim()) {
    const row = getDb()
      .select()
      .from(userPreferences)
      .where(and(activeScope(), eq(userPreferences.id, asInt)))
      .get();
    return row ? { kind: "match", row } : { kind: "none" };
  }
  const pattern = `%${idOrSubstring}%`;
  const matches = getDb()
    .select()
    .from(userPreferences)
    .where(and(activeScope(), like(userPreferences.content, pattern)))
    .all();
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "match", row: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

// Forget: soft-delete via valid_until = now. Row stays for audit.
export function forget(idOrSubstring: string): ResolveResult {
  const resolved = resolveActive(idOrSubstring);
  if (resolved.kind !== "match" || !resolved.row) return resolved;
  const now = new Date().toISOString();
  const updated = getDb()
    .update(userPreferences)
    .set({ validUntil: now, updatedAt: now })
    .where(eq(userPreferences.id, resolved.row.id))
    .returning()
    .get();
  return { kind: "match", row: updated };
}

// Confirm a fact the user affirmed: bump last_confirmed_at (the anti-stale
// reinforcement signal — only ever set on affirmation, never on recall/inject),
// which exempts an extracted row from decay so a re-affirmed fact reads as current.
export function confirm(idOrSubstring: string): ResolveResult {
  const resolved = resolveActive(idOrSubstring);
  if (resolved.kind !== "match" || !resolved.row) return resolved;
  const now = new Date().toISOString();
  const updated = getDb()
    .update(userPreferences)
    .set({ lastConfirmedAt: now, updatedAt: now })
    .where(eq(userPreferences.id, resolved.row.id))
    .returning()
    .get();
  return { kind: "match", row: updated };
}

// Update: atomic supersession. Old row gets valid_until = now; a new row
// is inserted with the new content, same category, same source attribution.
// Links pointing at the old row are re-pointed to the new row in the same txn
// so a bitemporal supersede never orphans them.
export interface UpdateOptions {
  detail?: string | null;
  /** Optional category change (consolidation recategorize / escape path). */
  category?: PreferenceCategory;
}

export interface UpdateResult {
  kind: "match" | "none" | "ambiguous";
  oldRow?: Preference;
  newRow?: Preference;
  candidates?: Preference[];
}

export function update(
  idOrSubstring: string,
  newContent: string,
  opts: UpdateOptions = {},
): UpdateResult {
  const resolved = resolveActive(idOrSubstring);
  if (resolved.kind !== "match" || !resolved.row) {
    return { kind: resolved.kind, candidates: resolved.candidates };
  }
  return supersede(resolved.row, newContent, opts);
}

function supersede(old: Preference, newContent: string, opts: UpdateOptions = {}): UpdateResult {
  const now = new Date().toISOString();
  return getDb().transaction((tx) => {
    // Insert the replacement first so its id exists, then end-date the old row
    // and point its `superseded_by` at the new one (distinguishes edit-history
    // from a deliberate forget — see listRecentlyForgotten).
    const newRow = tx
      .insert(userPreferences)
      .values({
        userId: old.userId,
        category: opts.category ?? old.category,
        content: newContent,
        detail: opts.detail !== undefined ? opts.detail : old.detail,
        source: old.source,
        sourceSessionId: old.sourceSessionId,
        sourceTurnIds: old.sourceTurnIds,
        confidence: old.confidence,
        lastConfirmedAt: old.lastConfirmedAt,
        validFrom: now,
        validUntil: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const oldRow = tx
      .update(userPreferences)
      .set({ validUntil: now, supersededBy: newRow.id, updatedAt: now })
      .where(eq(userPreferences.id, old.id))
      .returning()
      .get();
    // Re-point links so the supersede doesn't orphan them.
    tx.update(memoryLinks).set({ fromId: newRow.id }).where(eq(memoryLinks.fromId, old.id)).run();
    tx.update(memoryLinks).set({ toId: newRow.id }).where(eq(memoryLinks.toId, old.id)).run();
    return { kind: "match", oldRow, newRow };
  });
}

// Supersede driven by auto-extraction. Trust-tiered guard (ADR 0006 §3/§6):
// an extracted fact may only supersede ANOTHER extracted row — never an explicit
// `advisor_tool` note (lower-trust inference must not override what the user
// directly stated). Returns `rejected` when the target isn't an
// extraction-superseding candidate so the caller can skip rather than override.
export type ExtractionSupersedeResult =
  | { ok: true; result: UpdateResult }
  | { ok: false; rejected: "not_found" | "not_extracted" };

export function updateFromExtraction(
  targetId: number,
  newContent: string,
  confidence: number,
): ExtractionSupersedeResult {
  const target = getById(targetId);
  if (!target || target.validUntil !== null) return { ok: false, rejected: "not_found" };
  if (target.source !== "extracted") return { ok: false, rejected: "not_extracted" };
  const result = supersede({ ...target, confidence }, newContent);
  return { ok: true, result };
}

// Restore a recently-forgotten row by clearing valid_until. Scoped to the
// current user so one account can't restore another's forgotten row. Only
// restores a DELIBERATELY-forgotten row (`superseded_by IS NULL`): an edit-history
// row has a live successor, so reviving it would double-activate the memory.
export function restore(id: number): Preference | undefined {
  const now = new Date().toISOString();
  return getDb()
    .update(userPreferences)
    .set({ validUntil: null, updatedAt: now })
    .where(
      and(
        eq(userPreferences.id, id),
        ownedBy(userPreferences.userId),
        sql`${userPreferences.validUntil} IS NOT NULL`,
        isNull(userPreferences.supersededBy),
      ),
    )
    .returning()
    .get();
}

// Consolidation merge: collapse near-duplicate rows into one survivor. Each
// loser is end-dated and pointed at the survivor (superseded_by) — so it's
// edit-history, not a forget, and the bitemporal trail stays reversible. Links
// re-point to the survivor. The survivor's content is kept verbatim (the sweep
// picks the strongest-provenance row as survivor); no model rewrite here.
export function mergeMemories(survivorId: number, loserIds: number[]): number {
  const ids = loserIds.filter((id) => id !== survivorId);
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  return getDb().transaction((tx) => {
    let merged = 0;
    for (const loserId of ids) {
      const res = tx
        .update(userPreferences)
        .set({ validUntil: now, supersededBy: survivorId, updatedAt: now })
        .where(
          and(
            eq(userPreferences.id, loserId),
            ownedBy(userPreferences.userId),
            isNull(userPreferences.validUntil),
          ),
        )
        .returning()
        .get();
      if (!res) continue;
      tx.update(memoryLinks)
        .set({ fromId: survivorId })
        .where(eq(memoryLinks.fromId, loserId))
        .run();
      tx.update(memoryLinks).set({ toId: survivorId }).where(eq(memoryLinks.toId, loserId)).run();
      merged++;
    }
    return merged;
  });
}

// ── Links ──────────────────────────────────────────────────────────────────
// The model proposes links (meaning); the DB enforces integrity. createLink
// only links rows the current user owns; listLinks is validity-aware — a link
// to a superseded/soft-deleted target is never surfaced.

export function createLink(fromId: number, toId: number, relation: string): MemoryLink | undefined {
  if (fromId === toId) return undefined;
  // Both endpoints must be live rows owned by the caller.
  if (!getById(fromId) || !getById(toId)) return undefined;
  return getDb()
    .insert(memoryLinks)
    .values({
      userId: ownerId(),
      fromId,
      toId,
      relation,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export interface LinkedPreference {
  relation: string;
  preference: Preference;
}

// Links from `prefId` whose target is still active (valid_until IS NULL),
// scoped to the caller. A superseded/forgotten target drops out automatically.
export function listLinks(prefId: number): LinkedPreference[] {
  const rows = getDb()
    .select({ relation: memoryLinks.relation, preference: userPreferences })
    .from(memoryLinks)
    .innerJoin(userPreferences, eq(memoryLinks.toId, userPreferences.id))
    .where(
      and(
        eq(memoryLinks.fromId, prefId),
        ownedBy(memoryLinks.userId),
        isNull(userPreferences.validUntil),
      ),
    )
    .all();
  return rows.map((r) => ({ relation: r.relation, preference: r.preference }));
}

// Confidence decay for unconfirmed auto-extracted notes (ADR 0006 §6). Lowers
// the confidence of active, never-confirmed `extracted` rows older than
// `minAgeDays` by `step`, floored at `floor` — so an unconfirmed auto-fact
// drifts below the injection threshold over time (→ recall-only) instead of
// injecting forever. Explicit rows (confidence NULL) and confirmed rows are
// untouched. Confidence is metadata, so this updates in place (like confirm()).
export interface DecayOptions {
  step?: number;
  minAgeDays?: number;
  /** Lower bound; defaults to 0.3 (extract.MIN_SAVE_CONFIDENCE — stays recallable). */
  floor?: number;
}

export function decayExtracted(opts: DecayOptions = {}): number {
  const step = opts.step ?? 0.1;
  const floor = opts.floor ?? 0.3;
  const minAgeDays = opts.minAgeDays ?? 30;
  const cutoff = new Date(Date.now() - minAgeDays * 86_400_000).toISOString();
  const rows = getDb()
    .select()
    .from(userPreferences)
    .where(
      and(
        activeScope(),
        eq(userPreferences.source, "extracted"),
        isNotNull(userPreferences.confidence),
        isNull(userPreferences.lastConfirmedAt),
        lt(userPreferences.validFrom, cutoff),
      ),
    )
    .all();
  const now = new Date().toISOString();
  let decayed = 0;
  for (const row of rows) {
    const current = row.confidence ?? 0;
    const next = Math.max(floor, current - step);
    if (next < current) {
      getDb()
        .update(userPreferences)
        .set({ confidence: next, updatedAt: now })
        .where(eq(userPreferences.id, row.id))
        .run();
      decayed++;
    }
  }
  return decayed;
}

export const PREFERENCE_CATEGORIES = CATEGORIES;
