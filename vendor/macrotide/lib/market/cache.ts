import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getMarketDb } from "@/lib/db/context";
import { fundQuotes, navHistory } from "@/lib/db/schema";
import { rangeStartDate, type SeriesInterval, type SeriesRange } from "./providers/types";
import { resolveProviderChain } from "./registry";
import { quoteCacheKey } from "./sources";

// Cache freshness. One TTL governs each cached entry — both the daily series and
// the latest quote derived from it — so a quote refreshes at most once a day.
//
// The window is set by provider quotas, not by how often prices move. The
// `market` logical source resolves to real-index providers with small free quotas
// (FMP ~250/day, EODHD ~20/day; see providers/{fmp,eodhd}.ts), and the keyless
// Yahoo fallback returns 429 from datacenter IPs. At 24h that is ~1 fetch/day per
// symbol, within quota; a 5-minute TTL would be ~288/day per symbol, past EODHD's
// and FMP's limits, leaving only the rate-limited Yahoo fallback. Shortening it
// therefore depends on a higher-quota or unblocked provider, not on the TTL
// alone. See docs/reference/auth-and-providers.md § Cache freshness.
const CACHE_TTL_MS = 24 * 60 * 60_000; // 24h; one window for series + quote
const FAIL_BACKOFF_MS = 3 * 60_000; // after an upstream error, don't refetch this key for 3 min

// Negative cache: last upstream-failure time per (source:ticker) key. Stops a
// 429'd symbol from being re-hit on every page load — that hammer-loop is what
// provokes more 429s. Process-local; resets on restart, which is fine.
const recentFailures = new Map<string, number>();

// The cache table (fund_quotes / nav_history) is keyed by a single TEXT column
// called `ticker` for historical reasons. We namespace inserts by combining
// source + ticker into one key string, built by the canonical `quoteCacheKey`
// (lib/market/sources.ts) so write keys match the fold's read keys exactly. The
// combined key is internal — never returned to the UI.
const cacheKey = quoteCacheKey;

function isFresh(updatedAt: string, ttlMs: number): boolean {
  return Date.now() - new Date(updatedAt).getTime() < ttlMs;
}

// Series ranges ordered shallow → deep. Used to decide whether a cached series
// already covers a requested range, and to record the deepest range fetched.
const RANGE_ORDER: SeriesRange[] = ["1mo", "3mo", "6mo", "1y", "5y", "max"];

function rangeRank(range: string | null | undefined): number {
  // Legacy rows (null `deepest_range`) predate depth tracking; treat them as the
  // historical "6mo" default so a wider request deepens them instead of serving
  // a shallow window. An unrecognized value falls back to "6mo" too.
  const idx = RANGE_ORDER.indexOf((range ?? "6mo") as SeriesRange);
  return idx < 0 ? RANGE_ORDER.indexOf("6mo") : idx;
}

/** True if a series cached at `stored` depth already covers a `requested` range. */
function rangeCovers(stored: string | null | undefined, requested: SeriesRange): boolean {
  return rangeRank(stored) >= rangeRank(requested);
}

/** The deeper of two ranges (used to never shrink the recorded depth). */
function widerRange(a: string | null | undefined, b: SeriesRange): SeriesRange {
  return a && rangeRank(a) >= rangeRank(b) ? (a as SeriesRange) : b;
}

function yyyyMmDd(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export interface CachedSeries {
  /** Original ticker, as caller passed in. */
  ticker: string;
  series: { date: string; close: number; netAsset?: number | null }[];
  /** Most recent value (mirrors fund_quotes). */
  quote: {
    price: number;
    previousClose: number;
    asOf: string;
  } | null;
}

/**
 * Return cached daily series for `(source, ticker)` if it's <24h old,
 * otherwise refetch from the resolved provider and upsert into nav_history +
 * fund_quotes. The cached version is always preferred to keep upstream load
 * minimal.
 */
export async function getCachedSeries(
  source: string,
  ticker: string,
  range: SeriesRange = "6mo",
  interval: SeriesInterval = "1d",
  // Bypass the freshness gate and refetch even if the cached quote is <24h old.
  // Unlike marking the row stale, this leaves `updatedAt` untouched, so a refetch
  // that fails (upstream empty/down) preserves the real last-success timestamp
  // instead of stranding the row at the epoch sentinel.
  force = false,
): Promise<CachedSeries> {
  // The market cache lives in market.db, which demo sessions share with real
  // users — reads and write-through fills are identical. A symbol fetched once
  // serves every later session (demo or not), so demo adds no redundant
  // upstream calls. (Demo isolation is in app.db, which is per-session; market
  // data is global reference data, safe and beneficial to share.)
  const db = getMarketDb();
  const key = cacheKey(source, ticker);
  const cachedQuote = db.select().from(fundQuotes).where(eq(fundQuotes.ticker, key)).get();

  // Serve from cache only when it's fresh AND already deep enough for this
  // request. A wider range than we've stored (e.g. "All" on a fund only ever
  // fetched at 6mo) falls through to a refetch even while the quote is fresh, so
  // history deepens on demand rather than returning a shallow cached window.
  if (
    cachedQuote &&
    !force &&
    isFresh(cachedQuote.updatedAt, CACHE_TTL_MS) &&
    rangeCovers(cachedQuote.deepestRange, range)
  ) {
    return readCached(db, key, ticker, range, cachedQuote);
  }

  // Skip the live call if this key failed within the backoff window — serve
  // stale if we have it, otherwise surface the outage.
  const lastFail = recentFailures.get(key);
  const backingOff = lastFail !== undefined && Date.now() - lastFail < FAIL_BACKOFF_MS;

  if (!backingOff) {
    // Try each matching provider in preference order — keyed source first,
    // keyless fallback next — so one upstream's outage (e.g. Yahoo 429) doesn't
    // blank the symbol when another source can serve it.
    const chain = resolveProviderChain(source, ticker);
    if (chain.length === 0) {
      throw new Error(`No provider matches source="${source}", ticker="${ticker}"`);
    }
    let lastErr: unknown;
    for (const provider of chain) {
      try {
        const fresh = await provider.fetchSeries(ticker, range, interval);
        if (fresh.series.length === 0) {
          lastErr = new Error(`${provider.id} returned no data for ${ticker}`);
          continue; // empty result — try the next provider
        }
        recentFailures.delete(key);
        // Record the deepest range we've fetched so a fresh-but-shallow cache
        // still deepens on a wider request; never shrink it (nightly 6mo
        // refreshes keep a prior "max" depth).
        const deepest = widerRange(cachedQuote?.deepestRange, range);
        return persistFresh(db, key, ticker, fresh, deepest);
      } catch (err) {
        lastErr = err; // upstream failed — fall through to the next provider
      }
    }
    // Every provider failed. Back off this key, then serve the last good values
    // rather than blanking the symbol; only surface the error on a cold cache.
    recentFailures.set(key, Date.now());
    if (!cachedQuote) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  if (cachedQuote) return readCached(db, key, ticker, range, cachedQuote);
  throw new Error(`No cached data for ${key}; upstream is backing off`);
}

/** Read the cached series + quote for a key (used for fresh and stale serves). */
function readCached(
  db: ReturnType<typeof getMarketDb>,
  key: string,
  ticker: string,
  range: SeriesRange,
  cachedQuote: { nav: number; d1Pct: number | null; updatedAt: string },
): CachedSeries {
  const sinceDate = rangeStartDate(range);
  const rows = db
    .select()
    .from(navHistory)
    .where(and(eq(navHistory.ticker, key), gte(navHistory.date, sinceDate)))
    .orderBy(navHistory.date)
    .all();
  return {
    ticker,
    series: rows.map((r) => ({ date: r.date, close: r.nav, netAsset: r.netAsset })),
    quote: {
      price: cachedQuote.nav,
      // d1Pct is a PERCENTAGE (×100 at persist time) — invert the day change,
      // don't subtract percentage points from a price.
      previousClose:
        cachedQuote.d1Pct != null
          ? cachedQuote.nav / (1 + cachedQuote.d1Pct / 100)
          : cachedQuote.nav,
      asOf: cachedQuote.updatedAt,
    },
  };
}

/** Upsert a freshly-fetched series into the cache and return it. */
function persistFresh(
  db: ReturnType<typeof getMarketDb>,
  key: string,
  ticker: string,
  fresh: {
    quote: { price: number; previousClose: number };
    series: { t: number; close: number; netAsset?: number | null }[];
  },
  deepestRange: SeriesRange,
): CachedSeries {
  if (fresh.series.length === 0) {
    return { ticker, series: [], quote: null };
  }

  const updatedAt = new Date().toISOString();
  const latest = fresh.series.at(-1);
  const prev = fresh.series.length > 1 ? fresh.series.at(-2) : null;
  const d1Pct = latest && prev ? ((latest.close - prev.close) / prev.close) * 100 : null;
  const ytdPct = computeYtdPct(fresh.series);
  const y1Pct = computeReturnPct(fresh.series, 365);

  db.insert(fundQuotes)
    .values({
      ticker: key,
      nav: fresh.quote.price,
      d1Pct,
      ytdPct,
      y1Pct,
      updatedAt,
      deepestRange,
    })
    .onConflictDoUpdate({
      target: fundQuotes.ticker,
      set: {
        nav: fresh.quote.price,
        d1Pct,
        ytdPct,
        y1Pct,
        updatedAt,
        deepestRange,
      },
    })
    .run();

  for (const p of fresh.series) {
    const date = yyyyMmDd(p.t);
    db.insert(navHistory)
      .values({ ticker: key, date, nav: p.close, netAsset: p.netAsset ?? null })
      .onConflictDoUpdate({
        target: [navHistory.ticker, navHistory.date],
        set: { nav: p.close, netAsset: p.netAsset ?? null },
      })
      .run();
  }

  return {
    ticker,
    series: fresh.series.map((p) => ({
      date: yyyyMmDd(p.t),
      close: p.close,
      netAsset: p.netAsset ?? null,
    })),
    quote: {
      price: fresh.quote.price,
      previousClose: fresh.quote.previousClose,
      asOf: updatedAt,
    },
  };
}

function computeYtdPct(series: { close: number; t: number }[]): number | null {
  if (series.length < 2) return null;
  const year = new Date().getUTCFullYear();
  const yearStart = series.find((p) => new Date(p.t * 1000).getUTCFullYear() === year);
  if (!yearStart) return null;
  const latest = series[series.length - 1];
  return ((latest.close - yearStart.close) / yearStart.close) * 100;
}

function computeReturnPct(series: { close: number; t: number }[], days: number): number | null {
  if (series.length < 2) return null;
  const cutoff = Date.now() / 1000 - days * 86400;
  const start = series.find((p) => p.t >= cutoff);
  if (!start) return null;
  const latest = series[series.length - 1];
  return ((latest.close - start.close) / start.close) * 100;
}

/**
 * Force-refresh a set of holdings. Each is fetched independently — a single
 * failure doesn't abort the rest.
 */
export async function refreshSymbols(
  refs: Array<{ source: string; ticker: string }>,
  range: SeriesRange = "6mo",
): Promise<{ source: string; ticker: string; ok: boolean; error?: string }[]> {
  const results: { source: string; ticker: string; ok: boolean; error?: string }[] = [];
  for (const r of refs) {
    try {
      // Force a refetch past the 24h freshness gate. `force` (not a stale-marker
      // write) keeps the row's `updatedAt` intact, so an upstream miss preserves
      // the true last-success time instead of stranding the row at the epoch
      // sentinel; `deepest_range` survives and a failed refetch still serves the
      // prior values rather than going cold.
      await getCachedSeries(r.source, r.ticker, range, "1d", true);
      results.push({ ...r, ok: true });
    } catch (err) {
      results.push({
        ...r,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** List cache entries by source+ticker, with the last-updated timestamp. */
export function listCachedSymbols(): {
  source: string;
  ticker: string;
  updatedAt: string;
  navCount: number;
}[] {
  const db = getMarketDb();
  const rows = db
    .select({
      key: fundQuotes.ticker,
      updatedAt: fundQuotes.updatedAt,
      navCount: sql<number>`(SELECT COUNT(*) FROM nav_history WHERE ticker = ${fundQuotes.ticker})`,
    })
    .from(fundQuotes)
    .orderBy(desc(fundQuotes.updatedAt))
    .all();
  return rows.map((row) => {
    const idx = row.key.indexOf(":");
    return {
      source: idx >= 0 ? row.key.slice(0, idx) : "",
      ticker: idx >= 0 ? row.key.slice(idx + 1) : row.key,
      updatedAt: row.updatedAt,
      navCount: row.navCount,
    };
  });
}
