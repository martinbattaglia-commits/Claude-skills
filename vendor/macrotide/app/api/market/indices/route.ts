import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getUserIndicatorSymbols } from "@/lib/db/queries/market-indicators";
import { getCachedSeries } from "@/lib/market/cache";
import { indicatorBySymbol } from "@/lib/market/indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // withDb resolves the per-request DB context so each user's own indicator
  // list (and any warmed cache) is used — without it getCachedSeries reads the
  // owner singleton and a demo session falsely reports everything unavailable.
  return withDb(async () => {
    const symbols = getUserIndicatorSymbols();

    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        // All indicators route through the "market" provider chain
        // (Twelve Data → Frankfurter → Yahoo).
        const cached = await getCachedSeries("market", symbol, "6mo", "1d");
        const series = cached.series;
        const latest = series.at(-1);
        const prev = series.length > 1 ? series[series.length - 2] : null;
        const d1Pct = latest && prev ? ((latest.close - prev.close) / prev.close) * 100 : 0;
        const def = indicatorBySymbol(symbol);
        return {
          symbol,
          label: def?.label ?? symbol,
          name: def?.name ?? "",
          price: latest?.close ?? null,
          d1Pct,
          series: series.map((p) => ({ d: p.date, v: p.close })),
          asOf: cached.quote?.asOf ?? null,
        };
      }),
    );

    const payload = results.map((r, i) => {
      if (r.status === "fulfilled") return { ok: true as const, ...r.value };
      const symbol = symbols[i];
      const def = indicatorBySymbol(symbol);
      return {
        ok: false as const,
        symbol,
        label: def?.label ?? symbol,
        name: def?.name ?? "",
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    return NextResponse.json(payload);
  });
}
