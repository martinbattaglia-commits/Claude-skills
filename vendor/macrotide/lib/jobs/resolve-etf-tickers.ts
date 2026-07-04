// Resolve ETF-holding constituents' tickers from their CUSIP/ISIN via OpenFIGI,
// caching the crosswalk (security_id_map) and stamping us_etf_holdings.resolved_symbol.
// Bounded per run to respect the OpenFIGI rate limit; unresolved ids (bonds, cash,
// derivatives) are recorded so they aren't retried every run. Public-data crosswalk.

import "server-only";
import {
  getHoldingIdsNeedingResolution,
  stampResolvedSymbols,
  upsertSecurityIds,
} from "../db/queries/security-id-map";
import { mapIdsToTickers } from "../market/figi";

export interface ResolveEtfTickersOptions {
  /** Max ids to send to OpenFIGI this run (bounds API usage). Default 500. */
  limit?: number;
  /** Re-resolve ids whose cached attempt is older than this ISO time. */
  staleBefore?: string;
  /** Run marker; defaults to now. */
  resolvedAt?: string;
  /** Test seam; defaults to the live OpenFIGI mapping. */
  mapIds?: typeof mapIdsToTickers;
}

export interface ResolveEtfTickersResult {
  /** Distinct unresolved ids across all held ETFs. */
  candidates: number;
  /** Ids actually sent to OpenFIGI this run (≤ limit). */
  attempted: number;
  /** Of those, how many resolved to a ticker. */
  resolved: number;
}

export async function resolveEtfTickers(
  opts: ResolveEtfTickersOptions = {},
): Promise<ResolveEtfTickersResult> {
  const resolvedAt = opts.resolvedAt ?? new Date().toISOString();
  const mapIds = opts.mapIds ?? mapIdsToTickers;
  const all = getHoldingIdsNeedingResolution({ staleBefore: opts.staleBefore });
  const ids = opts.limit ? all.slice(0, opts.limit) : all;

  let resolvedCount = 0;
  if (ids.length > 0) {
    const resolved = await mapIds(ids);
    resolvedCount = resolved.size;
    // Record every attempted id (resolved ones get a ticker, the rest a null marker)
    // so a constituent that legitimately has no US listing isn't retried each run.
    upsertSecurityIds(ids, resolved, resolvedAt);
  }
  // Always re-stamp: a holdings refresh wipes resolved_symbol, and this repopulates
  // it from the cache (cheap, no network) even when nothing new was resolved.
  stampResolvedSymbols();

  return { candidates: all.length, attempted: ids.length, resolved: resolvedCount };
}
