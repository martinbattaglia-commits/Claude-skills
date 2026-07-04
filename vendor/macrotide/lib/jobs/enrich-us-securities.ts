// US securities detail enrichment — fill profile + fundamentals + ratios on
// `us_securities` from SEC public-domain data (see lib/market/edgar.ts).
//
// Bounded by design: enriches a capped batch of the symbols users actually see
// (popularity, then views, then never/stalest-enriched first), so a 12.9k catalog
// fills in over many nights instead of hammering SEC. Every selected symbol is
// stamped `last_enriched_at` even when SEC has nothing (e.g. an ETF has no
// operating-company facts), so it isn't retried every night.

import "server-only";
import { navOnDate } from "../db/queries/quotes";
import {
  applyGicsSectors,
  applyIndexMembership,
  listSymbolsToEnrich,
  setUsSecurityEnrichment,
  type UsEnrichment,
} from "../db/queries/us-securities";
import {
  computeRatios,
  fetchFundamentals,
  fetchProfile,
  tickerToCik,
  type UsFundamentals,
  type UsProfile,
} from "../market/edgar";
import { fetchGicsConstituents, type GicsRow } from "../market/gics";
import { fetchIndexMembership, type IndexMembership } from "../market/indices";
import { quoteCacheKey } from "../market/sources";
import { mapPool } from "./map-pool";

/**
 * Build the enrichment patch for one symbol — pure, so it's unit-testable without
 * SEC or a DB. `profile`/`fundamentals` are null when SEC has no match (the symbol
 * still gets stamped, just with the fields it does have). Ratios fold in our own
 * `price` (USD) since SEC carries no price.
 */
export function toEnrichmentPatch(
  symbol: string,
  cik: string | null,
  profile: UsProfile | null,
  fundamentals: UsFundamentals | null,
  price: number | null,
): UsEnrichment {
  const patch: UsEnrichment = { symbol, cik };
  if (profile) {
    patch.sic = profile.sic;
    patch.industry = profile.sicDescription;
  }
  if (fundamentals) {
    const r = computeRatios(fundamentals, price);
    patch.sharesOutstanding = fundamentals.sharesOutstanding;
    patch.epsDiluted = fundamentals.epsDiluted;
    patch.marketCap = r.marketCap;
    patch.peRatio = r.peRatio;
    patch.pbRatio = r.pbRatio;
    patch.netMargin = r.netMargin;
    patch.fundamentalsAsOf = fundamentals.asOf;
  }
  return patch;
}

export interface EnrichUsResult {
  selected: number;
  enriched: number;
  withProfile: number;
  withFundamentals: number;
  /** Catalog rows given a GICS sector this run (0 unless applyGics). */
  gicsApplied: number;
  /** Catalog rows given index membership this run (0 unless applyIndices). */
  indicesApplied: number;
}

export interface EnrichUsOptions {
  /** Max symbols to enrich this run (default 200). */
  limit?: number;
  /** Explicit symbols (overrides the popularity-ranked selection). */
  symbols?: string[];
  /** Only re-enrich rows older than this ISO time (omit = include never-enriched). */
  staleBefore?: string;
  /** Run marker; defaults to now. */
  enrichedAt?: string;
  /** SEC is fine to ~10 req/s; we keep a small pool (default 4 → ≤8 in-flight). */
  concurrency?: number;
  /** Also bulk-apply GICS sectors from the public S&P 500 dataset (nightly). */
  applyGics?: boolean;
  /** Also bulk-apply index membership from public index datasets (nightly). */
  applyIndices?: boolean;
  // ── test seams ──
  resolveCik?: (symbol: string) => Promise<{ cik: string } | null>;
  getProfile?: (cik: string) => Promise<UsProfile | null>;
  getFundamentals?: (cik: string) => Promise<UsFundamentals | null>;
  priceFor?: (symbol: string) => number | null;
  getGics?: () => Promise<GicsRow[]>;
  getIndices?: () => Promise<IndexMembership[]>;
}

export async function enrichUsSecurities(opts: EnrichUsOptions = {}): Promise<EnrichUsResult> {
  const enrichedAt = opts.enrichedAt ?? new Date().toISOString();
  const limit = opts.limit ?? 200;

  // GICS is a bulk dimension (one dataset → many catalog rows); apply it up front,
  // independent of the per-symbol selection below.
  let gicsApplied = 0;
  if (opts.applyGics) {
    const getGics = opts.getGics ?? fetchGicsConstituents;
    gicsApplied = applyGicsSectors(await getGics());
  }
  let indicesApplied = 0;
  if (opts.applyIndices) {
    const getIndices = opts.getIndices ?? fetchIndexMembership;
    indicesApplied = applyIndexMembership(await getIndices());
  }

  const symbols = opts.symbols ?? listSymbolsToEnrich(limit, { staleBefore: opts.staleBefore });
  if (symbols.length === 0)
    return {
      selected: 0,
      enriched: 0,
      withProfile: 0,
      withFundamentals: 0,
      gicsApplied,
      indicesApplied,
    };

  const resolveCik = opts.resolveCik ?? ((s: string) => tickerToCik(s));
  const getProfile = opts.getProfile ?? fetchProfile;
  const getFundamentals = opts.getFundamentals ?? fetchFundamentals;
  const priceFor =
    opts.priceFor ??
    ((s: string) => {
      const key = quoteCacheKey("market", s);
      return navOnDate([key], enrichedAt.slice(0, 10)).get(key) ?? null;
    });

  let withProfile = 0;
  let withFundamentals = 0;
  const patches = await mapPool(symbols, opts.concurrency ?? 4, async (symbol) => {
    const cik = await resolveCik(symbol);
    if (!cik) return toEnrichmentPatch(symbol, null, null, null, null);
    // profile + fundamentals are independent SEC endpoints → fetch together.
    const [profile, fundamentals] = await Promise.all([
      getProfile(cik.cik),
      getFundamentals(cik.cik),
    ]);
    if (profile) withProfile++;
    if (fundamentals) withFundamentals++;
    return toEnrichmentPatch(symbol, cik.cik, profile, fundamentals, priceFor(symbol));
  });

  const enriched = setUsSecurityEnrichment(patches, enrichedAt);
  return {
    selected: symbols.length,
    enriched,
    withProfile,
    withFundamentals,
    gicsApplied,
    indicesApplied,
  };
}
