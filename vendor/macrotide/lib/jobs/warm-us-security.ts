// JIT warm-on-open for a single US security — invoked (un-awaited by the client)
// from the detail-view POST. Fills the cold tail so a niche ticker's detail page
// self-heals within a couple seconds of first open, then the client revalidates.
// Stale-gated: only fetches what's missing/old, so a repeat open is a fast no-op.

import "server-only";
import { getUsSecurity } from "../db/queries/us-securities";
import { enrichUsSecurities } from "./enrich-us-securities";
import { ensureDividends } from "./refresh-dividends";
import { ensureEtfHoldings } from "./refresh-etf-holdings";

const ENRICH_STALE_DAYS = 7;

export interface WarmUsDeps {
  enrich: typeof enrichUsSecurities;
  ensureHoldings: typeof ensureEtfHoldings;
  ensureDivs: typeof ensureDividends;
}

/**
 * Warm profile/fundamentals (enrich), dividends, and — for ETFs — holdings + TER.
 * Each piece is independently stale-gated; runs them concurrently and never throws
 * (failures are swallowed by the underlying fetchers + allSettled).
 */
export async function warmUsSecurity(
  symbol: string,
  deps: Partial<WarmUsDeps> = {},
): Promise<void> {
  const security = getUsSecurity(symbol);
  if (!security) return;
  const enrich = deps.enrich ?? enrichUsSecurities;
  const ensureHoldings = deps.ensureHoldings ?? ensureEtfHoldings;
  const ensureDivs = deps.ensureDivs ?? ensureDividends;

  const staleBefore = new Date(Date.now() - ENRICH_STALE_DAYS * 86_400_000).toISOString();
  const tasks: Promise<unknown>[] = [];

  // Profile + fundamentals: enrich if never enriched or stale.
  if (!security.lastEnrichedAt || security.lastEnrichedAt < staleBefore) {
    tasks.push(enrich({ symbols: [symbol] }));
  }
  // Dividends apply to stocks + ETFs; ensure* self-gates on its own freshness.
  tasks.push(ensureDivs(symbol));
  // Holdings + TER only for ETFs.
  if (security.securityType === "etf") tasks.push(ensureHoldings(symbol));

  await Promise.allSettled(tasks);
}
