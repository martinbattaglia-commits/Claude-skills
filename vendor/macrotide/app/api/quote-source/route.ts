import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { catalogQuoteSource } from "@/lib/db/queries/funds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quote-source?tickers=A,B,C — resolve each ticker's price source against
// the real fund catalog, the single authority: in the catalog → "thai_mutual_fund",
// otherwise → "manual" (custom). No shape guess, no seed list. Lets the importer's
// editable table show the correct source badge on the fly for ANY symbol. Read-only
// over the shared market.db; no app.db write, so it works the same in demo and owner
// sessions.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("tickers") ?? "";
  const tickers = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (tickers.length === 0) return NextResponse.json({});
  return withDb(() => NextResponse.json(Object.fromEntries(catalogQuoteSource(tickers))));
}
