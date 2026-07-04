import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { listHeldQuoteRefs } from "@/lib/db/queries/holdings";
import { listFundQuotes } from "@/lib/db/queries/quotes";
import { getCachedSeries } from "@/lib/market/cache";
import { quoteCacheKey } from "@/lib/market/sources";

interface QuoteResult {
  source: string;
  ticker: string;
  ok: boolean;
  price?: number;
  previousClose?: number;
  asOf?: string;
  error?: string;
}

/**
 * Each `refs` parameter value is a `source:ticker` pair. Examples:
 *   refs=market:AAPL,market:^GSPC
 *   refs=thai_mutual_fund:K-FIXED-A
 *
 * Without `refresh=1`, returns the raw cached fund_quotes rows for the
 * matching keys (read-only, no network calls).
 * With `refresh=1`, dispatches each ref through its provider, populates
 * the cache, and returns normalized post-fetch state.
 * With `refresh=1&mine=1`, derives the refs from the caller's holdings
 * server-side — the client can fire this in parallel with its holdings
 * fetch instead of waterfalling refs through it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const refsParam = url.searchParams.get("refs");
  const refresh = url.searchParams.get("refresh") === "1";
  const mine = url.searchParams.get("mine") === "1";

  const refs = refsParam
    ? refsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseRef)
        .filter((r): r is { source: string; ticker: string } => r !== null)
    : [];

  if (!refresh) {
    const keys = refs.map((r) => quoteCacheKey(r.source, r.ticker));
    return withDb(() => NextResponse.json(listFundQuotes(keys.length ? keys : undefined)));
  }

  if (refs.length === 0 && !mine) {
    return NextResponse.json({ error: "refs query parameter required" }, { status: 400 });
  }

  return withDb(async () => {
    const targets = mine ? listHeldQuoteRefs() : refs;
    const results = await Promise.allSettled(
      targets.map(async (ref): Promise<QuoteResult> => {
        const cached = await getCachedSeries(ref.source, ref.ticker, "6mo", "1d");
        if (!cached.quote) {
          return { ...ref, ok: false, error: "no data" };
        }
        return {
          ...ref,
          ok: true,
          price: cached.quote.price,
          previousClose: cached.quote.previousClose,
          asOf: cached.quote.asOf,
        };
      }),
    );

    const payload: QuoteResult[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        ...targets[i],
        ok: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    return NextResponse.json(payload);
  });
}

function parseRef(value: string): { source: string; ticker: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) return null;
  return { source: value.slice(0, idx), ticker: value.slice(idx + 1) };
}
