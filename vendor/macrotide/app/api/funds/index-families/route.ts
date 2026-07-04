// GET /api/funds/index-families — the live "Tracks" facet menu: every index
// family with at least one active index-style (PN/PM) tracker, most-tracked
// first, each with its tracker count. Backed by listTrackedIndexFamilies();
// derived from the catalog so the menu follows the nightly refresh.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listTrackedIndexFamilies } from "@/lib/db/queries/funds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(() => NextResponse.json(listTrackedIndexFamilies()));
}
