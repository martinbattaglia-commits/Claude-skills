// In-memory full-text search index over the US securities catalog (MiniSearch).
//
// The US analogue of lib/search/fund-index.ts, and for the same reasons: the
// catalog is a bounded (~13k rows), read-only corpus refreshed nightly, so a
// small in-memory inverted index is the fastest lookup, has zero query-time DB
// contention, and rebuilds cheaply. It replaces the old `symbol LIKE 'q%' OR
// name LIKE '%q%'` path — whose leading-wildcard name scan could use no index
// and offered no typo tolerance (a search for "vangard" found nothing).
//
// Shares the fund index's query pre-processing: the same curated alias map
// (`expandQuery`) so "sp500" also matches an ETF whose name is "… S&P 500 …",
// and the same fuzzy/prefix rules, so results feel uniform across both catalogs.
//
// Lifecycle mirrors the fund index: built lazily on first search, cached per DB
// handle, and transparently rebuilt when a cheap staleness signature (active-row
// count + MAX(updated_at)) changes after the nightly catalog refresh.

import { sql } from "drizzle-orm";
import MiniSearch from "minisearch";
import type { MarketDb } from "../db/context";
import { getMarketDb } from "../db/context";
import { usSecurities } from "../db/schema";
import { cleanUsSecurityName } from "../market/us-security-name";
import { expandQuery } from "./fund-index";

interface UsDoc {
  id: string; // symbol
  symbol: string;
  name: string;
}

// The ticker is the strongest signal (a user typing "AAPL" wants Apple), then
// the security name. Exact-symbol ordering is applied by the caller on top.
const SEARCH_FIELDS = ["symbol", "name"] as const;
const FIELD_BOOST: Record<string, number> = { symbol: 8, name: 4 };

function newIndex(): MiniSearch<UsDoc> {
  return new MiniSearch<UsDoc>({
    fields: [...SEARCH_FIELDS],
    storeFields: ["id"],
    // Same tokenizer as the fund index: split on whitespace + punctuation so
    // "S&P 500" → ["s","p","500"] and "BRK.B" → ["brk","b"]. Lowercase for
    // case-insensitivity.
    tokenize: (text) => text.split(/[\s\-/&.,()]+/).filter(Boolean),
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      boost: FIELD_BOOST,
      // Fuzzy/prefix per-term, but never for short or purely-numeric tokens
      // (prefixing "500" or fuzzing "100" explodes recall). Same rule as the
      // fund index.
      fuzzy: (term) => (term.length >= 4 && !/^\d+$/.test(term) ? 0.2 : false),
      prefix: (term) => term.length >= 3 && !/^\d+$/.test(term),
    },
  });
}

function buildDocs(db: MarketDb): UsDoc[] {
  // Active rows only — a delisted security shouldn't surface in search (a held
  // delisted position is resolved by ticker elsewhere, not via search).
  const rows = db
    .select({ symbol: usSecurities.symbol, name: usSecurities.name })
    .from(usSecurities)
    .where(sql`${usSecurities.status} = 'active'`)
    .all();
  return rows.map((r) => ({
    id: r.symbol,
    symbol: r.symbol,
    // Index the cleaned name ("Apple Inc." not "Apple Inc. - Common Stock") so a
    // trailing boilerplate suffix can't dilute a name match.
    name: cleanUsSecurityName(r.name),
  }));
}

interface IndexEntry {
  index: MiniSearch<UsDoc>;
  signature: string;
}

const cache = new WeakMap<MarketDb, IndexEntry>();

/** Cheap staleness signature — changes when the catalog is refreshed/enriched. */
function catalogSignature(db: MarketDb): string {
  const row = db
    .select({
      n: sql<number>`count(*)`,
      maxUpd: sql<string | null>`max(${usSecurities.updatedAt})`,
    })
    .from(usSecurities)
    .where(sql`${usSecurities.status} = 'active'`)
    .get();
  return `${row?.n ?? 0}:${row?.maxUpd ?? ""}`;
}

function getIndex(db: MarketDb): MiniSearch<UsDoc> {
  const signature = catalogSignature(db);
  const cached = cache.get(db);
  if (cached && cached.signature === signature) return cached.index;

  const index = newIndex();
  const docs = buildDocs(db);
  if (docs.length > 0) index.addAll(docs);
  cache.set(db, { index, signature });
  return index;
}

/** Force the next search to rebuild the index for the current DB handle. */
export function invalidateUsSecurityIndex(db: MarketDb = getMarketDb()): void {
  cache.delete(db);
}

/** A search hit: candidate symbol + its MiniSearch BM25-style relevance score. */
export interface ScoredUsSymbol {
  symbol: string;
  score: number;
}

/**
 * Candidate symbols for a free-text query, ranked by MiniSearch relevance (best
 * first). Robust to an empty catalog (demo/first-boot) — returns []. The query is
 * alias-expanded first so index nicknames ("sp500") resolve, matching the fund
 * index's behavior.
 */
export function searchUsSymbolsScored(
  query: string,
  db: MarketDb = getMarketDb(),
): ScoredUsSymbol[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const index = getIndex(db);
  if (index.documentCount === 0) return [];
  return index
    .search(expandQuery(trimmed))
    .map((r) => ({ symbol: r.id as string, score: r.score }));
}
