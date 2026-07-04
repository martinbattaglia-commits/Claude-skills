import "server-only";
import { BENCHMARK_TR_OPTIONS, type BenchmarkOption } from "@/lib/market/benchmark-options";
import { getCachedSeries } from "@/lib/market/cache";
import type { SeriesRange } from "@/lib/market/providers/types";

export interface PrewarmBenchmarkOptions {
  /** History depth to fetch. "max" for the backfill, "1mo" for the daily append
   * (the depth-aware cache keeps prior "max" depth — see cache.ts). Default "max". */
  range?: SeriesRange;
  onProgress?: (info: {
    index: number;
    total: number;
    key: string;
    ticker: string;
    ok: boolean;
    error?: string;
  }) => void;
  /** Test seam — the catalog to warm. */
  _options?: BenchmarkOption[];
  /** Test seam — warm one series. */
  _warm?: (source: string, ticker: string, range: SeriesRange) => Promise<unknown>;
}

export interface PrewarmBenchmarkResult {
  requested: number;
  ok: number;
  failed: number;
  errors: Array<{ key: string; ticker: string; error: string }>;
}

/**
 * Pre-warm the total-return benchmark series cache (the `benchmark_tr` source),
 * so the portfolio "All" chart can overlay a like-for-like benchmark across its
 * full range without a cold first-open fetch.
 *
 * For each entry in `BENCHMARK_TR_OPTIONS` it calls
 * `getCachedSeries("benchmark_tr", ticker, range)`, reusing the cache's
 * write-through + depth-aware paths. The backfill (`range:"max"`) lands ~20y of
 * dividend-reinvested daily closes; the daily append (`range:"1mo"`) refetches
 * only the recent window and upserts today's point, keeping the deeper history
 * (`nav_history` is upsert-only). Re-runs are cheap — a series fresh and deep
 * enough is served from cache with no upstream call.
 *
 * This is a tiny, fixed work-list (a handful of curated proxies), so it runs
 * sequentially — well within Twelve Data's free per-minute rate. Per-ticker
 * failures are collected, never aborting the run.
 */
export async function prewarmBenchmark(
  opts: PrewarmBenchmarkOptions = {},
): Promise<PrewarmBenchmarkResult> {
  const range: SeriesRange = opts.range ?? "max";
  const options = opts._options ?? BENCHMARK_TR_OPTIONS;
  const warm = opts._warm ?? getCachedSeries;

  const total = options.length;
  let ok = 0;
  const errors: Array<{ key: string; ticker: string; error: string }> = [];

  for (let i = 0; i < options.length; i++) {
    const { key, source, ticker } = options[i];
    try {
      await warm(source, ticker, range);
      ok++;
      opts.onProgress?.({ index: i, total, key, ticker, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ key, ticker, error: msg });
      opts.onProgress?.({ index: i, total, key, ticker, ok: false, error: msg });
    }
  }

  return { requested: total, ok, failed: errors.length, errors };
}
