// Security-id → ticker crosswalk: the read/write layer over `security_id_map`
// (the OpenFIGI ISIN/CUSIP → ticker cache) and the stamping of the denormalized
// `us_etf_holdings.resolved_symbol`. This is what makes ETF holdings tappable and
// a stock's reverse "held via" list computable — a holdings file carries CUSIP/ISIN
// but no ticker.

import "server-only";
import { sql } from "drizzle-orm";
import type { SecurityIdType } from "../../market/figi";
import { getMarketDb } from "../context";
import { securityIdMap } from "../schema";

export interface HoldingId {
  idType: SecurityIdType;
  idValue: string;
}

/**
 * Infer the OpenFIGI id type from the value's shape: an ISIN is 12 chars starting
 * with a 2-letter country code; a US CUSIP is 9 chars. Defaults to CUSIP.
 */
export function inferIdType(idValue: string): SecurityIdType {
  const v = idValue.trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(v) ? "ID_ISIN" : "ID_CUSIP";
}

/**
 * Distinct constituent ids (prefer ISIN, else CUSIP) across all held ETFs that are
 * NOT yet in the crosswalk cache — or whose cached attempt is older than
 * `staleBefore`. These are the ids a resolution run must send to OpenFIGI.
 */
export function getHoldingIdsNeedingResolution(opts: { staleBefore?: string } = {}): HoldingId[] {
  const db = getMarketDb();
  const staleBefore = opts.staleBefore ?? null;
  // NOTE: the correlated NOT EXISTS references x.id_value (the outer holding id).
  // Left unqualified it binds to security_id_map.id_value (same column name), a
  // tautology that made this a silent no-op — so keep the `x.` alias.
  const rows = db.all(
    sql<{ id_value: string }>`
      SELECT DISTINCT x.id_value FROM (
        SELECT COALESCE(NULLIF(TRIM(isin), ''), NULLIF(TRIM(cusip), '')) AS id_value
          FROM us_etf_holdings
      ) x
      WHERE x.id_value IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM security_id_map m
          WHERE m.id_value = x.id_value
            AND (${staleBefore} IS NULL OR m.resolved_at >= ${staleBefore})
        )
    `,
  ) as { id_value: string }[];
  return rows.map((r) => ({ idType: inferIdType(r.id_value), idValue: r.id_value }));
}

/**
 * Cache resolution attempts. `ticker` is the resolved US symbol, or null to record
 * an attempted-but-unresolvable id (bond/cash/derivative) so it isn't retried every
 * run. Every id in `resolved` (including the null ones) gets a fresh `resolvedAt`.
 */
export function upsertSecurityIds(
  ids: HoldingId[],
  resolved: Map<string, string>,
  resolvedAt: string,
): void {
  if (ids.length === 0) return;
  const db = getMarketDb();
  for (const { idValue } of ids) {
    db.insert(securityIdMap)
      .values({ idValue, ticker: resolved.get(idValue) ?? null, resolvedAt })
      .onConflictDoUpdate({
        target: securityIdMap.idValue,
        set: { ticker: resolved.get(idValue) ?? null, resolvedAt },
      })
      .run();
  }
}

/**
 * Re-stamp `us_etf_holdings.resolved_symbol` from the crosswalk cache. Cheap (no
 * network) — run after a holdings refresh (which wipes the column) and after a
 * resolution pass. A holding matches the cache on its ISIN, else its CUSIP.
 */
export function stampResolvedSymbols(): void {
  getMarketDb().run(
    sql`
      UPDATE us_etf_holdings
      SET resolved_symbol = (
        SELECT m.ticker FROM security_id_map m
        WHERE m.id_value = COALESCE(NULLIF(TRIM(us_etf_holdings.isin), ''), NULLIF(TRIM(us_etf_holdings.cusip), ''))
      )
    `,
  );
}
