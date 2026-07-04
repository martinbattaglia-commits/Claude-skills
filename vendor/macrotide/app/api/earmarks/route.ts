import { NextResponse } from "next/server";
import { z } from "zod";
import { withDb } from "@/lib/api/with-db";
import { listBuckets } from "@/lib/db/queries/buckets";
import { deleteAccountEarmark, listEarmarks, setAccountEarmark } from "@/lib/db/queries/earmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cash earmarks (#149): reserve part (or all) of a cash account for a purpose. The split
// math is read-time (resolveEarmarks); this route just owns the designations.

const setBody = z.object({
  bucketId: z.string().trim().min(1),
  ticker: z.string().trim().min(1).max(64),
  // 'reserved' (excluded from return) | 'investable' (counts; row carries only a label).
  role: z.enum(["investable", "reserved"]).default("reserved"),
  // null = "All" (the whole balance, auto-tracks); a number = a fixed reserve.
  amount: z.number().finite().nonnegative().nullable(),
  currency: z.string().trim().min(1).max(8).nullish(),
  purpose: z.string().trim().max(120).nullish(),
});

const deleteBody = z.object({
  bucketId: z.string().trim().min(1),
  ticker: z.string().trim().min(1).max(64),
});

export async function GET() {
  return withDb(() => NextResponse.json(listEarmarks()));
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = setBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;
  return withDb(() => {
    // Only earmark a bucket the owner actually has (the FK would reject otherwise, but
    // fail clearly instead of with a constraint error).
    if (!listBuckets().some((b) => b.id === input.bucketId)) {
      return NextResponse.json({ error: "unknown_bucket" }, { status: 404 });
    }
    return NextResponse.json(setAccountEarmark(input), { status: 201 });
  });
}

export async function DELETE(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = deleteBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  return withDb(() => {
    deleteAccountEarmark(parsed.data.bucketId, parsed.data.ticker);
    return NextResponse.json({ ok: true });
  });
}
