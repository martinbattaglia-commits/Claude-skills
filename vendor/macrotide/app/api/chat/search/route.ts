import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { searchThreads } from "@/lib/db/queries/search";

export const runtime = "nodejs";

/**
 * Full-text search over chat threads + messages.
 * `GET /api/chat/search?q=<query>&limit=<n>` → ThreadSearchHit[].
 * A blank query returns an empty array (the UI hides results until the user
 * types), so there's no need to special-case it client-side.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(Number.parseInt(limitParam, 10) || 20, 1), 50) : 20;
  return withDb(() => NextResponse.json(searchThreads(q, { limit })));
}
