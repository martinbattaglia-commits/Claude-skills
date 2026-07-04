// GET /api/fund-classes/resolve — validate a typed ticker for add/import.
//
// A holding's ticker MUST be a priceable SHARE CLASS (e.g. "K-FIXED-A"), never a
// bare parent ("K-FIXED" may have multiple classes and no NAV of its own). This
// endpoint answers, for a single ticker:
//   - valid              — safe to add as-is (a known share class, or a non-fund
//                          ticker like a stock/index we shouldn't block).
//   - isParentWithClasses — the ticker is a parent fund with >1 class; the user
//                          must pick one of `classes` instead.
//
// Resolution order:
//   1. Known priceable share class (by ticker)        → valid.
//   2. Else a fund_catalog parent (by proj_id OR abbr) with >1 class
//                                                      → blocked, list classes.
//   3. Else (no catalog/class match — a stock/other)  → valid (don't block).

import { eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getMarketDb } from "@/lib/db/context";
import { getShareClassByTicker, listShareClassesByProj } from "@/lib/db/queries/share-classes";
import { fundCatalog } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ticker = (new URL(req.url).searchParams.get("ticker") ?? "").trim();
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  return withDb(() => {
    // 1. Already a priceable share class — safe to add as-is.
    if (getShareClassByTicker(ticker)) {
      return NextResponse.json({ ticker, valid: true, isParentWithClasses: false });
    }

    // 2. A parent fund (match on proj_id or abbr_name) with multiple classes —
    //    the user typed an unpriceable parent; surface its classes to pick from.
    const parent = getMarketDb()
      .select({ projId: fundCatalog.projId })
      .from(fundCatalog)
      .where(or(eq(fundCatalog.projId, ticker), eq(fundCatalog.abbrName, ticker)))
      .get();

    if (parent) {
      const classes = listShareClassesByProj(parent.projId);
      if (classes.length > 1) {
        return NextResponse.json({
          ticker,
          valid: false,
          isParentWithClasses: true,
          classes: classes.map((c) => ({
            ticker: c.ticker,
            distributionPolicy: c.distributionPolicy,
            taxIncentiveType: c.taxIncentiveType,
          })),
        });
      }
    }

    // 3. No catalog/class match (a stock/index/other, not a Thai fund) — or a
    //    single-class parent. Don't block non-fund tickers.
    return NextResponse.json({ ticker, valid: true, isParentWithClasses: false });
  });
}
