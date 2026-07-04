import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { forget, restore } from "@/lib/db/queries/preferences";

export const runtime = "nodejs";

// Soft-delete (sets valid_until = now). The row stays for 30 days so the user
// can restore it from Journal → Memory. See docs/explanation/memory.md § Forgetting.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const result = forget(String(id));
    if (result.kind !== "match" || !result.row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result.row);
  });
}

// Restore a recently-forgotten note: clears valid_until so it goes back into
// the active set and will be re-injected on the next chat.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  return withDb(() => {
    const row = restore(numericId);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  });
}
