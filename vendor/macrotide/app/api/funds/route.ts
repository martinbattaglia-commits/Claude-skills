// GET /api/funds — fee-aware fund catalog query endpoint.
//
// Powers the Select UI: given optional filters, returns funds from the SEC
// catalog sorted cheapest-first by TER. Backed by findFunds() in
// lib/db/queries/funds.ts, which annotates each fund with its current Total
// Fee and Expense figure.
//
// Query params (all optional):
//   assetClass      — 'equity' | 'bond' | 'alternative' | 'cash'
//   query           — free-text search against name / policy text
//   limit           — cap result count (default 50, max 100)
//   activeOnly      — '0' to include inactive/closed funds (default: active only)
//   indexType       — 'index' (passive, managementStyle PN/PM) | 'active' (everything else)
//   indexOnly       — '1' ≡ indexType=index (deprecated alias; indexType wins)
//   taxIncentive    — 'SSF' | 'ThaiESG' | 'RMF'
//   region          — 'foreign' | 'domestic' | 'mixed'
//   excludeFixedTerm — '0' to include fixed-term funds (default: excluded)

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import type { FindFundsFilter } from "@/lib/db/queries/funds";
import { findFunds } from "@/lib/db/queries/funds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const excludeFixedTermParam = url.searchParams.get("excludeFixedTerm");

  const limit = Math.min(limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 50) : 50, 100);
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
    const funds = findFunds({
      assetClass,
      query,
      activeOnly,
      limit,
      indexType,
      indexOnly,
      taxIncentive,
      region,
      excludeFixedTerm,
    });
    return NextResponse.json(funds);
  });
}
