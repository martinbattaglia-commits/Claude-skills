import "server-only";
import { and, inArray, lte, sql } from "drizzle-orm";
import { getMarketDb } from "../context";
import { fundQuotes, navHistory } from "../schema";

export type FundQuote = typeof fundQuotes.$inferSelect;
export type FundQuoteInsert = typeof fundQuotes.$inferInsert;

export function listFundQuotes(tickers?: string[]): FundQuote[] {
  const q = getMarketDb().select().from(fundQuotes);
  return (tickers?.length ? q.where(inArray(fundQuotes.ticker, tickers)) : q).all();
}

/**
 * NAV on or before `date` for each cache key — the most recent `nav_history` row
 * with `date <= date`. The divisor for deriving units from a dated value (#130):
 * a holding's unit count is fixed to its date, so a value stated for a past date
 * must divide by THAT date's NAV, never today's moving NAV (pairing them makes
 * the unit count drift). A "right now" Balance's date is today, so this returns
 * the latest historical NAV — the same rule, no special case.
 *
 * Keys are the combined `${source}:${ticker}` cache keys (see lib/market/cache.ts).
 * Missing keys are simply absent from the map; callers fall back to the latest
 * quote (fund_quotes) or flag the row needs-units.
 */
export function navOnDate(keys: string[], date: string): Map<string, number> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  // One grouped query: max(date) ≤ target per ticker, with its bare `nav` (SQLite's
  // documented "bare column travels with the aggregate's row" rule — same pattern
  // as the series carry-in read).
  const rows = getMarketDb()
    .select({
      ticker: navHistory.ticker,
      date: sql<string>`max(${navHistory.date})`.as("d"),
      nav: navHistory.nav,
    })
    .from(navHistory)
    .where(and(inArray(navHistory.ticker, keys), lte(navHistory.date, date)))
    .groupBy(navHistory.ticker)
    .all();
  for (const r of rows) if (r.nav > 0) out.set(r.ticker, r.nav);
  return out;
}

/**
 * Batched {@link navOnDate}: the latest NAV at-or-before EACH of several dates, per
 * ticker. A fold resolves derived units across every distinct trade date in the
 * ledger — calling navOnDate per date is a query-per-date loop that, on a long
 * history, blocks the event loop for ~100ms. This pulls each ticker's history up to
 * the latest needed date in ONE scan, then walks it in memory to answer every date.
 *
 * Result mirrors a Map of navOnDate results: `date → (ticker → nav)`, with an entry
 * for every requested date (empty inner map when nothing resolves). Matches navOnDate
 * exactly — only the row at the latest date ≤ target counts, and a non-positive NAV
 * there yields no entry (never falls back to an earlier row).
 */
export function navOnDates(keys: string[], dates: string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const d of dates) out.set(d, new Map());
  if (keys.length === 0 || dates.length === 0) return out;

  const maxDate = dates.reduce((m, d) => (d > m ? d : m));
  const rows = getMarketDb()
    .select({ ticker: navHistory.ticker, date: navHistory.date, nav: navHistory.nav })
    .from(navHistory)
    .where(and(inArray(navHistory.ticker, keys), lte(navHistory.date, maxDate)))
    .orderBy(navHistory.ticker, navHistory.date)
    .all();

  // Ascending (date, nav) per ticker.
  const series = new Map<string, { date: string; nav: number }[]>();
  for (const r of rows) {
    const s = series.get(r.ticker);
    if (s) s.push({ date: r.date, nav: r.nav });
    else series.set(r.ticker, [{ date: r.date, nav: r.nav }]);
  }

  // For each ticker, walk its ascending series once across the ascending target
  // dates — a single forward pointer answers every date (latest row with date ≤ it).
  const sortedDates = [...dates].sort();
  for (const [ticker, s] of series) {
    let i = -1;
    for (const target of sortedDates) {
      while (i + 1 < s.length && s[i + 1].date <= target) i++;
      if (i >= 0 && s[i].nav > 0) out.get(target)?.set(ticker, s[i].nav);
    }
  }
  return out;
}

export function upsertFundQuote(input: FundQuoteInsert): FundQuote {
  return getMarketDb()
    .insert(fundQuotes)
    .values(input)
    .onConflictDoUpdate({
      target: fundQuotes.ticker,
      set: {
        nav: input.nav,
        d1Pct: input.d1Pct,
        ytdPct: input.ytdPct,
        y1Pct: input.y1Pct,
        updatedAt: input.updatedAt,
      },
    })
    .returning()
    .get();
}
