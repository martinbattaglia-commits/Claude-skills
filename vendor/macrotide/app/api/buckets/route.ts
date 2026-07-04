import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { createBucket, listBuckets } from "@/lib/db/queries/buckets";

export async function GET() {
  return withDb(() => NextResponse.json(listBuckets()));
}

export async function POST(req: Request) {
  const body = await req.json();
  // Fill server-managed defaults so the client doesn't have to know schema details.
  // id: UUID is opaque from the user's perspective — they only see the name.
  // brokerage: legacy notNull column kept until broker import lands.
  const insert = {
    ...body,
    id: typeof body.id === "string" && body.id.length > 0 ? body.id : crypto.randomUUID(),
    brokerage:
      typeof body.brokerage === "string" && body.brokerage.length > 0 ? body.brokerage : "—",
  };
  return withDb(() => NextResponse.json(createBucket(insert), { status: 201 }));
}
