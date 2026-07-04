// GET /api/analysis/look-through?bucket=<id>
//
// Returns the underlying-exposure look-through for a scope of holdings —
// aggregate (all buckets) by default, or a single bucket when `bucket` is set.
// Look-through needs market.db (per-fund underlying holdings), so it can't be
// computed client-side; the Portfolio screen fetches it and injects it into the
// client-side computeHealth so the diversification check reflects the real
// underlying story. See docs/explanation/portfolio-health.md.

import { type NextRequest, NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { listHeldQuoteKeys, listHoldings } from "@/lib/db/queries/holdings";
import { listFundQuotes } from "@/lib/db/queries/quotes";
import { adaptAggregate, adaptPortfolios } from "@/lib/portfolio/adapter";
import { computeLookThrough } from "@/lib/portfolio/look-through";

export async function GET(req: NextRequest) {
  const bucket = req.nextUrl.searchParams.get("bucket");
  return withDb(() => {
    const portfolios = adaptPortfolios(
      listBuckets(),
      listHoldings(),
      listFundQuotes(listHeldQuoteKeys()),
    );
    const scoped =
      bucket && bucket !== "all" ? portfolios.filter((p) => p.id === bucket) : portfolios;
    const holdings = adaptAggregate(scoped).holdings;
    return NextResponse.json({ lookThrough: computeLookThrough(holdings) });
  });
}
