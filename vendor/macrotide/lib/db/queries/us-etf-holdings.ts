// US ETF holdings queries — the constituents of a US ETF (from SEC N-PORT) plus
// the derived country / asset-category exposure shown on the detail page.
//
// Write side: the bounded holdings refresh (and JIT-on-open) replaces a symbol's
// rows wholesale and stamps the freshness columns on us_securities.
// Read side: the detail API.

import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NportHolding } from "../../market/providers/edgar-nport";
import { tickerKey } from "../../market/sources";
import { getMarketDb } from "../context";
import { usEtfHoldings, usSecurities } from "../schema";

export type EtfHoldingRow = typeof usEtfHoldings.$inferSelect;

export interface EtfHoldings {
  asOf: string | null;
  fetchedAt: string | null;
  holdings: EtfHoldingRow[];
}

/**
 * Replace an ETF's stored holdings with `holdings` (already top-N, weight-sorted)
 * and stamp `holdings_as_of` / `holdings_fetched_at` on its catalog row. Atomic.
 * Case-folds the symbol so it matches the catalog. Returns rows written.
 */
export function setEtfHoldings(
  symbol: string,
  holdings: NportHolding[],
  asOf: string | null,
  fetchedAt: string,
  /** Total holdings in the filing (before the top-N cap) — for tracks_index. */
  totalCount?: number,
): number {
  const key = tickerKey(symbol);
  if (!key) return 0;
  const db = getMarketDb();
  const rows = holdings.map((h, i) => ({
    symbol: key,
    rank: i + 1,
    name: h.name,
    cusip: h.cusip,
    isin: h.isin,
    weightPct: h.weightPct,
    country: h.country,
    assetCat: h.assetClass,
    counterparty: h.counterparty ?? null,
  }));
  db.transaction((tx) => {
    tx.delete(usEtfHoldings).where(eq(usEtfHoldings.symbol, key)).run();
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(usEtfHoldings)
        .values(rows.slice(i, i + CHUNK))
        .run();
    }
    tx.update(usSecurities)
      .set({
        holdingsAsOf: asOf,
        holdingsFetchedAt: fetchedAt,
        ...(totalCount != null ? { holdingsCount: totalCount } : {}),
      })
      .where(sql`UPPER(${usSecurities.symbol}) = ${key}`)
      .run();
  });
  return rows.length;
}

/** One entry of a security's reverse "held via" list. */
export interface HeldViaEtf {
  /** The ETF that holds `symbol`. */
  symbol: string;
  /** The ETF's catalog name. */
  name: string;
  /** `symbol`'s weight in that ETF (percent of NAV), or null if unpublished. */
  weightPct: number | null;
  /** The ETF's expense ratio (fraction), or null — so the detail can show fee + weight together. */
  ter: number | null;
  /** Popularity score (0–1) — tiebreak among equal-fee holders. */
  popularityScore: number;
}

/**
 * ETFs whose holdings include `symbol` as a constituent — heaviest weight first,
 * the stock detail's "held via" list ("AAPL is held via VOO 6.6%…"). Matches on the
 * denormalized resolved_symbol (populated by resolveEtfTickers), joined to the
 * catalog for the ETF's name; active ETFs only.
 */
export function getEtfsHoldingSymbol(symbol: string, limit = 8): HeldViaEtf[] {
  const key = tickerKey(symbol);
  if (!key) return [];
  return getMarketDb()
    .select({
      symbol: usEtfHoldings.symbol,
      name: usSecurities.name,
      weightPct: usEtfHoldings.weightPct,
      ter: usSecurities.ter,
      popularityScore: usSecurities.popularityScore,
    })
    .from(usEtfHoldings)
    .innerJoin(usSecurities, sql`UPPER(${usSecurities.symbol}) = UPPER(${usEtfHoldings.symbol})`)
    .where(
      and(
        sql`UPPER(${usEtfHoldings.resolvedSymbol}) = ${key}`,
        eq(usSecurities.securityType, "etf"),
        eq(usSecurities.status, "active"),
      ),
    )
    .orderBy(desc(usEtfHoldings.weightPct))
    .limit(limit)
    .all();
}

/** An ETF's holdings (rank order) + the filing's as-of/fetched freshness. */
export function getEtfHoldings(symbol: string): EtfHoldings {
  const key = tickerKey(symbol);
  if (!key) return { asOf: null, fetchedAt: null, holdings: [] };
  const db = getMarketDb();
  const holdings = db
    .select()
    .from(usEtfHoldings)
    .where(eq(usEtfHoldings.symbol, key))
    .orderBy(asc(usEtfHoldings.rank))
    .all();
  const meta = db
    .select({ asOf: usSecurities.holdingsAsOf, fetchedAt: usSecurities.holdingsFetchedAt })
    .from(usSecurities)
    .where(sql`UPPER(${usSecurities.symbol}) = ${key}`)
    .get();
  return { asOf: meta?.asOf ?? null, fetchedAt: meta?.fetchedAt ?? null, holdings };
}

export interface ExposureSlice {
  key: string;
  pct: number;
}

export interface EtfExposure {
  byCountry: ExposureSlice[];
  byAssetCat: ExposureSlice[];
}

/**
 * Aggregate holdings into country and asset-category exposure (percent of NAV),
 * each sorted largest-first. Pure — N-PORT carries no fund-level rollup, so the
 * detail page computes it from the holdings. Unlabeled dimensions bucket to
 * "Unknown"/"Other" so the slices still sum toward the fund's invested weight.
 */
export function deriveExposure(
  holdings: Pick<EtfHoldingRow, "country" | "assetCat" | "weightPct">[],
): EtfExposure {
  const country = new Map<string, number>();
  const asset = new Map<string, number>();
  for (const h of holdings) {
    const w = h.weightPct ?? 0;
    if (w <= 0) continue;
    const c = h.country || "Unknown";
    const a = h.assetCat || "Other";
    country.set(c, (country.get(c) ?? 0) + w);
    asset.set(a, (asset.get(a) ?? 0) + w);
  }
  const toSlices = (m: Map<string, number>): ExposureSlice[] =>
    [...m].map(([key, pct]) => ({ key, pct })).sort((a, b) => b.pct - a.pct);
  return { byCountry: toSlices(country), byAssetCat: toSlices(asset) };
}

/**
 * Active ETFs whose holdings to refresh next — popularity/views first, NULL/stalest
 * `holdings_fetched_at` first among equals. Bounds the nightly N-PORT spend.
 */
export function listEtfsToRefreshHoldings(
  limit: number,
  opts: { staleBefore?: string } = {},
): string[] {
  const clauses = [eq(usSecurities.status, "active"), eq(usSecurities.securityType, "etf")];
  if (opts.staleBefore) {
    clauses.push(
      sql`(${usSecurities.holdingsFetchedAt} IS NULL OR ${usSecurities.holdingsFetchedAt} < ${opts.staleBefore})`,
    );
  }
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(and(...clauses))
    .orderBy(
      sql`${usSecurities.popularityScore} DESC`,
      sql`${usSecurities.viewCount} DESC`,
      sql`${usSecurities.holdingsFetchedAt} IS NOT NULL`,
      asc(usSecurities.holdingsFetchedAt),
    )
    .limit(limit)
    .all()
    .map((r) => r.symbol);
}
