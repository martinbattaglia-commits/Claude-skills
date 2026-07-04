// Returns reconciliation — pure, deterministic, DB- and network-free.
//
// Two "all-time" return numbers used to disagree on the Portfolio screen and
// read as a bug (#152):
//
//   • the hero showed gain on the CURRENT holdings vs what they cost
//     (value − cost basis) ÷ cost basis — small for a switching-heavy book,
//     because each fund switch banks realized gain into the new position's
//     basis, resetting the denominator toward 0;
//   • the chart's "All" pill showed total wealth growth vs the cash actually
//     contributed from outside (value − net contributions) ÷ contributions —
//     the truer lifetime return.
//
// `heroReturn` makes the headline the contribution-based total return (matching
// the chart), falling back to the cost-basis number only when there's no
// ledger-derived contribution history. `summarizeReturns` derives the full
// decomposition the breakdown sheet shows, so the headline and the breakdown
// can never disagree — they come from one formula.

/** The headline return — total return on the money contributed from outside. */
export interface HeroReturn {
  /** value − basis (THB). Basis is contributions when available, else cost basis. */
  pnl: number;
  /** The denominator used (contributions or cost basis). */
  basis: number;
  /** pnl ÷ basis × 100, or 0 when basis ≤ 0. */
  pnlPct: number;
  /** True when the figure is contribution-based; false when it fell back to cost basis. */
  usesContribution: boolean;
}

/**
 * Hero "all-time" return. Prefers total return on net contributions (deposits −
 * withdrawals) — the lifetime story that matches the chart's "All" pill. Falls
 * back to return on the current holdings' cost basis when there's no
 * contribution series (static placeholder data, or a book with no ledger).
 */
export function heroReturn(
  totalValue: number,
  netContributed: number | null,
  costBasisFallback: number,
): HeroReturn {
  const usesContribution = netContributed != null && netContributed > 0;
  const basis = usesContribution ? (netContributed as number) : costBasisFallback;
  const pnl = totalValue - basis;
  const pnlPct = basis > 0 ? (pnl / basis) * 100 : 0;
  return { pnl, basis, pnlPct, usesContribution };
}

export interface ReturnsBreakdownInput {
  /** Total wealth incl. in-transit cash — the hero balance (THB). */
  totalValue: number;
  /** Net external money contributed (deposits − withdrawals), or null if unknown. */
  netContributed: number | null;
  /** Σ remaining cost basis of still-held units (THB). */
  costBasisTotal: number;
  /** Σ realized gain booked from past sells (THB). */
  realizedTotal: number;
  /** Σ dividends received (THB). */
  incomeTotal: number;
  /** Σ fees paid (THB, positive magnitude). */
  expenseTotal: number;
  /** Annualized money-weighted return as a DECIMAL (0.12 = 12%), or null. */
  irr: number | null;
}

export interface ReturnsBreakdown {
  totalValue: number;
  netContributed: number | null;
  /** value − netContributed (THB), or null when no contribution history. */
  totalReturnAbs: number | null;
  /** totalReturnAbs ÷ netContributed × 100, or null. */
  totalReturnPct: number | null;
  costBasisTotal: number;
  /** value − cost basis (THB) — the older "all-time" number. */
  unrealizedAbs: number;
  /** unrealizedAbs ÷ cost basis × 100, or null when cost basis ≤ 0. */
  unrealizedPct: number | null;
  realizedTotal: number;
  incomeTotal: number;
  expenseTotal: number;
  /** Annualized money-weighted return as a PERCENT, or null. */
  annualizedPct: number | null;
  usesContribution: boolean;
}

/** Derive every figure the returns-breakdown sheet shows from one set of inputs. */
export function summarizeReturns(input: ReturnsBreakdownInput): ReturnsBreakdown {
  const { totalValue, netContributed, costBasisTotal, realizedTotal, incomeTotal, expenseTotal } =
    input;
  const usesContribution = netContributed != null && netContributed > 0;
  const totalReturnAbs = usesContribution ? totalValue - (netContributed as number) : null;
  const totalReturnPct =
    totalReturnAbs != null ? (totalReturnAbs / (netContributed as number)) * 100 : null;
  const unrealizedAbs = totalValue - costBasisTotal;
  const unrealizedPct = costBasisTotal > 0 ? (unrealizedAbs / costBasisTotal) * 100 : null;
  return {
    totalValue,
    netContributed,
    totalReturnAbs,
    totalReturnPct,
    costBasisTotal,
    unrealizedAbs,
    unrealizedPct,
    realizedTotal,
    incomeTotal,
    expenseTotal,
    annualizedPct: input.irr != null ? input.irr * 100 : null,
    usesContribution,
  };
}
