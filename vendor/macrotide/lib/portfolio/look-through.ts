// Server-side look-through assembly.
//
// Resolves the user's holdings to catalog funds, reads each fund's published
// underlying holdings from the regenerable market.db (full feeder look-through
// where we have it, otherwise the top-5 factsheet snapshot), and hands the
// shaped input to the pure aggregator. The result is injected into computeHealth
// so the concentration check can see underlying-exposure concentration.
//
// DB-reading orchestrator (mirrors fee-creep.ts): the aggregation maths live in
// the pure look-through-aggregate.ts. See docs/explanation/portfolio-health.md.

import { getFeederLookThroughHoldings } from "@/lib/db/queries/feeder-enrichment";
import { getFundTopHoldings } from "@/lib/db/queries/fund-enrichment";
import { getFundsByAbbr } from "@/lib/db/queries/funds";
import type { Holding } from "@/lib/static/types";
import type { LookThrough } from "./health";
import {
  aggregateLookThrough,
  type FundLookThroughInput,
  normalizeName,
  type UnderlyingHolding,
} from "./look-through-aggregate";

/** Underlying holdings for one catalog fund — feeder look-through first, else top-5. */
function underlyingFor(projId: string): UnderlyingHolding[] | null {
  // Feeder look-through (full master holdings) is the high-confidence source.
  const feeder = getFeederLookThroughHoldings(projId);
  if (feeder.length > 0) {
    const rows = feeder
      .filter((r) => r.name && (r.weightPct ?? 0) > 0)
      .map((r) => ({
        key: r.isin?.trim() || normalizeName(r.name),
        label: r.name,
        weightPct: r.weightPct as number,
      }));
    return rows.length > 0 ? rows : null;
  }
  // Top-5 factsheet snapshot — no ISIN, so match by normalized name. A lower
  // bound on real overlap (captures only a minority of NAV).
  const top5 = getFundTopHoldings(projId);
  const rows = top5
    .filter((r) => r.assetName && (r.assetRatio ?? 0) > 0)
    .map((r) => ({
      key: normalizeName(r.assetName as string),
      label: r.assetName as string,
      weightPct: r.assetRatio as number,
    }));
  return rows.length > 0 ? rows : null;
}

/**
 * Build the look-through signal for a set of holdings, or `null` when no held
 * fund publishes any usable underlying data. Holdings are grouped by ticker so a
 * fund held across several buckets counts once.
 */
export function computeLookThrough(holdings: Holding[]): LookThrough | null {
  const totalBook = holdings.reduce((s, h) => s + h.value, 0);
  if (totalBook <= 0) return null;

  // Group by ticker (a fund may sit in several buckets) → value + class.
  const byTicker = new Map<string, { value: number; isEquity: boolean }>();
  for (const h of holdings) {
    const prev = byTicker.get(h.ticker);
    byTicker.set(h.ticker, {
      value: (prev?.value ?? 0) + h.value,
      isEquity: prev?.isEquity || h.class === "equity",
    });
  }

  // Resolve held tickers to catalog projIds (holdings.ticker === abbrName).
  const catalog = getFundsByAbbr([...byTicker.keys()]);
  const projByAbbr = new Map(catalog.map((f) => [f.abbrName, f.projId]));

  const funds: FundLookThroughInput[] = [];
  for (const [ticker, { value, isEquity }] of byTicker) {
    const projId = projByAbbr.get(ticker);
    funds.push({
      ticker,
      bookWeight: value / totalBook,
      isEquity,
      underlying: projId ? underlyingFor(projId) : null,
    });
  }

  return aggregateLookThrough(funds);
}
