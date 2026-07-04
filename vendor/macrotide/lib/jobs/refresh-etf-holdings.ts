// US ETF holdings refresh — fetch each ETF's latest SEC N-PORT filing and store
// its constituents (top-N by weight) for the detail page + derived exposure.
//
// Bounded nightly (popularity/views first) for the hot set; the detail API also
// calls `ensureEtfHoldings` to JIT-fill a cold ETF on first open (warm-on-open).
// Public-domain SEC data, no key.

import "server-only";
import { deriveEtfTracking } from "../db/queries/etf-tracking";
import { stampResolvedSymbols } from "../db/queries/security-id-map";
import {
  getEtfHoldings,
  listEtfsToRefreshHoldings,
  setEtfHoldings,
} from "../db/queries/us-etf-holdings";
import { setUsEtfDerived, setUsSecurityTer } from "../db/queries/us-securities";
import { classifyEtf } from "../market/etf-classify";
import { fetchEtfExpenseRatio } from "../market/etf-expense";
import { type EtfHoldingsResult, fetchEtfHoldings } from "../market/providers/edgar-nport";
import { mapPool } from "./map-pool";

export interface RefreshEtfHoldingsResult {
  selected: number;
  withHoldings: number;
  /** ETFs given an expense ratio (TER) this run. */
  withTer: number;
  /** Resolved ETFs whose holdings fetch failed transiently — left stale to retry. */
  errored: number;
  /** ETFs that resolved to a tracked index after this run's derivation pass. */
  tracked: number;
  /** ETFs given a derived asset class and/or exposure region this run. */
  classified: number;
}

export interface RefreshEtfHoldingsOptions {
  /** Max ETFs this run (default 50). */
  limit?: number;
  /** Explicit symbols (overrides the ranked selection). */
  symbols?: string[];
  /** Only refresh ETFs whose holdings are older than this ISO time. */
  staleBefore?: string;
  /** Top-N holdings to keep per ETF (default 50). */
  topN?: number;
  /** N-PORT fetch is heavier (search + XML); keep the pool small (default 3). */
  concurrency?: number;
  /** Run marker; defaults to now. */
  fetchedAt?: string;
  /** Test seam; defaults to the live N-PORT fetch. */
  getHoldings?: (symbol: string, opts: { topN?: number }) => Promise<EtfHoldingsResult>;
  /** Test seam for the expense ratio; defaults to the live 485BPOS parse. */
  getTer?: (symbol: string) => Promise<number | null>;
}

export async function refreshEtfHoldings(
  opts: RefreshEtfHoldingsOptions = {},
): Promise<RefreshEtfHoldingsResult> {
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const limit = opts.limit ?? 50;
  const topN = opts.topN ?? 50;
  const symbols =
    opts.symbols ?? listEtfsToRefreshHoldings(limit, { staleBefore: opts.staleBefore });
  if (symbols.length === 0)
    return { selected: 0, withHoldings: 0, withTer: 0, errored: 0, tracked: 0, classified: 0 };

  const getHoldings = opts.getHoldings ?? fetchEtfHoldings;
  const getTer = opts.getTer ?? ((s: string) => fetchEtfExpenseRatio(s));
  let withHoldings = 0;
  let withTer = 0;
  let errored = 0;
  let classified = 0;
  await mapPool(symbols, opts.concurrency ?? 3, async (symbol) => {
    const res = await getHoldings(symbol, { topN });
    if (res.status === "error") {
      // Transient holdings failure — DON'T cache/stamp, so the next run or a JIT
      // open retries instead of showing "no holdings" for weeks.
      errored++;
      return;
    }
    // "ok" or "unresolved" (genuine empty, e.g. SPY/UIT) → cache + stamp freshness.
    setEtfHoldings(symbol, res.holdings, res.asOfDate, fetchedAt, res.totalCount);
    if (res.holdings.length > 0) {
      withHoldings++;
      // Derive the ETF's asset class + exposure region from the look-through we just
      // stored (#268) — pure, no network; only non-null attributes are written, so a
      // fund we can't classify keeps any prior value. Coverage widens with holdings.
      const derived = classifyEtf(
        res.holdings.map((h) => ({
          assetCat: h.assetClass,
          country: h.country,
          weightPct: h.weightPct,
        })),
      );
      if (setUsEtfDerived(symbol, derived) > 0) classified++;
    }

    // TER is independent + best-effort (485BPOS parse is fragile): only write a
    // value when found, never overwrite a good TER with null, never block holdings.
    const ter = await getTer(symbol);
    if (ter != null) {
      setUsSecurityTer(symbol, ter);
      withTer++;
    }
  });
  // Replacing an ETF's rows wiped their resolved_symbol; re-stamp from the crosswalk
  // cache (cheap, no network). New constituents are resolved by resolveEtfTickers.
  stampResolvedSymbols();
  // Recompute which index each ETF tracks from the freshly-stamped holdings
  // (whole hot set — pure set math, no network). Keeps the "own the index"
  // cross-link comprehensive as holdings and membership shift.
  const { tracked } = deriveEtfTracking();
  return { selected: symbols.length, withHoldings, withTer, errored, tracked, classified };
}

/**
 * Just-in-time fill for a single ETF on detail open: fetch now if its holdings are
 * missing or older than `maxAgeDays` (default 30), else no-op. Fire-and-forget
 * from the request path — failures are swallowed by the underlying fetch.
 */
export async function ensureEtfHoldings(
  symbol: string,
  opts: {
    maxAgeDays?: number;
    fetchedAt?: string;
    getHoldings?: RefreshEtfHoldingsOptions["getHoldings"];
    getTer?: RefreshEtfHoldingsOptions["getTer"];
  } = {},
): Promise<void> {
  const cur = getEtfHoldings(symbol);
  const maxAgeMs = (opts.maxAgeDays ?? 30) * 86_400_000;
  const fetchedAtMs = cur.fetchedAt ? Date.parse(cur.fetchedAt) : Number.NaN;
  const fresh = Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < maxAgeMs;
  if (cur.holdings.length > 0 && fresh) return;
  await refreshEtfHoldings({
    symbols: [symbol],
    fetchedAt: opts.fetchedAt,
    getHoldings: opts.getHoldings,
    getTer: opts.getTer,
  });
}
