import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { quoteCacheKey, tickerKey } from "@/lib/market/sources";
import type { ProjectedPosition } from "@/lib/portfolio/project-positions";
import { getDb } from "../context";
import { buckets, holdings, transactions } from "../schema";
import { listBrokerConnections } from "./broker-connections";
import { resolveCatalogSymbol } from "./funds";
import { enrichHoldingsWithCatalog } from "./holding-enrichment";
import { projectBucketPositions } from "./project-holdings";
import { ownedBy } from "./scope";

/** The stored holdings row: instrument metadata + identity only — NO position. */
export type HoldingRow = typeof holdings.$inferSelect;
export type HoldingInsert = typeof holdings.$inferInsert;
export type HoldingUpdate = Partial<Omit<HoldingInsert, "id" | "createdAt">>;

/**
 * A holding as the app reads it: the stored metadata row PLUS the live position
 * (`units`/`avgCost`) folded from the ledger on read (ADR 0004). The position is
 * never stored — the `holdings` table holds only the instrument metadata that has
 * no home in the ledger (name, asset class, quote source, portfolio). So units,
 * cost, value, gains, and weight always reflect the latest NAV and can't disagree
 * with the analytics, which folds the same ledger.
 */
export type Holding = HoldingRow & {
  units: number;
  avgCost: number | null;
  /** SEC risk-spectrum code, overlaid from the catalog (market.db) by
   * enrichHoldingsWithCatalog — absent for non-catalog holdings. */
  riskSpectrum?: string | null;
  /** Instrument type for a US (`market`) holding — "etf" | "stock", overlaid from
   * us_securities by enrichHoldingsWithCatalog. Absent for Thai funds (identified
   * by quoteSource) and unresolved/custom holdings. Drives the row type chip. */
  instrumentType?: "stock" | "etf" | null;
  /** Derived exposure region ("US"/"Intl"/"EM"/"Global") for a US ETF, overlaid
   * from us_securities (N-PORT look-through). Absent otherwise. Drives the row's
   * line-2 geography for ETFs beyond the curated starter map. */
  exposureRegion?: string | null;
  /**
   * Broker name when this holding was imported from a connected broker, else
   * null. RELIABLE: derived only from ledger rows carrying a non-null
   * `external_id` (the dedup anchor that only broker imports stamp) — a
   * manually-entered holding whose free-text `source` merely names a broker is
   * NOT flagged. Drives the "synced" icon in the holdings list.
   * See {@link syncedBrokerForBuckets}.
   */
  syncedBroker?: string | null;
};

/**
 * Fold the reliable broker-sync signal for a set of buckets: the broker name per
 * held ticker, keyed `${bucketId} ${ticker}`. A holding counts as synced only
 * when one of its ledger rows has a non-null `external_id` (`sourceTag:account:ref`)
 * — the marker that ONLY broker imports stamp; a hand-typed `source` never
 * qualifies. The label is that row's `source` (the displayName kept in step with
 * holdings.source by renameHoldingSource), falling back to the sourceTag prefix.
 * One ledger scan — no per-holding queries.
 */
function syncedBrokerForBuckets(bucketIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (bucketIds.length === 0) return out;
  const rows = getDb()
    .select({
      bucketId: transactions.bucketId,
      ticker: transactions.ticker,
      source: transactions.source,
      externalId: transactions.externalId,
    })
    .from(transactions)
    .where(and(inArray(transactions.bucketId, bucketIds), isNotNull(transactions.externalId)))
    .all();
  for (const r of rows) {
    const key = `${r.bucketId} ${tickerKey(r.ticker)}`;
    if (out.has(key)) continue; // first synced row wins; stable label per holding
    const broker = r.source?.trim() || (r.externalId ?? "").split(":")[0];
    if (broker) out.set(key, broker);
  }
  return out;
}

/** Overlay the live fold onto stored rows. A row the ledger no longer folds to a
 * held position is OMITTED — the fold, not the row, decides what you hold (a
 * sold-out holding's row is already gone, deleted by the rebuild). */
function overlayLive(rows: HoldingRow[]): Holding[] {
  if (rows.length === 0) return [];
  const buckets = new Set(rows.map((h) => h.bucketId));
  const live = new Map<string, ProjectedPosition>();
  for (const b of buckets)
    for (const p of projectBucketPositions(b)) live.set(`${b} ${tickerKey(p.ticker)}`, p);
  const synced = syncedBrokerForBuckets([...buckets]);
  const out: Holding[] = [];
  for (const h of rows) {
    const p = live.get(`${h.bucketId} ${tickerKey(h.ticker)}`);
    if (!p) continue;
    out.push({
      ...h,
      units: p.units,
      avgCost: p.avgCost,
      acquiredOn: h.acquiredOn ?? p.acquiredOn,
      syncedBroker: synced.get(`${h.bucketId} ${tickerKey(h.ticker)}`) ?? null,
    });
  }
  return out;
}

/**
 * Subquery: ids of the buckets the current context may see (ownedBy semantics —
 * the caller's buckets in a request, the NULL-owned single-owner set in jobs).
 * Holdings carry no user_id of their own; every holdings read scopes through
 * this so one user's instrument list can never reach another's request. Jobs
 * that genuinely need every user's refs read the table directly with their own
 * loudly-documented query (see lib/jobs/refresh-tracked-market.ts).
 */
function ownedBucketIds() {
  return getDb().select({ id: buckets.id }).from(buckets).where(ownedBy(buckets.userId));
}

/**
 * The distinct `{source, ticker}` quote refs of the CURRENT USER's held
 * instruments — metadata rows only, no ledger fold. Cheap enough for a hot
 * request path: the quotes-refresh route uses it to derive the user's refs
 * server-side so the client doesn't have to fetch holdings first (request
 * waterfall). User-scoped: a refresh spends provider quota only on the
 * caller's own symbols and never reveals what other accounts hold.
 */
export function listHeldQuoteRefs(): { source: string; ticker: string }[] {
  const rows = getDb()
    .select({
      ticker: holdings.ticker,
      source: holdings.quoteSource,
      catalogProjId: holdings.catalogProjId,
      catalogClassName: holdings.catalogClassName,
      catalogIsin: holdings.catalogIsin,
    })
    .from(holdings)
    .where(inArray(holdings.bucketId, ownedBucketIds()))
    .all();
  const seen = new Set<string>();
  const out: { source: string; ticker: string }[] = [];
  for (const r of rows) {
    // Refresh/look up NAV under the fund's CURRENT code (#235): a renamed fund's
    // stored ticker is the old code, but the catalog + cache live under the new one.
    const ticker = resolveCatalogSymbol(r)?.currentTicker ?? r.ticker;
    const key = `${r.source}:${ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: r.source, ticker });
  }
  return out;
}

/**
 * The combined `${source}:${ticker}` quote cache keys for the current user's
 * held instruments — the exact `fund_quotes.ticker`/`nav_history.ticker` keys
 * (built through `quoteCacheKey`, so case matches the cache). Pass these to
 * `listFundQuotes(keys)` instead of loading the whole table: the analysis and
 * advisor paths only ever read quotes for funds the user holds, so an unfiltered
 * scan grows with the global catalog, not the caller's portfolio.
 */
export function listHeldQuoteKeys(): string[] {
  return listHeldQuoteRefs().map((r) => quoteCacheKey(r.source, r.ticker));
}

/**
 * Holdings visible to the current context, optionally narrowed to one bucket.
 * Always bucket-ownership-scoped — even with an explicit `bucketId`, a foreign
 * bucket folds to an empty list rather than another user's rows (defense in
 * depth under the route-level getBucket guards).
 */
export function listHoldings(bucketId?: string): Holding[] {
  const scope = inArray(holdings.bucketId, ownedBucketIds());
  const rows = getDb()
    .select()
    .from(holdings)
    .where(bucketId ? and(eq(holdings.bucketId, bucketId), scope) : scope)
    .all();
  return enrichHoldingsWithCatalog(overlayLive(rows));
}

export function getHolding(id: number): Holding | undefined {
  // Bucket-ownership-scoped like every holdings read: a foreign id resolves to
  // undefined (ids are sequential integers — don't rely on them being secret).
  const row = getDb()
    .select()
    .from(holdings)
    .where(and(eq(holdings.id, id), inArray(holdings.bucketId, ownedBucketIds())))
    .get();
  if (!row) return undefined;
  // Load by id even when the ledger folds to no position (units 0) — the metadata
  // row exists and may need editing.
  const p = projectBucketPositions(row.bucketId).find(
    (x) => tickerKey(x.ticker) === tickerKey(row.ticker),
  );
  const syncedBroker =
    syncedBrokerForBuckets([row.bucketId]).get(`${row.bucketId} ${tickerKey(row.ticker)}`) ?? null;
  return enrichHoldingsWithCatalog([
    { ...row, units: p?.units ?? 0, avgCost: p?.avgCost ?? null, syncedBroker },
  ])[0];
}

/**
 * Rename a `source` label across all holdings in the given buckets. The caller
 * passes the user's own bucket ids (resolved via the user-scoped listBuckets in
 * the route), so a user can only rewrite their own holdings. Empty `to` clears
 * the label (NULL). Returns the number of rows changed.
 */
export function renameHoldingSource(bucketIds: string[], from: string, to: string): number {
  if (bucketIds.length === 0) return 0;
  const db = getDb();
  // `source` is ledger-carried identity (ADR 0004): rename it on the ledger too,
  // or the next projection rebuild would revert the holding rows. Both are kept
  // in step so they never disagree.
  db.update(transactions)
    .set({ source: to || null })
    .where(and(eq(transactions.source, from), inArray(transactions.bucketId, bucketIds)))
    .run();
  const res = db
    .update(holdings)
    .set({ source: to || null, updatedAt: new Date().toISOString() })
    .where(and(eq(holdings.source, from), inArray(holdings.bucketId, bucketIds)))
    .run();
  return res.changes;
}

/**
 * The source labels in these buckets that belong to a LIVE broker connection: the
 * provenance (`source`) of ledger rows carrying an `external_id` whose
 * `external_account` still maps to a current `brokerConnections` row. Renaming one
 * would desync it from the connector — the next sync re-stamps the old label and
 * the source splits in two — so the rename flow refuses these. Once a broker is
 * disconnected its connection rows are gone, so its label drops out of this set and
 * becomes renamable again (no live sync can re-stamp it).
 */
export function managedSourceLabels(bucketIds: string[]): Set<string> {
  const out = new Set<string>();
  if (bucketIds.length === 0) return out;
  const liveAccounts = listBrokerConnections().map((c) => c.accountCode);
  if (liveAccounts.length === 0) return out;
  const rows = getDb()
    .select({ source: transactions.source })
    .from(transactions)
    .where(
      and(
        inArray(transactions.bucketId, bucketIds),
        isNotNull(transactions.externalId),
        inArray(transactions.externalAccount, liveAccounts),
        isNotNull(transactions.source),
      ),
    )
    .all();
  for (const r of rows) {
    const s = r.source?.trim();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Distinct source labels across the given buckets with their holding counts, each
 * flagged `managed` when it belongs to a live broker connection (see
 * {@link managedSourceLabels}). Drives Settings → Sources: a managed label is kept
 * in step with its connection, so it's shown read-only rather than free-text
 * renamable.
 */
export function sourceLabelSummary(
  bucketIds: string[],
): { source: string; count: number; managed: boolean }[] {
  if (bucketIds.length === 0) return [];
  const rows = getDb()
    .select({ source: holdings.source })
    .from(holdings)
    .where(and(inArray(holdings.bucketId, bucketIds), isNotNull(holdings.source)))
    .all();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = r.source?.trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const managed = managedSourceLabels(bucketIds);
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count, managed: managed.has(source) }))
    .sort((a, b) => a.source.localeCompare(b.source));
}
