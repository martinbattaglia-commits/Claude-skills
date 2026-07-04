import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { deleteBucket, getBucket, updateBucket } from "@/lib/db/queries/buckets";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const row = getBucket(id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  return withDb(() => {
    const row = updateBucket(id, body);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    deleteBucket(id);
    return new NextResponse(null, { status: 204 });
  });
}
