// Feeder fund look-through queries — read/write for the two feeder enrichment
// tables: feeder_master_map and feeder_look_through_holdings.
//
// Write side: upsert helpers called by the fund-catalog refresh job when
//   EXTERNAL_INGEST_FEEDER_HOLDINGS=1 is set.
// Read side: typed getters for the API route and FundDetailSheet.

import "server-only";
import { and, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import { tickerKey } from "../../market/sources";
import { getMarketDb } from "../context";
import { feederLookThroughHoldings, feederMasterMap, securityIdMap, usSecurities } from "../schema";

/**
 * Resolve a feeder's master fund to its US ETF ticker by NAME. The master_isin
 * in the source is UNRELIABLE (one placeholder ISIN is shared across many S&P
 * masters and resolves to AGG, a bond ETF) — but master_name is reliable and is
 * present verbatim in us_securities (e.g. "iShares Core S&P 500 ETF" = IVV). So
 * match on the cleaned name, case-insensitively and EXACTLY (no fuzzy match, so no
 * ACWI-vs-ACWX false positives). Returns null with no confident match (e.g. a
 * European UCITS master with no US listing). No hardcoded map — us_securities is
 * the source of truth.
 */
export function resolveMasterSymbol(masterMap: FeederMasterMapRow | null): string | null {
  const clean = masterMap?.masterName?.replace(/กองทุน/g, "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const hit = getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(
      and(
        sql`UPPER(${usSecurities.name}) = ${clean.toUpperCase()}`,
        eq(usSecurities.securityType, "etf"),
        eq(usSecurities.status, "active"),
      ),
    )
    .get();
  return hit?.symbol ?? null;
}

// ─── Inferred row types ───────────────────────────────────────────────────────

export type FeederMasterMapRow = typeof feederMasterMap.$inferSelect;
export type FeederMasterMapInsert = typeof feederMasterMap.$inferInsert;

export type FeederLookThroughHoldingRow = typeof feederLookThroughHoldings.$inferSelect & {
  /** The constituent's US ticker (resolved from its ISIN via the crosswalk), or null
   *  when it isn't a US-listed security we can open — drives row tappability. */
  resolvedSymbol: string | null;
};
export type FeederLookThroughHoldingInsert = typeof feederLookThroughHoldings.$inferInsert;

// ─── Write side ──────────────────────────────────────────────────────────────

/**
 * Upsert the master fund mapping for a feeder fund. Overwrites any existing
 * entry (a feeder fund maps to exactly one master fund at a time).
 */
export function upsertFeederMasterMap(row: FeederMasterMapInsert): void {
  const db = getMarketDb();
  db.insert(feederMasterMap)
    .values(row)
    .onConflictDoUpdate({
      target: feederMasterMap.projId,
      set: {
        masterIsin: row.masterIsin,
        masterName: row.masterName ?? null,
        provider: row.provider ?? "ishares",
      },
    })
    .run();
}

/**
 * Replace all look-through holdings for a feeder fund. Deletes the existing
 * snapshot first so stale rows from a previous crawl are never mixed with
 * the latest data (the CSV is a complete snapshot, not an incremental diff).
 */
export function upsertFeederLookThroughHoldings(
  projId: string,
  rows: FeederLookThroughHoldingInsert[],
): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    tx.delete(feederLookThroughHoldings).where(eq(feederLookThroughHoldings.projId, projId)).run();
    for (const row of rows) {
      tx.insert(feederLookThroughHoldings).values(row).run();
    }
  });
}

// ─── Read side ────────────────────────────────────────────────────────────────

/** Every feeder → master mapping. Used by the catalog transform to fold
 * curated master names into facet derivation (index family). */
export function listFeederMasterMap(): FeederMasterMapRow[] {
  return getMarketDb().select().from(feederMasterMap).all();
}

/**
 * Transitive weight of a US security in each Thai feeder fund — how much of the
 * fund is that stock, seen through its master ETF's holdings. A feeder is ~100%
 * invested in its master, so the master's weight IS the feeder's. Keyed by feeder
 * proj_id. The feeder look-through carries no ticker (N-PORT names only), so it's
 * matched on ISIN through the same OpenFIGI crosswalk (security_id_map) that
 * resolves US ETF holdings — no licensed identifier is exposed.
 */
export function getFeederWeightsForSymbol(symbol: string): Map<string, number> {
  const key = tickerKey(symbol);
  const out = new Map<string, number>();
  if (!key) return out;
  const rows = getMarketDb()
    .select({
      projId: feederLookThroughHoldings.projId,
      weightPct: feederLookThroughHoldings.weightPct,
    })
    .from(feederLookThroughHoldings)
    // id_value is stored upper-cased; upper-case the isin side so a lower-case
    // ISIN still matches (one-sided keeps the id_value PK index seekable).
    .innerJoin(
      securityIdMap,
      eq(securityIdMap.idValue, sql`UPPER(${feederLookThroughHoldings.isin})`),
    )
    .where(
      and(
        sql`UPPER(${securityIdMap.ticker}) = ${key}`,
        isNotNull(feederLookThroughHoldings.weightPct),
      ),
    )
    .all();
  for (const r of rows) {
    if (r.weightPct == null) continue;
    // One master per feeder, but guard against dupes by keeping the largest.
    out.set(r.projId, Math.max(out.get(r.projId) ?? 0, r.weightPct));
  }
  return out;
}

/** Feeder → master mapping for one fund. Returns null if not mapped. */
export function getFeederMasterMap(projId: string): FeederMasterMapRow | null {
  return (
    getMarketDb().select().from(feederMasterMap).where(eq(feederMasterMap.projId, projId)).get() ??
    null
  );
}

/**
 * Look-through holdings for one feeder fund (latest snapshot), ordered by
 * rank ascending (largest holding first = rank 1).
 */
export function getFeederLookThroughHoldings(projId: string): FeederLookThroughHoldingRow[] {
  // Resolve each holding's ISIN to its US ticker via the crosswalk so a US
  // constituent (a stock/ETF the app can open) becomes a tappable drill-in.
  return (
    getMarketDb()
      .select({
        ...getTableColumns(feederLookThroughHoldings),
        resolvedSymbol: securityIdMap.ticker,
      })
      .from(feederLookThroughHoldings)
      // id_value is stored upper-cased; upper-case the isin side so a lower-case ISIN
      // still resolves (one-sided keeps the id_value PK index seekable).
      .leftJoin(
        securityIdMap,
        eq(securityIdMap.idValue, sql`UPPER(${feederLookThroughHoldings.isin})`),
      )
      .where(eq(feederLookThroughHoldings.projId, projId))
      .orderBy(feederLookThroughHoldings.rank)
      .all()
  );
}

/**
 * Composite feeder enrichment for one fund — returns both the master map row
 * and the look-through holdings in a single call.
 */
export function getFeederEnrichment(projId: string): {
  masterMap: FeederMasterMapRow | null;
  lookThroughHoldings: FeederLookThroughHoldingRow[];
} {
  return {
    masterMap: getFeederMasterMap(projId),
    lookThroughHoldings: getFeederLookThroughHoldings(projId),
  };
}
