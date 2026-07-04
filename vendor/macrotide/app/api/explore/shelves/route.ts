// GET /api/explore/shelves — the Explore "All" idle browse: curated cross-asset
// shelves (index ETFs / Thai funds / US stocks), each ranked by its own honest
// signal. Searching uses /api/search (flat relevance) instead.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getExploreShelves } from "@/lib/db/queries/explore-shelves";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return withDb(() => NextResponse.json({ shelves: getExploreShelves() }));
}
