import type { QuoteSource } from "@/lib/market/sources";

// Client-side resolver for a typed symbol's price-source badge, backed by the REAL
// fund catalog via GET /api/quote-source (lib/db/queries/funds.ts `catalogQuoteSource`
// — in the catalog → its fund source, else `manual`/custom; no shape guess, no seed).
//
// One process-wide cache shared by BOTH inline editors (the Add modal + the History
// editor) so a hand-typed symbol resolves to the SAME badge in each — picking a
// suggestion already sets the source; this covers the case where the user types a
// catalog code without picking it. Keyed by UPPER-CASED ticker.

const cache = new Map<string, QuoteSource>();
const norm = (ticker: string): string => ticker.trim().toUpperCase();

/** The cached source for a ticker, or undefined if not yet resolved. */
export function cachedQuoteSource(ticker: string): QuoteSource | undefined {
  return cache.get(norm(ticker));
}

/**
 * Resolve any not-yet-cached tickers against the catalog and populate the shared
 * cache. Best-effort: a failed fetch leaves them unresolved (the `manual` default
 * stands) and they retry on the next call. Returns true if the cache gained an
 * entry, so the caller knows to re-apply the now-known sources.
 */
export async function resolveQuoteSources(tickers: string[]): Promise<boolean> {
  const pending = [...new Set(tickers.map(norm).filter((t) => t && !cache.has(t)))];
  if (pending.length === 0) return false;
  try {
    const res = await fetch(`/api/quote-source?tickers=${encodeURIComponent(pending.join(","))}`);
    if (!res.ok) return false;
    const map = (await res.json()) as Record<string, QuoteSource>;
    let gained = false;
    for (const [t, s] of Object.entries(map)) {
      cache.set(norm(t), s);
      gained = true;
    }
    return gained;
  } catch {
    return false;
  }
}
