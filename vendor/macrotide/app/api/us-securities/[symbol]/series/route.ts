// GET /api/us-securities/[symbol]/series?range=1y — daily price history for one
// US stock / ETF, powering the US fund-detail chart.
//
// The symbol is the `market:${SYMBOL}` cache key tail read through the shared
// market cache (24h TTL, provider fallback Twelve Data → Alpaca → Yahoo,
// write-through). Prices are the provider's native close (USD for US tickers).
// A cold/empty cache or an upstream backing off returns an empty series rather
// than a 500, so the chart shows its empty state.
//
// nav_history lives in market.db (shared/real even in demo), so no demo branch.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getCachedSeries } from "@/lib/market/cache";
import type { SeriesRange } from "@/lib/market/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

function parseRange(value: string | null): SeriesRange {
  return RANGES.includes(value as SeriesRange) ? (value as SeriesRange) : "1y";
}

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  const range = parseRange(new URL(req.url).searchParams.get("range"));

  return withDb(async () => {
    try {
      const cached = await getCachedSeries("market", symbol, range);
      return NextResponse.json({
        series: cached.series.map((p) => ({ d: p.date, v: p.close })),
        asOf: cached.quote?.asOf ?? cached.series.at(-1)?.date ?? null,
      });
    } catch {
      return NextResponse.json({ series: [], asOf: null });
    }
  });
}
