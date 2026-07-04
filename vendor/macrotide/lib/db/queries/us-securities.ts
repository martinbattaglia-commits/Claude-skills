// US securities catalog queries — the shared contract over `us_securities`.
//
// Write side (ingestion): the nightly Nasdaq-directory refresh upserts the
// listed universe and delists rows the latest directory no longer carries.
// Read side (consumers): Explore browse/search/filter, the Add-holding ticker
// autofill, and the Advisor's US-instrument search tool.

import "server-only";
import { and, asc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { quoteCacheKey, tickerKey } from "../../market/sources";
import { searchUsSymbolsScored } from "../../search/us-security-index";
import { getMarketDb } from "../context";
import { fundQuotes, navHistory, usSecurities } from "../schema";

export type UsSecurity = typeof usSecurities.$inferSelect;
export type UsSecurityInsert = typeof usSecurities.$inferInsert;

// ─── write side (refresh job) ───────────────────────────────────────────────

/**
 * Batch upsert directory rows. Every upserted row is stamped with `seenAt` so a
 * follow-up `markDelistedExcept(seenAt)` can flip any active row the latest
 * directory didn't touch to 'delisted' — no large NOT IN needed. Re-listing is
 * automatic: a returning symbol upserts back to status 'active'.
 */
export function upsertUsSecurities(rows: UsSecurityInsert[], seenAt: string): number {
  if (rows.length === 0) return 0;
  const db = getMarketDb();
  let n = 0;
  // Chunk to stay well under SQLite's bound-variable ceiling (7 cols/row).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows
      .slice(i, i + CHUNK)
      .map((r) => ({ ...r, status: "active" as const, updatedAt: seenAt }));
    db.insert(usSecurities)
      .values(chunk)
      .onConflictDoUpdate({
        target: usSecurities.symbol,
        set: {
          name: sql`excluded.name`,
          securityType: sql`excluded.security_type`,
          exchange: sql`excluded.exchange`,
          // Don't clobber an enriched asset_class with the directory's NULL.
          assetClass: sql`COALESCE(excluded.asset_class, ${usSecurities.assetClass})`,
          currency: sql`excluded.currency`,
          status: sql`excluded.status`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    n += chunk.length;
  }
  return n;
}

/**
 * Flip every still-'active' row NOT touched by the current refresh (its
 * `updatedAt` differs from this run's `seenAt`) to 'delisted'. Returns the count.
 */
export function markDelistedExcept(seenAt: string): number {
  const res = getMarketDb()
    .update(usSecurities)
    .set({ status: "delisted", updatedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(and(eq(usSecurities.status, "active"), ne(usSecurities.updatedAt, seenAt)))
    .run();
  return res.changes;
}

// ─── read side (Explore / Advisor / Add-holding) ────────────────────────────

export interface FindUsSecuritiesFilter {
  /** Free-text over symbol (prefix) + name (contains). */
  query?: string;
  securityType?: "stock" | "etf";
  /** Include delisted rows. Default false (active only). */
  includeDelisted?: boolean;
  sort?: "symbol" | "name" | "popularity";
  limit?: number;
  offset?: number;
}

const FIND_DEFAULT_LIMIT = 50;
const FIND_MAX_LIMIT = 600;

/** Structured (non-text) filters shared by the browse fetch + its count. */
function structuredClauses(filter: FindUsSecuritiesFilter): SQL[] {
  const clauses: SQL[] = [];
  if (!filter.includeDelisted) clauses.push(eq(usSecurities.status, "active"));
  if (filter.securityType) clauses.push(eq(usSecurities.securityType, filter.securityType));
  return clauses;
}

export interface UsSecuritiesPage {
  items: UsSecurity[];
  total: number;
}

export function findUsSecurities(filter: FindUsSecuritiesFilter = {}): UsSecuritiesPage {
  const db = getMarketDb();
  const limit = Math.min(filter.limit ?? FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);
  const clauses = structuredClauses(filter);
  const queryStr = filter.query?.trim();

  // ── Text query → relevance search via the in-memory MiniSearch index ──
  // (typo/prefix/alias tolerant, no leading-wildcard table scan). Candidates are
  // capped to a bounded pool; the structured type/status filters still apply.
  if (queryStr) {
    const scored = searchUsSymbolsScored(queryStr).slice(0, FIND_MAX_LIMIT);
    if (scored.length === 0) return { items: [], total: 0 };
    const rank = new Map(scored.map((s, i) => [s.symbol.toUpperCase(), i]));
    clauses.push(inArray(sql`upper(${usSecurities.symbol})`, [...rank.keys()]));
    const rows = db
      .select()
      .from(usSecurities)
      .where(and(...clauses))
      .all();
    // Exact-symbol first (typing "AAPL" surfaces Apple), then MiniSearch relevance
    // rank — the IN clause can't preserve the ranked order, so sort in memory over
    // the bounded candidate set.
    const exact = tickerKey(queryStr);
    const keyOf = (s: string) => s.toUpperCase();
    rows.sort((a, b) => {
      const ea = keyOf(a.symbol) === exact ? 0 : 1;
      const eb = keyOf(b.symbol) === exact ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ra = rank.get(keyOf(a.symbol)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(keyOf(b.symbol)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  }

  // ── No query → browse order ──
  const where = clauses.length ? and(...clauses) : undefined;
  const order: SQL[] =
    filter.sort === "popularity"
      ? // Default browse order ("alphabet isn't useful"): most-traded (daily
        // most-actives score) → biggest (market cap, populated for enriched
        // mega-caps even when the most-actives score is sparse) → in-app demand →
        // symbol as the stable tiebreak. SQLite sorts NULLs last on DESC.
        [
          sql`${usSecurities.popularityScore} DESC`,
          sql`${usSecurities.marketCap} DESC`,
          sql`${usSecurities.viewCount} DESC`,
          asc(usSecurities.symbol),
        ]
      : [asc(filter.sort === "name" ? usSecurities.name : usSecurities.symbol)];

  const items = db
    .select()
    .from(usSecurities)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset)
    .all();

  const total = db.select({ n: sql<number>`count(*)` }).from(usSecurities).where(where).get();

  return { items, total: total?.n ?? 0 };
}

/** Batch case-insensitive symbol lookup — returns the rows that exist (any status). */
export function getUsSecuritiesBySymbols(symbols: string[]): UsSecurity[] {
  const keys = symbols.map((s) => tickerKey(s)).filter((s): s is string => !!s);
  if (keys.length === 0) return [];
  return getMarketDb()
    .select()
    .from(usSecurities)
    .where(inArray(sql`UPPER(${usSecurities.symbol})`, [...new Set(keys)]))
    .all();
}

/** Case-insensitive single-symbol lookup (active or delisted). */
export function getUsSecurity(symbol: string): UsSecurity | undefined {
  const s = tickerKey(symbol);
  if (!s) return undefined;
  return getMarketDb()
    .select()
    .from(usSecurities)
    .where(sql`UPPER(${usSecurities.symbol}) = ${s}`)
    .get();
}

// ─── demand signal (drives the popular-prewarm warm set) ────────────────────

/**
 * Record a user view of a US security: +1 `view_count`, stamp `last_viewed_at`.
 * Called on a real detail open (not a prefetch or the warm job). Case-insensitive;
 * a no-op when the symbol isn't catalogued. `seenAt` is injectable for tests.
 */
export function bumpUsSymbolDemand(symbol: string, seenAt?: string): void {
  const s = tickerKey(symbol);
  if (!s) return;
  getMarketDb()
    .update(usSecurities)
    .set({
      viewCount: sql`${usSecurities.viewCount} + 1`,
      lastViewedAt: seenAt ?? new Date().toISOString(),
    })
    .where(sql`UPPER(${usSecurities.symbol}) = ${s}`)
    .run();
}

// ─── popularity (set by the daily most-actives pass; drives the warm set) ───

/** Write normalized popularity scores (0–1) + a scored-at stamp. Case-insensitive. */
export function setPopularityScores(
  rows: { symbol: string; score: number }[],
  scoredAt: string,
): void {
  if (rows.length === 0) return;
  const db = getMarketDb();
  for (const r of rows) {
    db.update(usSecurities)
      .set({ popularityScore: r.score, lastScoredAt: scoredAt })
      .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(r.symbol)}`)
      .run();
  }
}

/**
 * Decay every still-positive popularity score NOT set by this run (its
 * `lastScoredAt` differs from `scoredAt`) toward a floor, so a name that stops
 * ranking ages out of the warm set instead of warming forever. Returns the count.
 */
export function decayPopularityExcept(
  scoredAt: string,
  opts: { step?: number; floor?: number } = {},
): number {
  const step = opts.step ?? 0.1;
  const floor = opts.floor ?? 0;
  const res = getMarketDb()
    .update(usSecurities)
    .set({ popularityScore: sql`MAX(${floor}, ${usSecurities.popularityScore} - ${step})` })
    .where(
      and(
        sql`(${usSecurities.lastScoredAt} IS NULL OR ${usSecurities.lastScoredAt} != ${scoredAt})`,
        sql`${usSecurities.popularityScore} > ${floor}`,
      ),
    )
    .run();
  return res.changes;
}

/** Active symbols with a positive popularity score, most-popular first. */
export function listTopPopularSymbols(limit: number): string[] {
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(and(eq(usSecurities.status, "active"), sql`${usSecurities.popularityScore} > 0`))
    .orderBy(sql`${usSecurities.popularityScore} DESC`)
    .limit(limit)
    .all()
    .map((r) => r.symbol);
}

/** Active symbols viewed within `windowDays`, most-viewed first (the demand half). */
export function listTopDemandSymbols(limit: number, windowDays: number): string[] {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(and(eq(usSecurities.status, "active"), sql`${usSecurities.lastViewedAt} >= ${cutoff}`))
    .orderBy(sql`${usSecurities.viewCount} DESC`)
    .limit(limit)
    .all()
    .map((r) => r.symbol);
}

// ─── FIGI anchor (rename-persistent US identity; see lib/market/figi.ts) ─────

/** Set composite FIGIs on catalog rows (nightly enrichment). Returns rows touched. */
export function setUsSecurityFigis(rows: { symbol: string; figi: string }[]): number {
  if (rows.length === 0) return 0;
  const db = getMarketDb();
  let n = 0;
  for (const r of rows) {
    n += db
      .update(usSecurities)
      .set({ figi: r.figi })
      .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(r.symbol)}`)
      .run().changes;
  }
  return n;
}

/**
 * Active symbols still missing a FIGI, most-relevant first (popular/viewed get
 * priority) — bounds the nightly OpenFIGI spend to the symbols that matter.
 */
export function listSymbolsMissingFigi(limit: number): string[] {
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(and(eq(usSecurities.status, "active"), sql`${usSecurities.figi} IS NULL`))
    .orderBy(sql`${usSecurities.popularityScore} DESC`, sql`${usSecurities.viewCount} DESC`)
    .limit(limit)
    .all()
    .map((r) => r.symbol);
}

/** Current active catalog symbol for a composite FIGI — the rename resolution. */
export function resolveUsSecurityByFigi(figi: string): UsSecurity | undefined {
  const f = figi.trim();
  if (!f) return undefined;
  return getMarketDb()
    .select()
    .from(usSecurities)
    .where(and(eq(usSecurities.figi, f), eq(usSecurities.status, "active")))
    .get();
}

/** A symbol's stored FIGI (lets anchor-binding reuse the catalog over an API call). */
export function getUsSecurityFigi(symbol: string): string | null {
  return getUsSecurity(symbol)?.figi ?? null;
}

/**
 * Detect ticker renames via the shared FIGI: a delisted symbol whose composite
 * FIGI now belongs to an active symbol IS that security under a new ticker
 * (FB→META). Returns old→new pairs so the refresh can bridge the NAV cache.
 */
export function findUsRenames(): { oldSymbol: string; newSymbol: string }[] {
  const db = getMarketDb();
  const figiToActive = new Map<string, string>();
  for (const r of db
    .select({ symbol: usSecurities.symbol, figi: usSecurities.figi })
    .from(usSecurities)
    .where(and(eq(usSecurities.status, "active"), sql`${usSecurities.figi} IS NOT NULL`))
    .all()) {
    if (r.figi) figiToActive.set(r.figi, r.symbol);
  }
  const out: { oldSymbol: string; newSymbol: string }[] = [];
  for (const r of db
    .select({ symbol: usSecurities.symbol, figi: usSecurities.figi })
    .from(usSecurities)
    .where(and(eq(usSecurities.status, "delisted"), sql`${usSecurities.figi} IS NOT NULL`))
    .all()) {
    const newSymbol = r.figi ? figiToActive.get(r.figi) : undefined;
    if (newSymbol && tickerKey(newSymbol) !== tickerKey(r.symbol)) {
      out.push({ oldSymbol: r.symbol, newSymbol });
    }
  }
  return out;
}

/** Move cached NAV/quote from an old US symbol's key to the new one (rename bridge). */
export function repointUsNav(oldSymbol: string, newSymbol: string): void {
  const db = getMarketDb();
  const oldKey = quoteCacheKey("market", oldSymbol);
  const newKey = quoteCacheKey("market", newSymbol);
  if (oldKey === newKey) return;
  db.run(sql`UPDATE OR REPLACE ${fundQuotes} SET ticker = ${newKey} WHERE ticker = ${oldKey}`);
  db.run(sql`UPDATE OR REPLACE ${navHistory} SET ticker = ${newKey} WHERE ticker = ${oldKey}`);
}

export interface UsHoldingResolution {
  /** The CURRENT catalog symbol (differs from the held ticker after a rename). */
  currentSymbol: string;
  name: string;
  assetClass: string | null;
  /** Catalog expense ratio (ETF TER, decimal) — overlaid when the user set none. */
  ter: number | null;
  /** Instrument type — drives the "ETF"/"Stock" row chip. Null only if a future
   *  catalog row lacks it (the column is NOT NULL today). */
  securityType: "stock" | "etf" | null;
  /** Derived exposure region ("US"/"Intl"/"EM"/"Global") for an ETF; drives the
   *  holdings-list line-2 geography. Null for stocks and un-fetched ETFs. */
  exposureRegion: string | null;
}

/**
 * Resolve a held US security to its CURRENT catalog row — the US analogue of
 * `resolveCatalogSymbol`. By the rename-persistent FIGI anchor first (so a held
 * ticker that was renamed still resolves once its old symbol left the catalog),
 * falling back to a bare-ticker match for holdings without a bound FIGI.
 */
export function resolveUsHolding(input: {
  ticker: string;
  catalogFigi?: string | null;
}): UsHoldingResolution | null {
  const row =
    (input.catalogFigi ? resolveUsSecurityByFigi(input.catalogFigi) : undefined) ??
    getUsSecurity(input.ticker);
  if (!row) return null;
  return {
    currentSymbol: row.symbol,
    name: row.name,
    assetClass: row.assetClass,
    ter: row.ter,
    securityType: row.securityType,
    exposureRegion: row.exposureRegion,
  };
}

// ─── detail enrichment (profile + fundamentals + ratios; see lib/market/edgar.ts) ───

/** One symbol's enrichment patch. Omitted keys are left untouched (so the
 *  profile/fundamentals pass and a later TER/GICS pass don't clobber each
 *  other); an explicit `null` clears the column. */
export interface UsEnrichment {
  symbol: string;
  cik?: string | null;
  sic?: string | null;
  industry?: string | null;
  gicsSector?: string | null;
  gicsSubIndustry?: string | null;
  sharesOutstanding?: number | null;
  marketCap?: number | null;
  epsDiluted?: number | null;
  peRatio?: number | null;
  pbRatio?: number | null;
  netMargin?: number | null;
  ter?: number | null;
  fundamentalsAsOf?: string | null;
}

const ENRICH_KEYS = [
  "cik",
  "sic",
  "industry",
  "gicsSector",
  "gicsSubIndustry",
  "sharesOutstanding",
  "marketCap",
  "epsDiluted",
  "peRatio",
  "pbRatio",
  "netMargin",
  "ter",
  "fundamentalsAsOf",
] as const;

/**
 * Apply enrichment patches and stamp `last_enriched_at`. Only the keys present on
 * each row are written (partial set), so a profile/fundamentals pass and a
 * separate TER/GICS pass compose instead of wiping each other. Case-insensitive;
 * a no-op for an uncatalogued symbol. Returns rows touched.
 */
export function setUsSecurityEnrichment(rows: UsEnrichment[], enrichedAt: string): number {
  if (rows.length === 0) return 0;
  const db = getMarketDb();
  let n = 0;
  for (const r of rows) {
    const set: Record<string, unknown> = { lastEnrichedAt: enrichedAt };
    for (const k of ENRICH_KEYS) {
      if (r[k] !== undefined) set[k] = r[k];
    }
    n += db
      .update(usSecurities)
      .set(set)
      .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(r.symbol)}`)
      .run().changes;
  }
  return n;
}

/**
 * Apply GICS sector / sub-industry by symbol (the public S&P 500 dataset). Does
 * NOT touch `last_enriched_at` — GICS is a separate, bulk dimension, not the
 * profile/fundamentals pass — so it can't starve a symbol of that enrichment.
 * Case-insensitive; a no-op for an uncatalogued symbol. Returns rows touched.
 */
export function applyGicsSectors(
  rows: { symbol: string; gicsSector: string; gicsSubIndustry?: string }[],
): number {
  if (rows.length === 0) return 0;
  const db = getMarketDb();
  let n = 0;
  for (const r of rows) {
    n += db
      .update(usSecurities)
      .set({ gicsSector: r.gicsSector, gicsSubIndustry: r.gicsSubIndustry || null })
      .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(r.symbol)}`)
      .run().changes;
  }
  return n;
}

/** Set an ETF's expense ratio (decimal fraction). No `last_enriched_at` stamp —
 *  TER comes from the ETF-data refresh, not the profile/fundamentals pass. */
export function setUsSecurityTer(symbol: string, ter: number): number {
  return getMarketDb()
    .update(usSecurities)
    .set({ ter })
    .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(symbol)}`)
    .run().changes;
}

/**
 * Write an ETF's DERIVED asset class + exposure region (from N-PORT look-through;
 * see lib/market/etf-classify). Only sets a field when its value is non-null, so a
 * run that can't decide one attribute doesn't clobber a prior good value with null.
 * Case-insensitive; no-op for an uncatalogued symbol or an empty patch.
 */
export function setUsEtfDerived(
  symbol: string,
  patch: { assetClass?: string | null; exposureRegion?: string | null },
): number {
  const set: Partial<{ assetClass: string; exposureRegion: string }> = {};
  if (patch.assetClass != null) set.assetClass = patch.assetClass;
  if (patch.exposureRegion != null) set.exposureRegion = patch.exposureRegion;
  if (Object.keys(set).length === 0) return 0;
  return getMarketDb()
    .update(usSecurities)
    .set(set)
    .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(symbol)}`)
    .run().changes;
}

/**
 * Apply index membership (comma-joined keys like "sp500,nasdaq100") by symbol.
 * Like GICS: bulk, no `last_enriched_at` stamp. An empty membership clears it.
 * Case-insensitive; no-op for an uncatalogued symbol. Returns rows touched.
 */
export function applyIndexMembership(rows: { symbol: string; indices: string[] }[]): number {
  if (rows.length === 0) return 0;
  const db = getMarketDb();
  let n = 0;
  for (const r of rows) {
    n += db
      .update(usSecurities)
      .set({ indices: r.indices.length ? r.indices.join(",") : null })
      .where(sql`UPPER(${usSecurities.symbol}) = ${tickerKey(r.symbol)}`)
      .run().changes;
  }
  return n;
}

/**
 * Active symbols to enrich next — most-relevant first (popularity, then views),
 * NULL/stalest `last_enriched_at` first among equals. Bounds the nightly SEC spend
 * to the symbols users actually see. `staleBefore` (ISO) re-enriches only rows
 * older than that; omit to also include never-enriched rows regardless.
 */
export function listSymbolsToEnrich(limit: number, opts: { staleBefore?: string } = {}): string[] {
  const clauses: SQL[] = [eq(usSecurities.status, "active")];
  if (opts.staleBefore) {
    clauses.push(
      sql`(${usSecurities.lastEnrichedAt} IS NULL OR ${usSecurities.lastEnrichedAt} < ${opts.staleBefore})`,
    );
  }
  return getMarketDb()
    .select({ symbol: usSecurities.symbol })
    .from(usSecurities)
    .where(and(...clauses))
    .orderBy(
      sql`${usSecurities.popularityScore} DESC`,
      sql`${usSecurities.viewCount} DESC`,
      // NULLs sort first (0 before 1), then oldest enriched.
      sql`${usSecurities.lastEnrichedAt} IS NOT NULL`,
      asc(usSecurities.lastEnrichedAt),
    )
    .limit(limit)
    .all()
    .map((r) => r.symbol);
}

/** Count by status — used by the refresh job to log coverage. */
export function countUsSecurities(): { active: number; delisted: number } {
  const rows = getMarketDb()
    .select({ status: usSecurities.status, n: sql<number>`count(*)` })
    .from(usSecurities)
    .groupBy(usSecurities.status)
    .all();
  let active = 0;
  let delisted = 0;
  for (const r of rows) {
    if (r.status === "active") active = r.n;
    else if (r.status === "delisted") delisted = r.n;
  }
  return { active, delisted };
}
