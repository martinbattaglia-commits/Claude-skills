// Deterministic identity keys for generated Portfolio action items.
//
// Portfolio action items (fee-creep flags today; the headline and rebalance
// suggestions later) are recomputed every render from live holdings + the
// target model — they carry no DB row of their own. To let a user dismiss /
// snooze / disagree with one and have that choice survive reloads, we synthesize
// a stable `item_key` from the item's IDENTITY inputs only, never its magnitudes.
//
// Why identity-only: a key built from the dollar saving or TER would change on
// every NAV tick, so a dismissal would evaporate the next minute. Keying on the
// held ticker alone means "I've handled the VWRA fee flag" stays handled even as
// the exact saving drifts — while a genuinely different finding (a different
// fund) gets a different key and resurfaces normally.
//
// Pure + dependency-free so both the server filter and any client need share one
// source of truth. See lib/db/queries/action-items.ts and
// app/api/portfolio/fee-creep/route.ts for the consumers.

export type ActionItemType = "headline" | "rebalance" | "fee_creep";

/**
 * Key for a fee-creep finding: `fee_creep:{heldTicker}`.
 *
 * The cheapest-alternative identity is deliberately excluded so a "disagree"
 * sticks even if a cheaper peer changes — the user is rejecting the flag on the
 * fund they hold, not on a specific alternative.
 */
export function feeCreepKey(heldTicker: string): string {
  return `fee_creep:${heldTicker}`;
}

/**
 * Key for the health headline: `headline:{branch}:{subject}`.
 *
 * `branch` is the priority branch (drift / concentration / cash / fee /
 * ontrack); `subject` is the salient id (top ticker, target name, or ""). A
 * dismissal sticks while the same problem about the same subject is the
 * headline, but a flip to a different problem produces a new key.
 *
 * Not yet wired (headline is an MVP+1 consumer); defined here so the recipe
 * lives in one place.
 */
export function headlineKey(branch: string, subject = ""): string {
  return `headline:${branch}:${subject}`;
}

/**
 * Key for a rebalance suggestion: `rebalance:{sortedSignedTickers}`, e.g.
 * `rebalance:ADD~BNDX|TRIM~VWRA`. Same pair of moves = same suggestion; a
 * different over/underweight pair is a new item. Sorted so input order can't
 * change the key.
 *
 * Not yet wired (rebalance is an MVP+1 consumer).
 */
export function rebalanceKey(addTicker: string, trimTicker: string): string {
  const parts = [`ADD~${addTicker}`, `TRIM~${trimTicker}`].sort();
  return `rebalance:${parts.join("|")}`;
}
