// Reason-aware, deterministic resurfacing for suppressed Portfolio action items
// (Layer 1 of the #74 design — pure, no AI). When a finding is archived or
// rejected ("Not for me") we snapshot its magnitude (annual saving, pp/yr). It
// only comes back when the CURRENT magnitude is materially WORSE than the
// snapshot, by a bar that the rejection REASON selects. Never resurfaces on an
// improvement (the saving shrinking is good news, not a nag).
//
// Wave A scope (#74): this is the backend decision only. The UI wiring (cards,
// Hidden-checks list) and the Journal-feedback signal are Wave B.
//
// Pure + dependency-free so the server filter (lib/db/queries/action-items.ts)
// and tests share one source of truth. The "ratchet" (re-snapshot the new,
// higher value on re-suppression) lives in the query layer, not here — this
// function only answers "given the stored snapshot, does the current value
// cross the bar?".

/**
 * The two honest suppression states (#74). `active` = no row.
 *   - "archived"    — "I've seen this; file it."  (Acknowledge)
 *   - "not_for_me"  — "This advice isn't right for me." (Reject, optional reason)
 */
export type SuppressionState = "archived" | "not_for_me";

/**
 * Reason chip keys for "Not for me". The chip — not the free text — selects the
 * deterministic resurface policy (free text is annotation only; the Advisor
 * reads it in Layer 2, out of scope for Wave A). A null/absent reason on a
 * reject behaves like Archive (material-change), per the locked design.
 *
 * The four starter chips (open for label review, see design §8):
 *   - too_small         "Too small to matter"   → magnitude premise → normal bar
 *   - tax_switching     "Tax & switching cost"  → high bar (big jump only)
 *   - prefer_this_fund  "I prefer this fund"     → preference → never
 *   - already_considered "Already considered"    → never
 */
export const REASON_CHIPS = [
  "too_small",
  "tax_switching",
  "prefer_this_fund",
  "already_considered",
] as const;

export type ReasonChip = (typeof REASON_CHIPS)[number];

export function isReasonChip(value: unknown): value is ReasonChip {
  return typeof value === "string" && (REASON_CHIPS as readonly string[]).includes(value);
}

// ─── Material-change dials (starting values, tunable) ───────────────────────
// Expressed in the unit the fee card already shows: annual saving, pp/yr.
// Erring slightly loose is self-correcting because the ratchet re-baselines on
// each re-suppression (fires at most once per material jump). See design §4.

/** Normal bar: resurface when the saving grows by ≥ this many pp above the snapshot. */
export const RESURFACE_NORMAL_DELTA_PP = 0.2;

/** High bar (tax / switching cost): saving must at least multiply by this factor… */
export const RESURFACE_HIGH_BAR_FACTOR = 2;
/** …AND reach at least this absolute saving (pp/yr) to plausibly justify a switch cost. */
export const RESURFACE_HIGH_BAR_MIN_PP = 0.5;

/**
 * Which reasons never resurface deterministically (preference / structural, or
 * free-text the Layer-1 logic can't relate to magnitude). For these, Layer 1 is
 * inert — only the Advisor (Layer 2) may reopen, with context.
 */
function isDurableReason(reason: string | null): boolean {
  return reason === "prefer_this_fund" || reason === "already_considered";
}

/**
 * Which reasons take the HIGH bar (a rejection explicitly tied to a switch cost
 * — only a big jump is worth re-raising).
 */
function isHighBarReason(reason: string | null): boolean {
  return reason === "tax_switching";
}

export interface ResurfaceInput {
  /** The current magnitude of the finding (annual saving, pp/yr) right now. */
  currentSavingsPp: number;
  /** The magnitude snapshotted at suppression time (pp/yr). Null = no snapshot stored. */
  snapshotSavingsPp: number | null;
  /** The suppression state. */
  state: SuppressionState;
  /** The reason chip key or free text on a "Not for me"; null for archive / no-reason reject. */
  reason: string | null;
}

/**
 * Decide whether a suppressed finding should resurface (become visible again).
 *
 * Rules (design §4):
 *   - Durable reasons ("I prefer this fund" / "Already considered" / unrecognized
 *     free-text on a reject) → NEVER resurface here (Layer 2 only).
 *   - No snapshot stored → can't compare → stay hidden (conservative; a finding
 *     suppressed before snapshots existed shouldn't pop back on noise).
 *   - Improvement (current ≤ snapshot) → NEVER resurface (ratchet: only worse fires).
 *   - High-bar reason (tax/switching) → resurface only if current ≥ 2× snapshot
 *     AND current ≥ 0.50pp.
 *   - Everything else (archive, no-reason reject, "too small") → resurface when
 *     current ≥ snapshot + 0.20pp.
 *
 * Pure: no clock, no DB. The ratchet (re-snapshotting the higher value) is the
 * caller's job on re-suppression.
 */
export function shouldResurface(input: ResurfaceInput): boolean {
  const { currentSavingsPp, snapshotSavingsPp, state, reason } = input;

  // A reject with a durable/preference reason (or free text we can't map to a
  // chip) is inert in Layer 1. Archive never carries a durable reason.
  const effectiveReason = state === "not_for_me" ? reason : null;
  if (effectiveReason !== null && !isReasonChip(effectiveReason)) {
    // Free-text-only reject → durable (Layer 1 won't override words it can't
    // relate to magnitude).
    return false;
  }
  if (isDurableReason(effectiveReason)) return false;

  // No baseline to compare against → don't resurface on noise.
  if (snapshotSavingsPp === null) return false;

  // Ratchet: only a materially WORSE finding resurfaces; an improvement never does.
  if (currentSavingsPp <= snapshotSavingsPp) return false;

  if (isHighBarReason(effectiveReason)) {
    return (
      currentSavingsPp >= snapshotSavingsPp * RESURFACE_HIGH_BAR_FACTOR &&
      currentSavingsPp >= RESURFACE_HIGH_BAR_MIN_PP
    );
  }

  // Normal bar.
  return currentSavingsPp >= snapshotSavingsPp + RESURFACE_NORMAL_DELTA_PP;
}
