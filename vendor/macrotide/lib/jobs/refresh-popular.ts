// Popular US-securities prewarm — keeps a DYNAMICALLY-DERIVED popular set warm in
// the NAV cache so opening its chart is instant, even on a first-ever view by any
// user. No hardcoded ticker/ETF/index list: the candidate pool is Alpaca's daily
// most-actives screener, re-ranked by DOLLAR volume (price × volume) with
// leveraged/inverse names filtered out, blended with the per-symbol user demand
// counter. The set self-updates daily and picks up emergent tickers.
//
// One pass does both jobs: warming a candidate to read its latest close (for the
// dollar-volume rank) also fills the cache. Held US positions are warmed
// separately by refresh-tracked-market; this job adds the popular + recently-
// demanded long tail. Mirrors the refresh-tracked-market / prewarm-nav idiom.

import "server-only";
import {
  decayPopularityExcept,
  getUsSecurity,
  listTopDemandSymbols,
  setPopularityScores,
} from "../db/queries/us-securities";
import { getCachedSeries } from "../market/cache";
import type { SeriesRange } from "../market/providers/types";
import { fetchMostActives, type MostActive } from "../market/screener";

// Leverage/inverse markers in the security NAME — a RULE, not a ticker list. The
// multiplier (e.g. "3X") and "Ultra" catch Direxion/ProShares leveraged + inverse
// products (SOXS "…Bear 3X Shares", TQQQ "UltraPro QQQ") while leaving plain ETFs
// and stocks alone. Deliberately avoids bare "short"/"bull"/"bear" (would catch
// legit "Short Treasury" funds) — the multiplier/ultra/inverse markers suffice.
const LEVERAGED_RE = /\b[1-3]x\b|\bultra(?:pro)?\b|\binverse\b|\bleveraged\b|-1x/i;

export function isLeveragedOrInverse(name: string): boolean {
  return LEVERAGED_RE.test(name);
}

interface Candidate {
  symbol: string;
  volume: number;
  close: number;
  name: string;
}

/**
 * Rank warmed candidates by dollar volume (close × share volume), drop
 * leveraged/inverse and non-priceable rows, keep the top `keep`, and normalize
 * to a 0–1 score (1 = the most-traded by value). Pure — unit-testable.
 */
export function rankCandidates(
  warmed: Candidate[],
  keep: number,
): { symbol: string; score: number }[] {
  const eligible = warmed
    .filter((c) => Number.isFinite(c.close) && c.close > 0 && c.volume > 0)
    .filter((c) => !isLeveragedOrInverse(c.name))
    .map((c) => ({ symbol: c.symbol, dollarVol: c.close * c.volume }))
    .sort((a, b) => b.dollarVol - a.dollarVol)
    .slice(0, keep);
  const max = eligible.length > 0 ? eligible[0].dollarVol : 0;
  return eligible.map((c) => ({ symbol: c.symbol, score: max > 0 ? c.dollarVol / max : 0 }));
}

/** Bounded-concurrency pool — keep the SEC/provider rate gate from being flooded. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    })(),
  );
  await Promise.all(workers);
}

export interface RefreshPopularOptions {
  /** Most-actives pull size (the candidate pool). Default 100. */
  candidateTop?: number;
  /** Keep the top-N candidates as the popular set. Default 100 — the whole
   *  most-actives pool (Alpaca caps `candidateTop` at 100), minus the leveraged/
   *  inverse + non-priceable rows dropped in ranking. */
  popularKeep?: number;
  /** Also warm the top-M recently-demanded symbols. Default 25. */
  demandKeep?: number;
  /** Demand recency window (days). Default 14. */
  demandWindowDays?: number;
  /** Warm depth — matches the detail sheet's default range so the open is instant. Default "1y". */
  range?: SeriesRange;
  decayStep?: number;
  decayFloor?: number;
  concurrency?: number;
  seenAt?: string;
  /** Test seam — most-actives source. */
  _fetchActives?: (top: number) => Promise<MostActive[]>;
  /** Test seam — warm one symbol, returning its latest close (or null on failure). */
  _warm?: (symbol: string, range: SeriesRange) => Promise<number | null>;
}

export interface RefreshPopularResult {
  actives: number;
  warmed: number;
  scored: number;
  demandWarmed: number;
  decayed: number;
  errors: { symbol: string; error: string }[];
}

/** Default warm: fetch (and thereby cache) one symbol's series; return latest close. */
async function defaultWarm(symbol: string, range: SeriesRange): Promise<number | null> {
  try {
    const { series } = await getCachedSeries("market", symbol, range);
    return series.at(-1)?.close ?? null;
  } catch {
    return null;
  }
}

export async function refreshPopular(
  opts: RefreshPopularOptions = {},
): Promise<RefreshPopularResult> {
  const candidateTop = opts.candidateTop ?? 100;
  const popularKeep = opts.popularKeep ?? 100;
  const demandKeep = opts.demandKeep ?? 25;
  const demandWindowDays = opts.demandWindowDays ?? 14;
  const range = opts.range ?? "1y";
  const concurrency = opts.concurrency ?? 4;
  const seenAt = opts.seenAt ?? new Date().toISOString();
  const fetchActives = opts._fetchActives ?? fetchMostActives;
  const warm = opts._warm ?? defaultWarm;

  const errors: { symbol: string; error: string }[] = [];

  // 1. Candidate pool → warm each to read its latest close.
  const actives = await fetchActives(candidateTop);
  const warmedCandidates: Candidate[] = [];
  await runPool(actives, concurrency, async (a) => {
    const close = await warm(a.symbol, range);
    if (close == null) {
      errors.push({ symbol: a.symbol, error: "warm failed" });
      return;
    }
    warmedCandidates.push({
      symbol: a.symbol,
      volume: a.volume,
      close,
      name: getUsSecurity(a.symbol)?.name ?? a.symbol,
    });
  });

  // 2. Rank by dollar volume + filter, persist scores, decay the rest.
  const ranked = rankCandidates(warmedCandidates, popularKeep);
  setPopularityScores(ranked, seenAt);
  const decayed = decayPopularityExcept(seenAt, { step: opts.decayStep, floor: opts.decayFloor });

  // 3. Warm the demand half (recently-viewed) that the candidate pool didn't cover.
  const warmedSet = new Set(warmedCandidates.map((c) => c.symbol.toUpperCase()));
  const demandSyms = listTopDemandSymbols(demandKeep, demandWindowDays).filter(
    (s) => !warmedSet.has(s.toUpperCase()),
  );
  let demandWarmed = 0;
  await runPool(demandSyms, concurrency, async (sym) => {
    const close = await warm(sym, range);
    if (close != null) demandWarmed++;
    else errors.push({ symbol: sym, error: "warm failed" });
  });

  return {
    actives: actives.length,
    warmed: warmedCandidates.length,
    scored: ranked.length,
    demandWarmed,
    decayed,
    errors,
  };
}
