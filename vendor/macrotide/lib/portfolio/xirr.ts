// Money-weighted return (XIRR) — pure, deterministic, DB- and network-free.
//
// The headline "how am I actually doing" number for a contribution-driven
// portfolio. Unlike a time-weighted return it accounts for WHEN cash went in, so
// a steady DCA investor is judged on the money they actually had at work.
//
// Solves  NPV(r) = Σ Pᵢ / (1 + r)^((dᵢ − d₀)/365) = 0  for the annualized rate r.
//
// Sign convention (the caller is responsible for it; see the schema comment on
// `transactions.amount`):
//   • buys / contributions / fees → NEGATIVE (cash out)
//   • sells / cash dividends / withdrawals → POSITIVE (cash in)
//   • reinvested (accumulating) dividends → EXCLUDED (internal, no external cash)
// To value a portfolio that is still partly held, the caller appends the current
// market value (THB, priced today) as a final POSITIVE cash flow dated today —
// WITHOUT that terminal flow an all-buys-still-holding series is single-signed
// and has no solution. The caller must also guarantee that value is real: if any
// still-held position lacks a fresh quote it should pass nothing and show an
// empty state, never let a missing price masquerade as a zero terminal value.

import type { LedgerTxn } from "./lots";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

export interface CashFlow {
  /** ISO-8601 date (or datetime); only the day is significant. */
  date: string;
  /** Signed THB amount (see sign convention above). */
  amount: number;
}

/**
 * Map a transaction ledger to external cash flows for XIRR, applying the
 * exclusion rules: `reinvest`, `split`, `snapshot`, and ALL explicit-cash kinds
 * (`deposit` / `withdraw` / `cash_balance`) are dropped here. A snapshot/cash_balance is
 * a restatement, not a flow; the cash CONTRIBUTION flows are supplied separately by
 * `cashContributionFlows` (settlement-cash.ts) — the single shared definition — so a
 * Set balance's contribution reaches XIRR (it carries no `amount`, only an asserted
 * balance) and the three contribution paths can't diverge (#149). Everything else passes
 * through with its already-signed `amount` (buys/fees negative, sells/cash dividends
 * positive). A costed `opening` carries a negative `amount` (cash put to work) and is
 * included; an uncosted `opening` carries `amount` 0 and is a no-op. The caller appends
 * the cash contribution flows and the terminal market-value flow.
 */
export function txnsToCashFlows(txns: readonly LedgerTxn[]): CashFlow[] {
  const flows: CashFlow[] = [];
  for (const txn of txns) {
    if (
      txn.kind === "reinvest" ||
      txn.kind === "split" ||
      txn.kind === "snapshot" ||
      txn.kind === "deposit" ||
      txn.kind === "withdraw" ||
      txn.kind === "cash_balance"
    )
      continue;
    flows.push({ date: txn.tradeDate, amount: txn.amount });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return flows;
}

export interface XirrOptions {
  /** Newton starting guess (annualized decimal rate). */
  guess?: number;
  /** Max Newton iterations before falling back to bisection. */
  maxIterations?: number;
  /** NPV convergence tolerance. */
  tolerance?: number;
}

/**
 * Compute the annualized money-weighted return for a set of dated cash flows.
 *
 * @returns the rate as a decimal (0.12 = +12%/yr), or `null` when it is
 *   undefined or cannot be solved reliably:
 *     • fewer than two cash flows,
 *     • all flows the same sign (no rate makes NPV zero),
 *     • neither Newton nor bisection converges to a real root.
 *   Returning `null` rather than a garbage rate is deliberate — a wrong return
 *   number is worse than an honest "not enough to compute".
 */
export function xirr(flows: readonly CashFlow[], opts: XirrOptions = {}): number | null {
  if (flows.length < 2) return null;

  const t0 = dayNumber(flows[0].date);
  const points = flows.map((f) => ({
    amount: f.amount,
    years: (dayNumber(f.date) - t0) / DAYS_PER_YEAR,
  }));

  // Need at least one inflow and one outflow, else NPV is monotonic in r and
  // never crosses zero.
  const hasPositive = points.some((p) => p.amount > 0);
  const hasNegative = points.some((p) => p.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const tolerance = opts.tolerance ?? 1e-7;
  const maxIterations = opts.maxIterations ?? 50;

  const npv = (rate: number): number => {
    let sum = 0;
    for (const p of points) sum += p.amount / (1 + rate) ** p.years;
    return sum;
  };
  const dNpv = (rate: number): number => {
    let sum = 0;
    for (const p of points) {
      if (p.years === 0) continue;
      sum += (-p.years * p.amount) / (1 + rate) ** (p.years + 1);
    }
    return sum;
  };

  // Newton-Raphson.
  let rate = opts.guess ?? 0.1;
  for (let i = 0; i < maxIterations; i++) {
    if (rate <= -1) break; // (1 + r) must stay positive
    const value = npv(rate);
    if (Math.abs(value) < tolerance) return rate;
    const slope = dNpv(rate);
    if (slope === 0 || !Number.isFinite(slope)) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) {
      rate = next;
      if (Math.abs(npv(rate)) < tolerance) return rate;
      break;
    }
    rate = next;
  }

  // Bisection fallback over a wide bracket — guaranteed to find a root wherever
  // NPV changes sign (this is what Excel's XIRR falls back to).
  return bisect(npv, tolerance);
}

function bisect(npv: (r: number) => number, tolerance: number): number | null {
  let lo = -0.9999; // just above -100% (base must stay > 0)
  let hi = 1e7;
  let flo = npv(lo);
  let fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo * fhi > 0) return null; // no sign change to bracket → no real root here

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid);
    if (!Number.isFinite(fmid)) return null;
    if (Math.abs(fmid) < tolerance || (hi - lo) / 2 < 1e-9) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

/** Whole-day number for a date string, for an actual/365 day count. */
function dayNumber(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`xirr: unparseable date "${iso}"`);
  return Math.floor(ms / MS_PER_DAY);
}
