// Symbol-field autocomplete suggestions. The pool is the USER'S OWN HOLDINGS — real
// symbols they already track. Live catalog funds are fetched separately by
// SymbolCombobox (GET /api/fund-classes). There is NO static seed list: the central
// fund catalog is the single authority for what exists and how it's priced (today
// Thai funds; stocks/ETFs/etc. join the same catalog later). A symbol the catalog
// doesn't know is a custom (self-priced) asset — never a shape guess.

import type { QuoteSource } from "@/lib/market/sources";

/** One autocomplete suggestion. Today every suggestion comes from the user's holdings. */
export interface TickerSuggestion {
  ticker: string;
  name: string;
  quote_source: QuoteSource;
  /** From the user's own holdings (vs. a live catalog row, merged in by the combobox). */
  fromHoldings?: boolean;
}

const normalize = (s: string) => s.trim().toLowerCase();

const asQuoteSource = (s: string): QuoteSource =>
  s === "thai_mutual_fund" || s === "market" || s === "manual" ? s : "manual";

/**
 * Case-insensitive substring filter over ticker OR name.
 *
 * - Empty / whitespace-only query returns the input list unchanged.
 * - Matches are ranked: ticker-prefix matches first, then ticker-substring,
 *   then name-substring. User-holdings entries break ties (so prior entries
 *   surface first). The `limit` caps the dropdown so it stays scannable.
 */
export function filterKnownTickers(
  list: readonly TickerSuggestion[],
  query: string,
  limit = 8,
): TickerSuggestion[] {
  const q = normalize(query);
  if (!q) return list.slice(0, limit);

  const scored: { entry: TickerSuggestion; score: number }[] = [];
  for (const entry of list) {
    const ticker = normalize(entry.ticker);
    const name = normalize(entry.name);
    let score = -1;
    if (ticker.startsWith(q)) score = 0;
    else if (ticker.includes(q)) score = 1;
    else if (name.includes(q)) score = 2;
    if (score === -1) continue;
    // Holdings tie-break: subtract a tiny epsilon so they sort ahead within tier.
    if (entry.fromHoldings) score -= 0.5;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * The user's own holdings as autocomplete suggestions, deduped by ticker and
 * carrying each holding's persisted `englishName` / `quote_source`.
 */
export function mergeWithHoldings(
  holdings: readonly { ticker: string; englishName: string; quoteSource: string }[],
): TickerSuggestion[] {
  const seen = new Set<string>();
  const out: TickerSuggestion[] = [];
  for (const h of holdings) {
    const key = h.ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ticker: h.ticker,
      name: h.englishName,
      quote_source: asQuoteSource(h.quoteSource),
      fromHoldings: true,
    });
  }
  return out;
}
