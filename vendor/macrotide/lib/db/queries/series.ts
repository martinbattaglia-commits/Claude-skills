import "server-only";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { BASE_CURRENCY, inferHoldingCurrency } from "@/lib/market/currency";
import { buildFxConverter } from "@/lib/market/fx";
import { quoteCacheKey, tickerKey } from "@/lib/market/sources";
import { demoHoldingSeries } from "@/lib/mock/demo-history-read";
import { type LedgerTxn, type PositionCheckpoint, reduceLots } from "@/lib/portfolio/lots";
import {
  type CashPoint,
  cashContributionFlows,
  foldSettlementCash,
} from "@/lib/portfolio/settlement-cash";
import { toLedgerTxn } from "@/lib/portfolio/transaction-analytics";
import { isAnchorKind } from "@/lib/portfolio/txn-import";
import { getDb, getMarketDb, isDemoRequest, type MarketDb } from "../context";
import { fundCatalog, holdings as holdingsTable, navHistory } from "../schema";
import { listBuckets } from "./buckets";
import { resolveCatalogSymbol } from "./funds";
import { listHoldings } from "./holdings";
import { foldableEvents } from "./resolve-derived-units";
import { listTransactionsForBuckets, type Transaction } from "./transactions";

// One range vocabulary + window math app-wide (shared with the market cache).
export type { SeriesRange } from "@/lib/market/providers/types";

import { rangeStartDate, type SeriesRange } from "@/lib/market/providers/types";

export interface SeriesPoint {
  /** ISO YYYY-MM-DD */
  date: string;
  value: number;
}

/**
 * The cash slices needed to recompute the return for either contribution mode,
 * each a step series aligned to the scope's plotted dates.
 */
export interface CashDecomp {
  /** THB value of ALL cash (held cash accounts + in-transit settlement cash) per date. */
  cashValue: SeriesPoint[];
  /**
   * THB value of HELD cash accounts only per date — excludes in-transit settlement
   * cash (a fund switch's proceeds mid-flight). This is the slice "Funds only" removes:
   * idle cash drag comes out, but a sell→buy switch's pending proceeds stay invested,
   * so a routine rebalance draws no phantom dip in the return view. (`cashValue` keeps
   * the in-transit float for the Mix composition, where it really is cash.)
   */
  heldCashValue: SeriesPoint[];
  /** THB value of RESERVED held cash per date (always excluded from the return). */
  reservedCashValue: SeriesPoint[];
  /** Cumulative contribution from ALL cash events (deposit/withdraw/Set-balance) per date. */
  cashContrib: SeriesPoint[];
  /** Cumulative contribution from RESERVED cash events per date. */
  reservedCashContrib: SeriesPoint[];
}

export interface PortfolioSeriesResult {
  aggregate: SeriesPoint[];
  perBucket: Record<string, SeriesPoint[]>;
  /**
   * Cumulative EXTERNAL money in the book (inflows minus expired/withdrawn
   * proceeds) on the same dates as `aggregate` — the chart's contribution
   * line. Derived from the settlement-cash fold, NOT from
   * `reduceLots().netInvested`: that subtracts sale PROCEEDS (the right sign
   * convention for XIRR) and so would phantom-swing on every fund switch.
   */
  netInvested: SeriesPoint[];
  netInvestedByBucket: Record<string, SeriesPoint[]>;
  /**
   * Contribution line for the TIME-WEIGHTED return: like `netInvested`, but a
   * walked-away (expired) sell lot leaves at its full proceeds, not just cost
   * basis — so a realized gain that exits the book doesn't read as a phantom loss
   * in TWR. Differs from `netInvested` ONLY at a walk-away sale; feeds `twrSeries`
   * / `periodTwr` (the contribution line + money-weighted figures stay on
   * `netInvested`). See settlement-cash `returnFlows`.
   */
  netInvestedForReturn: SeriesPoint[];
  netInvestedForReturnByBucket: Record<string, SeriesPoint[]>;
  /**
   * In-transit settlement cash included in `aggregate` per date (sell proceeds
   * not yet reinvested, within the settlement window). Lets the UI disclose
   * "incl. ฿X cash in transit" instead of baking it in silently.
   */
  cash: SeriesPoint[];
  /**
   * Cash decomposition for the contribution-mode pill (#149). Lets the client
   * compute the "Funds only" vs "Incl. cash" return WITHOUT a refetch: it
   * subtracts the right cash slice from the value + contribution lines. Reserved
   * cash is ALWAYS out of the return (both modes); the rest of the cash is out
   * only in "Funds only" (mode B). The hero BALANCE stays full net worth — this
   * only adjusts the return view. Aligned to `aggregate`'s dates.
   */
  cashDecomp: CashDecomp;
  cashDecompByBucket: Record<string, CashDecomp>;
  /** ISO timestamp of the most recent plotted date. */
  asOf: string | null;
  /**
   * The book's first transaction date (inception) — independent of the requested
   * window, so the client can tell total history length (e.g. to hide a 5Y range
   * that would just duplicate "All" on a younger book). Null when empty.
   */
  historyStart: string | null;
  /**
   * Currencies whose USD/THB (or cross) rate could not be resolved, so those
   * holdings were dropped from the totals this run. Empty = everything
   * converted cleanly. The UI surfaces this so a cold FX cache doesn't silently
   * undercount a mixed-currency book.
   */
  missingFx: string[];
  /**
   * True if any held holding is a fund whose `fund_catalog.distributionPolicy`
   * is "dividend" — i.e. it pays distributions out rather than accumulating
   * them. The balance line is price return (units × NAV) and never reinvests
   * those payouts, so when this is set the user's real total return is higher
   * than the line shown. Drives the performance-vs-index disclaimer copy.
   * Only `thai_mutual_fund` holdings can match the catalog (joined app-side on
   * the bare ticker = `fund_catalog.abbr_name`); non-Thai holdings never match
   * and correctly don't trigger it.
   */
  hasDistributingHolding: boolean;
  /**
   * Latest plotted date on which some position was valued from the ledger's own
   * trade-implied prices (or carried at cost) rather than a cached NAV — i.e.
   * history up to here is partly estimated. Null = every point is cache-priced.
   * Drives the chart's disclosure caption.
   */
  estimatedThrough: string | null;
  /**
   * Tickers that had held-but-unpriceable dates with no cost basis to carry —
   * those positions contributed nothing on those dates. Rare (a derived-units
   * row with no NAV anywhere); surfaced rather than silently dropped.
   */
  unpriced: string[];
}

const EMPTY_CASH_DECOMP: CashDecomp = {
  cashValue: [],
  heldCashValue: [],
  reservedCashValue: [],
  cashContrib: [],
  reservedCashContrib: [],
};

const EMPTY_RESULT: Omit<PortfolioSeriesResult, "hasDistributingHolding"> = {
  aggregate: [],
  perBucket: {},
  netInvested: [],
  netInvestedByBucket: {},
  netInvestedForReturn: [],
  netInvestedForReturnByBucket: {},
  cash: [],
  cashDecomp: EMPTY_CASH_DECOMP,
  cashDecompByBucket: {},
  asOf: null,
  historyStart: null,
  missingFx: [],
  estimatedThrough: null,
  unpriced: [],
};

const UNIT_EPSILON = 1e-9;

/**
 * Demo-mode replacement for the market.db `nav_history` read. Builds the same
 * `{ ticker (cache key), date, nav }` rows the DB would, but from the committed
 * fixture: fixture points are the holding's per-unit NAV in THB, same shape as
 * a market.db row. Holdings with no fixture series (unmapped) are simply
 * omitted — graceful degradation, identical to a market.db cache miss.
 */
function demoNavRows(
  allHoldings: { quoteSource: string; ticker: string }[],
  since: string,
): { ticker: string; date: string; nav: number }[] {
  const seen = new Set<string>();
  const rows: { ticker: string; date: string; nav: number }[] = [];
  for (const h of allHoldings) {
    const key = quoteCacheKey(h.quoteSource, h.ticker);
    if (seen.has(key)) continue;
    seen.add(key);
    // demoHoldingSeries supplies the in-window points plus a carry-in dated to
    // `since`, so every holding has a value on the window's first date.
    const series = demoHoldingSeries(key, since);
    if (!series) continue;
    for (const p of series) rows.push({ ticker: key, date: p.date, nav: p.value });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Owner-mode nav_history read with CARRY-IN. Returns the in-window rows
 * (`date >= since`) PLUS, for each cache key that has NO row exactly on `since`,
 * its most recent pre-window nav re-dated to `since`. That seeds the forward-fill
 * so the window's FIRST date is never partial (e.g. a window that opens on a
 * weekend/holiday still shows every holding). The carry-in date is `since`
 * itself, so it never widens the plotted timeline before the window start.
 */
function marketNavRows(
  marketDb: MarketDb,
  cacheKeys: string[],
  since: string,
): { ticker: string; date: string; nav: number }[] {
  const inWindow = marketDb
    .select({ ticker: navHistory.ticker, date: navHistory.date, nav: navHistory.nav })
    .from(navHistory)
    .where(and(inArray(navHistory.ticker, cacheKeys), gte(navHistory.date, since)))
    .orderBy(navHistory.date)
    .all();

  // Latest pre-window nav per cache key: group by ticker, take max(date) < since,
  // then the nav on that row. One grouped query, not a per-key scan. Relies on
  // SQLite's documented "bare column" rule: with max(date) in the SELECT, the
  // bare `nav` column comes from the row holding that max date.
  const carryIn = marketDb
    .select({
      ticker: navHistory.ticker,
      date: sql<string>`max(${navHistory.date})`.as("d"),
      nav: navHistory.nav,
    })
    .from(navHistory)
    .where(and(inArray(navHistory.ticker, cacheKeys), lt(navHistory.date, since)))
    .groupBy(navHistory.ticker)
    .all();

  // Only carry in keys that lack an exact `since` row, re-dating the carry to
  // `since` so it seeds the fill without adding a pre-window date.
  const hasSinceRow = new Set(inWindow.filter((r) => r.date === since).map((r) => r.ticker));
  const rows = [...inWindow];
  for (const c of carryIn) {
    if (!hasSinceRow.has(c.ticker)) rows.push({ ticker: c.ticker, date: since, nav: c.nav });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * True if any of the given holding tickers is a catalog fund with a "dividend"
 * distribution policy. The user-visible ticker is the fund's `abbr_name` in
 * `fund_catalog` (same bare-ticker mapping the fund-detail route uses), so we
 * match held tickers against `abbr_name` and ask whether any matched row pays
 * dividends out. One indexed query over the held tickers; works in demo mode
 * too since the catalog lives in the shared market.db. Empty input → false.
 */
function holdsDistributingFund(marketDb: MarketDb, tickers: string[]): boolean {
  if (tickers.length === 0) return false;
  // Case-fold (#235): held tickers are stored in catalog case but the catalog has
  // lowercase-coded funds (the ttb family), so compare upper() on both sides.
  const keys = tickers.map((t) => tickerKey(t));
  const row = marketDb
    .select({ n: sql<number>`count(*)` })
    .from(fundCatalog)
    .where(
      and(
        inArray(sql`upper(${fundCatalog.abbrName})`, keys),
        eq(fundCatalog.distributionPolicy, "dividend"),
      ),
    )
    .get();
  return (row?.n ?? 0) > 0;
}

/**
 * Real prices the user transacted at, recovered from the ledger itself: a
 * trade's execution price (else |amount| ÷ units), and a Balance's
 * value ÷ units. These honestly price the era BEFORE a fund's cached NAV
 * coverage begins — and funds that never get coverage (e.g. liquidated ones).
 * An anchor's `pricePerUnit` is an avg COST, not a market price — never used.
 * THB-priced keys only: the ledger's money fields are THB, so an implied point
 * for a foreign-currency key would corrupt the per-date FX conversion.
 */
function tradeImpliedRows(
  events: readonly Transaction[],
  currencyByKey: ReadonlyMap<string, string>,
): { ticker: string; date: string; nav: number }[] {
  const rows: { ticker: string; date: string; nav: number }[] = [];
  for (const r of events) {
    if (r.units == null || r.units <= 0) continue;
    const key = quoteCacheKey(r.quoteSource, r.ticker);
    if (currencyByKey.get(key) !== BASE_CURRENCY) continue;
    let price: number | null = null;
    if (r.kind === "buy" || r.kind === "sell" || r.kind === "reinvest") {
      price =
        r.pricePerUnit && r.pricePerUnit > 0
          ? r.pricePerUnit
          : Math.abs(r.amount) > 0
            ? Math.abs(r.amount) / r.units
            : null;
    } else if (isAnchorKind(r.kind) && r.value != null && r.value > 0) {
      price = r.value / r.units;
    }
    if (price !== null && Number.isFinite(price)) {
      rows.push({ ticker: key, date: r.tradeDate, nav: price });
    }
  }
  return rows;
}

/**
 * Pointer walker over a date-ascending point list: `at(d)` returns the last
 * point with date ≤ d. Queries MUST come in ascending date order (they do —
 * the axis is sorted); that makes the whole replay O(events + dates).
 */
function stepWalker<T extends { date: string }>(points: readonly T[]): (d: string) => T | null {
  let i = 0;
  let last: T | null = null;
  return (d: string) => {
    while (i < points.length && points[i].date <= d) {
      last = points[i];
      i++;
    }
    return last;
  };
}

/**
 * Compose per-bucket and aggregate value series by REPLAYING THE LEDGER, plus a
 * contribution (net-invested) line, with every value FX-converted into the base
 * currency (THB) before it is summed.
 *
 * Per bucket, the lot fold (`reduceLots`) yields every position's units and
 * remaining cost basis after each event; the settlement-cash fold yields the
 * bucket's in-transit cash and external flows. On each chart date:
 *
 *   value = Σ units(position, date) × NAV(date) × fx(date) + cash(date)
 *
 * A position contributes 0 before its first ledger event — a Balance entered
 * today is a point today, never a back-projected multi-year curve (an anchor
 * asserts nothing about the past, ADR 0004). Exited positions keep
 * contributing over the dates they were held. NAV gaps are forward-filled per
 * holding so Thai funds (skip weekends) and US ETFs (skip TH holidays) share a
 * timeline; dates a fund was held before its cached NAV coverage are priced
 * from the ledger's own trade-implied prices (`tradeImpliedRows`), falling
 * back to carrying the position at cost — both reported via
 * `estimatedThrough`. Each holding's native currency is inferred from its
 * routing key (lib/market/currency.ts) and converted at that date's USD/THB
 * (or cross) rate before summing — without this, a USD ETF and a THB fund were
 * added as if both were baht. FX rates come from the existing keyless
 * Frankfurter chain. Aggregate series is the per-bucket sum on each date.
 * Async because FX rates are fetched (cached) from the market layer.
 */
export async function getPortfolioSeries(
  range: SeriesRange = "6mo",
  opts: { reservedTickers?: ReadonlySet<string> } = {},
): Promise<PortfolioSeriesResult> {
  // Reserved cash account tickers (#149) — always carved out of the RETURN view
  // (both contribution modes), never out of net worth. Upper-cased to match the
  // ledger ticker. Empty = nothing reserved = today's behavior.
  const reservedTickers = opts.reservedTickers;
  // Cross-domain read: the ledger lives in app.db, NAV series in market.db.
  // There is no SQL join — we read each side and join app-side on the soft
  // `${quoteSource}:${ticker}` cache key.
  const marketDb = getMarketDb();
  const since = rangeStartDate(range);
  const today = new Date().toISOString().slice(0, 10);

  const buckets = listBuckets();
  const ledger = listTransactionsForBuckets(buckets.map((b) => b.id));
  // Holdings are NOT the basket (exited positions must chart) — they supply the
  // distributing-fund flag and the demo fixture mapping only.
  const allHoldings = listHoldings();

  const heldTickers = Array.from(new Set(allHoldings.map((h) => h.ticker)));
  const hasDistributingHolding = holdsDistributingFund(marketDb, heldTickers);
  if (ledger.length === 0) return { ...EMPTY_RESULT, hasDistributingHolding };

  // Facts-only rows → fold-ready events (derive value-only Balance units at
  // tradeDate NAV; drop anchors that stay unresolved) — the same pre-pass the
  // holdings projection and analytics run, so the chart can't disagree with them.
  const events = foldableEvents(ledger);
  const byBucket = new Map<string, Transaction[]>();
  for (const r of events) {
    let arr = byBucket.get(r.bucketId);
    if (!arr) {
      arr = [];
      byBucket.set(r.bucketId, arr);
    }
    arr.push(r);
  }

  // Map a held (possibly renamed) ledger ticker to the fund's CURRENT code (#235),
  // so NAV resolves under the symbol the cache + prewarm actually use. Built from
  // the raw holdings anchors — the enriched list already shows the current code,
  // losing the stored old one we need to bridge the ledger. Only renamed funds get
  // an entry; everything else keeps its ledger ticker unchanged.
  const navTickerByBucketTicker = new Map<string, string>();
  for (const r of getDb()
    .select({
      bucketId: holdingsTable.bucketId,
      ticker: holdingsTable.ticker,
      catalogProjId: holdingsTable.catalogProjId,
      catalogClassName: holdingsTable.catalogClassName,
      catalogIsin: holdingsTable.catalogIsin,
    })
    .from(holdingsTable)
    .where(
      inArray(
        holdingsTable.bucketId,
        buckets.map((b) => b.id),
      ),
    )
    .all()) {
    const cur = resolveCatalogSymbol(r)?.currentTicker;
    if (cur && tickerKey(cur) !== tickerKey(r.ticker))
      navTickerByBucketTicker.set(`${r.bucketId} ${tickerKey(r.ticker)}`, cur);
  }

  // One cache key + currency per (bucket, ledger ticker) — the last row's
  // quote_source wins, matching how the holdings projection routes a ticker.
  const keyByBucketTicker = new Map<string, string>();
  const keyMeta = new Map<string, { quoteSource: string; ticker: string }>();
  for (const r of events) {
    const navTicker =
      navTickerByBucketTicker.get(`${r.bucketId} ${tickerKey(r.ticker)}`) ?? r.ticker;
    const key = quoteCacheKey(r.quoteSource, navTicker);
    keyByBucketTicker.set(`${r.bucketId} ${tickerKey(r.ticker)}`, key);
    keyMeta.set(key, { quoteSource: r.quoteSource, ticker: navTicker });
  }
  const cacheKeys = Array.from(keyMeta.keys());
  // Cash carries its currency on the holding row (the ticker is the account name,
  // not a symbol) — index it by cache key so inferHoldingCurrency can read it.
  const cashCurrencyByKey = new Map<string, string | null>();
  for (const h of allHoldings) {
    if (h.quoteSource === "cash") {
      cashCurrencyByKey.set(quoteCacheKey(h.quoteSource, h.ticker), h.currency ?? null);
    }
  }
  const currencyByKey = new Map<string, string>();
  const currencies = new Set<string>();
  for (const [key, m] of keyMeta) {
    const ccy = inferHoldingCurrency(m.quoteSource, m.ticker, cashCurrencyByKey.get(key));
    currencyByKey.set(key, ccy);
    currencies.add(ccy);
  }

  // DEMO MODE: source NAV history from the committed fixture instead of
  // market.db. Both sources seed a carry-in on `since` so the window's first
  // date is never partial. See lib/mock/demo-history.ts.
  const navRows = isDemoRequest()
    ? demoNavRows(allHoldings, since)
    : marketNavRows(marketDb, cacheKeys, since);

  // Merge cached NAVs with trade-implied prices per key. Cached rows win on a
  // date collision (the provider's close beats a fee-skewed implied point).
  // Implied rows keep their PRE-WINDOW dates: they never join the axis, but
  // they seed the forward-fill so a window opening mid-gap is still priced.
  const rowsByKey = new Map<string, Map<string, number>>();
  const firstCachedByKey = new Map<string, string>();
  for (const r of tradeImpliedRows(events, currencyByKey)) {
    let m = rowsByKey.get(r.ticker);
    if (!m) {
      m = new Map();
      rowsByKey.set(r.ticker, m);
    }
    m.set(r.date, r.nav);
  }
  for (const r of navRows) {
    let m = rowsByKey.get(r.ticker);
    if (!m) {
      m = new Map();
      rowsByKey.set(r.ticker, m);
    }
    m.set(r.date, r.nav);
    const first = firstCachedByKey.get(r.ticker);
    if (first === undefined || r.date < first) firstCachedByKey.set(r.ticker, r.date);
  }

  // The shared timeline: every in-window date any key has data for, plus every
  // in-window ledger event date (cash and contribution step on event dates,
  // which need not be NAV dates).
  const dateSet = new Set<string>();
  for (const r of navRows) dateSet.add(r.date);
  for (const r of events) {
    if (r.tradeDate >= since && r.tradeDate <= today) dateSet.add(r.tradeDate);
  }
  const dates = Array.from(dateSet).sort();
  if (dates.length === 0) return { ...EMPTY_RESULT, hasDistributingHolding };

  // Native-currency → THB converter for the shared dates. THB-only books need
  // no rates; the converter degrades gracefully if a rate is cold (rateOn →
  // null) and reports which currencies failed via `missing`.
  const fx = await buildFxConverter(currencies, range, dates);

  // Forward-fill each key over the shared dates (pre-window implied rows fold
  // into the seed value before the first axis date).
  const filled = new Map<string, Map<string, number>>();
  for (const [key, byDate] of rowsByKey) {
    const rows = Array.from(byDate.entries())
      .map(([date, nav]) => ({ date, nav }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const out = new Map<string, number>();
    let i = 0;
    let last: number | null = null;
    for (const d of dates) {
      while (i < rows.length && rows[i].date <= d) {
        last = rows[i].nav;
        i++;
      }
      if (last !== null) out.set(d, last);
    }
    filled.set(key, out);
  }
  // A date is estimate-priced for a key until its first CACHED nav lands.
  const isEstimated = (key: string, d: string): boolean => {
    const first = firstCachedByKey.get(key);
    return first === undefined || d < first;
  };

  const perBucket: Record<string, SeriesPoint[]> = {};
  const netInvestedByBucket: Record<string, SeriesPoint[]> = {};
  const netInvestedForReturnByBucket: Record<string, SeriesPoint[]> = {};
  const cashDecompByBucket: Record<string, CashDecomp> = {};
  const aggregateByDate = new Map<string, number>();
  const investedByDate = new Map<string, number>();
  const investedForReturnByDate = new Map<string, number>();
  const cashByDate = new Map<string, number>();
  // Cash decomposition for the return-mode pill (#149), summed across buckets.
  const cashValueByDate = new Map<string, number>();
  const heldCashValueByDate = new Map<string, number>();
  const reservedCashValueByDate = new Map<string, number>();
  const cashContribByDate = new Map<string, number>();
  const reservedCashContribByDate = new Map<string, number>();
  // THB value priced from trade-implied prices / cost-carry (not cached NAV) per
  // date — drives a MATERIALITY-gated `estimatedThrough` so one dust position
  // with shallow NAV coverage can't imply the whole history is estimated.
  const estimatedByDate = new Map<string, number>();
  const emittedDates = new Set<string>();
  const unpriced = new Set<string>();

  for (const [bucketId, bucketEvents] of byBucket) {
    const ledgerTxns: LedgerTxn[] = bucketEvents.map(toLedgerTxn);
    const { positionTimeline, realized } = reduceLots(ledgerTxns);
    // Per-sell cost basis so a withdrawal removes capital, not realized gain —
    // otherwise cashing out at a profit drives the contribution line negative.
    const costBySellId = new Map<number, number>();
    for (const ev of realized) if (ev.id != null) costBySellId.set(ev.id, ev.costRemoved);
    const { cashTimeline, externalFlows, returnFlows } = foldSettlementCash(
      ledgerTxns,
      today,
      undefined,
      costBySellId,
    );

    const tickerWalkers: [string, (d: string) => PositionCheckpoint | null][] = [];
    for (const [ticker, checkpoints] of positionTimeline) {
      tickerWalkers.push([ticker, stepWalker(checkpoints)]);
    }
    const cashAt = stepWalker<CashPoint>(cashTimeline);
    let running = 0;
    const contributions = externalFlows.map((f) => {
      running += f.amount;
      return { date: f.date, value: running };
    });
    const contribAt = stepWalker(contributions);
    // Same cumulative on the TWR flows (full proceeds at a walk-away sale) — feeds
    // the time-weighted return only; the contribution line above stays cost-basis.
    let runningForReturn = 0;
    const returnContributions = returnFlows.map((f) => {
      runningForReturn += f.amount;
      return { date: f.date, value: runningForReturn };
    });
    const returnContribAt = stepWalker(returnContributions);

    // Cumulative CASH-only contributions (deposit/withdraw/Set-balance) — the
    // slice the pill removes in "Funds only", and reserved-only for "Incl. cash".
    // Same SHARED definition as the fold/XIRR so the three can't diverge.
    const cumulative = (flows: { date: string; amount: number }[]) => {
      let acc = 0;
      return stepWalker(
        flows.map((f) => {
          acc += f.amount;
          return { date: f.date, value: acc };
        }),
      );
    };
    const cashContribAt = cumulative(cashContributionFlows(ledgerTxns));
    const reservedCashContribAt = reservedTickers
      ? cumulative(
          cashContributionFlows(ledgerTxns.filter((t) => reservedTickers.has(tickerKey(t.ticker)))),
        )
      : null;

    // The bucket exists on the chart from its first ledger event — never before.
    const firstEvent = bucketEvents.reduce(
      (min, r) => (r.tradeDate < min ? r.tradeDate : min),
      bucketEvents[0].tradeDate,
    );

    const series: SeriesPoint[] = [];
    const invested: SeriesPoint[] = [];
    const investedForReturn: SeriesPoint[] = [];
    const bCashValue: SeriesPoint[] = [];
    const bHeldCashValue: SeriesPoint[] = [];
    const bReservedCashValue: SeriesPoint[] = [];
    const bCashContrib: SeriesPoint[] = [];
    const bReservedCashContrib: SeriesPoint[] = [];
    for (const d of dates) {
      if (d < firstEvent) continue;
      const cash = cashAt(d)?.cash ?? 0;
      let value = cash;
      // Held cash-account value on this date (in-transit cash is added separately
      // below); reserved tracked apart so the pill can carve either slice.
      let heldCashThb = 0;
      let reservedCashThb = 0;
      for (const [ticker, at] of tickerWalkers) {
        const cp = at(d);
        if (!cp || cp.units <= UNIT_EPSILON) continue;
        const key = keyByBucketTicker.get(`${bucketId} ${tickerKey(ticker)}`);
        // Cash: priced EXACTLY at 1.0 in its currency (no NAV), converted to THB.
        // A null rate (cold FX) drops it, reported via missingFx; never estimated.
        if (key !== undefined && keyMeta.get(key)?.quoteSource === "cash") {
          const rate = fx.rateOn(currencyByKey.get(key) ?? BASE_CURRENCY, d);
          if (rate === null) continue;
          const thb = cp.units * rate;
          value += thb;
          heldCashThb += thb;
          if (reservedTickers?.has(tickerKey(ticker))) reservedCashThb += thb;
          continue;
        }
        const nav = key === undefined ? undefined : filled.get(key)?.get(d);
        if (nav !== undefined && key !== undefined) {
          // Convert native value → THB at this date's rate. A null rate (cold
          // FX cache) drops the holding from the total rather than summing raw
          // foreign NAV as if it were baht — reported via missingFx below.
          const rate = fx.rateOn(currencyByKey.get(key) ?? "USD", d);
          if (rate === null) continue;
          const thb = cp.units * nav * rate;
          value += thb;
          if (isEstimated(key, d)) estimatedByDate.set(d, (estimatedByDate.get(d) ?? 0) + thb);
        } else if (cp.costBasis !== null && cp.costBasis > 0) {
          // Held but unpriceable on this date: carry at remaining cost (THB) —
          // contribution-without-growth beats vanishing from the chart.
          value += cp.costBasis;
          estimatedByDate.set(d, (estimatedByDate.get(d) ?? 0) + cp.costBasis);
        } else {
          unpriced.add(ticker);
        }
      }
      series.push({ date: d, value });
      const contributed = contribAt(d)?.value ?? 0;
      invested.push({ date: d, value: contributed });
      const contributedForReturn = returnContribAt(d)?.value ?? 0;
      investedForReturn.push({ date: d, value: contributedForReturn });
      // Total cash value = held cash accounts + in-transit settlement cash
      // (in-transit cash is heuristic sell proceeds, never reserved). `heldCashThb`
      // alone is the "Funds only" exclusion slice — see CashDecomp.heldCashValue.
      const totalCashThb = heldCashThb + cash;
      const cashContributed = cashContribAt(d)?.value ?? 0;
      const reservedContributed = reservedCashContribAt?.(d)?.value ?? 0;
      bCashValue.push({ date: d, value: totalCashThb });
      bHeldCashValue.push({ date: d, value: heldCashThb });
      bReservedCashValue.push({ date: d, value: reservedCashThb });
      bCashContrib.push({ date: d, value: cashContributed });
      bReservedCashContrib.push({ date: d, value: reservedContributed });
      aggregateByDate.set(d, (aggregateByDate.get(d) ?? 0) + value);
      investedByDate.set(d, (investedByDate.get(d) ?? 0) + contributed);
      investedForReturnByDate.set(d, (investedForReturnByDate.get(d) ?? 0) + contributedForReturn);
      cashByDate.set(d, (cashByDate.get(d) ?? 0) + cash);
      cashValueByDate.set(d, (cashValueByDate.get(d) ?? 0) + totalCashThb);
      heldCashValueByDate.set(d, (heldCashValueByDate.get(d) ?? 0) + heldCashThb);
      reservedCashValueByDate.set(d, (reservedCashValueByDate.get(d) ?? 0) + reservedCashThb);
      cashContribByDate.set(d, (cashContribByDate.get(d) ?? 0) + cashContributed);
      reservedCashContribByDate.set(
        d,
        (reservedCashContribByDate.get(d) ?? 0) + reservedContributed,
      );
      emittedDates.add(d);
    }
    perBucket[bucketId] = series;
    netInvestedByBucket[bucketId] = invested;
    netInvestedForReturnByBucket[bucketId] = investedForReturn;
    cashDecompByBucket[bucketId] = {
      cashValue: bCashValue,
      heldCashValue: bHeldCashValue,
      reservedCashValue: bReservedCashValue,
      cashContrib: bCashContrib,
      reservedCashContrib: bReservedCashContrib,
    };
  }

  const plotted = dates.filter((d) => emittedDates.has(d));

  // Latest date where estimate-priced positions are a MATERIAL share (>2%) of
  // the day's value. Gating by share (not "any position") stops a tiny
  // late-covered holding from captioning the whole chart as estimated, while
  // still flagging the genuine pre-NAV-coverage era when major holdings were
  // trade-priced. `plotted` is date-ascending, so the last match wins.
  const ESTIMATE_MATERIALITY = 0.02;
  let estimatedThrough: string | null = null;
  for (const d of plotted) {
    const total = aggregateByDate.get(d) ?? 0;
    if (total > 0 && (estimatedByDate.get(d) ?? 0) / total > ESTIMATE_MATERIALITY) {
      estimatedThrough = d;
    }
  }

  const aggregate: SeriesPoint[] = plotted.map((d) => ({
    date: d,
    value: aggregateByDate.get(d) ?? 0,
  }));
  const netInvested: SeriesPoint[] = plotted.map((d) => ({
    date: d,
    value: investedByDate.get(d) ?? 0,
  }));
  const netInvestedForReturn: SeriesPoint[] = plotted.map((d) => ({
    date: d,
    value: investedForReturnByDate.get(d) ?? 0,
  }));
  const cash: SeriesPoint[] = plotted.map((d) => ({ date: d, value: cashByDate.get(d) ?? 0 }));
  const cashDecomp: CashDecomp = {
    cashValue: plotted.map((d) => ({ date: d, value: cashValueByDate.get(d) ?? 0 })),
    heldCashValue: plotted.map((d) => ({ date: d, value: heldCashValueByDate.get(d) ?? 0 })),
    reservedCashValue: plotted.map((d) => ({
      date: d,
      value: reservedCashValueByDate.get(d) ?? 0,
    })),
    cashContrib: plotted.map((d) => ({ date: d, value: cashContribByDate.get(d) ?? 0 })),
    reservedCashContrib: plotted.map((d) => ({
      date: d,
      value: reservedCashContribByDate.get(d) ?? 0,
    })),
  };

  return {
    aggregate,
    perBucket,
    netInvested,
    netInvestedByBucket,
    netInvestedForReturn,
    netInvestedForReturnByBucket,
    cash,
    cashDecomp,
    cashDecompByBucket,
    asOf: plotted[plotted.length - 1] ?? null,
    // Inception = earliest ledger trade (the list is ordered oldest-first), so
    // it's the true history start regardless of the requested window.
    historyStart: ledger[0]?.tradeDate ?? null,
    missingFx: Array.from(fx.missing).sort(),
    hasDistributingHolding,
    estimatedThrough,
    unpriced: Array.from(unpriced).sort(),
  };
}

export interface HoldingValueSeriesResult {
  /** Market value of the position per date (units × NAV × fx), THB. */
  value: SeriesPoint[];
  /** Remaining cost basis per date (what you've put in, net of sells), THB. */
  costBasis: SeriesPoint[];
  /** Most recent plotted date, or null when the holding never charts. */
  asOf: string | null;
  /**
   * Latest plotted date valued from trade-implied prices / cost-carry rather
   * than a cached NAV — history up to here is partly estimated. Null = every
   * point is cache-priced. Drives the chart's disclosure caption.
   */
  estimatedThrough: string | null;
  /** Currency that couldn't be FX-converted (value degraded on those dates). */
  missingFx: string[];
}

const EMPTY_HOLDING_SERIES: HoldingValueSeriesResult = {
  value: [],
  costBasis: [],
  asOf: null,
  estimatedThrough: null,
  missingFx: [],
};

/**
 * Value-over-time for a SINGLE holding — the per-position slice of the same
 * ledger replay `getPortfolioSeries` runs (ADR 0005), before it's summed into a
 * bucket. The instrument is folded across every bucket it appears in (matching
 * the ticker-scoped analytics endpoint), so the position screen shows the whole
 * holding, not a per-bucket slice.
 *
 * On each chart date: `value = units(date) × NAV(date) × fx(date)` — 0 before
 * the first event, exited positions still charted over the dates held, history
 * before the fund's cached NAV coverage priced from the ledger's own
 * trade-implied prices (carried at cost as a last resort), and the native
 * currency converted to THB. The cost-basis line is the lot fold's remaining
 * basis over the same axis, so the gap to the value line reads as unrealized
 * gain. Reuses the same NAV/FX/forward-fill helpers as `getPortfolioSeries`.
 */
export async function getHoldingValueSeries(
  ticker: string,
  range: SeriesRange = "6mo",
): Promise<HoldingValueSeriesResult> {
  const marketDb = getMarketDb();
  const since = rangeStartDate(range);
  const today = new Date().toISOString().slice(0, 10);

  const buckets = listBuckets();
  const ledger = listTransactionsForBuckets(buckets.map((b) => b.id));
  if (ledger.length === 0) return EMPTY_HOLDING_SERIES;

  // Bridge a fund CODE rename (#235): the param is the symbol the UI shows (the
  // CURRENT catalog code), but the immutable ledger keeps the original code. Find
  // the held row for this instrument to recover its stored (ledger) code, and the
  // current code for the NAV cache key (where the re-pointed history lives). For a
  // never-renamed fund / custom asset these are equal, so behavior is unchanged.
  const want = tickerKey(ticker);
  const held = getDb()
    .select({
      ticker: holdingsTable.ticker,
      catalogProjId: holdingsTable.catalogProjId,
      catalogClassName: holdingsTable.catalogClassName,
      catalogIsin: holdingsTable.catalogIsin,
    })
    .from(holdingsTable)
    .where(
      inArray(
        holdingsTable.bucketId,
        buckets.map((b) => b.id),
      ),
    )
    .all();
  const hit =
    held.find((h) => tickerKey(h.ticker) === want) ??
    held.find((h) => tickerKey(resolveCatalogSymbol(h)?.currentTicker ?? "") === want);
  const ledgerTicker = hit?.ticker ?? ticker;
  const navTicker = hit ? (resolveCatalogSymbol(hit)?.currentTicker ?? hit.ticker) : ticker;

  // One instrument across every bucket it appears in. `foldableEvents` is the
  // same pre-pass holdings/analytics run, so the chart can't disagree with them.
  const events = foldableEvents(ledger).filter(
    (r) => tickerKey(r.ticker) === tickerKey(ledgerTicker),
  );
  if (events.length === 0) return EMPTY_HOLDING_SERIES;

  const ledgerTxns: LedgerTxn[] = events.map(toLedgerTxn);
  const { positionTimeline, basisTimeline } = reduceLots(ledgerTxns);
  // One instrument → one position; fall back to the sole entry if the folded
  // display case differs from the stored code.
  const checkpoints = positionTimeline.get(ledgerTicker) ?? [...positionTimeline.values()][0] ?? [];

  // Routing key + currency (last event's quote_source wins, mirroring the
  // holdings projection and getPortfolioSeries).
  let quoteSource = events[0].quoteSource;
  for (const r of events) quoteSource = r.quoteSource;
  const key = quoteCacheKey(quoteSource, ledgerTicker);
  // NAV is cached under the CURRENT code (re-pointed on a rename); fetch by it.
  const navKey = quoteCacheKey(quoteSource, navTicker);
  // Cash carries its currency on the ledger (tradeCurrency); the ticker is the
  // account name, so it can't be inferred from the symbol.
  const isCash = quoteSource === "cash";
  const cashCcy = isCash ? (events.find((r) => r.tradeCurrency)?.tradeCurrency ?? null) : null;
  const currency = inferHoldingCurrency(quoteSource, ledgerTicker, cashCcy);
  const currencyByKey = new Map([[key, currency]]);

  // NAV rows under the current code (demo fixture or market.db), merged with the
  // ledger's trade-implied prices (keyed by the stored code). Cached rows win on
  // a date collision.
  const navRows = (
    isDemoRequest()
      ? demoNavRows([{ quoteSource, ticker: navTicker }], since)
      : marketNavRows(marketDb, [navKey], since)
  ).filter((r) => r.ticker === navKey);

  const byDate = new Map<string, number>();
  let firstCached: string | undefined;
  for (const r of tradeImpliedRows(events, currencyByKey)) {
    if (r.ticker === key) byDate.set(r.date, r.nav);
  }
  for (const r of navRows) {
    byDate.set(r.date, r.nav);
    if (firstCached === undefined || r.date < firstCached) firstCached = r.date;
  }

  // Shared axis: every in-window NAV date + every in-window ledger event date
  // (cost-basis steps land on event dates, which need not be NAV dates).
  const dateSet = new Set<string>();
  for (const r of navRows) dateSet.add(r.date);
  for (const r of events) {
    if (r.tradeDate >= since && r.tradeDate <= today) dateSet.add(r.tradeDate);
  }
  const dates = Array.from(dateSet).sort();
  if (dates.length === 0) return EMPTY_HOLDING_SERIES;

  const fx = await buildFxConverter(new Set([currency]), range, dates);

  // Forward-fill NAV over the shared dates (pre-window implied rows fold into
  // the seed before the first axis date).
  const sortedNav = Array.from(byDate.entries())
    .map(([date, nav]) => ({ date, nav }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const filled = new Map<string, number>();
  {
    let i = 0;
    let last: number | null = null;
    for (const d of dates) {
      while (i < sortedNav.length && sortedNav[i].date <= d) {
        last = sortedNav[i].nav;
        i++;
      }
      if (last !== null) filled.set(d, last);
    }
  }
  const isEstimated = (d: string): boolean => firstCached === undefined || d < firstCached;

  const firstEvent = events.reduce(
    (min, r) => (r.tradeDate < min ? r.tradeDate : min),
    events[0].tradeDate,
  );

  const unitsAt = stepWalker(checkpoints);
  const basisAt = stepWalker(basisTimeline);
  const value: SeriesPoint[] = [];
  const costBasis: SeriesPoint[] = [];
  let estimatedThrough: string | null = null;

  for (const d of dates) {
    if (d < firstEvent) continue;
    const cp = unitsAt(d);
    let v = 0;
    let estimated = false;
    if (cp && cp.units > UNIT_EPSILON && isCash) {
      // Cash: priced EXACTLY at 1.0 in its currency, converted to THB. Not estimated.
      const rate = fx.rateOn(currency, d);
      if (rate !== null) v = cp.units * rate;
    } else if (cp && cp.units > UNIT_EPSILON) {
      const nav = filled.get(d);
      if (nav !== undefined) {
        const rate = fx.rateOn(currency, d);
        if (rate !== null) {
          v = cp.units * nav * rate;
          estimated = isEstimated(d);
        }
      } else if (cp.costBasis !== null && cp.costBasis > 0) {
        // Held but unpriceable on this date: carry at remaining cost.
        v = cp.costBasis;
        estimated = true;
      }
    }
    if (estimated && v > 0) estimatedThrough = d;
    value.push({ date: d, value: v });
    costBasis.push({ date: d, value: basisAt(d)?.costBasis ?? 0 });
  }

  return {
    value,
    costBasis,
    asOf: value[value.length - 1]?.date ?? null,
    estimatedThrough,
    missingFx: Array.from(fx.missing).sort(),
  };
}
