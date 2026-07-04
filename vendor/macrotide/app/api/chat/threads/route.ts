import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { createThread, listDeletedThreads, listThreads } from "@/lib/db/queries/chat";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const include = url.searchParams.get("include");
  return withDb(() => {
    if (include === "deleted") {
      // 30-day restore window; older trash is purged by a background job in
      // a future phase.
      return NextResponse.json(listDeletedThreads(30));
    }
    return NextResponse.json(listThreads());
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string | null };
  return withDb(() =>
    NextResponse.json(createThread({ title: body.title ?? null }), { status: 201 }),
  );
}
