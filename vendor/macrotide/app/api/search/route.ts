// GET /api/search — the unified Explore search across ALL assets (Thai funds +
// US stocks & ETFs). Backs the single search bar + asset-type pill.
//
// Query params (all optional): query (free text), type ('all'|'thai'|'us'|
// 'us_stock'|'us_etf', default 'all'), limit (default 30, max 100), offset.
//
// Returns { items: AssetSearchItem[], total } — items carry a `kind` discriminator
// so the client renders the right row + opens the right detail.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { type AssetTypeFilter, searchAssets } from "@/lib/db/queries/asset-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: AssetTypeFilter[] = ["all", "thai", "us", "us_stock", "us_etf"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("query") ?? undefined;
  const typeParam = url.searchParams.get("type") as AssetTypeFilter | null;
  const assetType = typeParam && TYPES.includes(typeParam) ? typeParam : "all";
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const limit = Math.min(limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 30) : 30, 100);
  const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;

  return withDb(() => NextResponse.json(searchAssets({ query, assetType, limit, offset })));
}
