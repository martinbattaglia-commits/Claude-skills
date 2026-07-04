import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getBucket } from "@/lib/db/queries/buckets";
import { isCatalogHolding, stripCatalogOwnedFields } from "@/lib/db/queries/holding-enrichment";
import { getHolding } from "@/lib/db/queries/holdings";
import { deleteHoldingViaLedger, editHoldingViaLedger } from "@/lib/db/queries/project-holdings";

/** A holding is owned iff its parent bucket resolves under the user-scoped getBucket. */
function ownsHolding(id: number): boolean {
  const row = getHolding(id);
  return !!row && !!getBucket(row.bucketId);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    const row = getHolding(Number(id));
    if (!row || !getBucket(row.bucketId)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(row);
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  return withDb(() => {
    if (!ownsHolding(Number(id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Editing a holding is sugar over the ledger: position changes write events,
    // metadata updates the row (ADR 0004).
    const existing = getHolding(Number(id));
    // A synced holding's identity is owned by its broker connection: changing its
    // source (or ticker) here would desync and split it on the next sync. Block
    // those edits; other metadata (name, class, TER, price source) stays editable.
    if (existing?.syncedBroker) {
      const changesSource = body.source !== undefined && body.source !== existing.source;
      const changesTicker =
        typeof body.ticker === "string" &&
        !!body.ticker.trim() &&
        body.ticker.trim().toLowerCase() !== existing.ticker.toLowerCase();
      if (changesSource || changesTicker) {
        return NextResponse.json(
          { error: "managed_source", broker: existing.syncedBroker },
          { status: 409 },
        );
      }
    }
    const rawPatch = {
      ticker: body.ticker,
      englishName: body.englishName,
      quoteSource: body.quoteSource,
      units: body.units == null ? undefined : Number(body.units),
      avgCost:
        body.avgCost === undefined ? undefined : body.avgCost == null ? null : Number(body.avgCost),
      source: body.source,
      thaiName: body.thaiName,
      category: body.category,
      assetClass: body.assetClass,
      region: body.region,
      ter: body.ter === undefined ? undefined : body.ter == null ? null : Number(body.ter),
    };
    const nextTicker =
      typeof body.ticker === "string" && body.ticker.trim() ? body.ticker.trim() : existing?.ticker;
    const patch =
      nextTicker && isCatalogHolding(nextTicker) ? stripCatalogOwnedFields(rawPatch) : rawPatch;
    const row = editHoldingViaLedger(Number(id), patch);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(getHolding(row.id) ?? row);
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withDb(() => {
    if (!ownsHolding(Number(id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    deleteHoldingViaLedger(Number(id));
    return new NextResponse(null, { status: 204 });
  });
}
