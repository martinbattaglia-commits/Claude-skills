// Which index an ETF tracks — DERIVED from its holdings, not a curated map. The
// index-focus core: "VOO tracks the S&P 500" is a fact we compute, so it stays
// comprehensive and self-updating as holdings refresh, instead of a hand-picked
// handful that silently misses SPLG/ITOT/… .
//
// Two signals (public-domain, no licensed identifiers):
//  1. COVERAGE — are the ETF's biggest holdings all inside the index's
//     constituent SET (from the same public membership lists that populate
//     us_securities.indices)? An S&P 500 fund's top holdings are all S&P names.
//  2. COUNT — does the ETF's TOTAL holding count match the index size?
//
// Why both, and why not a set overlap (Jaccard): we only STORE each ETF's top-N
// holdings, and the top holdings of a total-market fund (VTI) and an S&P 500 fund
// (VOO) are IDENTICAL — the same megacaps, all S&P members. From the stored rows
// alone they're indistinguishable, so any set-overlap metric fails. The total
// holding count is what separates them: VOO holds ~505 (≈ the 503-name index),
// VTI holds ~3,600. So: high coverage AND a total count near the index size ⇒
// tracks it. VTI → coverage 1.0 but count 7× the S&P → NO match (correctly, since
// total-market isn't an index we cover). QQQ → covers the Nasdaq-100 with ~100
// holdings ≈ its size → Nasdaq-100. Leveraged/inverse funds hold swaps, not the
// stocks → no resolved constituents → no match, for free.
//
// Scope: decisive for full-replication, cap-weighted equity indices (S&P 500 /
// Nasdaq-100 / Dow + the S&P sector slices). Funds whose count matches no covered
// index resolve to no tracked index rather than a wrong guess.

// A candidate index to test an ETF against: a key and its constituent tickers.
export interface CandidateIndex {
  /** Stored in us_securities.tracks_index (e.g. "sp500", "sector:it"). */
  key: string;
  /** Constituent tickers, upper-cased. */
  members: Set<string>;
}

// One resolved ETF holding for the overlap. The caller passes only rows with a
// resolved US ticker (bonds/cash/foreign/derivatives are dropped upstream).
export interface TrackingHolding {
  symbol: string;
  weightPct: number | null;
  /** The holding's GICS sector (from us_securities.gics_sector), or null when
   *  unknown (non-S&P names). Drives the single-sector concentration guard that
   *  keeps a sector fund from matching a broad index. */
  sector?: string | null;
}

export interface TrackingMatch {
  key: string;
  /** Share of the ETF's held weight sitting inside the winning index. */
  coverage: number;
  /** ETF total-holdings ÷ index size — ~1 when the ETF replicates the index. */
  countRatio: number;
}

// Tuned for full-replication cap-weighted equity indices. We only STORE an ETF's
// top-N holdings, so the top holdings of a total-market fund and an S&P 500 fund
// are identical — a set overlap (Jaccard) over the stored rows can't tell them
// apart. Two signals do: coverage (are the ETF's biggest holdings all inside the
// index?) AND a total-holdings count that matches the index size (~505 for the
// S&P 500 vs ~3,600 for a total-market fund).
export const TRACKING_COVERAGE_MIN = 0.85;
// Total-holdings ÷ index-size must land in this band. Wide enough for sampling
// (a fund holding ~90% of names) and a little cash/ADR padding; tight enough to
// reject a total-market fund (~7× the S&P 500) or a sector slice (~0.14×).
export const TRACKING_COUNT_MIN = 0.5;
export const TRACKING_COUNT_MAX = 1.6;
// A fund whose held weight sits this overwhelmingly in ONE GICS sector is a
// sector fund, not a broad-market one — so it must not match a BROAD index even
// though its names are all members of it (a Vanguard/iShares sector ETF holds only
// tech megacaps, which are all S&P 500 names, yet it tracks a sector index, not the
// S&P 500). Broad-market funds spread across sectors (top holdings ~30-50% in the
// largest sector); a sector fund is ~100%. Sector candidates are unaffected — this
// only vetoes broad matches, so such a fund resolves to its S&P sector slice, or to
// NULL when we don't cover its index (the VTI→NULL principle, applied to sectors).
export const TRACKING_SECTOR_CONCENTRATION_MAX = 0.7;

/**
 * Share of the ETF's (stored, top-N) weight that falls inside `members` — "are
 * the biggest holdings all in this index?". Weight-aware so a trivial off-index
 * holding barely counts; falls back to a plain count ratio when weights are all
 * unpublished.
 */
export function weightCoverage(holdings: TrackingHolding[], members: Set<string>): number {
  let total = 0;
  let inside = 0;
  let n = 0;
  let nInside = 0;
  for (const h of holdings) {
    const w = h.weightPct != null && h.weightPct > 0 ? h.weightPct : 0;
    const isIn = members.has(h.symbol.toUpperCase());
    total += w;
    n++;
    if (isIn) {
      inside += w;
      nInside++;
    }
  }
  if (total > 0) return inside / total;
  return n > 0 ? nInside / n : 0;
}

/**
 * Largest single-GICS-sector share of the ETF's held weight (0 when no holding
 * carries a sector). ~1 for a sector fund (all one sector), ~0.3-0.5 for a broad
 * fund. Weight-aware, falling back to a plain count share when weights are all
 * unpublished. Only holdings with a known sector count toward the total, so a fund
 * whose top names are all sectored megacaps reads its true concentration.
 */
export function dominantSectorShare(holdings: TrackingHolding[]): number {
  const bySector = new Map<string, number>();
  let total = 0;
  let useCount = true;
  for (const h of holdings) {
    if (h.weightPct != null && h.weightPct > 0) useCount = false;
  }
  for (const h of holdings) {
    if (!h.sector) continue;
    const w = useCount ? 1 : h.weightPct != null && h.weightPct > 0 ? h.weightPct : 0;
    if (w <= 0) continue;
    total += w;
    bySector.set(h.sector, (bySector.get(h.sector) ?? 0) + w);
  }
  if (total <= 0) return 0;
  let max = 0;
  for (const w of bySector.values()) if (w > max) max = w;
  return max / total;
}

/**
 * The single best index an ETF tracks, or null. Requires high COVERAGE (its top
 * holdings sit inside the index) AND a total-holding COUNT near the index size —
 * the count is what tells a full-replication S&P 500 fund from a total-market fund
 * whose stored top holdings look identical. Among matches, the tightest size fit
 * (count ratio closest to 1) wins, then the more specific (smaller) index.
 */
export function pickTrackedIndex(
  holdings: TrackingHolding[],
  totalCount: number,
  candidates: CandidateIndex[],
  opts: {
    coverageMin?: number;
    countMin?: number;
    countMax?: number;
    sectorConcentrationMax?: number;
  } = {},
): TrackingMatch | null {
  const coverageMin = opts.coverageMin ?? TRACKING_COVERAGE_MIN;
  const countMin = opts.countMin ?? TRACKING_COUNT_MIN;
  const countMax = opts.countMax ?? TRACKING_COUNT_MAX;
  const sectorMax = opts.sectorConcentrationMax ?? TRACKING_SECTOR_CONCENTRATION_MAX;
  if (holdings.length === 0 || totalCount <= 0) return null;

  // A single-sector-concentrated fund is a sector fund — veto BROAD candidates so
  // it never resolves to the S&P 500 just because its megacaps are S&P names.
  const sectorConcentrated = dominantSectorShare(holdings) >= sectorMax;

  let best: (TrackingMatch & { size: number }) | null = null;
  for (const c of candidates) {
    if (c.members.size === 0) continue;
    if (sectorConcentrated && !c.key.startsWith("sector:")) continue;
    const cov = weightCoverage(holdings, c.members);
    if (cov < coverageMin) continue;
    const ratio = totalCount / c.members.size;
    if (ratio < countMin || ratio > countMax) continue;
    // Prefer the tightest size fit (|1 − ratio| smallest), then higher coverage,
    // then the smaller/more-specific index.
    const better =
      best === null ||
      Math.abs(1 - ratio) < Math.abs(1 - best.countRatio) ||
      (ratio === best.countRatio && cov > best.coverage) ||
      (ratio === best.countRatio && cov === best.coverage && c.members.size < best.size);
    if (better) best = { key: c.key, coverage: cov, countRatio: ratio, size: c.members.size };
  }
  if (best === null) return null;
  return { key: best.key, coverage: best.coverage, countRatio: best.countRatio };
}
