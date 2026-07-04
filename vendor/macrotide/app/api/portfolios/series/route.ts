import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listEarmarks } from "@/lib/db/queries/earmarks";
import { getPortfolioSeries, type SeriesRange } from "@/lib/db/queries/series";

const VALID_RANGES: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

function parseRange(value: string | null): SeriesRange {
  if (value && (VALID_RANGES as string[]).includes(value)) return value as SeriesRange;
  return "6mo";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  return withDb(async () => {
    // Reserved cash (#149) is always carved out of the RETURN view — the series
    // decomposition needs to know which cash accounts those are.
    const reservedTickers = new Set(
      listEarmarks()
        .filter((e) => e.role === "reserved" && e.ticker)
        .map((e) => (e.ticker as string).toUpperCase()),
    );
    return NextResponse.json(await getPortfolioSeries(range, { reservedTickers }));
  });
}
