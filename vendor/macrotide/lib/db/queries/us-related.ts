// Index-based "related" cross-links for the US detail page — the index-investing
// on-ramp. From a single stock or ETF we surface the low-cost index funds that
// give the same exposure: "AAPL is part of the S&P 500 — own it broadly through
// VOO or a low-TER Thai S&P 500 fund."
//
// Which ETF tracks which index is DERIVED (us_securities.tracks_index, from
// holdings overlap — see lib/market/etf-tracking), not a hand-curated list, so
// the "own the index" set stays comprehensive and self-updating. A stock's index
// membership (us_securities.indices) also bridges to the Thai catalog: the label
// (trackingLabel("sp500") = "S&P 500") is the canonical fund_catalog.index_family
// value Thai trackers carry, so one label spans both worlds.

import "server-only";
import { INDEX_KEYS, type IndexKey, sectorKeyForGics, trackingLabel } from "../../market/indices";
import { getEtfsTrackingIndex } from "./etf-tracking";
import { getFeederWeightsForSymbol } from "./feeder-enrichment";
import { findShareClasses } from "./funds";
import { getUsSecuritiesBySymbols, type UsSecurity } from "./us-securities";

const BROAD_KEYS = new Set<string>(INDEX_KEYS);

// The Thai catalog's canonical index_family spelling differs from our US display
// label for some indices (e.g. "NASDAQ-100" vs "Nasdaq 100"), so map keys to the
// exact fund_catalog.index_family value. Broad indices only — there are no Thai
// sector index funds.
const THAI_INDEX_FAMILY: Record<IndexKey, string> = {
  sp500: "S&P 500",
  nasdaq100: "NASDAQ-100",
  dow: "Dow Jones Industrial Average",
};

// The Explore idle "Low-cost index ETFs" shelf — a curated pool of broad,
// low-cost index ETFs spanning the major building blocks (US large-cap, total US
// market, Nasdaq-100, US dividend, international, total-world, US bonds), with a
// couple of recognizable same-exposure alternates. Editorial on purpose: "a good
// low-cost index ETF" is advice, not a derivable fact, so it's hand-picked, not
// the cheapest-row-in-the-catalog (which could surface a brand-new micro-AUM or
// mislabeled product). Stable tickers — they don't delist or rename. The pool is
// intentionally larger than the shelf; getStarterIndexEtfs shows the cheapest
// live-TER ones that exist, so the "low-cost" label self-validates and a symbol
// missing from the catalog just drops. Reviewed by a human, rarely; not in the DB.
export const STARTER_INDEX_ETFS = [
  "VOO", // S&P 500
  "IVV", // S&P 500 (iShares)
  "VTI", // Total US market
  "QQQM", // Nasdaq-100
  "SCHD", // US dividend
  "VXUS", // Total international
  "VT", // Total world
  "BND", // US total bond
  "SPLG", // S&P 500 (cheapest)
  "ITOT", // Total US market (iShares)
  "VEA", // Developed international
  "VWO", // Emerging markets
];

export interface RelatedEtf {
  symbol: string;
  name: string;
  ter: number | null;
  securityType: "stock" | "etf";
  /** Popularity score (0–1, from the most-actives prewarm) — the tiebreak among
   *  equal-fee ETFs so the bigger/more-traded tracker leads. */
  popularityScore: number;
  /** Which kind of index this ETF tracks relative to the subject: a "broad"
   *  market index it belongs to (S&P 500 / Nasdaq-100 / Dow) or the subject's
   *  GICS "sector". Groups the "own the index" list so a higher-fee sector ETF
   *  sits in its own row group instead of sinking under the cheap broad ones. */
  group: "broad" | "sector";
}
export interface RelatedFund {
  projId: string;
  ticker: string | null;
  name: string;
  ter: number | null;
  /** How much of this fund is the security, via its master ETF (feeder look-through); null if unknown. */
  weightPct?: number | null;
}
export interface RelatedByIndex {
  /** Display labels of the indices this security belongs to / tracks. */
  indexNames: string[];
  /** Low-cost US ETFs tracking those indices (cheapest first, self excluded). */
  usEtfs: RelatedEtf[];
  /** Thai index funds tracking the same family (cheapest first). */
  thaiFunds: RelatedFund[];
}

const EMPTY: RelatedByIndex = { indexNames: [], usEtfs: [], thaiFunds: [] };

// Fallback for an ETF whose holdings-overlap derivation hasn't resolved (holdings
// not yet fetched, or all-foreign constituents): read the tracked index off the
// fund name. Partial by nature — QQQ doesn't say "Nasdaq" — so it's a backstop,
// not the primary path.
function trackFromName(name: string): IndexKey | null {
  const n = name.toLowerCase();
  if (n.includes("s&p 500") || n.includes("s&p500") || n.includes("s & p 500")) return "sp500";
  if (n.includes("nasdaq 100") || n.includes("nasdaq-100") || n.includes("nasdaq100"))
    return "nasdaq100";
  if (n.includes("dow jones") || n.includes("dow 30")) return "dow";
  return null;
}

/**
 * The indices a security belongs to (a stock's membership) or tracks (an ETF's
 * derived tracks_index, name fallback). Stocks resolve to broad indices only;
 * an ETF may resolve to a broad index or an S&P sector. Pure — exported for
 * direct unit testing.
 */
export function indexKeysFor(
  security: Pick<
    UsSecurity,
    "securityType" | "symbol" | "name" | "indices" | "tracksIndex" | "gicsSector"
  >,
): string[] {
  if (security.securityType === "etf") {
    const k = security.tracksIndex ?? trackFromName(security.name);
    return k ? [k] : [];
  }
  // A stock: its broad membership keys, then its GICS sector key so the sector
  // ETFs (XLK/VGT for a tech stock) surface as their own group — a concentrated,
  // usually higher-fee way to own the stock through an index. Sector last so broad
  // (the cheaper, default index route) leads.
  const broad = (security.indices ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => BROAD_KEYS.has(s));
  const sector = sectorKeyForGics(security.gicsSector);
  return sector ? [...broad, sector] : broad;
}

/** Injectable data access — defaults hit market.db; tests pass fakes (no DB). */
export interface RelatedDeps {
  /** Active ETFs tracking an index key (broad index or S&P sector). */
  getEtfsTracking: (key: string) => UsSecurity[];
  /** Thai index funds tracking one canonical family, already mapped. */
  findThaiByFamily: (indexFamily: string) => RelatedFund[];
  /** Transitive weight of a symbol in each feeder fund (by proj_id), via look-through. */
  getFeederWeights: (symbol: string) => Map<string, number>;
}

const defaultDeps: RelatedDeps = {
  getEtfsTracking: getEtfsTrackingIndex,
  getFeederWeights: getFeederWeightsForSymbol,
  // Per SHARE CLASS, not parent fund — a fund's cheap e-class (e.g. 0.11%) must
  // surface, not the parent's blended TER. Same class-level logic as the fund tab
  // (findShareClasses). Cheapest-class-first; getRelatedByIndex dedups to one
  // class per parent (the cheapest) and re-sorts by fee.
  findThaiByFamily: (indexFamily) =>
    findShareClasses({ trackingIndex: indexFamily, indexType: "index", limit: 12 }).items.map(
      (c) => ({
        projId: c.projId,
        ticker: c.ticker,
        name: c.englishName ?? c.thaiName ?? c.abbrName ?? c.ticker,
        ter: c.ter,
      }),
    ),
};

/** Sort by effective TER ascending; a null or non-positive (unpublished) fee sorts
 *  last. Equal fees (incl. two unpublished → both Infinity) return 0 so the sort
 *  stays stable — `Infinity - Infinity` is NaN, which would shuffle ties. */
function terAsc(a: number | null, b: number | null): number {
  const ea = a != null && a > 0 ? a : Number.POSITIVE_INFINITY;
  const eb = b != null && b > 0 ? b : Number.POSITIVE_INFINITY;
  return ea === eb ? 0 : ea - eb;
}

/**
 * The curated starter index ETFs (STARTER_INDEX_ETFS) that exist in the catalog,
 * cheapest live-TER first, capped at `limit`. Backs the Explore idle shelf.
 * `getBySymbols` is injectable for tests; defaults to the market.db batch lookup.
 */
export function getStarterIndexEtfs(
  limit: number,
  getBySymbols: (symbols: string[]) => UsSecurity[] = getUsSecuritiesBySymbols,
): UsSecurity[] {
  return (
    getBySymbols(STARTER_INDEX_ETFS)
      .filter((u) => u.securityType === "etf")
      // Cheapest first; equal fee → more prominent (popularity) → ticker A→Z, so a
      // block of equal-TER ETFs (and the catalog has many) is deterministic, not
      // left in arbitrary DB order. Mirrors the Thai screener's AUM/ticker tiebreak.
      .sort(
        (a, b) =>
          terAsc(a.ter, b.ter) ||
          b.popularityScore - a.popularityScore ||
          a.symbol.localeCompare(b.symbol),
      )
      .slice(0, limit)
  );
}

/**
 * Index-investing cross-links for a US security: the indices it belongs to (or
 * tracks), the cheapest US ETFs tracking those indices, and the cheapest Thai
 * index funds tracking the same family. Empty when the security maps to no
 * tracked index. Cheap — a couple of indexed lookups.
 */
export function getRelatedByIndex(
  security: UsSecurity,
  deps: RelatedDeps = defaultDeps,
): RelatedByIndex {
  const keys = indexKeysFor(security);
  if (keys.length === 0) return EMPTY;
  const indexNames = keys.map(trackingLabel);

  const self = security.symbol.toUpperCase();
  const seen = new Set<string>();
  const rows: { etf: UsSecurity; group: "broad" | "sector" }[] = [];
  for (const k of keys) {
    const group = k.startsWith("sector:") ? "sector" : "broad";
    for (const e of deps.getEtfsTracking(k)) {
      const s = e.symbol.toUpperCase();
      if (s === self || seen.has(s)) continue;
      seen.add(s);
      rows.push({ etf: e, group });
    }
  }
  // No cap here — the grouped display (broad vs sector) caps per group, so a
  // higher-fee sector ETF isn't dropped by a global cheapest-first slice that the
  // broad trackers would win. Sort cheapest-first within each group downstream.
  const usEtfs: RelatedEtf[] = rows
    .sort(
      (a, b) =>
        terAsc(a.etf.ter, b.etf.ter) ||
        b.etf.popularityScore - a.etf.popularityScore ||
        a.etf.symbol.localeCompare(b.etf.symbol),
    )
    .map(({ etf, group }) => ({
      symbol: etf.symbol,
      name: etf.name,
      ter: etf.ter,
      securityType: etf.securityType,
      popularityScore: etf.popularityScore,
      group,
    }));

  const byProj = new Map<string, RelatedFund>();
  for (const k of keys) {
    if (!BROAD_KEYS.has(k)) continue; // sectors have no Thai counterpart
    for (const f of deps.findThaiByFamily(THAI_INDEX_FAMILY[k as IndexKey])) {
      if (!byProj.has(f.projId)) byProj.set(f.projId, f);
    }
  }
  // Cheapest-first, capped at a small pool; the detail sheet shows the first few
  // with a "show more" expander (like the US ETF groups).
  const picked = [...byProj.values()].sort((a, b) => terAsc(a.ter, b.ter)).slice(0, 12);
  // Annotate each fund with how much of it is this security (via its master ETF's
  // look-through) — the Thai analogue of a US ETF's "holds X%".
  const feederWeights = deps.getFeederWeights(self);
  const thaiFunds = picked.map((f) => ({ ...f, weightPct: feederWeights.get(f.projId) ?? null }));

  return { indexNames, usEtfs, thaiFunds };
}
