// GET /api/funds/[projId] — fund detail including enrichment data.
//
// Returns the catalog row for one fund plus all available enrichment snapshots:
//   - performance  — all perf-type rows (fund/benchmark volatility + return,
//                    peer avg) from the latest factsheet
//   - assetAllocation — %NAV breakdown by asset type (latest factsheet)
//   - topHoldings  — top-5 holdings (latest factsheet)
//   - portfolio    — full quarterly portfolio (latest quarter, if ingested)
//   - portfolioAssetType — monthly asset-type summary (latest month, if ingested)
//   - feederMasterMap — master fund mapping if this is a feeder fund (or null)
//   - lookThroughHoldings — master fund's holdings for feeder look-through
//
// Any table that has not been populated (enrichment flags were off during last
// crawl) returns an empty array / null — callers should handle gracefully.
//
// The path segment is matched against fund_catalog.proj_id first; if nothing
// matches it falls back to an exact fund_catalog.abbr_name match. That lets a
// portfolio holding open its catalog detail by its bare ticker (which is the
// fund's abbr_name) without the client having to resolve proj_id first. A
// holding that isn't a catalog fund (a stock/index) simply 404s, and the caller
// degrades to showing the holding's own data.
//
// This is an ADDITIVE route; the existing /api/funds (list/filter) is unchanged.

import { eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getMarketDb } from "@/lib/db/context";
import { getFeederEnrichment, resolveMasterSymbol } from "@/lib/db/queries/feeder-enrichment";
import { getFundEnrichment } from "@/lib/db/queries/fund-enrichment";
import { getShareClassByTicker, listShareClassesByProj } from "@/lib/db/queries/share-classes";
import { fundCatalog } from "@/lib/db/schema";
import { pickDefaultClass } from "@/lib/market/share-class-select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ projId: string }> }) {
  const { projId } = await params;
  if (!projId) {
    return NextResponse.json({ error: "projId is required" }, { status: 400 });
  }

  return withDb(() => {
    // Resolve the path segment to a catalog fund. It may be a proj_id, a parent
    // abbr_name, or a share-class ticker (the screener/search now pass a class).
    const db = getMarketDb();
    const classMatch = getShareClassByTicker(projId);
    const fund = db
      .select()
      .from(fundCatalog)
      .where(
        classMatch
          ? eq(fundCatalog.projId, classMatch.projId)
          : or(eq(fundCatalog.projId, projId), eq(fundCatalog.abbrName, projId)),
      )
      .get();

    if (!fund) {
      return NextResponse.json({ error: "Fund not found" }, { status: 404 });
    }

    // Enrichment is keyed by the canonical proj_id, not whatever was passed in.
    const enrichment = getFundEnrichment(fund.projId);
    const feederEnrichment = getFeederEnrichment(fund.projId);

    // Share classes (priceable units) + which one to show first: the class the
    // caller opened (a ticker click) wins; otherwise the heuristic default.
    const shareClasses = listShareClassesByProj(fund.projId);
    const selectedClassTicker =
      classMatch?.ticker ??
      pickDefaultClass(shareClasses, fund.abbrName)?.ticker ??
      fund.abbrName ??
      null;

    return NextResponse.json({
      ...fund,
      ...enrichment,
      ...feederEnrichment,
      shareClasses,
      selectedClassTicker,
      // The master fund resolved to a US ETF by name (its ISIN is unreliable).
      masterSymbol: resolveMasterSymbol(feederEnrichment.masterMap),
    });
  });
}
