import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listActive, listRecentlyForgotten } from "@/lib/db/queries/preferences";

export const runtime = "nodejs";

// Memory is scoped to the request user via ownedBy() (withDb stamps the user
// into context); demo sessions get their own isolated namespace.
export async function GET() {
  return withDb(() =>
    NextResponse.json({
      active: listActive(),
      recentlyForgotten: listRecentlyForgotten(30),
    }),
  );
}
