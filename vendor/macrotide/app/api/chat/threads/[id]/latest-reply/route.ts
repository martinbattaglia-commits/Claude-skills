import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { deleteLatestAssistantTurn } from "@/lib/db/queries/chat";

export const runtime = "nodejs";

/**
 * Remove the thread's most recent assistant reply — the server half of
 * "Regenerate". The client deletes the stale reply here, then re-asks the
 * preceding user turn through the normal chat send (which appends a fresh
 * reply). Scoped to a thread the caller owns; demo-safe via `withDb`.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const removed = deleteLatestAssistantTurn(id);
    if (!removed) return NextResponse.json({ error: "no_reply" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  });
}
