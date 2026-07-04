import "server-only";
import { appDb } from "@/lib/db/client";
import { holdings } from "@/lib/db/schema";
import { refreshSymbols } from "@/lib/market/cache";
import { BASE_CURRENCY, inferHoldingCurrency } from "@/lib/market/currency";
import { INDICATOR_CATALOG } from "@/lib/market/indicators";
import type { SeriesRange } from "@/lib/market/providers/types";
import { quoteCacheKey } from "@/lib/market/sources";

interface SymbolRef {
  source: string;
  ticker: string;
}

/** The distinct native currencies of the held positions: a security infers
 * from its symbol, cash carries its own `currency`. Drives which FX series to warm. */
function listHeldCurrencies(): string[] {
  const set = new Set<string>();
  for (const r of appDb
    .selectDistinct({
      source: holdings.quoteSource,
      ticker: holdings.ticker,
      currency: holdings.currency,
    })
    .from(holdings)
    .all()) {
    set.add(inferHoldingCurrency(r.source, r.ticker, r.currency));
  }
  return [...set];
}

/**
 * The FX series a foreign holding's value fold needs. Every conversion runs
 * through USD→THB (`THB=X`); a non-USD foreign currency C also needs its USD cross
 * series (`C=X`) for `C→THB = (USD→THB)/(USD→C)`. Warmed at `max` alongside the held
 * NAV so a foreign holding's baht chart is as deep and fresh as its native NAV —
 * covering both the daily refresh and the historical backfill in one pass.
 */
function fxRefsForCurrencies(currencies: string[]): SymbolRef[] {
  const foreign = currencies.filter((c) => c && c !== BASE_CURRENCY);
  if (foreign.length === 0) return [];
  const tickers = new Set<string>(["THB=X"]);
  for (const c of foreign) if (c !== "USD") tickers.add(`${c}=X`);
  return [...tickers].map((ticker) => ({ source: "market", ticker }));
}

export interface RefreshTrackedMarketResult {
  /** Distinct (source, ticker) refs refreshed after de-dup. */
  requested: number;
  ok: number;
  failed: number;
  errors: Array<{ source: string; ticker: string; error?: string }>;
}

/** Distinct (source, ticker) of every held position. quote_source is explicit on
 * holdings, so routing never guesses by ticker shape. */
function listHeldRefs(): SymbolRef[] {
  return appDb
    .selectDistinct({ source: holdings.quoteSource, ticker: holdings.ticker })
    .from(holdings)
    .all()
    .map((r) => ({ source: r.source, ticker: r.ticker }));
}

export interface RefreshTrackedMarketOptions {
  /** Depth for indicators + held funds. Held `market` positions always warm to
   * `max` regardless (see below). Default "6mo". */
  range?: SeriesRange;
  /** Test seam — enumerate held refs. */
  _listHeld?: () => SymbolRef[];
  /** Test seam — enumerate held currencies. */
  _listHeldCurrencies?: () => string[];
  /** Test seam — refresh a batch of refs. */
  _refreshSymbols?: typeof refreshSymbols;
}

/**
 * Refresh the cached NAV/quote for everything the app *actively tracks*: every
 * indicator in `INDICATOR_CATALOG` (the `market` provider chain) plus every
 * distinct held position (routed by its own `quote_source`). De-dups by
 * `${source}:${ticker}` so a held index isn't fetched twice.
 *
 * This is the **freshness** job (issue #23): bounded to what's tracked, it runs
 * on a daily timer so charts are current without a user trigger. It is distinct
 * from `prewarmNav` (issue #104), the heavy **coverage** crawl that warms NAV
 * for the *whole* fund catalog. Keep the boundary: this one never enumerates the
 * catalog.
 *
 * **Depth split.** Held `market`-sourced positions (a foreign ETF, gold, an
 * index held as a position) are warmed to `max`; indicators and held funds stay
 * at the shallow default. A held fund is deepened by `prewarmNav`, and an
 * indicator only needs a recent window for the Markets screen — but a held
 * non-fund position has *no* coverage job of its own, so the portfolio "All"
 * chart's depth for it rides on this pass. Warming it here means a cold first
 * "All" open is already deep instead of paying an on-demand backfill. This keeps
 * the freshness/coverage boundary intact: the boundary is about *scope* (never
 * enumerate the catalog), not depth — held refs are still only what's tracked.
 *
 * The deep batch is built first so that a symbol that is both held-as-market and
 * a catalog indicator claims the `max` slot before the shallow indicator
 * duplicate is de-duped away. (After day one the cache's `widerRange` protects
 * recorded depth regardless; the ordering only matters for the cold first run.)
 *
 * Shared by the admin `refresh-market` route and the scheduled job script so the
 * symbol-set logic lives in exactly one place. Reads the owner app.db directly
 * (no request context) — correct for both the owner-only admin route and the CLI
 * job; demo sessions are never refreshed by a schedule.
 */
export async function refreshTrackedMarket(
  opts: RefreshTrackedMarketOptions = {},
): Promise<RefreshTrackedMarketResult> {
  const shallowRange = opts.range ?? "6mo";
  const refresh = opts._refreshSymbols ?? refreshSymbols;
  const listHeld = opts._listHeld ?? listHeldRefs;
  const listCurrencies = opts._listHeldCurrencies ?? listHeldCurrencies;

  const indexRefs: SymbolRef[] = INDICATOR_CATALOG.map((i) => ({
    source: "market",
    ticker: i.symbol,
  }));
  const heldRefs = listHeld();

  const seen = new Set<string>();
  const dedupe = (refs: SymbolRef[]): SymbolRef[] =>
    refs.filter((r) => {
      const k = quoteCacheKey(r.source, r.ticker);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // Deep first (held market positions + the FX series their baht chart needs → max),
  // then the shallow rest (indicators + held funds/manual). De-dup is shared across
  // both, so the deep claim wins.
  const deepRefs = dedupe([
    ...heldRefs.filter((r) => r.source === "market"),
    ...fxRefsForCurrencies(listCurrencies()),
  ]);
  const shallowRefs = dedupe([...indexRefs, ...heldRefs.filter((r) => r.source !== "market")]);

  const deepResults = deepRefs.length > 0 ? await refresh(deepRefs, "max") : [];
  const shallowResults = shallowRefs.length > 0 ? await refresh(shallowRefs, shallowRange) : [];
  const results = [...deepResults, ...shallowResults];

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  return {
    requested: results.length,
    ok,
    failed: failed.length,
    errors: failed.map((f) => ({ source: f.source, ticker: f.ticker, error: f.error })),
  };
}
