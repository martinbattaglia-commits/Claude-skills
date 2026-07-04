// GET /api/us-securities/[symbol] — the full US detail payload (cache-first).
//
// Returns { security, price, dividends, holdings } — catalog row (profile/sector/
// ratios/TER/index membership), latest price, dividend history + trailing yield,
// and (ETFs only) holdings + country/asset exposure. Whatever is cached NOW; the
// detail open also POSTs /view to JIT-warm the cold tail, then the client
// revalidates. 404 when the symbol isn't catalogued.

import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getUsSecurityDetail } from "@/lib/db/queries/us-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  return withDb(() => {
    const detail = getUsSecurityDetail(symbol);
    if (!detail) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  });
}
