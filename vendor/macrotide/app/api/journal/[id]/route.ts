import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import {
  archiveJournalEntry,
  deleteJournalEntry,
  getJournalEntry,
  updateJournalEntry,
} from "@/lib/db/queries/journal";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const row = getJournalEntry(Number(id));
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  return withDb(() => {
    const row = updateJournalEntry(Number(id), body);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const archive = new URL(req.url).searchParams.get("archive") === "true";
  return withDb(() => {
    if (archive) {
      archiveJournalEntry(Number(id));
    } else {
      deleteJournalEntry(Number(id));
    }
    return new NextResponse(null, { status: 204 });
  });
}
