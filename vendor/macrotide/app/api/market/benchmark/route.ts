import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { findBenchmark, getBenchmarkSeries } from "@/lib/market/benchmarks";
import type { SeriesRange } from "@/lib/market/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES = new Set<SeriesRange>(["1mo", "3mo", "6mo", "1y", "5y", "max"]);

/**
 * Real index series for a benchmark, over `range`, for the Portfolio "VS"
 * overlay. Series comes from the market cache (stale-tolerant); an empty series
 * means the upstream is cold / backing off — the client treats that as
 * "unavailable", never as zero.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  const rangeParam = (url.searchParams.get("range") ?? "6mo") as SeriesRange;
  const range = RANGES.has(rangeParam) ? rangeParam : "6mo";

  const opt = findBenchmark(key);
  if (!opt) {
    return NextResponse.json({ error: "unknown_benchmark" }, { status: 404 });
  }

  // getBenchmarkSeries → getCachedSeries reads the per-request DB context.
  return withDb(async () => {
    const series = await getBenchmarkSeries(key, range);
    return NextResponse.json({ key: opt.key, label: opt.label, series });
  });
}
