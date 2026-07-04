import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import {
  getThread,
  listMessages,
  purgeThread,
  renameThread,
  restoreThread,
  softDeleteThread,
} from "@/lib/db/queries/chat";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const thread = getThread(id);
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ thread, messages: listMessages(id) });
  });
}

/**
 * Rename or restore a thread.
 *
 * - `{ title: string }` — rename. (Existing behavior.)
 * - `{ restore: true }` — clear `deleted_at`, bringing the thread back from
 *   the 30-day trash. Title is left alone.
 *
 * Both payload shapes can be sent in a single PATCH (`restore` runs first so
 * the title bump still updates `updated_at`).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    restore?: boolean;
  };
  const wantsRename = typeof body.title === "string";
  const wantsRestore = body.restore === true;
  if (!wantsRename && !wantsRestore) {
    return NextResponse.json({ error: "expected_title_or_restore" }, { status: 400 });
  }
  return withDb(() => {
    let row = getThread(id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (wantsRestore) {
      row = restoreThread(id) ?? row;
    }
    if (wantsRename && typeof body.title === "string") {
      row = renameThread(id, body.title) ?? row;
    }
    return NextResponse.json(row);
  });
}

/**
 * Delete a thread.
 *
 * - Default (`DELETE /api/chat/threads/:id`) is a **soft-delete**: sets
 *   `deleted_at = now()`. The thread is hidden from the default sidebar
 *   listing and surfaces under "Deleted chats (30 days)" until purged.
 * - `?purge=true` performs the irreversible hard delete (cascades to
 *   `chat_messages`). Used by the "Delete forever" action in the trash
 *   group.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const purge = url.searchParams.get("purge") === "true";
  return withDb(() => {
    if (purge) {
      purgeThread(id);
    } else {
      const row = softDeleteThread(id);
      if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  });
}
