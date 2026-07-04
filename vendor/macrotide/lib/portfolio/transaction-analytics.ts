import "server-only";
import { listFundQuotes } from "@/lib/db/queries/quotes";
import { foldableEvents } from "@/lib/db/queries/resolve-derived-units";
import type { Transaction } from "@/lib/db/queries/transactions";
import { inferHoldingCurrency } from "@/lib/market/currency";
import { buildFxConverter } from "@/lib/market/fx";
import { quoteCacheKey } from "@/lib/market/sources";
import { type ContributionSummary, summarizeContributions } from "./contributions";
import {
  type BasisPoint,
  type CostBasisMethod,
  type LedgerTxn,
  type PositionState,
  type RealizedEvent,
  reduceLots,
  type TxnKind,
} from "./lots";
import { cashContributionFlows } from "./settlement-cash";
import { isTxnKind } from "./txn-import";
import { type CashFlow, txnsToCashFlows, xirr } from "./xirr";

// Server-side orchestrator for the Activity ledger's analytics.
//
// This is the ONLY place the two-DB join happens: transactions come from app.db
// (passed in by the route), the terminal market value is priced from market.db
// (fund_quotes) and FX-converted into THB at today's rate. The pure helpers
// (reduceLots / xirr / summarizeContributions) stay DB- and network-free — they
// receive fully assembled data. Keep that boundary: never read a DB inside a
// pure helper.

export interface TransactionAnalytics {
  method: CostBasisMethod;
  realized: RealizedEvent[];
  realizedTotal: number;
  incomeTotal: number;
  expenseTotal: number;
  positions: PositionState[];
  basisTimeline: BasisPoint[];
  contributions: ContributionSummary;
  /**
   * Σ remaining cost basis of still-held units in THB — the capital actually
   * still invested. Deducts the COST of sold units (via the lots fold), not
   * their proceeds, so it never double-counts realized gain (that's `realizedTotal`)
   * and can't go negative. Uncosted held units (cost_unknown) contribute 0.
   */
  costBasisTotal: number;
  /** Current market value of still-held units in THB, or null if unpriced. */
  marketValue: number | null;
  /** Money-weighted (annualized) return as a decimal, or null when undefined. */
  irr: number | null;
  /** Why IRR is null, for the UI empty state (null when irr is present). */
  irrUnavailable: string | null;
  /** Currencies whose FX rate couldn't be resolved (terminal value degraded). */
  missingFx: string[];
}

// Day this analytics snapshot is "as of" (the terminal cash-flow date).
export interface AnalyticsOptions {
  method?: CostBasisMethod;
  /** ISO date for the terminal value; defaults handled by the caller (route). */
  asOf: string;
  /**
   * Contribution mode (D4b, #149). `true` (default, mode A): uninvested cash counts —
   * deposits/Set-balance raises are contributions and the cash value is in the return
   * terminal, so idle cash honestly drags the return. `false` (mode B, sidecar): cash is
   * excluded from the RETURN (no cash contribution flows, cash value out of the terminal)
   * while net worth (`marketValue`) still includes it. A user preference; caller passes it.
   */
  countUninvestedCash?: boolean;
  /**
   * Cash account tickers marked `reserved` (#149) — ALWAYS excluded from the return (their
   * contributions and terminal value), regardless of the mode, while still counted in net
   * worth (`marketValue`). The caller fetches these from the earmarks.
   */
  reservedTickers?: ReadonlySet<string>;
}

const MIN_IRR_DAYS = 28; // annualized XIRR over < ~1 month is meaningless

// Latest positive market_price per ticker, by trade date — the current price for
// a holding with no live NAV (a "manual" / custom asset). Prices come straight
// from the ledger: a Balance's current-price field, or a trade's execution price.
function latestMarketPriceByTicker(rows: readonly Transaction[]): Map<string, number> {
  const best = new Map<string, { date: string; price: number }>();
  for (const r of rows) {
    const price = r.marketPrice;
    if (price == null || price <= 0) continue;
    const cur = best.get(r.ticker);
    if (!cur || r.tradeDate > cur.date) best.set(r.ticker, { date: r.tradeDate, price });
  }
  const out = new Map<string, number>();
  for (const [ticker, v] of best) out.set(ticker, v.price);
  return out;
}

export async function computeTransactionAnalytics(
  rows: readonly Transaction[],
  opts: AnalyticsOptions,
): Promise<TransactionAnalytics> {
  const method = opts.method ?? "average";
  // Facts-only ledger: derive the missing unit count (value-only Balances +
  // amount-only trades) from NAV(date) at read, so realized gains / IRR /
  // value-over-time always reflect the latest NAV — never a unit count frozen at
  // save (ADR 0004). An anchor still unpriceable is dropped (not folded as zero) so
  // it can't wipe a position — foldableEvents matches the holdings projection.
  const txns = foldableEvents(rows).map(toLedgerTxn);
  const countUninvestedCash = opts.countUninvestedCash ?? true;
  const reservedTickers = opts.reservedTickers;

  const lots = reduceLots(txns, method);
  const contributions = summarizeContributions(txns, {
    countUninvestedCash,
    excludeTickers: reservedTickers,
  });

  // Explicit-cash contribution flows from the SHARED definition, negated to the XIRR sign
  // (money into the portfolio = a negative, out-of-pocket flow). Reserved accounts are
  // always dropped; mode B drops the rest too.
  const cashFlows: CashFlow[] = countUninvestedCash
    ? cashContributionFlows(txns, reservedTickers).map((f) => ({ date: f.date, amount: -f.amount }))
    : [];

  // Price still-held positions → THB, to form the terminal cash flow.
  const held = lots.positions.filter((p) => p.units > 0);
  const costBasisTotal = held.reduce((s, p) => s + (p.costBasis ?? 0), 0);
  const sourceByTicker = new Map<string, string>();
  const cashCurrencyByTicker = new Map<string, string>();
  for (const r of rows) {
    sourceByTicker.set(r.ticker, r.quoteSource);
    // A cash account's currency rides on its rows (tradeCurrency); the ticker is
    // the account name, so currency can't be inferred from it.
    if (r.quoteSource === "cash" && r.tradeCurrency) {
      cashCurrencyByTicker.set(r.ticker, r.tradeCurrency);
    }
  }
  const currencyFor = (source: string, ticker: string): string =>
    inferHoldingCurrency(source, ticker, cashCurrencyByTicker.get(ticker));

  let marketValue: number | null = null;
  let irr: number | null = null;
  let irrUnavailable: string | null = null;
  const missingFx: string[] = [];

  if (held.length === 0) {
    // Fully exited — no synthetic terminal flow needed; IRR rests on real flows
    // (incl. any cash deposits/withdrawals that netted the position to zero).
    marketValue = 0;
    ({ irr, irrUnavailable } = solveIrr(txns, null, opts.asOf, cashFlows));
  } else {
    const cacheKeys = held.map((p) =>
      quoteCacheKey(sourceByTicker.get(p.ticker) ?? "market", p.ticker),
    );
    const navByKey = new Map<string, number>();
    for (const q of listFundQuotes(cacheKeys)) {
      if (q.nav > 0) navByKey.set(q.ticker, q.nav);
    }
    // A "manual" holding has no live provider — it's priced from the LATEST
    // market_price the user recorded in its own ledger (the current-price field on
    // a Balance, or a trade's execution price). Known funds never use this.
    const manualPrice = latestMarketPriceByTicker(rows);

    const currencies = new Set<string>();
    for (const p of held) {
      currencies.add(currencyFor(sourceByTicker.get(p.ticker) ?? "market", p.ticker));
    }
    const fx = await buildFxConverter(currencies, "1mo", [opts.asOf]);
    for (const c of fx.missing) missingFx.push(c);

    let total = 0;
    let cashValue = 0; // THB value of ALL cash positions — dropped from the RETURN terminal in mode B
    let reservedCashValue = 0; // reserved cash — ALWAYS dropped from the return terminal
    const unpriced: string[] = [];
    for (const p of held) {
      const source = sourceByTicker.get(p.ticker) ?? "market";
      // Cash is priced at 1.0 in its currency; manual uses the latest recorded
      // price; everything else uses the cached NAV.
      const nav =
        source === "cash"
          ? 1
          : source === "manual"
            ? manualPrice.get(p.ticker)
            : navByKey.get(quoteCacheKey(source, p.ticker));
      const rate = fx.rateOn(currencyFor(source, p.ticker), opts.asOf);
      if (nav === undefined || rate === null) {
        unpriced.push(p.ticker);
        continue;
      }
      const thb = p.units * nav * rate;
      total += thb;
      if (source === "cash") {
        cashValue += thb;
        if (reservedTickers?.has(p.ticker)) reservedCashValue += thb;
      }
    }

    if (unpriced.length > 0) {
      // A missing price must NOT masquerade as a zero terminal value (that would
      // read as a total loss). Refuse to compute rather than mislead.
      marketValue = null;
      irrUnavailable =
        unpriced.length === 1
          ? "Waiting on a current price for 1 holding."
          : `Waiting on current prices for ${unpriced.length} holdings.`;
    } else {
      // Net worth always includes cash; the RETURN terminal drops reserved cash always,
      // and the rest of the cash too in mode B (sidecar).
      marketValue = total;
      const returnTerminal = total - (countUninvestedCash ? reservedCashValue : cashValue);
      ({ irr, irrUnavailable } = solveIrr(
        txns,
        { date: opts.asOf, amount: returnTerminal },
        opts.asOf,
        cashFlows,
      ));
    }
  }

  return {
    method,
    realized: lots.realized,
    realizedTotal: lots.realizedTotal,
    incomeTotal: lots.incomeTotal,
    expenseTotal: lots.expenseTotal,
    positions: lots.positions,
    basisTimeline: lots.basisTimeline,
    contributions,
    costBasisTotal,
    marketValue,
    irr,
    irrUnavailable,
    missingFx,
  };
}

function solveIrr(
  txns: LedgerTxn[],
  terminal: { date: string; amount: number } | null,
  asOf: string,
  cashFlows: CashFlow[],
): { irr: number | null; irrUnavailable: string | null } {
  // Fund flows (buys/sells/dividends) + the explicit-cash contribution flows (the shared
  // definition, already XIRR-signed) + the terminal value.
  const flows = [...txnsToCashFlows(txns), ...cashFlows];
  if (terminal) flows.push(terminal);
  if (flows.length < 2)
    return { irr: null, irrUnavailable: "Not enough activity to compute a return yet." };

  // Gate on elapsed history: annualizing a sub-month window explodes the rate.
  const first = flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0].date);
  const days = (Date.parse(asOf) - Date.parse(first)) / 86_400_000;
  if (days < MIN_IRR_DAYS) {
    return { irr: null, irrUnavailable: "Not enough activity to compute a return yet." };
  }

  const rate = xirr(flows);
  if (rate === null) {
    return { irr: null, irrUnavailable: "Not enough activity to compute a return yet." };
  }
  return { irr: rate, irrUnavailable: null };
}

/** Narrow a stored row to the pure-engine shape, defaulting an unknown kind to "buy". */
export function toLedgerTxn(r: Transaction): LedgerTxn {
  const kind: TxnKind = isTxnKind(r.kind) ? r.kind : "buy";
  return {
    id: r.id,
    bucketId: r.bucketId,
    ticker: r.ticker,
    kind,
    tradeDate: r.tradeDate,
    units: r.units,
    // Anchors (opening/snapshot) carry their asserted avg cost here; the engine
    // ignores it for deltas.
    pricePerUnit: r.pricePerUnit,
    amount: r.amount,
    // Cash-fold inputs (#149): FX to value a cash_balance in THB; the reconcile override.
    fxToThb: r.fxToThb,
    reconcile: r.reconcile,
    createdAt: r.createdAt,
  };
}
