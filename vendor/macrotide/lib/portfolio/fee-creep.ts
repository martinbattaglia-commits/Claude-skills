// Fee-creep analysis layer.
//
// For each fund the user holds, if the catalog contains a cheaper fund with the
// same exposure (asset class + geographic region), surface a finding. This is
// the product's headline promise: "comparable exposure, lower fee." The
// analysis is deterministic — no AI calls.
//
// Data flow:
//   holdings (listHoldings)
//   → matched to catalog via getFundsByAbbr (holdings.ticker === fund_catalog.abbrName)
//   → current TER from getCurrentTer
//   → cheaper peers from filterCheaperAlternatives over a per-asset-class pool
//
// Holdings that have no catalog match, no published TER, or no cheaper peers are
// silently omitted — the caller only sees actionable findings.

import {
  type Fund,
  type FundWithTer,
  filterCheaperAlternatives,
  findFunds,
  getCurrentTer,
  getFundsByAbbr,
} from "@/lib/db/queries/funds";
import { listHoldings } from "@/lib/db/queries/holdings";

export interface FeeCreepFinding {
  /** The ticker the user holds (= fund_catalog.abbrName for matched funds). */
  heldTicker: string;
  /** Display name for the held fund (englishName or abbrName from catalog, else ticker). */
  heldName: string;
  /** Current TER (%) being paid. */
  heldTer: number;
  /** Asset class (equity / bond / alternative / cash). Null when catalog entry has no class. */
  assetClass: string | null;
  /** Cheaper funds with the same exposure (asset class + region), sorted cheapest-first, capped at 3. */
  alternatives: FundWithTer[];
  /**
   * Potential annual fee saving in percentage-points against the cheapest
   * alternative: heldTer − alternatives[0].ter.
   */
  savingsPp: number;
}

/**
 * Compute fee-creep findings for the caller's current portfolio. Must be called
 * inside a DB context (route handler or test).
 *
 * Returns one finding per held fund that has:
 *   - a catalog match (holdings.ticker === fund_catalog.abbrName)
 *   - a published TER
 *   - at least one strictly cheaper active peer with the same exposure
 *     (asset class + geographic region)
 *
 * Sorted by `savingsPp` descending so the biggest potential saving is first.
 */
export function computeFeeCreep(): FeeCreepFinding[] {
  const holdings = listHoldings();
  if (holdings.length === 0) return [];

  // Deduplicate tickers — a user might hold the same fund across multiple buckets.
  const uniqueTickers = [...new Set(holdings.map((h) => h.ticker))];

  // Bulk-lookup catalog rows for all held tickers in one query.
  const catalogFunds = getFundsByAbbr(uniqueTickers);
  const catalogByAbbr = new Map(catalogFunds.map((f) => [f.abbrName, f]));

  // Resolve each held ticker to its catalog row + current TER once (skip non-catalog
  // and no-TER funds silently — the caller only sees actionable findings).
  const held = uniqueTickers
    .map((ticker) => {
      const fund = catalogByAbbr.get(ticker);
      if (!fund) return null;
      const heldTer = getCurrentTer(fund.projId);
      return heldTer == null ? null : { ticker, fund, heldTer };
    })
    .filter((x): x is { ticker: string; fund: Fund; heldTer: number } => x !== null);

  // The cheaper-peer pool depends only on asset class, so fetch ONE pool per distinct
  // class — was a full fund_catalog scan PER holding (O(holdings) scans; ~290ms for a
  // 10-fund equity portfolio). Same pools, deduped by class.
  const poolByClass = new Map<string | null, FundWithTer[]>();
  for (const { fund } of held)
    if (!poolByClass.has(fund.assetClass))
      poolByClass.set(
        fund.assetClass,
        findFunds({ assetClass: fund.assetClass ?? undefined, limit: 200 }),
      );

  const findings: FeeCreepFinding[] = [];
  for (const { ticker, fund, heldTer } of held) {
    const alts = filterCheaperAlternatives(
      fund,
      heldTer,
      poolByClass.get(fund.assetClass) ?? [],
      3,
    );
    if (alts.length === 0) continue; // already among the cheapest — nothing to flag

    const cheapestTer = alts[0].ter as number; // filter only returns funds with ter != null
    findings.push({
      heldTicker: ticker,
      heldName: fund.englishName ?? fund.abbrName ?? ticker,
      heldTer,
      assetClass: fund.assetClass,
      alternatives: alts,
      savingsPp: Math.round((heldTer - cheapestTer) * 100) / 100,
    });
  }

  // Biggest saving first.
  findings.sort((a, b) => b.savingsPp - a.savingsPp);
  return findings;
}
