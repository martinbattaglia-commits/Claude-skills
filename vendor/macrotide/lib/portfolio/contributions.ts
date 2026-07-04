// Contribution timeline — pure, deterministic, DB- and network-free.
//
// Aggregates the transaction ledger into the monthly invested/withdrawn series
// behind the DCA timeline chart, plus the summary figures (total invested,
// average contribution, detected cadence). This is also the input a future
// contribution / DCA planner consumes, so it stays a standalone pure helper.
//
// All amounts are THB magnitudes off the signed `amount` field (see lots.ts for
// why `amount` is the authoritative money field and FX is never re-applied).

import type { LedgerTxn } from "./lots";
import { cashContributionFlows } from "./settlement-cash";

export interface MonthlyContribution {
  /** Calendar month, "YYYY-MM". */
  month: string;
  /** THB put in (buys + reinvested dividends) this month. */
  invested: number;
  /** THB taken out (sells) this month. */
  withdrawn: number;
  /** invested − withdrawn. */
  net: number;
}

export interface ContributionSummary {
  months: MonthlyContribution[];
  /** Σ invested across all months, THB. */
  totalInvested: number;
  /** Σ withdrawn across all months, THB. */
  totalWithdrawn: number;
  /** Mean of the buy amounts (per contributing transaction), THB; 0 if none. */
  averageContribution: number;
  /** Number of buy/reinvest transactions. */
  contributionCount: number;
  /**
   * Median gap in days between contribution dates, or null with fewer than two
   * contributions. A ~30 here reads as a monthly DCA cadence.
   */
  cadenceDays: number | null;
}

const CONTRIBUTING: ReadonlySet<string> = new Set(["buy", "reinvest"]);

/** Aggregate a ledger into the monthly contribution series + summary. */
export function summarizeContributions(
  txns: readonly LedgerTxn[],
  opts: { countUninvestedCash?: boolean; excludeTickers?: ReadonlySet<string> } = {},
): ContributionSummary {
  const byMonth = new Map<string, MonthlyContribution>();
  const contributionAmounts: number[] = [];
  const contributionDays: number[] = [];

  let totalInvested = 0;
  let totalWithdrawn = 0;

  // Sort by trade date so the months come out chronological and cadence gaps
  // are measured in order.
  const sorted = [...txns].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  for (const txn of sorted) {
    const magnitude = Math.abs(txn.amount);
    const month = txn.tradeDate.slice(0, 7); // "YYYY-MM"
    const row = byMonth.get(month) ?? { month, invested: 0, withdrawn: 0, net: 0 };

    if (CONTRIBUTING.has(txn.kind)) {
      row.invested += magnitude;
      totalInvested += magnitude;
      contributionAmounts.push(magnitude);
      contributionDays.push(dayNumber(txn.tradeDate));
    } else if (txn.kind === "sell") {
      row.withdrawn += magnitude;
      totalWithdrawn += magnitude;
    }
    // dividend / fee / split don't move the contribution series.

    row.net = row.invested - row.withdrawn;
    byMonth.set(month, row);
  }

  // Explicit-cash contributions (mode A, #149): a deposit / Set-balance raise adds to
  // invested, a withdraw / Set-balance drop to withdrawn — the SAME shared definition the
  // chart line and XIRR use, so the three agree. Deliberately kept OUT of the cadence /
  // average figures (those measure investment-purchase rhythm, which idle cash isn't).
  // Mode B (countUninvestedCash false) excludes cash from the contribution totals entirely.
  if (opts.countUninvestedCash ?? true) {
    for (const f of cashContributionFlows(txns, opts.excludeTickers)) {
      const month = f.date.slice(0, 7);
      const row = byMonth.get(month) ?? { month, invested: 0, withdrawn: 0, net: 0 };
      if (f.amount > 0) {
        row.invested += f.amount;
        totalInvested += f.amount;
      } else {
        row.withdrawn += -f.amount;
        totalWithdrawn += -f.amount;
      }
      row.net = row.invested - row.withdrawn;
      byMonth.set(month, row);
    }
  }

  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  const averageContribution =
    contributionAmounts.length > 0
      ? contributionAmounts.reduce((s, a) => s + a, 0) / contributionAmounts.length
      : 0;

  return {
    months,
    totalInvested,
    totalWithdrawn,
    averageContribution,
    contributionCount: contributionAmounts.length,
    cadenceDays: medianGap(contributionDays),
  };
}

/** Median of consecutive gaps in a sorted-ascending list of day numbers. */
function medianGap(days: number[]): number | null {
  if (days.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

const MS_PER_DAY = 86_400_000;

function dayNumber(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`contributions: unparseable date "${iso}"`);
  return Math.floor(ms / MS_PER_DAY);
}
