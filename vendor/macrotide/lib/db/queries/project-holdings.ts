import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { tickerKey } from "@/lib/market/sources";
import {
  type ProjectedPosition,
  type ProjectionEvent,
  projectPositions,
} from "@/lib/portfolio/project-positions";
import { getDb } from "../context";
import { earmarks, holdings, transactions } from "../schema";
import { canonicalTicker, resolveCatalogSymbol, resolveShareClassByTicker } from "./funds";
import type { Holding, HoldingRow } from "./holdings";
import { foldableEvents } from "./resolve-derived-units";
import type { Transaction, TransactionInsert } from "./transactions";
import { getUsSecurityFigi, resolveUsHolding } from "./us-securities";

/** Case-insensitive ticker match for a WHERE clause (#235): tickers are stored in
 * official catalog case, so a cascade/lookup must fold case to stay correct even
 * if a row's case drifts (legacy data, custom mixed-case). */
const tickerEqSql = (
  col: typeof transactions.ticker | typeof earmarks.ticker | typeof holdings.ticker,
  ticker: string,
) => sql`upper(${col}) = ${tickerKey(ticker)}`;

// Holdings-as-projection orchestration (ADR 0004). The ledger (`transactions`)
// is the source of truth for POSITIONS; `holdings` is a derived cache that this
// module rebuilds after every ledger write. The pure projection math lives in
// lib/portfolio/project-positions.ts; this layer does only the DB I/O —
// read the ledger, project, merge the user-editable instrument metadata that has
// no home in the ledger, and write the holdings rows.

/** The default cost-basis method (ADR 0003/0004: moving average; FIFO is a future per-bucket setting). */
const DEFAULT_METHOD = "average" as const;

/** Map a stored ledger row to the projection's event shape. */
function toProjectionEvent(r: Transaction): ProjectionEvent {
  return {
    id: r.id,
    ticker: r.ticker,
    kind: r.kind as ProjectionEvent["kind"],
    tradeDate: r.tradeDate,
    units: r.units,
    pricePerUnit: r.pricePerUnit,
    amount: r.amount,
    createdAt: r.createdAt,
    quoteSource: r.quoteSource,
    englishName: r.englishName,
    source: r.source,
  };
}

/**
 * Fold one bucket's ledger into its derived positions (one per held ticker) —
 * the single source of position truth, shared by the read path (holdings reads
 * overlay these live) and the write path (rebuild persists row existence +
 * metadata). Facts-only: the missing unit count (value-only Balances + amount-only
 * trades) is derived from NAV(date) here, and an anchor we still can't price is
 * DROPPED (foldableEvents) so it never wipes a position by folding as zero.
 */
export function projectBucketPositions(bucketId: string): ProjectedPosition[] {
  const events = getDb()
    .select()
    .from(transactions)
    .where(eq(transactions.bucketId, bucketId))
    .all();
  return projectPositions(foldableEvents(events).map(toProjectionEvent), DEFAULT_METHOD);
}

/**
 * How many tickers ONE broker account currently holds — fold only that account's
 * ledger rows (by `external_account`), across the caller-owned buckets, and count
 * the surviving positions. Per-account (not per-bucket) so the count is stable
 * when the account is remapped/merged into a different portfolio.
 */
export function countHeldByExternalAccount(
  externalAccount: string,
  ownedBucketIds: string[],
): number {
  if (ownedBucketIds.length === 0) return 0;
  const events = getDb()
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.externalAccount, externalAccount),
        inArray(transactions.bucketId, ownedBucketIds),
      ),
    )
    .all();
  return projectPositions(foldableEvents(events).map(toProjectionEvent), DEFAULT_METHOD).length;
}

/**
 * The broker that already syncs this (bucket, ticker), or null. A ledger row with
 * a non-null `external_id` is the reliable "came from a broker import" marker (a
 * hand-typed `source` never qualifies). Its `source` is the broker label. Used to
 * block a manual add of a ticker that a connection already feeds into the same
 * portfolio, which would silently double-count the position.
 */
export function syncedBrokerForTicker(bucketId: string, ticker: string): string | null {
  const row = getDb()
    .select({ source: transactions.source })
    .from(transactions)
    .where(
      and(
        eq(transactions.bucketId, bucketId),
        tickerEqSql(transactions.ticker, ticker),
        isNotNull(transactions.externalId),
      ),
    )
    .get();
  if (!row) return null;
  return row.source?.trim() || "a connected broker";
}

/** Build the read-model Holding (stored row + folded position) — the same overlay
 * listHoldings/getHolding do, inlined here to avoid a holdings.ts import cycle. */
function withFoldedPosition(row: HoldingRow): Holding {
  const p = projectBucketPositions(row.bucketId).find(
    (x) => tickerKey(x.ticker) === tickerKey(row.ticker),
  );
  return { ...row, units: p?.units ?? 0, avgCost: p?.avgCost ?? null };
}

/**
 * Reconcile the `holdings` rows for one bucket with its ledger. A `holdings` row
 * is the home for instrument metadata that has no place in the ledger (thaiName,
 * category, assetClass, region, ter) plus ledger-carried identity
 * (quoteSource, englishName, source). Positions (units/avgCost) are NOT stored —
 * they're folded on read (listHoldings/getHolding). This keeps one row per held
 * ticker: create a row when a ticker is first held, drop it when it's no longer
 * held, preserve metadata across rebuilds. Idempotent and deterministic.
 */
export function rebuildHoldingsForBucket(bucketId: string): void {
  const db = getDb();
  const positions = projectBucketPositions(bucketId);

  const existing = db.select().from(holdings).where(eq(holdings.bucketId, bucketId)).all();
  // Group by the case-folded ticker (#235): the ledger and the holdings row store
  // the official catalog case, but a case drift must still resolve to ONE row, not
  // silently fork into a duplicate. If legacy data already has two rows that fold
  // to the same key (e.g. "voo" + "VOO"), keep the first and DROP the rest — else
  // both would overlay the one folded position and double-count it.
  const byTicker = new Map<string, (typeof existing)[number]>();
  const dupIds: number[] = [];
  for (const h of existing) {
    const k = tickerKey(h.ticker);
    if (byTicker.has(k)) dupIds.push(h.id);
    else byTicker.set(k, h);
  }
  const now = new Date().toISOString();

  // Cash accounts carry their currency on the ledger (tradeCurrency); surface it +
  // the "cash" asset class onto a NEW holding row so allocation / net-worth see it.
  const cashCurrency = new Map<string, string | null>();
  for (const t of db
    .select({
      ticker: transactions.ticker,
      currency: transactions.tradeCurrency,
      quoteSource: transactions.quoteSource,
    })
    .from(transactions)
    .where(eq(transactions.bucketId, bucketId))
    .all()) {
    if (t.quoteSource === "cash") cashCurrency.set(tickerKey(t.ticker), t.currency ?? null);
  }

  db.transaction((tx) => {
    const seen = new Set<string>();
    for (const p of positions) {
      seen.add(tickerKey(p.ticker));
      const prev = byTicker.get(tickerKey(p.ticker));
      // Bind the stable catalog anchor (#235) from the CURRENT ticker. A renamed
      // fund's stored (old) ticker no longer matches the catalog → keep the
      // existing anchor rather than nulling it (the anchor is what survives a
      // rename). A custom / cash position resolves to null and stays unanchored.
      const sc = resolveShareClassByTicker(p.ticker);
      // US (`market`) holdings anchor on the rename-persistent FIGI from the US
      // catalog (null until the symbol is FIGI-enriched, then the bare ticker
      // anchors — like a Thai class with no ISIN).
      const usFigi = p.quoteSource === "market" ? getUsSecurityFigi(p.ticker) : null;
      if (prev) {
        // Refresh only the ledger-carried identity; leave metadata untouched. No
        // position columns to write — units/avgCost are folded on read.
        tx.update(holdings)
          .set({
            // Adopt the folded display case (#235) so the row's ticker tracks the
            // ledger's canonical case after a case-normalizing rename/backfill.
            ticker: p.ticker,
            quoteSource: p.quoteSource,
            englishName: p.englishName || prev.englishName,
            source: p.source ?? prev.source,
            acquiredOn: prev.acquiredOn ?? p.acquiredOn,
            // Only (re)bind when the current ticker resolves; never wipe a renamed
            // fund's anchor with the now-stale ticker's miss.
            ...(sc
              ? {
                  catalogProjId: sc.projId,
                  catalogClassName: sc.className,
                  catalogIsin: sc.isin,
                }
              : {}),
            ...(usFigi ? { catalogFigi: usFigi } : {}),
            updatedAt: now,
          })
          .where(eq(holdings.id, prev.id))
          .run();
      } else {
        // First time we've seen this ticker — create the metadata row with whatever
        // identity the ledger carries; richer metadata fills in via later edits. A
        // cash account also gets its asset class + native currency from the ledger.
        const isCash = p.quoteSource === "cash";
        tx.insert(holdings)
          .values({
            bucketId,
            ticker: p.ticker,
            englishName: p.englishName || p.ticker,
            quoteSource: p.quoteSource,
            catalogProjId: sc?.projId,
            catalogClassName: sc?.className,
            catalogIsin: sc?.isin,
            catalogFigi: usFigi ?? undefined,
            assetClass: isCash ? "cash" : undefined,
            currency: isCash ? (cashCurrency.get(tickerKey(p.ticker)) ?? null) : undefined,
            source: p.source,
            acquiredOn: p.acquiredOn,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }
    // Drop holdings whose ticker no longer nets to a held position.
    for (const h of existing) {
      if (!seen.has(tickerKey(h.ticker))) tx.delete(holdings).where(eq(holdings.id, h.id)).run();
    }
    // Drop any case-variant duplicate rows (legacy data) so one position can't
    // be double-counted by two rows that fold to the same ticker.
    for (const dupId of dupIds) tx.delete(holdings).where(eq(holdings.id, dupId)).run();
  });
}

/** Rebuild several buckets (e.g. after a multi-bucket import). */
export function rebuildHoldingsForBuckets(bucketIds: Iterable<string>): void {
  for (const id of new Set(bucketIds)) rebuildHoldingsForBucket(id);
}

// ─── Holdings write paths, routed through the ledger (ADR 0004) ───────────────
//
// "Add a holding" / "edit a holding" / "delete a holding" are sugar over ledger
// events: the user never types a position directly. Each function makes its
// ledger change with raw ops, then runs ONE rebuild so the projection lands once.

/** Input for {@link createHoldingViaLedger} — the snapshot "add holding" payload. */
export interface CreateHoldingInput {
  bucketId: string;
  ticker: string;
  englishName: string;
  quoteSource: string;
  units: number;
  /** Avg cost per unit; null/undefined → an uncosted opening (cost unknown). */
  avgCost?: number | null;
  source?: string | null;
  acquiredOn?: string | null;
  // Instrument metadata (no home in the ledger; lands on the holding row).
  thaiName?: string | null;
  category?: string | null;
  assetClass?: string | null;
  region?: string | null;
  ter?: number | null;
}

/** Patch for {@link editHoldingViaLedger} — any subset of position/identity/metadata. */
export interface EditHoldingPatch {
  ticker?: string;
  englishName?: string;
  quoteSource?: string;
  units?: number;
  avgCost?: number | null;
  source?: string | null;
  thaiName?: string | null;
  category?: string | null;
  assetClass?: string | null;
  region?: string | null;
  ter?: number | null;
}

const METADATA_KEYS = ["thaiName", "category", "assetClass", "region", "ter"] as const;

function pickMetadata(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of METADATA_KEYS) if (patch[k] !== undefined) out[k] = patch[k];
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const NUM_EPSILON = 1e-9;
function numChanged(next: number | null | undefined, prev: number | null): boolean {
  if (next === undefined) return false;
  if (next === null || prev === null) return next !== prev;
  return Math.abs(next - prev) > NUM_EPSILON;
}

/**
 * Create a holding from the snapshot "add holding" flow: write an `opening`
 * anchor, rebuild, then stamp the instrument metadata onto the derived row.
 */
export function createHoldingViaLedger(input: CreateHoldingInput): Holding | undefined {
  const db = getDb();
  // Atomic: ledger write + projection rebuild + metadata stamp commit or roll back
  // together — a torn write into the precious app.db is not regenerable. The inner
  // rebuild nests as a savepoint (better-sqlite3 native transaction).
  return db.transaction(() => {
    const avgCost = input.avgCost ?? null;
    // Persist the official catalog case (#235); a custom asset keeps the typed case.
    const ticker = canonicalTicker(input.ticker);
    db.insert(transactions)
      .values({
        bucketId: input.bucketId,
        ticker,
        englishName: input.englishName,
        quoteSource: input.quoteSource,
        kind: "opening",
        tradeDate: input.acquiredOn ?? today(),
        units: input.units,
        pricePerUnit: avgCost,
        amount: avgCost != null ? -(input.units * avgCost) : 0,
        fee: null,
        tradeCurrency: "THB",
        fxToThb: 1,
        source: input.source ?? null,
        importBatchId: "add-holding",
      })
      .run();
    rebuildHoldingsForBucket(input.bucketId);

    const meta = pickMetadata(input as unknown as Record<string, unknown>);
    const row = db
      .select()
      .from(holdings)
      .where(and(eq(holdings.bucketId, input.bucketId), tickerEqSql(holdings.ticker, ticker)))
      .get();
    if (row && Object.keys(meta).length > 0) {
      db.update(holdings)
        .set({ ...meta, updatedAt: new Date().toISOString() })
        .where(eq(holdings.id, row.id))
        .run();
    }
    if (!row) return undefined;
    // Re-read AFTER the metadata update; the position is folded on read (no stored units).
    const fresh = db.select().from(holdings).where(eq(holdings.id, row.id)).get();
    return fresh ? withFoldedPosition(fresh) : undefined;
  });
}

/**
 * Edit a holding "directly" — sugar over the ledger (ADR 0004):
 *   • metadata (name/category/TER/…) updates the row;
 *   • a position change (units/avgCost) edits the single backing event when there
 *     is exactly one, else appends a `snapshot` anchor (history preserved);
 *   • a ticker/quoteSource change is propagated to the ledger so identity stays
 *     consistent.
 * One rebuild lands the result. Returns the updated holding, or undefined if the
 * id doesn't exist.
 */
export function editHoldingViaLedger(id: number, patch: EditHoldingPatch): Holding | undefined {
  const db = getDb();
  const h = db.select().from(holdings).where(eq(holdings.id, id)).get();
  if (!h) return undefined;
  // Atomic: identity/position/metadata writes + rebuild commit or roll back together
  // (precious app.db). The inner rebuild nests as a savepoint.
  return db.transaction(() => {
    const bucketId = h.bucketId;
    const oldTicker = h.ticker;
    // A ticker edit re-resolves to the official catalog case (#235); a custom asset
    // keeps the typed case. A pure case-normalization still cascades below.
    const newTicker = patch.ticker ? canonicalTicker(patch.ticker) || oldTicker : oldTicker;
    const now = new Date().toISOString();
    // Current position folded from the ledger — units/avgCost aren't stored on the row.
    const cur = projectBucketPositions(bucketId).find(
      (p) => tickerKey(p.ticker) === tickerKey(oldTicker),
    );
    const curUnits = cur?.units ?? 0;
    const curAvg = cur?.avgCost ?? null;

    // 1. Identity onto the ledger (ticker / quoteSource / englishName / source).
    const idSet: Record<string, unknown> = {};
    if (newTicker !== oldTicker) idSet.ticker = newTicker;
    if (patch.quoteSource) idSet.quoteSource = patch.quoteSource;
    if (patch.englishName !== undefined) idSet.englishName = patch.englishName;
    if (patch.source !== undefined) idSet.source = patch.source;
    if (Object.keys(idSet).length > 0) {
      db.update(transactions)
        .set(idSet)
        .where(
          and(eq(transactions.bucketId, bucketId), tickerEqSql(transactions.ticker, oldTicker)),
        )
        .run();
    }

    // 2. Position change → edit the single backing event, else append a snapshot.
    if (numChanged(patch.units, curUnits) || numChanged(patch.avgCost, curAvg)) {
      const newUnits = patch.units ?? curUnits;
      const newAvg = patch.avgCost !== undefined ? patch.avgCost : curAvg;
      const events = db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.bucketId, bucketId), tickerEqSql(transactions.ticker, newTicker)),
        )
        .orderBy(transactions.tradeDate, transactions.id)
        .all();
      if (events.length === 1) {
        const e = events[0];
        const isSnapshot = e.kind === "snapshot";
        db.update(transactions)
          .set({
            units: newUnits,
            pricePerUnit: newAvg,
            // A snapshot moves no cash; a single opening/buy carries the cost out.
            amount: isSnapshot ? 0 : newAvg != null ? -(newUnits * newAvg) : 0,
            updatedAt: now,
          })
          .where(eq(transactions.id, e.id))
          .run();
      } else {
        db.insert(transactions)
          .values({
            bucketId,
            ticker: newTicker,
            englishName: patch.englishName ?? h.englishName,
            quoteSource: patch.quoteSource ?? h.quoteSource,
            kind: "snapshot",
            tradeDate: today(),
            units: newUnits,
            pricePerUnit: newAvg,
            amount: 0,
            fee: null,
            tradeCurrency: "THB",
            fxToThb: 1,
            importBatchId: "edit-snapshot",
          })
          .run();
      }
    }

    // 3. Rename the row BEFORE rebuild so the projection matches it (keeps id + metadata).
    if (newTicker !== oldTicker) {
      db.update(holdings).set({ ticker: newTicker }).where(eq(holdings.id, id)).run();
      // Cascade the cash Purpose (#149): an earmark is keyed by (bucketId, ticker), so a
      // rename must move it to the new name — same cascade the ledger does — or the
      // account's Investable/Reserved designation would orphan.
      db.update(earmarks)
        .set({ ticker: newTicker, updatedAt: now })
        .where(and(eq(earmarks.bucketId, bucketId), tickerEqSql(earmarks.ticker, oldTicker)))
        .run();
    }

    // 4. Metadata onto the row.
    const meta = pickMetadata(patch as unknown as Record<string, unknown>);
    // Cash has no expense ratio — the edit form carries a numeric `ter` (0), which
    // would otherwise persist and render "TER 0.00%" on the row. Force it null (#149).
    if ((patch.quoteSource ?? h.quoteSource) === "cash") meta.ter = null;
    if (Object.keys(meta).length > 0) {
      db.update(holdings)
        .set({ ...meta, updatedAt: now })
        .where(eq(holdings.id, id))
        .run();
    }

    // 5. One rebuild reconciles the row set; the position is folded on read.
    rebuildHoldingsForBucket(bucketId);
    const updated = db.select().from(holdings).where(eq(holdings.id, id)).get();
    return updated ? withFoldedPosition(updated) : undefined;
  });
}

/**
 * Delete a holding by removing its backing ledger events, then rebuilding (which
 * drops the now-empty position). Returns false if the id doesn't exist.
 */
export function deleteHoldingViaLedger(id: number): boolean {
  const db = getDb();
  const h = db.select().from(holdings).where(eq(holdings.id, id)).get();
  if (!h) return false;
  // Atomic: ledger delete + rebuild + defensive row drop commit or roll back together
  // (precious app.db). The inner rebuild nests as a savepoint.
  return db.transaction(() => {
    db.delete(transactions)
      .where(and(eq(transactions.bucketId, h.bucketId), tickerEqSql(transactions.ticker, h.ticker)))
      .run();
    // Cascade the cash Purpose: an earmark is keyed by (bucketId, ticker), so
    // deleting the account must drop its earmark too — or it orphans and would
    // re-attach if the same name is re-added (mirrors editHoldingViaLedger's rename
    // cascade, which the delete path previously forgot).
    db.delete(earmarks)
      .where(and(eq(earmarks.bucketId, h.bucketId), tickerEqSql(earmarks.ticker, h.ticker)))
      .run();
    rebuildHoldingsForBucket(h.bucketId);
    // Defensive: if the holding had no ledger events at all (legacy row), drop it.
    db.delete(holdings).where(eq(holdings.id, id)).run();
    return true;
  });
}

/**
 * Reconcile holdings against the live catalog (#235) — the seamless no-data → data
 * transition. A custom (`manual`) holding whose ticker has since JOINED the catalog
 * (a fund newly listed, or a crawl that finally reached it) is promoted to
 * `thai_mutual_fund` so it starts pricing automatically, with no re-create; and any
 * holding whose catalog anchor is missing/stale is (re)bound from its current
 * ticker. Routing lives on both the ledger and the holdings row, so the source
 * upgrade is written to both. Idempotent — a second run finds nothing to do.
 *
 * Run after the nightly catalog refresh. macrotide is MULTI-USER in prod: as a
 * batch job (no request context) this intentionally sweeps EVERY user's holdings
 * — the all-users pattern, not a per-user scope. Each write stays in its own row's
 * bucket, so there is no cross-user effect. Returns the counts.
 */
export function reconcileHoldingCatalog(): { promoted: number; bound: number } {
  const db = getDb();
  // All users' holdings (multi-user prod) — a nightly batch reconciles everyone.
  const rows = db.select().from(holdings).all();
  let promoted = 0;
  let bound = 0;
  for (const h of rows) {
    // Cash accounts are never cataloged funds — even if a user names one like a
    // real fund code, it must not pick up catalog metadata or get promoted (#235).
    if (h.quoteSource === "cash") continue;
    // Resolve via the STORED ANCHOR first (resolveCatalogSymbol), so a holding that
    // was already renamed still resolves and gets its anchor refreshed (e.g. an
    // ISIN added to the class later) — a bare ticker lookup would miss it.
    const sc = resolveCatalogSymbol(h);
    if (sc) {
      const anchorStale =
        h.catalogProjId !== sc.projId ||
        h.catalogClassName !== sc.className ||
        h.catalogIsin !== sc.isin;
      const promote = h.quoteSource === "manual";
      if (!anchorStale && !promote) continue;
      db.transaction(() => {
        if (promote) {
          db.update(transactions)
            .set({ quoteSource: "thai_mutual_fund" })
            .where(
              and(
                eq(transactions.bucketId, h.bucketId),
                tickerEqSql(transactions.ticker, h.ticker),
              ),
            )
            .run();
          promoted++;
        }
        db.update(holdings)
          .set({
            ...(promote ? { quoteSource: "thai_mutual_fund" } : {}),
            catalogProjId: sc.projId,
            catalogClassName: sc.className,
            catalogIsin: sc.isin,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(holdings.id, h.id))
          .run();
        // Count a pure anchor refresh; a promotion already implies the anchor write,
        // so don't double-count it in the summary.
        if (anchorStale && !promote) bound++;
      });
      continue;
    }
    // US: a `market` holding (refresh its FIGI anchor + current symbol) or a
    // `manual` holding whose ticker now matches the US catalog (promote → market).
    if (h.quoteSource === "market" || h.quoteSource === "manual") {
      const us = resolveUsHolding({ ticker: h.ticker, catalogFigi: h.catalogFigi });
      if (!us) continue;
      const usPromote = h.quoteSource === "manual";
      const usFigi = getUsSecurityFigi(us.currentSymbol);
      const usStale = h.catalogFigi !== usFigi;
      if (!usPromote && !usStale) continue;
      db.transaction(() => {
        if (usPromote) {
          db.update(transactions)
            .set({ quoteSource: "market" })
            .where(
              and(
                eq(transactions.bucketId, h.bucketId),
                tickerEqSql(transactions.ticker, h.ticker),
              ),
            )
            .run();
          promoted++;
        }
        db.update(holdings)
          .set({
            ...(usPromote ? { quoteSource: "market" } : {}),
            ...(usFigi ? { catalogFigi: usFigi } : {}),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(holdings.id, h.id))
          .run();
        if (usStale && !usPromote) bound++;
      });
    }
  }
  return { promoted, bound };
}

/**
 * Build the `opening` ledger anchor that reproduces a snapshot holding — used by
 * the seeds and the prod backfill so an existing/seeded holding becomes a
 * first-class ledger event. A holding with no avg cost becomes an UNCOSTED
 * opening (cost basis unknown; gains degrade gracefully).
 */
export function openingFromHolding(
  h: Pick<
    Holding,
    | "bucketId"
    | "ticker"
    | "englishName"
    | "quoteSource"
    | "units"
    | "avgCost"
    | "source"
    | "acquiredOn"
    | "createdAt"
  >,
  importBatchId = "backfill-opening",
): TransactionInsert {
  const tradeDate = h.acquiredOn ?? h.createdAt.slice(0, 10);
  const costed = h.avgCost != null;
  return {
    bucketId: h.bucketId,
    ticker: h.ticker,
    englishName: h.englishName,
    quoteSource: h.quoteSource,
    kind: "opening",
    tradeDate,
    units: h.units,
    pricePerUnit: h.avgCost ?? null,
    amount: costed ? -(h.units * (h.avgCost as number)) : 0,
    fee: null,
    tradeCurrency: "THB",
    fxToThb: 1,
    source: h.source ?? null,
    importBatchId,
  };
}
