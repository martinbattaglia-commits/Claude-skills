// GET /api/funds/[projId]/series?range=1y — daily NAV/AUM history for one fund
// SHARE CLASS.
//
// Powers the chart in the fund-detail sheet. NAV is per share class, so the path
// segment is resolved to a priceable class ticker: a share-class ticker is used
// directly (e.g. "MDIVA-A"); a parent proj_id / abbr falls back to the fund's
// default class. That ticker is the `${source}:${ticker}` cache key the SEC
// crawler writes into nav_history, read through the shared market cache (24h TTL,
// provider fallback, write-through). A cold/empty cache returns an empty series
// rather than erroring, so the chart shows its empty state instead of a 500.
//
// nav_history lives in market.db (shared/real even in demo), so no demo branch.

import { eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getMarketDb } from "@/lib/db/context";
import { getShareClassByTicker, listShareClassesByProj } from "@/lib/db/queries/share-classes";
import { fundCatalog } from "@/lib/db/schema";
import { getCachedSeries } from "@/lib/market/cache";
import type { SeriesRange } from "@/lib/market/providers/types";
import { pickDefaultClass } from "@/lib/market/share-class-select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

function parseRange(value: string | null): SeriesRange {
  return RANGES.includes(value as SeriesRange) ? (value as SeriesRange) : "1y";
}

export async function GET(req: Request, { params }: { params: Promise<{ projId: string }> }) {
  const { projId } = await params;
  if (!projId) {
    return NextResponse.json({ error: "projId is required" }, { status: 400 });
  }
  const range = parseRange(new URL(req.url).searchParams.get("range"));

  return withDb(async () => {
    // A share-class ticker is the cache key directly; a parent proj_id/abbr
    // resolves to the fund's default class.
    const classMatch = getShareClassByTicker(projId);
    let ticker: string | null = classMatch?.ticker ?? null;

    if (!ticker) {
      const fund = getMarketDb()
        .select({ projId: fundCatalog.projId, abbrName: fundCatalog.abbrName })
        .from(fundCatalog)
        .where(or(eq(fundCatalog.projId, projId), eq(fundCatalog.abbrName, projId)))
        .get();
      if (!fund) {
        return NextResponse.json({ error: "Fund not found" }, { status: 404 });
      }
      const classes = listShareClassesByProj(fund.projId);
      ticker = pickDefaultClass(classes, fund.abbrName)?.ticker ?? fund.abbrName ?? null;
    }

    // No resolvable ticker → no cache key; degrade to an empty series.
    if (!ticker) {
      return NextResponse.json({ series: [], asOf: null });
    }

    try {
      const cached = await getCachedSeries("thai_mutual_fund", ticker, range);
      return NextResponse.json({
        series: cached.series.map((p) => ({ d: p.date, v: p.close, aum: p.netAsset ?? null })),
        asOf: cached.quote?.asOf ?? cached.series.at(-1)?.date ?? null,
      });
    } catch {
      // Cold cache + upstream backing off: degrade to an empty series so the
      // chart renders its empty state rather than throwing a 500.
      return NextResponse.json({ series: [], asOf: null });
    }
  });
}
