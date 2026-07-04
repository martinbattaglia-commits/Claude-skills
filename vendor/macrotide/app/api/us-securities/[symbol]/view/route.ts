// POST /api/us-securities/[symbol]/view — record a real user view of a US security
// AND JIT-warm its detail data (fire-and-forget from the detail sheet on open).
// Bumps the demand counter that seeds the popular-prewarm warm set, then warms
// profile/fundamentals/dividends/holdings for the cold tail so a niche ticker's
// page self-heals within a couple seconds (the client revalidates the GET).
// Deliberately a SEPARATE endpoint from the series GET so the chart's SWR cache key
// stays param-free and prefetch-warmed — a prefetch never counts as demand or
// warms, only an actual open does.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { bumpUsSymbolDemand } from "@/lib/db/queries/us-securities";
import { warmUsSecurity } from "@/lib/jobs/warm-us-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  return withDb(async () => {
    bumpUsSymbolDemand(symbol);
    // Stale-gated: a no-op once warm. The client doesn't await this POST, so the
    // fetch latency on a cold ticker doesn't block the UI.
    await warmUsSecurity(symbol);
    return NextResponse.json({ ok: true });
  });
}
