import "server-only";
import { and, eq } from "drizzle-orm";
import { type SuppressionState, shouldResurface } from "@/lib/portfolio/action-item-resurface";
import { getDb } from "../context";
import { actionItemStates } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type ActionItemStateRow = typeof actionItemStates.$inferSelect;

// Re-export so existing route imports keep one source of truth for the state type.
export type ActionItemState = SuppressionState;

/** A suppressed item, as the generator filter consumes it. */
export interface SuppressedRow {
  itemKey: string;
  state: ActionItemState;
  reason: string | null;
  snapshotSavingsPp: number | null;
}

/**
 * The current magnitude of a live finding, keyed by its item_key. The
 * suppression filter needs this to decide whether a hidden item has crossed the
 * resurface bar (material-change). `savingsPp` is the only magnitude today
 * (fee-creep); items without a magnitude (headline / rebalance) pass null.
 */
export interface CurrentFinding {
  itemKey: string;
  savingsPp: number | null;
}

/**
 * The suppression set the generator filter subtracts, AFTER applying the
 * reason-aware resurface logic (Layer 1, design §4). A row is returned (= stays
 * hidden) UNLESS its finding has materially worsened past the bar its reason
 * selects, in which case it is omitted (= resurfaces). Pure decision lives in
 * lib/portfolio/action-item-resurface.ts.
 *
 * `currentFindings` maps item_key → current magnitude for the findings live this
 * render. A suppressed row with no matching current finding (the finding no
 * longer fires at all) stays hidden — there's nothing to resurface.
 *
 * Scoped to the current owner / demo session via `ownedBy`.
 */
export function listSuppressed(currentFindings: CurrentFinding[] = []): SuppressedRow[] {
  const currentByKey = new Map(currentFindings.map((f) => [f.itemKey, f.savingsPp]));

  const rows = getDb()
    .select({
      itemKey: actionItemStates.itemKey,
      state: actionItemStates.state,
      reason: actionItemStates.reason,
      snapshotSavingsPp: actionItemStates.snapshotSavingsPp,
    })
    .from(actionItemStates)
    .where(ownedBy(actionItemStates.userId))
    .all();

  return rows
    .map((r) => ({ ...r, state: r.state as ActionItemState }))
    .filter((r) => {
      const current = currentByKey.get(r.itemKey);
      // No live finding for this key → nothing to compare → stays suppressed.
      if (current == null) return true;
      // Resurface (omit from the suppressed set) only when materially worse.
      return !shouldResurface({
        currentSavingsPp: current,
        snapshotSavingsPp: r.snapshotSavingsPp,
        state: r.state,
        reason: r.reason,
      });
    });
}

/**
 * Record an Archive / "Not for me" on an item. Idempotent upsert on
 * (user_id, item_key) — one state per item. Re-acting overwrites the row (you
 * can't be both archived and rejected).
 *
 * Stores the finding's current magnitude (`snapshotSavingsPp`) so the resurface
 * check has a baseline — and on re-suppression this re-snapshots the NEW value,
 * which is the ratchet (design §4): a finding fires at most once per material
 * jump, then re-baselines higher.
 *
 * We scope-then-update/insert rather than `ON CONFLICT (user_id, item_key)`
 * because SQLite treats NULL user_ids as distinct in a UNIQUE index — so in
 * single-owner / demo mode (user_id NULL) the conflict would never fire and we'd
 * accumulate duplicates. Matching on `ownedBy(...)` collapses to the one logical
 * owner correctly (same pattern as setUserIndicatorSymbols).
 */
export function recordActionItem(input: {
  itemType: string;
  itemKey: string;
  state: ActionItemState;
  /** Optional reason on a "Not for me" (REASON_CHIPS key or free text); forced null for archive. */
  reason?: string | null;
  /** Current magnitude of the finding (annual saving, pp/yr); null when none. */
  snapshotSavingsPp?: number | null;
}): ActionItemStateRow {
  // Archive carries no reject reason; only "not_for_me" keeps it.
  const reason = input.state === "not_for_me" ? (input.reason ?? null) : null;
  const snapshotSavingsPp = input.snapshotSavingsPp ?? null;
  const now = new Date().toISOString();
  const db = getDb();
  const scope = and(eq(actionItemStates.itemKey, input.itemKey), ownedBy(actionItemStates.userId));

  const existing = db.select().from(actionItemStates).where(scope).get();
  if (existing) {
    return db
      .update(actionItemStates)
      .set({
        state: input.state,
        reason,
        snapshotSavingsPp,
        itemType: input.itemType,
        updatedAt: now,
      })
      .where(scope)
      .returning()
      .get();
  }
  return db
    .insert(actionItemStates)
    .values({
      userId: ownerId(),
      itemType: input.itemType,
      itemKey: input.itemKey,
      state: input.state,
      reason,
      snapshotSavingsPp,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Every suppressed item for the current owner — the source for the future
 * "Hidden checks (N)" review-and-restore surface (Wave B). Returns both archived
 * and not-for-me rows with their reason + snapshot, newest first.
 */
export function listHidden(): ActionItemStateRow[] {
  return getDb()
    .select()
    .from(actionItemStates)
    .where(ownedBy(actionItemStates.userId))
    .all()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Delete a state row → the item becomes active again (un-archive / restore). */
export function clearActionItemState(itemKey: string): void {
  getDb()
    .delete(actionItemStates)
    .where(and(eq(actionItemStates.itemKey, itemKey), ownedBy(actionItemStates.userId)))
    .run();
}
