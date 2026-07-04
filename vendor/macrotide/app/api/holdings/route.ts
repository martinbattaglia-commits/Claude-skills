import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getBucket } from "@/lib/db/queries/buckets";
import { getHolding, listHoldings } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger, syncedBrokerForTicker } from "@/lib/db/queries/project-holdings";

export async function GET(req: Request) {
  const bucket = new URL(req.url).searchParams.get("bucket") ?? undefined;
  return withDb(() => {
    if (bucket) {
      // Holdings have no user_id of their own — they're scoped through their
      // bucket. getBucket is user-scoped, so a bucket id from another user
      // resolves to undefined: return nothing rather than leak their holdings.
      if (!getBucket(bucket)) return NextResponse.json([]);
      return NextResponse.json(listHoldings(bucket));
    }
    // No bucket filter: listHoldings is bucket-ownership-scoped at the query
    // layer, so an unfiltered list is already only the caller's holdings.
    return NextResponse.json(listHoldings());
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  return withDb(() => {
    // Never insert against a bucket the caller doesn't own. getBucket is
    // user-scoped, so a foreign or missing bucket id is rejected here.
    const bucketId = typeof body?.bucketId === "string" ? body.bucketId.trim() : "";
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim() : "";
    if (!bucketId || !getBucket(bucketId)) {
      return NextResponse.json({ error: "bucket_not_found" }, { status: 404 });
    }
    if (!ticker) return NextResponse.json({ error: "ticker_required" }, { status: 400 });

    // A broker connection already feeds this ticker into this portfolio: a manual
    // add would fold on top of the synced lots and silently double-count. Block it
    // and point the user at the synced holding instead.
    const broker = syncedBrokerForTicker(bucketId, ticker);
    if (broker) {
      return NextResponse.json({ error: "synced_duplicate", broker }, { status: 409 });
    }

    // A holding is created by writing an `opening` anchor to the ledger; the
    // holding row is then the projection of it (ADR 0004).
    const created = createHoldingViaLedger({
      bucketId,
      ticker,
      englishName:
        typeof body.englishName === "string" && body.englishName ? body.englishName : ticker,
      quoteSource:
        typeof body.quoteSource === "string" && body.quoteSource ? body.quoteSource : "market",
      units: Number(body.units) || 0,
      avgCost: body.avgCost == null ? null : Number(body.avgCost),
      source: body.source ?? null,
      acquiredOn: body.acquiredOn ?? null,
      thaiName: body.thaiName ?? null,
      category: body.category ?? null,
      assetClass: body.assetClass ?? null,
      region: body.region ?? null,
      ter: body.ter == null ? null : Number(body.ter),
    });
    return NextResponse.json(created ? (getHolding(created.id) ?? created) : created, {
      status: 201,
    });
  });
}
