// US dividend refresh — pull each symbol's cash-dividend history from Alpaca and
// store it for the detail page + trailing yield. Bounded nightly (popularity-first)
// for the hot set; the detail API calls `ensureDividends` to JIT-fill on open.

import "server-only";
import {
  getDividends,
  listSymbolsToRefreshDividends,
  setDividends,
} from "../db/queries/us-dividends";
import { type DividendFetch, fetchDividends } from "../market/corporate-actions";
import { mapPool } from "./map-pool";

export interface RefreshDividendsResult {
  selected: number;
  withDividends: number;
  /** Symbols whose fetch failed / had no creds — left stale to retry. */
  errored: number;
}

export interface RefreshDividendsOptions {
  limit?: number;
  symbols?: string[];
  staleBefore?: string;
  fetchedAt?: string;
  concurrency?: number;
  /** Test seam; defaults to the live Alpaca fetch. */
  getDividendsFor?: (symbol: string) => Promise<DividendFetch>;
}

export async function refreshDividends(
  opts: RefreshDividendsOptions = {},
): Promise<RefreshDividendsResult> {
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const limit = opts.limit ?? 50;
  const symbols =
    opts.symbols ?? listSymbolsToRefreshDividends(limit, { staleBefore: opts.staleBefore });
  if (symbols.length === 0) return { selected: 0, withDividends: 0, errored: 0 };

  const get = opts.getDividendsFor ?? ((s: string) => fetchDividends(s));
  let withDividends = 0;
  let errored = 0;
  await mapPool(symbols, opts.concurrency ?? 4, async (symbol) => {
    const res = await get(symbol);
    if (!res.fetched) {
      // No creds / transient failure — don't cache (an empty would wrongly read as
      // "no dividends"); leave it stale so the next run / JIT open retries.
      errored++;
      return;
    }
    // A 2xx, even if empty (a genuine non-payer) → cache + stamp.
    setDividends(symbol, res.dividends, fetchedAt);
    if (res.dividends.length > 0) withDividends++;
  });
  return { selected: symbols.length, withDividends, errored };
}

/**
 * JIT fill on detail open: fetch now if the symbol's dividends are missing or
 * older than `maxAgeDays` (default 7 — dividends change more often than holdings),
 * else no-op.
 */
export async function ensureDividends(
  symbol: string,
  opts: {
    maxAgeDays?: number;
    fetchedAt?: string;
    getDividendsFor?: RefreshDividendsOptions["getDividendsFor"];
  } = {},
): Promise<void> {
  const cur = getDividends(symbol);
  const maxAgeMs = (opts.maxAgeDays ?? 7) * 86_400_000;
  const fetchedAtMs = cur.fetchedAt ? Date.parse(cur.fetchedAt) : Number.NaN;
  const fresh = Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < maxAgeMs;
  if (cur.fetchedAt && fresh) return;
  await refreshDividends({
    symbols: [symbol],
    fetchedAt: opts.fetchedAt,
    getDividendsFor: opts.getDividendsFor,
  });
}
