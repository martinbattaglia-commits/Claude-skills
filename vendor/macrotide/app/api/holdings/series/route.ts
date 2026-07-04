import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getHoldingValueSeries, type SeriesRange } from "@/lib/db/queries/series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

function parseRange(value: string | null): SeriesRange {
  if (value && (VALID_RANGES as string[]).includes(value)) return value as SeriesRange;
  return "6mo";
}

// GET /api/holdings/series?ticker=SYM&range=6mo
//
// Value-over-time for a single holding (units × NAV × fx per date) plus its
// cost-basis line, scoped to the caller's buckets. The ledger replay is the
// per-position slice of the portfolio chart (ADR 0005); getHoldingValueSeries
// folds the instrument across every bucket it appears in.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker")?.trim();
  const range = parseRange(url.searchParams.get("range"));
  if (!ticker) return NextResponse.json({ error: "ticker_required" }, { status: 400 });
  return withDb(async () => NextResponse.json(await getHoldingValueSeries(ticker, range)));
}
