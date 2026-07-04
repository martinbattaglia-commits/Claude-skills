// GET /api/us-securities — browse / search the US stock & ETF catalog.
//
// Backs the Explore US segment, the Add-holding ticker autofill, and (server
// side) the Advisor's US-instrument search. Mirrors /api/fund-classes but over
// the flat `us_securities` table.
//
// Query params (all optional): query (free text over symbol prefix + name),
// type ('stock'|'etf'), sort ('symbol'|'name'), limit (default 50, max 600 —
// "Load more" grows it), offset (paging), includeDelisted ('1').
//
// Returns { items: UsSecurity[], total } — `total` is the full eligible count
// so the client can show "Showing X of N" and stop paging at the end.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { findUsSecurities } from "@/lib/db/queries/us-securities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 600;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("query") ?? undefined;
  const typeParam = url.searchParams.get("type");
  const sortParam = url.searchParams.get("sort");
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const includeDelisted = url.searchParams.get("includeDelisted") === "1";

  const securityType = typeParam === "stock" || typeParam === "etf" ? typeParam : undefined;
  const sort = sortParam === "name" ? "name" : sortParam === "popularity" ? "popularity" : "symbol";
  const limit = Math.min(
    limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 50) : 50,
    MAX_LIMIT,
  );
  const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;

  return withDb(() => {
    const result = findUsSecurities({
      query,
      securityType,
      sort,
      limit,
      offset,
      includeDelisted,
    });
    return NextResponse.json(result);
  });
}
