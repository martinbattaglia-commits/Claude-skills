import "server-only";
import {
  listActiveShareClassTickers,
  listHeldShareClassTickers,
  type ShareClassTicker,
} from "@/lib/db/queries/share-classes";
import { getCachedSeries } from "@/lib/market/cache";
import { primeFundResolution, SEC_THAILAND_SOURCE } from "@/lib/market/providers/sec-thailand";
import type { SeriesRange } from "@/lib/market/providers/types";

export interface PrewarmNavOptions {
  /** Cap the number of tickers (spike/dev). 0 / undefined = all. */
  limit?: number;
  /** In-flight fetches. The SEC rate gate caps real throughput regardless; this
   * just keeps the pipeline full. Default 6. */
  concurrency?: number;
  /** History depth to fetch. "max" for the backfill, "1mo" for the daily append
   * (the depth-aware cache keeps prior "max" depth — see cache.ts). Default "max". */
  range?: SeriesRange;
  /** Warm only retail-buyable classes first (cuts volume on multi-class funds). */
  retailOnly?: boolean;
  onProgress?: (info: {
    index: number;
    total: number;
    ticker: string;
    ok: boolean;
    error?: string;
  }) => void;
  /** Test seam — enumerate the active-universe work-list. */
  _listTickers?: (opts: { retailOnly?: boolean }) => ShareClassTicker[];
  /** Test seam — enumerate every user's held funds (any lifecycle status). */
  _listHeld?: () => ShareClassTicker[];
  /** Test seam — prime the resolution cache. */
  _prime?: typeof primeFundResolution;
  /** Test seam — warm one ticker. */
  _warm?: (source: string, ticker: string, range: SeriesRange) => Promise<unknown>;
}

export interface PrewarmNavResult {
  tickersSeen: number;
  ok: number;
  failed: number;
  errors: Array<{ ticker: string; error: string }>;
}

/**
 * Pre-warm the NAV + AUM (net_asset) history cache for the full registered-fund
 * universe (issue #104), so fund-detail charts, the screener's price/return/size
 * columns, and any backtest read deep history instantly instead of paying a cold
 * per-fund fetch on first open.
 *
 * For each priceable share-class `ticker` it calls
 * `getCachedSeries("thai_mutual_fund", ticker, range)`, reusing the cache's
 * write-through, provider-fallback, and depth-aware paths. Two consequences fall
 * out of that reuse, by design:
 *  - Re-runs are cheap: `getCachedSeries` serves from cache (no upstream call)
 *    when a fund is already fresh *and* deep enough, so re-running only fills
 *    gaps. The daily append uses `range:"1mo"` — funds fetched <24h ago are
 *    skipped; the rest refetch the recent window and upsert today's point while
 *    keeping their existing deeper history (`nav_history` is upsert-only).
 *  - Multi-class funds cost one SEC query *per class* (the NAV endpoint is
 *    server-side filtered by `fund_class_name`). `retailOnly` trims the bulk of
 *    that. Batching all classes of a proj_id into one query is a possible future
 *    optimization, but it would bypass the shared cache layer.
 *
 * The SEC symbol-resolution cache is primed from the local catalog first, so
 * each fetch skips the 1–2 profile lookups `resolveSymbol` would otherwise make.
 * Per-ticker failures are collected, never aborting the run (a fund with no
 * published NAV history throws and is counted as failed — expected for a slice
 * of the universe).
 */
export async function prewarmNav(opts: PrewarmNavOptions = {}): Promise<PrewarmNavResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const range: SeriesRange = opts.range ?? "max";
  const listTickers = opts._listTickers ?? listActiveShareClassTickers;
  const listHeld = opts._listHeld ?? listHeldShareClassTickers;
  const prime = opts._prime ?? primeFundResolution;
  const warm = opts._warm ?? getCachedSeries;

  // Active universe ∪ funds ANY user HOLDS (any status; multi-user prod). The union
  // ensures a closed/liquidated or IPO held fund — excluded from the active-only
  // crawl — still gets its NAV warmed, so its price doesn't silently go stale (#235).
  const byTicker = new Map<string, ShareClassTicker>();
  for (const t of listTickers({ retailOnly: opts.retailOnly })) byTicker.set(t.ticker, t);
  for (const t of listHeld()) byTicker.set(t.ticker, t);
  let tickers = [...byTicker.values()];
  if (opts.limit && opts.limit > 0) tickers = tickers.slice(0, opts.limit);

  // Prime resolution so fetchSeries → resolveSymbol hits the local mapping (zero
  // extra SEC calls) instead of the abbr→proj_id profile lookups.
  prime(
    tickers.map((t) => ({
      ticker: t.ticker,
      projId: t.projId,
      fundClassName: t.className,
      name: t.name,
    })),
  );

  const total = tickers.length;
  let ok = 0;
  const errors: Array<{ ticker: string; error: string }> = [];
  const inFlight = new Set<Promise<void>>();

  async function processOne(ticker: string, index: number): Promise<void> {
    try {
      await warm(SEC_THAILAND_SOURCE, ticker, range);
      ok++;
      opts.onProgress?.({ index, total, ticker, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ ticker, error: msg });
      opts.onProgress?.({ index, total, ticker, ok: false, error: msg });
    }
  }

  for (let i = 0; i < tickers.length; i++) {
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
    const task = processOne(tickers[i].ticker, i).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  }
  await Promise.all(inFlight);

  return { tickersSeen: total, ok, failed: errors.length, errors };
}
