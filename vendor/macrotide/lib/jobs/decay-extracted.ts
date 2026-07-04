// Confidence-decay sweep for unconfirmed auto-extracted memory (ADR 0006 §6).
//
// Auto-extracted facts carry a confidence score; only those at/above the
// injection threshold load into the chat. Without decay, an unconfirmed guess
// would keep injecting forever. This sweep lowers the confidence of active,
// never-confirmed `extracted` notes that have aged past `minAgeDays`, so they
// drift below the threshold and become recall-only (never deleted — still
// searchable, and a user affirmation via confirm() resets the clock by setting
// last_confirmed_at, which excludes the row from decay). Explicit user/advisor
// notes (confidence NULL) are never touched.
//
// Runs ONCE PER USER SCOPE — the single-owner NULL set plus every registered
// user id, each via runWithUserScope so the user-scoped query sees exactly that
// user's rows. Idempotent at the floor: a row already at `floor` stops moving.
import { runWithUserScope } from "../db/context";
import { listUserIds } from "../db/queries/admin";
import { decayExtracted } from "../db/queries/preferences";

/** Confidence subtracted per run from each eligible row. */
export const DEFAULT_DECAY_STEP = 0.1;
/** Minimum age (days) before an unconfirmed extracted note starts decaying. */
export const DEFAULT_MIN_AGE_DAYS = 30;

export interface DecayExtractedOptions {
  step?: number;
  minAgeDays?: number;
  floor?: number;
  /**
   * User scopes to sweep. Defaults to the NULL single-owner set plus every
   * registered user id — override only in tests.
   */
  scopes?: (string | null)[];
  /** Decay dependency — injectable for tests. Defaults to the real query. */
  decay?: () => number;
}

export interface DecayExtractedResult {
  /** Rows whose confidence was lowered this run, across all scopes. */
  decayedCount: number;
  /** User scopes swept this run (null = the single-owner row set). */
  scopesSwept: (string | null)[];
}

export function decayStaleExtractedMemory(
  options: DecayExtractedOptions = {},
): DecayExtractedResult {
  const step = options.step ?? DEFAULT_DECAY_STEP;
  const minAgeDays = options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const decay = options.decay ?? (() => decayExtracted({ step, minAgeDays, floor: options.floor }));
  const scopes = options.scopes ?? [null, ...listUserIds()];

  let decayedCount = 0;
  for (const userId of scopes) {
    runWithUserScope(userId, () => {
      decayedCount += decay();
    });
  }

  return { decayedCount, scopesSwept: scopes };
}
