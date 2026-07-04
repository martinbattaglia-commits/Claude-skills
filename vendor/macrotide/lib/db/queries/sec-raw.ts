// SEC raw-landing queries — the EXTRACT/LOAD side of the ELT crawl. The catalog
// refresh lands verbatim SEC payloads here; the transform (lib/jobs/
// transform-fund-catalog.ts) reads them back and derives the normalized catalog.
//
// One table (`sec_raw`) holds every endpoint, keyed by (endpoint, projId, rowKey)
// with a JSON `payload`. Adding an endpoint is a new SEC_ENDPOINT value + a
// transform step — never a schema change. See lib/db/schema/market.ts.

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getMarketDb } from "../context";
import { secRaw } from "../schema";

export type SecRawRow = typeof secRaw.$inferSelect;
export type SecRawInsert = typeof secRaw.$inferInsert;

/**
 * Stable `endpoint` keys for `sec_raw`. The SEC path tail, so a row's origin is
 * legible in the DB and `readSecRaw(SEC_ENDPOINTS.profiles)` reads it back.
 * `aum` is our own derived snapshot of `daily-info/nav` (latest net asset), not
 * a verbatim endpoint — named distinctly so it never collides with a future
 * full NAV landing.
 */
export const SEC_ENDPOINTS = {
  profiles: "general-info/profiles",
  fees: "factsheet/fees",
  aum: "daily-info/aum",
  riskSpectrum: "factsheet/risk-spectrum",
  benchmarks: "factsheet/benchmarks",
  statistics: "factsheet/statistics",
  specifications: "general-info/specifications",
  factsheetUrls: "factsheet/urls",
  minimums: "factsheet/subscription-redemption-minimums",
  dividendPolicy: "factsheet/dividend-policy",
  dividendHistory: "daily-info/dividend-history",
  // v1 FundFactsheet (separate optional subscription) — AIMC peer-group code.
  aimcCategory: "v1/fund-compare",
} as const;

export type SecEndpoint = (typeof SEC_ENDPOINTS)[keyof typeof SEC_ENDPOINTS];

/**
 * Build a raw landing row. `payload` is JSON-stringified verbatim so nothing is
 * dropped at land time; `rowKey` discriminates rows within one (endpoint, projId)
 * — pass "" for a per-fund singleton.
 */
export function makeSecRaw(
  endpoint: string,
  projId: string,
  rowKey: string,
  payload: unknown,
): SecRawInsert {
  return { endpoint, projId, rowKey, payload: JSON.stringify(payload) };
}

/**
 * Batch-upsert raw rows in a single transaction. Idempotent on the
 * (endpoint, projId, rowKey) PK: re-landing the same row overwrites the payload
 * and bumps `fetchedAt`, so a re-crawl corrects in place rather than duplicating.
 */
export function upsertSecRaw(rows: SecRawInsert[]): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(secRaw)
        .values(row)
        .onConflictDoUpdate({
          target: [secRaw.endpoint, secRaw.projId, secRaw.rowKey],
          set: { payload: row.payload, fetchedAt: sql`(CURRENT_TIMESTAMP)` },
        })
        .run();
    }
  });
}

/** Every landed row for one endpoint — the transform's input for that endpoint. */
export function readSecRaw(endpoint: string): SecRawRow[] {
  return getMarketDb().select().from(secRaw).where(eq(secRaw.endpoint, endpoint)).all();
}

/**
 * Distinct landed proj_ids for one endpoint, payloads NOT loaded — pair with
 * {@link readSecRawItemFor} / {@link readSecRawItemsFor} to stream an endpoint
 * one fund at a time instead of materializing every payload at once.
 */
export function listSecRawProjIds(endpoint: string): string[] {
  return getMarketDb()
    .selectDistinct({ projId: secRaw.projId })
    .from(secRaw)
    .where(eq(secRaw.endpoint, endpoint))
    .all()
    .map((r) => r.projId);
}

/**
 * One fund's landed singleton payload (rowKey "") for an endpoint, parsed.
 * Null when absent or unparseable (never abort the transform over one row).
 */
export function readSecRawItemFor<T>(endpoint: string, projId: string): T | null {
  const row = getMarketDb()
    .select()
    .from(secRaw)
    .where(and(eq(secRaw.endpoint, endpoint), eq(secRaw.projId, projId), eq(secRaw.rowKey, "")))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

/**
 * One fund's landed payloads across ALL rowKeys for an endpoint, parsed —
 * the per-fund unit for endpoints that land several rows per fund (benchmark
 * blend rows, per-class statistics…). Unparseable rows are skipped.
 */
export function readSecRawItemsFor<T>(endpoint: string, projId: string): T[] {
  const out: T[] = [];
  const rows = getMarketDb()
    .select()
    .from(secRaw)
    .where(and(eq(secRaw.endpoint, endpoint), eq(secRaw.projId, projId)))
    .all();
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as T);
    } catch {
      // Skip an unparseable row; the next crawl re-lands it.
    }
  }
  return out;
}

/**
 * Parse each landed payload back into its typed item. Rows whose payload fails
 * to parse are skipped (never abort the transform over one corrupt row).
 */
export function readSecRawItems<T>(endpoint: string): T[] {
  const out: T[] = [];
  for (const row of readSecRaw(endpoint)) {
    try {
      out.push(JSON.parse(row.payload) as T);
    } catch {
      // Skip an unparseable row; the next crawl re-lands it.
    }
  }
  return out;
}

/** Count of landed rows for an endpoint (coverage logging for the transform). */
export function countSecRaw(endpoint: string): number {
  const row = getMarketDb()
    .select({ n: sql<number>`count(*)` })
    .from(secRaw)
    .where(eq(secRaw.endpoint, endpoint))
    .get();
  return row?.n ?? 0;
}
