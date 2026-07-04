// Cash earmark resolution — pure, deterministic, DB- and network-free (issue #149).
//
// An earmark DESIGNATES part (or all) of a cash account as "reserved" for a purpose.
// Reserved cash is excluded from INVESTMENT return while net worth + allocation still
// count the full balance — so it never double-counts (it's a view of money already
// there, not new money).
//
// One mechanism, multiple SCOPES, most-specific wins:
//   • account   — reserve on one cash account `(bucketId, ticker)` (built in v1)
//   • portfolio — a default for every cash account in `bucketId` (schema-ready)
//   • goal      — #36
//
// This resolver works in the holding's NATIVE currency. Converting the reserved
// slice to THB is the caller's job, via the SAME `fx.rateOn(asOf)` used to value the
// holding — there must be exactly one FX path, or a foreign reserve double-converts.

export type EarmarkScope = "account" | "portfolio" | "goal";

/** A cash position to resolve reserves against (native units = the cash amount). */
export interface CashHoldingInput {
  bucketId: string;
  ticker: string;
  /** Current balance in the account's NATIVE currency. */
  balance: number;
  /** Native currency (e.g. "THB", "USD"). */
  currency: string;
}

/** A stored earmark row (the pure subset the resolver needs). */
export interface EarmarkInput {
  scope: EarmarkScope;
  bucketId: string;
  /** Account scope: the cash account ticker. NULL for portfolio scope. */
  ticker: string | null;
  /**
   * The account's RETURN role. Only `reserved` rows produce a reserved slice; an
   * `investable` row exists solely to carry a `purpose` label on dry powder and is
   * ignored by the reserve math. Absent → treated as `reserved` (legacy rows).
   */
  role?: "investable" | "reserved" | null;
  /** Reserved amount in `currency`; NULL = "All" (the whole balance, auto-tracks). */
  amount: number | null;
  currency?: string | null;
  purpose?: string | null;
}

export interface ResolvedEarmark {
  bucketId: string;
  ticker: string;
  /** Balance in native units. */
  balance: number;
  currency: string;
  /** What the user asked to reserve, native units ("All" → the balance). */
  requested: number;
  /** Actually reserved, native units = min(requested, balance) (so spending self-caps). */
  effective: number;
  /** requested − balance when underfunded (native units), else 0 — surfaced, never hidden. */
  shortfall: number;
  purpose: string | null;
}

// Reserved cash below this is dust (float residue).
const EPSILON = 1e-6;

const sameTicker = (a: string, b: string): boolean =>
  a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Pick the most-specific earmark for a cash holding: an `account`-scope earmark on the
 * exact `(bucketId, ticker)` wins over a `portfolio`-scope default on the bucket.
 * (`goal` scope is reserved for #36 and ignored here.)
 */
function pickEarmark(
  holding: CashHoldingInput,
  earmarks: readonly EarmarkInput[],
): EarmarkInput | null {
  let account: EarmarkInput | null = null;
  let portfolio: EarmarkInput | null = null;
  for (const e of earmarks) {
    if (e.bucketId !== holding.bucketId) continue;
    // Only `reserved` rows reserve; an `investable` row is a label-carrier (no reserve).
    if (e.role === "investable") continue;
    if (e.scope === "account" && e.ticker != null && sameTicker(e.ticker, holding.ticker)) {
      account = e;
    } else if (e.scope === "portfolio") {
      portfolio = e;
    }
  }
  return account ?? portfolio;
}

/**
 * Resolve every cash holding's reserved slice (native units) against the earmarks.
 * Holdings with no matching earmark are omitted from the result (nothing reserved).
 * A `null` amount ("All") reserves the whole balance; a fixed amount caps at the
 * balance and reports any shortfall.
 */
export function resolveEarmarks(
  holdings: readonly CashHoldingInput[],
  earmarks: readonly EarmarkInput[],
): ResolvedEarmark[] {
  const out: ResolvedEarmark[] = [];
  for (const h of holdings) {
    const e = pickEarmark(h, earmarks);
    if (!e) continue;
    const balance = Math.max(0, h.balance);
    // "All" (amount null) tracks the whole balance; a fixed amount caps at it.
    const requested = e.amount == null ? balance : Math.max(0, e.amount);
    const effective = Math.min(requested, balance);
    const shortfall = Math.max(0, requested - balance);
    if (effective <= EPSILON && shortfall <= EPSILON) continue;
    out.push({
      bucketId: h.bucketId,
      ticker: h.ticker,
      balance,
      currency: h.currency,
      requested,
      effective,
      shortfall,
      purpose: e.purpose ?? null,
    });
  }
  return out;
}
