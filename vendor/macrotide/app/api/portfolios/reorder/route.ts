import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { reorderBuckets } from "@/lib/db/queries/buckets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH { orderedIds: string[] } → persist a manual portfolio ordering by
// writing `position = index` for each id. Owner-scoped inside the query: a
// caller can only reorder their own buckets; ids they don't own are no-ops.
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as { orderedIds?: unknown } | null;
  if (
    !body ||
    !Array.isArray(body.orderedIds) ||
    !body.orderedIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json({ error: "Expected { orderedIds: string[] }" }, { status: 400 });
  }
  return withDb(() => {
    reorderBuckets(body.orderedIds as string[]);
    return NextResponse.json({ ok: true });
  });
}
