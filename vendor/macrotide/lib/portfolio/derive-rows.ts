import "server-only";
import { catalogQuoteSource } from "@/lib/db/queries/funds";
import { listFundQuotes, navOnDate } from "@/lib/db/queries/quotes";
import { type QuoteSource, quoteCacheKey } from "@/lib/market/sources";
import { type DerivedRow, deriveRow, type ExtractedRow } from "./ocr";

// The composite `${source}:${TICKER}` cache key for `fund_quotes` / `nav_history`
// is canonical in lib/market/sources.ts — re-exported here for the existing
// callers and tests that import it from this module.
export { quoteCacheKey };

// Shared NAV-derivation for extracted holding rows. Both the image-import route
// (POST /api/import/image) and the advisor's `propose_holdings_import` tool turn
// raw vision-extracted rows into NAV-derived rows for the confirmation table, so
// the units/avgCost math (and the cache-key lookup it depends on) lives here once
// rather than being duplicated. Prices each row off the NAV on the snapshot's OWN
// date (#130) — `nav_history` on-or-before `asOf` — so a dated statement's units
// don't drift against today's moving NAV; falls back to the latest quote
// (fund_quotes) when no dated NAV is on file (or no date was read). Rows we still
// can't price come back with `needsUnits` set so the UI asks the user to fill them
// in. See deriveRow (lib/portfolio/ocr.ts) for the per-row precedence rules.

/**
 * Derive units/avgCost for each extracted row from the NAV on the snapshot's own
 * date (#130), falling back to the latest NAV on file. Server-only — reads
 * market.db through the request's DB context.
 *
 * @param rows  extracted holding rows
 * @param asOf  the snapshot's as-of date (ISO); prices each row off NAV(asOf).
 *              Omit / empty for a "right now" snapshot → uses the latest quote.
 */
export function deriveRowsWithNav(rows: ExtractedRow[], asOf?: string): DerivedRow[] {
  if (rows.length === 0) return [];

  // The REAL catalog is the single source authority — and it also drives the NAV
  // cache key, so a real fund's NAV (cached under thai_mutual_fund:TICKER) is found
  // and a custom asset (manual:TICKER, no NAV on file) simply isn't. No shape guess.
  const catSource = catalogQuoteSource(rows.map((r) => r.ticker));
  const sourceOf = (t: string): QuoteSource => catSource.get(t.trim().toUpperCase()) ?? "manual";

  // fund_quotes / nav_history are keyed by the combined "source:ticker" cache key,
  // not the bare symbol — build the same key per row so the NAV lookups hit.
  const keys = rows.map((r) => quoteCacheKey(sourceOf(r.ticker), r.ticker));

  // Prefer NAV on the snapshot's own date; fall back to the latest quote per key.
  const datedNav = asOf?.trim() ? navOnDate(keys, asOf) : new Map<string, number>();
  const latestNav = new Map<string, number>();
  for (const q of listFundQuotes(keys)) {
    if (q.nav > 0) latestNav.set(q.ticker, q.nav);
  }

  return rows.map((r) => {
    const key = quoteCacheKey(sourceOf(r.ticker), r.ticker);
    const out = deriveRow(r, datedNav.get(key) ?? latestNav.get(key));
    return { ...out, quoteSource: sourceOf(r.ticker) };
  });
}
