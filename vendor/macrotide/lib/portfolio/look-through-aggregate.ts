// Look-through aggregation — PURE. Given each fund's book weight and its
// published underlying holdings (full feeder look-through OR a top-5 snapshot),
// aggregate the same underlying security across funds into the book-level
// signals the concentration check consumes.
//
// Pure and DB-free by design (the AGENTS purity rule for lib/portfolio): the
// server orchestrator (look-through.ts) does the market.db reads and hands the
// shaped input here. Every figure is a LOWER BOUND — most funds publish only a
// top-5, so unseen tail holdings can only make true concentration higher, never
// lower. See docs/explanation/portfolio-health.md.

import type { LookThrough } from "./health";

export interface UnderlyingHolding {
  /** Cross-fund identity key — ISIN where available, else a normalized name. */
  key: string;
  /** Display label for the security (e.g. "Apple Inc."). */
  label: string;
  /** Weight as % of the holding fund's NAV (e.g. 7.2 for 7.2%). */
  weightPct: number;
}

export interface FundLookThroughInput {
  /** The user-held ticker (for redundancy labelling). */
  ticker: string;
  /** Fraction of the WHOLE book this fund represents, 0..1. */
  bookWeight: number;
  /** Whether this holding counts toward the equity coverage denominator. */
  isEquity: boolean;
  /**
   * Published underlying holdings, ordered largest-first. `null` when the fund
   * publishes nothing usable (it then counts against coverage but contributes
   * no names). An empty array is treated the same as `null`.
   */
  underlying: UnderlyingHolding[] | null;
}

/** How many top holdings two funds must share to be called redundant. */
const REDUNDANCY_TOP_N = 5;
const REDUNDANCY_MIN_SHARED = 4;

/** Normalize a security name into a cross-fund match key (when no ISIN). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(
      /\b(inc|incorporated|corp|corporation|co|ltd|limited|plc|nv|sa|ag|class [a-z]|cl [a-z]|the)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Aggregate per-fund look-through into book-level concentration signals.
 * Returns `null` when no fund carries any usable underlying data (the caller
 * then leaves look-through off entirely, and concentration falls back to the
 * certain fund-level facts).
 */
export function aggregateLookThrough(funds: FundLookThroughInput[]): LookThrough | null {
  const withData = funds.filter((f) => f.underlying && f.underlying.length > 0);
  if (withData.length === 0) return null;

  // Book-level single-name aggregation: contribution% = fund's book weight ×
  // the name's weight within that fund, summed across funds holding it.
  const byName = new Map<string, { label: string; pct: number; funds: Set<string> }>();
  for (const f of withData) {
    for (const u of f.underlying as UnderlyingHolding[]) {
      const entry = byName.get(u.key) ?? { label: u.label, pct: 0, funds: new Set<string>() };
      entry.pct += f.bookWeight * u.weightPct;
      entry.funds.add(f.ticker);
      byName.set(u.key, entry);
    }
  }
  let maxName: LookThrough["maxName"] = null;
  for (const e of byName.values()) {
    if (!maxName || e.pct > maxName.pct) {
      maxName = { label: e.label, pct: round1(e.pct), fundCount: e.funds.size };
    }
  }

  // Equity coverage — the share of equity book value we can actually see into.
  const equityTotal = funds.filter((f) => f.isEquity).reduce((s, f) => s + f.bookWeight, 0);
  const equityCovered = withData.filter((f) => f.isEquity).reduce((s, f) => s + f.bookWeight, 0);
  const equityCoverage = equityTotal > 0 ? Math.min(1, equityCovered / equityTotal) : 0;

  // Redundant pairs — two funds sharing ≥4 of their top-5 underlying keys are
  // effectively the same exposure. High-confidence even from top-5 data.
  const topKeys = withData.map((f) => ({
    ticker: f.ticker,
    keys: new Set(
      (f.underlying as UnderlyingHolding[]).slice(0, REDUNDANCY_TOP_N).map((u) => u.key),
    ),
  }));
  const redundantPairs: { a: string; b: string }[] = [];
  for (let i = 0; i < topKeys.length; i++) {
    for (let j = i + 1; j < topKeys.length; j++) {
      const a = topKeys[i];
      const b = topKeys[j];
      let shared = 0;
      for (const k of a.keys) if (b.keys.has(k)) shared++;
      if (shared >= REDUNDANCY_MIN_SHARED) redundantPairs.push({ a: a.ticker, b: b.ticker });
    }
  }

  return {
    maxName,
    redundantPairs,
    equityCoverage,
    // Coarse per-fund region data can't honestly support a target-relative
    // region divergence yet; region surfaces as disclosure until it deepens.
    regionDivergencePp: null,
  };
}
