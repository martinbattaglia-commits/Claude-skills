// Derive which index each ETF TRACKS from its holdings, and store it in
// us_securities.tracks_index — the data behind the detail page's "own the index"
// cross-link. Replaces a hand-curated ETF→index map with a computed one, so it's
// comprehensive (any overlapping ETF resolves, not just a hard-coded handful) and
// self-updating. The overlap math is pure (lib/market/etf-tracking); this module
// is the DB glue: build the candidate index sets, run each ETF's resolved holdings
// through the matcher, and persist the result.

import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type CandidateIndex, pickTrackedIndex } from "../../market/etf-tracking";
import { INDEX_KEYS, sectorKeyForGics } from "../../market/indices";
import { tickerKey } from "../../market/sources";
import { getMarketDb } from "../context";
import { usEtfHoldings, usSecurities } from "../schema";
import type { UsSecurity } from "./us-securities";

const BROAD_KEYS = new Set<string>(INDEX_KEYS);

/**
 * Constituent SETS to match ETFs against, built from the same public membership
 * data that powers us_securities.indices / gics_sector. Broad indices group by
 * membership key; S&P sector slices group the S&P 500 by GICS sector. Pure —
 * takes catalog rows, returns candidate sets (uppercased tickers). Exported for
 * direct testing.
 */
export function buildCandidateSets(
  rows: { symbol: string; indices: string | null; gicsSector: string | null }[],
): CandidateIndex[] {
  const broad = new Map<string, Set<string>>();
  const sector = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, symbol: string) => {
    const set = m.get(key) ?? new Set<string>();
    set.add(symbol);
    m.set(key, set);
  };
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    for (const raw of (r.indices ?? "").split(",")) {
      const k = raw.trim();
      if (BROAD_KEYS.has(k)) add(broad, k, sym);
    }
    // Only S&P 500 members carry gics_sector, so a sector set IS the S&P slice.
    const sk = sectorKeyForGics(r.gicsSector);
    if (sk) add(sector, sk, sym);
  }
  return [...broad, ...sector].map(([key, members]) => ({ key, members }));
}

/** Active ETFs that have holdings fetched — the derivation's default target set. */
function etfsWithHoldings(): string[] {
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(
      and(
        eq(usSecurities.securityType, "etf"),
        eq(usSecurities.status, "active"),
        isNotNull(usSecurities.holdingsFetchedAt),
      ),
    )
    .all()
    .map((r) => r.symbol);
}

export interface DeriveTrackingResult {
  /** ETFs evaluated. */
  evaluated: number;
  /** ETFs that resolved to a tracked index. */
  tracked: number;
}

/**
 * Recompute tracks_index for the target ETFs (default: all active ETFs with
 * holdings). Cheap set math over already-cached holdings — no network — so the
 * nightly holdings refresh regenerates the whole hot set. An ETF that matches no
 * covered index is set back to NULL (self-healing when holdings or membership
 * shift). Only resolved US-listed constituents count; bonds/cash/foreign rows
 * (resolved_symbol NULL) are excluded.
 */
export function deriveEtfTracking(opts: { symbols?: string[] } = {}): DeriveTrackingResult {
  const db = getMarketDb();
  const catalog = db
    .select({
      symbol: usSecurities.symbol,
      indices: usSecurities.indices,
      gicsSector: usSecurities.gicsSector,
      holdingsCount: usSecurities.holdingsCount,
    })
    .from(usSecurities)
    .all();
  const candidates = buildCandidateSets(catalog);
  // Total-holdings count per ETF — the signal that separates a full-replication
  // fund from a total-market one whose stored top holdings look identical.
  const countBySymbol = new Map(catalog.map((r) => [r.symbol.toUpperCase(), r.holdingsCount ?? 0]));
  // Each constituent's GICS sector — feeds the single-sector concentration guard
  // that keeps a sector fund (all-tech holdings) from matching the S&P 500.
  const sectorBySymbol = new Map(catalog.map((r) => [r.symbol.toUpperCase(), r.gicsSector]));

  const targets = opts.symbols ?? etfsWithHoldings();
  if (targets.length === 0) return { evaluated: 0, tracked: 0 };
  const wantedList = targets.map((s) => tickerKey(s)).filter((s): s is string => Boolean(s));
  const wanted = new Set(wantedList);

  // Group every resolved holding by its owning ETF in one pass. When a specific
  // target set is given (a JIT/bounded refresh of a few ETFs), scope the scan to
  // those symbols in SQL rather than pulling the whole holdings table and filtering
  // client-side — the table grows unbounded as more ETFs are fetched.
  const holdingsByEtf = new Map<
    string,
    { symbol: string; weightPct: number | null; sector: string | null }[]
  >();
  const rows = db
    .select({
      symbol: usEtfHoldings.symbol,
      resolvedSymbol: usEtfHoldings.resolvedSymbol,
      weightPct: usEtfHoldings.weightPct,
    })
    .from(usEtfHoldings)
    .where(
      opts.symbols
        ? and(isNotNull(usEtfHoldings.resolvedSymbol), inArray(usEtfHoldings.symbol, wantedList))
        : isNotNull(usEtfHoldings.resolvedSymbol),
    )
    .all();
  for (const r of rows) {
    const owner = r.symbol.toUpperCase();
    if (!wanted.has(owner)) continue;
    const resolved = r.resolvedSymbol as string;
    const list = holdingsByEtf.get(owner) ?? [];
    list.push({
      symbol: resolved,
      weightPct: r.weightPct,
      sector: sectorBySymbol.get(resolved.toUpperCase()) ?? null,
    });
    holdingsByEtf.set(owner, list);
  }

  let tracked = 0;
  db.transaction((tx) => {
    for (const sym of wanted) {
      const match = pickTrackedIndex(
        holdingsByEtf.get(sym) ?? [],
        countBySymbol.get(sym) ?? 0,
        candidates,
      );
      tx.update(usSecurities)
        .set({ tracksIndex: match?.key ?? null })
        .where(sql`UPPER(${usSecurities.symbol}) = ${sym}`)
        .run();
      if (match) tracked++;
    }
  });
  return { evaluated: wanted.size, tracked };
}

/**
 * Active ETFs that track `key` (a broad index or S&P sector) — the "own the
 * index" list. Full rows so the caller sorts by live TER/popularity. Cheap:
 * indexed on tracks_index.
 */
export function getEtfsTrackingIndex(key: string): UsSecurity[] {
  return getMarketDb()
    .select()
    .from(usSecurities)
    .where(
      and(
        eq(usSecurities.tracksIndex, key),
        eq(usSecurities.securityType, "etf"),
        eq(usSecurities.status, "active"),
      ),
    )
    .all();
}
