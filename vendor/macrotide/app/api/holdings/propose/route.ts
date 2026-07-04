import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { applyHoldingProposal } from "@/lib/portfolio/apply-holding-proposal";

// Accept side of the advisor holding-proposal loop. The advisor's
// `propose_holding` tool only emits a proposal (rendered as a HoldingProposalCard
// in chat); nothing is written until the user clicks Accept, which POSTs here.
// applyHoldingProposal resolves the target bucket THROUGH the per-user-scoped
// bucket queries, so a holding can only ever be attached to a bucket the caller
// owns. Rejecting just dismisses the card client-side and never reaches here.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const ticker = typeof body.ticker === "string" ? body.ticker : "";
  const englishName = typeof body.englishName === "string" ? body.englishName : "";
  const units = typeof body.units === "number" ? body.units : Number(body.units);
  if (!ticker.trim() || !Number.isFinite(units)) {
    return NextResponse.json({ error: "invalid_holding" }, { status: 400 });
  }

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null =>
    v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;

  return withDb(() => {
    const result = applyHoldingProposal({
      bucketId: str(body.bucketId),
      ticker,
      englishName,
      thaiName: str(body.thaiName),
      category: str(body.category),
      assetClass: str(body.assetClass),
      region: str(body.region),
      units,
      avgCost: num(body.avgCost),
      ter: num(body.ter),
      quoteSource: str(body.quoteSource),
      source: str(body.source),
    });

    if (!result.ok) {
      const status =
        result.error === "invalid"
          ? 400
          : result.error === "no_bucket" || result.error === "synced_duplicate"
            ? 409
            : 404;
      return NextResponse.json({ error: result.error, broker: result.broker }, { status });
    }
    return NextResponse.json(result.holding, { status: 201 });
  });
}
