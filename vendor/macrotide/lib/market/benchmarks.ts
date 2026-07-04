import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { getMarketDb, isDemoRequest } from "@/lib/db/context";
import { navHistory } from "@/lib/db/schema";
import { demoIndexSeries } from "@/lib/mock/demo-history-read";
import { findBenchmark } from "./benchmark-options";
import { getCachedSeries } from "./cache";
import { buildFxConverter } from "./fx";
import type { SeriesRange } from "./providers/types";
import { benchmarkRangeStart } from "./range";
import { BENCHMARK_TR_SOURCE, quoteCacheKey } from "./sources";

// Re-export the client-safe catalog so server callers can keep importing
// everything benchmark-related from this one module.
export { BENCHMARK_TR_OPTIONS, type BenchmarkOption, findBenchmark } from "./benchmark-options";

// Benchmark key → demo fixture index key (lib/mock/demo-history.ts). Every
// featured benchmark maps to a real index proxy stored in the committed fixture,
// so the demo overlay renders for all of them with no live fetch.
const DEMO_BENCHMARK_INDEX: Record<string, string> = {
  acwi_tr: "acwi",
  us_tr: "sp500",
  us_tech_tr: "nasdaq",
  dev_exus_tr: "dev_exus",
  em_tr: "em",
  japan_tr: "nikkei",
  thai_tr: "set",
};

export interface BenchmarkSeriesPoint {
  /** ISO YYYY-MM-DD */
  date: string;
  value: number;
}

/**
 * Real index series for a benchmark over `range`, from the market cache
 * (stale-tolerant). Returns `[]` when the key is unknown or the upstream is
 * cold / backing off — callers treat an empty series as "unavailable", never
 * as zero.
 */
export async function getBenchmarkSeries(
  key: string,
  range: SeriesRange = "6mo",
): Promise<BenchmarkSeriesPoint[]> {
  const b = findBenchmark(key);
  if (!b) return [];
  const since = benchmarkRangeStart(range);

  // DEMO MODE: serve the benchmark overlay from the committed ~5y fixture instead
  // of market.db. The fixture is keyed by its own index keys (sp500/nasdaq/…), so
  // map the benchmark key to its fixture index. demoIndexSeries seeds a carry-in
  // on `since` so the overlay spans the full window. The fixture is already
  // rebased/synthetic and shares the demo portfolio's indices, so it needs no FX
  // conversion (owner mode does — below). See lib/mock/demo-history.ts.
  if (isDemoRequest()) {
    const indexKey = DEMO_BENCHMARK_INDEX[key];
    return indexKey ? demoIndexSeries(indexKey, since) : [];
  }

  try {
    const cached = await getCachedSeries(b.source, b.ticker, range);
    const series = cached.series.map((p) => ({ date: p.date, value: p.close }));
    // CARRY-IN: if the cached series' first in-window point is after `since`
    // (the window opened on a non-trading day for this index), seed the left edge
    // with the most recent pre-window close, re-dated to `since`, so the overlay
    // spans the full window and the client rebases from the same start as the
    // portfolio line. Re-dating to `since` keeps the axis at the window start.
    if (series.length > 0 && series[0].date > since) {
      const carry = getMarketDb()
        .select({ nav: navHistory.nav })
        .from(navHistory)
        .where(
          and(eq(navHistory.ticker, quoteCacheKey(b.source, b.ticker)), lt(navHistory.date, since)),
        )
        .orderBy(desc(navHistory.date))
        .limit(1)
        .get();
      if (carry) series.unshift({ date: since, value: carry.nav });
    }
    return await convertToBaseCurrency(b.source, series, range);
  } catch {
    return [];
  }
}

/**
 * Convert a benchmark series into the base currency (฿). The `benchmark_tr`
 * proxies are USD ETFs, so without this the overlay's % return would carry the
 * USD/THB move over the window — flattering or punishing the comparison against
 * the ฿ portfolio line. Reuses the keyless Frankfurter FX chain. A future
 * ฿-native benchmark would skip conversion (other sources pass through).
 */
async function convertToBaseCurrency(
  source: string,
  series: BenchmarkSeriesPoint[],
  range: SeriesRange,
): Promise<BenchmarkSeriesPoint[]> {
  if (source !== BENCHMARK_TR_SOURCE || series.length === 0) return series;
  const fx = await buildFxConverter(
    ["USD"],
    range,
    series.map((p) => p.date),
  );
  return series.map((p) => {
    const rate = fx.rateOn("USD", p.date);
    return rate == null ? p : { date: p.date, value: p.value * rate };
  });
}

/**
 * Total return % for a benchmark over `range`. When `fromDate` is given, the
 * window starts at the first benchmark point on/after it — so a benchmark and a
 * portfolio can be compared over the *same* span. Returns `null` when there
 * isn't enough data.
 */
export async function getBenchmarkReturnPct(
  key: string,
  range: SeriesRange = "6mo",
  fromDate?: string,
): Promise<number | null> {
  const series = await getBenchmarkSeries(key, range);
  const pts = fromDate ? series.filter((p) => p.date >= fromDate) : series;
  if (pts.length < 2) return null;
  const first = pts[0].value;
  const last = pts[pts.length - 1].value;
  if (!first) return null;
  return (last / first - 1) * 100;
}
