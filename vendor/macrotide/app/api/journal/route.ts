import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { createJournalEntry, type JournalKind, listJournalEntries } from "@/lib/db/queries/journal";

const VALID_KINDS: ReadonlyArray<JournalKind> = ["note", "decision", "question", "reading"];

function parseKind(value: string | null): JournalKind | undefined {
  if (!value) return undefined;
  return (VALID_KINDS as readonly string[]).includes(value) ? (value as JournalKind) : undefined;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const filters = {
    kind: parseKind(url.searchParams.get("kind")),
    since: url.searchParams.get("since") ?? undefined,
    includeArchived: url.searchParams.get("includeArchived") === "true",
    limit: limitParam ? Number(limitParam) : undefined,
  };
  return withDb(() => NextResponse.json(listJournalEntries(filters)));
}

export async function POST(req: Request) {
  const body = await req.json();
  return withDb(() => NextResponse.json(createJournalEntry(body), { status: 201 }));
}
