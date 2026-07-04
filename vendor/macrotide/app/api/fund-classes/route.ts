// GET /api/fund-classes — screener query that returns priceable SHARE CLASSES.
//
// Same filters as /api/funds, but each result is a share class (NAV/fees/tax are
// per class — decision D2b), annotated with its parent metadata + latest NAV.
// Backed by findShareClasses() in lib/db/queries/funds.ts. /api/funds (parent
// funds) is unchanged and still backs the advisor's find_funds tool.
//
// Query params (all optional): assetClass, query, limit (default 50, max 600 —
// the screener's "Load more" grows the limit to page through the full catalog),
// activeOnly ('0' to include closed), indexType ('index'|'active'; indexOnly
// '1' still accepted as a deprecated alias for indexType=index), taxIncentive
// ('SSF'|'ThaiESG'|'RMF'), region ('foreign'|'domestic'|'mixed'),
// trackingIndex (normalized index family, e.g. 'S&P 500' — index-style funds
// tracking it), excludeFixedTerm ('0' to include), access ('accredited' |
// 'ultra' | 'both' — the "Access" facet filters browse to that restricted
// audience; absent = retail).
//
// Returns { items: ShareClassListItem[], total } — `total` is the full eligible
// count so the client can show "Showing X of N" and stop paging at the end.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import type { FindFundsFilter } from "@/lib/db/queries/funds";
import { findShareClasses } from "@/lib/db/queries/funds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generous ceiling so "Load more" can reach the whole catalog (a 100-row cap
// would just move the silent truncation, not remove it). It only guards against
// abusive direct API calls; the UI never requests beyond the reported `total`.
const SCREENER_MAX_LIMIT = 600;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetClass = url.searchParams.get("assetClass") ?? undefined;
  const query = url.searchParams.get("query") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const activeOnlyParam = url.searchParams.get("activeOnly");
  const indexTypeParam = url.searchParams.get("indexType");
  const indexOnlyParam = url.searchParams.get("indexOnly");
  const taxIncentiveParam = url.searchParams.get("taxIncentive");
  const regionParam = url.searchParams.get("region");
  const trackingIndex = url.searchParams.get("trackingIndex") ?? undefined;
  const excludeFixedTermParam = url.searchParams.get("excludeFixedTerm");
  const accessParam = url.searchParams.get("access");
  const access =
    accessParam === "accredited" || accessParam === "ultra" || accessParam === "both"
      ? accessParam
      : undefined;

  const limit = Math.min(
    limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 50) : 50,
    SCREENER_MAX_LIMIT,
  );
  const activeOnly = activeOnlyParam !== "0";
  const indexType =
    indexTypeParam === "index" || indexTypeParam === "active" ? indexTypeParam : undefined;
  const indexOnly = indexOnlyParam === "1" ? true : undefined;
  const excludeFixedTerm = excludeFixedTermParam !== "0";

  const taxIncentive =
    taxIncentiveParam === "SSF" || taxIncentiveParam === "ThaiESG" || taxIncentiveParam === "RMF"
      ? (taxIncentiveParam as FindFundsFilter["taxIncentive"])
      : undefined;

  const region =
    regionParam === "foreign" || regionParam === "domestic" || regionParam === "mixed"
      ? (regionParam as FindFundsFilter["region"])
      : undefined;

  return withDb(() => {
    const result = findShareClasses({
      assetClass,
      query,
      activeOnly,
      limit,
      indexType,
      indexOnly,
      taxIncentive,
      region,
      trackingIndex,
      excludeFixedTerm,
      access,
    });
    return NextResponse.json(result);
  });
}
