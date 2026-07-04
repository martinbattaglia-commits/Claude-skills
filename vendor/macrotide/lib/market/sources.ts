// Quote sources — the asset-class taxonomy that drives provider routing.
//
// A holding's `quote_source` column tells the registry which provider to call
// when fetching NAV / price. The values name the asset class, not the
// underlying provider — that way the registry's source→provider map can
// change (e.g. swap Yahoo for Alpha Vantage on US stocks) without re-tagging
// any holdings.
//
// The user-facing label is what the HoldingSheet's type selector shows.
// Update the label only; the wire value (string key) is a stable contract
// with the database.

// "manual" = a custom asset with no live provider; its current price comes from
// the latest market_price the user records in its ledger (see
// transaction-analytics). It has no registry Provider — valuation handles it.
// "cash" = real bank cash (issue #149); priced at 1.0 in its own currency (held
// in the holding's `currency` column), converted to THB via the FX chain. No NAV,
// no registry Provider — valuation prices it inline at 1.0 × FX.
export const QUOTE_SOURCES = ["market", "thai_mutual_fund", "manual", "cash"] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

export const QUOTE_SOURCE_LABELS: Record<QuoteSource, string> = {
  market: "Stock / ETF / Index",
  thai_mutual_fund: "Thai mutual fund",
  manual: "Custom (you set the price)",
  cash: "Cash / bank balance",
};

export const DEFAULT_QUOTE_SOURCE: QuoteSource = "market";

export function isQuoteSource(value: unknown): value is QuoteSource {
  return typeof value === "string" && (QUOTE_SOURCES as readonly string[]).includes(value);
}

// Benchmark total-return series live under their OWN source value, deliberately
// kept out of QUOTE_SOURCES: it routes provider matching (the adjusted-close
// Twelve Data provider) and namespaces the `nav_history` / `fund_quotes` cache
// rows (`benchmark_tr:ACWI`), but it is NOT a holdable asset class — leaving it
// out of QUOTE_SOURCES keeps it from leaking into the HoldingSheet selector, the
// advisor tool enums, and proposal validation. The series is a tracking ETF's
// adjusted close (dividends reinvested) as a total-return proxy, so it can be
// overlaid like-for-like against the dividend-reinvesting portfolio line.
export const BENCHMARK_TR_SOURCE = "benchmark_tr";

/**
 * The composite cache key for the `fund_quotes` / `nav_history` tables:
 * `${source}:${TICKER}`. The ticker is normalized to trimmed UPPER case so the
 * SAME row is hit no matter the stored case — a lowercase-cataloged fund (ttb
 * SSF/RMF family) and a ledger ticker stored in its official catalog case must
 * resolve to one key, or a value-only Balance can never find its NAV and silently
 * drops from holdings (#134). The source is a fixed lowercase taxonomy value and
 * is left as-is; only the ticker is normalized. (Tickers are STORED in catalog
 * case now (#235); `tickerKey` is the matching-side twin of this normalization.)
 *
 * Every writer and reader of those tables MUST build the key through here — the
 * casing only stays consistent if there is exactly one builder.
 */
export function quoteCacheKey(source: string, ticker: string): string {
  return `${source}:${ticker.trim().toUpperCase()}`;
}

/**
 * The canonical comparison key for a ticker: trimmed + upper-cased. Tickers are
 * STORED in their official catalog case (a cataloged fund keeps the SEC's
 * `abbr_name` case; a custom asset keeps what the user typed), so any equality,
 * Set membership, or Map keying that must match two tickers regardless of case
 * MUST go through here — never compare raw `.ticker` strings. This is the single
 * comparison chokepoint, the read-side twin of `quoteCacheKey`'s write-side
 * normalization. (Stored case is for display; matching is always case-folded.)
 */
export function tickerKey(ticker: string): string {
  return ticker.trim().toUpperCase();
}
