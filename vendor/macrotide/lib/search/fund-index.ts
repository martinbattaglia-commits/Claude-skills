// In-memory full-text search index over the fund catalog (MiniSearch).
//
// Why MiniSearch and not SQLite FTS5 / a search server: the catalog is a
// bounded, read-only corpus (a few thousand active funds). A small in-memory
// inverted index is the fastest possible lookup, has zero query-time DB
// contention for concurrent users, and rebuilds cheaply after the nightly
// refresh. The old path — `LIKE '%q%'` across four columns — could not use any
// index (leading wildcard) and could never match a fund by its FEEDER MASTER
// (e.g. searching "S&P500" should surface "KKP US500-UH" whose master is the
// "iShares Core S&P 500 ETF"); folding the master name into the document text
// fixes both.
//
// Lifecycle: the index is built lazily on first search and cached per DB handle.
// A cheap staleness signal (active-fund row count + MAX(updated_at)) lets the
// nightly catalog refresh transparently trigger a rebuild without an explicit
// invalidation call. `invalidateFundIndex()` is also exported for callers that
// want to force a rebuild.

import { eq, sql } from "drizzle-orm";
import MiniSearch from "minisearch";
import type { MarketDb } from "../db/context";
import { getMarketDb } from "../db/context";
import { feederMasterMap, fundCatalog, fundShareClasses } from "../db/schema";

// ─── Index nickname / alias expansion ────────────────────────────────────────

// Curated map of index nicknames → canonical terms folded into the query. Keys
// are matched case-insensitively against whole query tokens (after stripping
// punctuation, so "s&p500" and "sp500" both normalize to "sp500"). Values are
// extra terms appended to the query so a search for "us500" also matches funds
// whose master is the "S&P 500" ETF. Keep this small and curated.
const ALIASES: Record<string, string[]> = {
  sp500: ["s&p", "500"],
  spx: ["s&p", "500"],
  us500: ["s&p", "500"],
  sandp: ["s&p", "500"],
  nasdaq: ["nasdaq", "100"],
  ndx: ["nasdaq", "100"],
  ndx100: ["nasdaq", "100"],
  qqq: ["nasdaq", "100"],
  acwi: ["msci", "acwi", "all", "country", "world"],
  msciworld: ["msci", "world"],
  world: ["msci", "world"],
  emerging: ["msci", "emerging", "markets"],
  em: ["emerging", "markets"],
  gold: ["gold"],
  set50: ["set", "50"],
  set100: ["set", "100"],
};

/** Strip punctuation and lowercase a token so "S&P500" and "sp500" collide. */
function normalizeToken(tok: string): string {
  return tok.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Expand a raw query string with curated index-nickname synonyms. The original
 * query is always preserved; alias expansions are appended so a great literal
 * match still wins on relevance while the alias broadens recall.
 */
export function expandQuery(query: string): string {
  const extra: string[] = [];
  for (const tok of query.split(/\s+/)) {
    const norm = normalizeToken(tok);
    if (norm && ALIASES[norm]) extra.push(...ALIASES[norm]);
  }
  return extra.length ? `${query} ${extra.join(" ")}` : query;
}

// ─── Index documents ─────────────────────────────────────────────────────────

interface FundDoc {
  id: string; // projId
  abbrName: string;
  englishName: string;
  thaiName: string;
  policyDesc: string;
  // Feeder master name from the catalog column AND the feeder_master_map table,
  // concatenated — this is what makes "S&P500" surface "KKP US500-UH".
  master: string;
  // Priceable share-class tickers of this fund (space-joined), e.g.
  // "SCBGOLD SCBGOLDA SCBGOLDP". Indexed so a class-specific ticker the user
  // typed (SCBGOLDP) finds its parent — the screener then lists the family.
  // Without this, only the parent abbr is searchable and class codes are
  // invisible to search despite showing in the Explore list.
  classTickers: string;
}

// Field boosts: the symbol is the strongest signal, then the names, then the
// long-form policy/master text. Tuned so an exact abbr-name hit outranks a
// buried policy-text mention. Class tickers are exact symbols too, so they
// match the abbr boost.
const SEARCH_FIELDS = [
  "abbrName",
  "englishName",
  "thaiName",
  "policyDesc",
  "master",
  "classTickers",
] as const;
const FIELD_BOOST: Record<string, number> = {
  abbrName: 8,
  classTickers: 8,
  englishName: 4,
  thaiName: 4,
  policyDesc: 1,
  master: 2,
};

function newIndex(): MiniSearch<FundDoc> {
  return new MiniSearch<FundDoc>({
    fields: [...SEARCH_FIELDS],
    storeFields: ["id"],
    // Tokenize on whitespace AND punctuation so "S&P 500" indexes as ["s","p","500"]
    // and "KKP US500-UH" as ["kkp","us500","uh"]. Lowercase for case-insensitivity.
    tokenize: (text) => text.split(/[\s\-/&.,()]+/).filter(Boolean),
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      boost: FIELD_BOOST,
      // Fuzzy/prefix per-term, but NEVER for short or purely-numeric tokens:
      // prefix-matching "500" or fuzzing "100" explodes recall (matches every
      // S&P 500 / Nasdaq 100 fund) and dilutes relevance. Such tokens must hit
      // exactly. Real words still get typo + as-you-type tolerance.
      fuzzy: (term) => (term.length >= 4 && !/^\d+$/.test(term) ? 0.2 : false),
      prefix: (term) => term.length >= 3 && !/^\d+$/.test(term),
    },
  });
}

function buildDocs(db: MarketDb): FundDoc[] {
  // Master name from the feeder_master_map table (richer than the catalog
  // column for some funds), joined onto every catalog row.
  const rows = db
    .select({
      id: fundCatalog.projId,
      abbrName: fundCatalog.abbrName,
      englishName: fundCatalog.englishName,
      thaiName: fundCatalog.thaiName,
      policyDesc: fundCatalog.policyDesc,
      catalogMaster: fundCatalog.feederMasterFund,
      mapMaster: feederMasterMap.masterName,
    })
    .from(fundCatalog)
    .leftJoin(feederMasterMap, eq(feederMasterMap.projId, fundCatalog.projId))
    .all();

  // Space-joined share-class tickers per proj_id (one extra grouped query, not a
  // join — a parent has several classes, which would multiply the rows above).
  const classRows = db
    .select({ projId: fundShareClasses.projId, ticker: fundShareClasses.ticker })
    .from(fundShareClasses)
    .all();
  const classTickersByProj = new Map<string, string[]>();
  for (const c of classRows) {
    const list = classTickersByProj.get(c.projId);
    if (list) list.push(c.ticker);
    else classTickersByProj.set(c.projId, [c.ticker]);
  }

  return rows.map((r) => ({
    id: r.id,
    abbrName: r.abbrName ?? "",
    englishName: r.englishName ?? "",
    thaiName: r.thaiName ?? "",
    policyDesc: r.policyDesc ?? "",
    // Fold both master-name sources; dedupe identical strings to avoid double weight.
    master: [r.catalogMaster, r.mapMaster].filter((s, i, a) => s && a.indexOf(s) === i).join(" "),
    classTickers: (classTickersByProj.get(r.id) ?? []).join(" "),
  }));
}

// ─── Cache + staleness ───────────────────────────────────────────────────────

interface IndexEntry {
  index: MiniSearch<FundDoc>;
  signature: string; // staleness key: rowCount + latest updatedAt
}

// Keyed by DB handle so the owner DB and any demo/per-request DB each get their
// own index (demo DBs are short-lived; the owner index dominates).
const cache = new WeakMap<MarketDb, IndexEntry>();

/**
 * Cheap staleness signature — changes when the catalog OR the share-class table
 * is refreshed. The class table is its own term because `jobs:refresh-share-classes`
 * populates `fund_share_classes` without touching `fund_catalog`; watching only
 * the catalog would serve a class-blind index until the next catalog change.
 */
function catalogSignature(db: MarketDb): string {
  const cat = db
    .select({
      n: sql<number>`count(*)`,
      maxUpd: sql<string | null>`max(${fundCatalog.updatedAt})`,
    })
    .from(fundCatalog)
    .get();
  const cls = db
    .select({
      n: sql<number>`count(*)`,
      maxUpd: sql<string | null>`max(${fundShareClasses.updatedAt})`,
    })
    .from(fundShareClasses)
    .get();
  return `${cat?.n ?? 0}:${cat?.maxUpd ?? ""}:${cls?.n ?? 0}:${cls?.maxUpd ?? ""}`;
}

function getIndex(db: MarketDb): MiniSearch<FundDoc> {
  const signature = catalogSignature(db);
  const cached = cache.get(db);
  if (cached && cached.signature === signature) return cached.index;

  const index = newIndex();
  const docs = buildDocs(db);
  if (docs.length > 0) index.addAll(docs);
  cache.set(db, { index, signature });
  return index;
}

/**
 * Force the next search to rebuild the index for the current DB handle. Called
 * by the nightly catalog refresh; the staleness signature already covers the
 * common case, so this is a belt-and-braces hook.
 */
export function invalidateFundIndex(db: MarketDb = getMarketDb()): void {
  cache.delete(db);
}

// ─── Public search API ───────────────────────────────────────────────────────

/**
 * Return candidate projIds for a free-text query, ranked by MiniSearch relevance
 * (best match first). Robust to an empty catalog (demo mode) — returns []. The
 * query is alias-expanded before searching so index nicknames resolve.
 */
export function searchFundIds(query: string, db: MarketDb = getMarketDb()): string[] {
  return searchFundIdsScored(query, db).map((r) => r.id);
}

/** A search hit: candidate projId + its MiniSearch BM25-style relevance score. */
export interface ScoredFundId {
  id: string;
  score: number;
}

/**
 * Like {@link searchFundIds} but keeps each hit's relevance `score`. The
 * screener uses the score to gate low-relevance, non-buyable funds (provident,
 * institutional, fixed-term) — they surface only on a strong/exact match so a
 * generic query isn't polluted with funds the user can't buy. Returned in
 * descending score order.
 */
export function searchFundIdsScored(query: string, db: MarketDb = getMarketDb()): ScoredFundId[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const index = getIndex(db);
  if (index.documentCount === 0) return [];
  const expanded = expandQuery(trimmed);
  // combineWith OR (default) + fuzzy/prefix gives recall; relevance ordering is
  // MiniSearch's BM25-style score.
  return index.search(expanded).map((r) => ({ id: r.id as string, score: r.score }));
}
