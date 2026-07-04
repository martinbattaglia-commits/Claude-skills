// Unified asset search across both catalogs — the single Explore search bar over
// Thai funds (fund_catalog/share classes) AND US securities (us_securities). Each
// source keeps its own finder + ranking; this merges them into one list, ranked by
// match quality when searching and by popularity when idle. The asset-type pill
// narrows to one source (and, for US, to stock vs ETF).

import "server-only";
import { cleanUsSecurityName } from "../../market/us-security-name";
import { findShareClasses, type ShareClassListItem } from "./funds";
import { findUsSecurities, type UsSecurity } from "./us-securities";

export type AssetKind = "thai_fund" | "us_stock" | "us_etf";

export interface AssetSearchItem {
  kind: AssetKind;
  /** Priceable ticker — US symbol or Thai class ticker. */
  ticker: string;
  name: string;
  /** "US ETF" | "US Stock" | "Thai fund" — the row's type chip. */
  typeLabel: string;
  ter: number | null;
  /** Sector (US: GICS/industry) or asset class (Thai). */
  category: string | null;
  exchange: string | null;
  /** Thai routing key for opening the fund detail (null for US). */
  projId: string | null;
}

export type AssetTypeFilter = "all" | "thai" | "us" | "us_stock" | "us_etf";

export interface AssetSearchFilter {
  query?: string;
  assetType?: AssetTypeFilter;
  limit?: number;
  offset?: number;
}

export interface AssetSearchPage {
  items: AssetSearchItem[];
  total: number;
}

interface Ranked extends AssetSearchItem {
  /** Position in this item's SOURCE relevance list (0 = best). Each finder already
   *  ranks by relevance (MiniSearch BM25 for both catalogs), so we interleave the
   *  two lists by position rather than recomputing a coarse text score — that
   *  preserved fuzzy/alias relevance instead of collapsing alias hits to "no match"
   *  and letting popularity float unrelated rows to the top. */
  rank: number;
  /** Exact-ticker hit — hoisted above everything else when searching. */
  exact: boolean;
  pop: number;
}

const DEFAULT_LIMIT = 30;
const MERGE_CAP = 300;

/** Map a Thai share class to the shared cross-asset row shape. Pure. */
export function thaiToItem(t: ShareClassListItem): AssetSearchItem {
  return {
    kind: "thai_fund",
    ticker: t.ticker,
    name: t.englishName || t.thaiName || t.ticker,
    typeLabel: "Thai fund",
    ter: t.ter,
    // Title-case the lowercase asset class (bond → Bond) for the row badge.
    category: t.assetClass ? t.assetClass.charAt(0).toUpperCase() + t.assetClass.slice(1) : null,
    exchange: null,
    projId: t.projId,
  };
}

/** Map a US security to the shared cross-asset row shape. Pure. */
export function usToItem(u: UsSecurity): AssetSearchItem {
  return {
    kind: u.securityType === "etf" ? "us_etf" : "us_stock",
    ticker: u.symbol,
    name: cleanUsSecurityName(u.name),
    typeLabel: u.securityType === "etf" ? "US ETF" : "US Stock",
    ter: u.ter,
    // GICS sector only — the SIC `industry` string is long + ugly.
    category: u.gicsSector ?? null,
    exchange: u.exchange,
    projId: null,
  };
}

/** Lower is a better text match (0 best). 0 when no query (idle browse). Pure. */
export function matchScore(query: string, ticker: string, name: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = ticker.toLowerCase();
  const n = name.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (t.includes(q) || n.includes(q)) return 3;
  return 9;
}

/** Merge + rank + page already-mapped items. Pure. Query → exact ticker, then each
 *  source's relevance rank (interleaved), then popularity; idle → popularity. */
export function rankAssets(
  items: Ranked[],
  hasQuery: boolean,
  offset: number,
  limit: number,
): AssetSearchItem[] {
  items.sort((a, b) => {
    if (hasQuery) {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
    }
    if (a.pop !== b.pop) return b.pop - a.pop;
    return a.name.localeCompare(b.name);
  });
  return items
    .slice(offset, offset + limit)
    .map(({ rank: _r, exact: _e, pop: _p, ...rest }) => rest);
}

export interface AssetSearchDeps {
  findThai: typeof findShareClasses;
  findUs: typeof findUsSecurities;
}

export function searchAssets(
  filter: AssetSearchFilter = {},
  deps: Partial<AssetSearchDeps> = {},
): AssetSearchPage {
  const findThai = deps.findThai ?? findShareClasses;
  const findUs = deps.findUs ?? findUsSecurities;
  const query = filter.query?.trim() ?? "";
  const hasQuery = query.length > 0;
  const at = filter.assetType ?? "all";
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), 100);
  // Clamp offset to the merge window: nothing is reachable past it, so a larger
  // offset would only ever return an empty page (defensive — unbounded before).
  const offset = Math.min(Math.max(filter.offset ?? 0, 0), MERGE_CAP);
  // Always merge over the SAME top-N window per source, independent of offset/limit.
  // Fetching only offset+limit rows meant each page re-derived the candidate pool AND
  // the Thai popularity divisor (per-window max AUM) from a different slice — so ranks
  // (and which items landed on a page) shifted between "load more" requests, and a
  // strong match ranked beyond a small page's cap was dropped before cross-source
  // ranking. A fixed window makes ranking + normalization deterministic across pages.
  const cap = MERGE_CAP;

  const wantThai = at === "all" || at === "thai";
  const wantUs = at === "all" || at === "us" || at === "us_stock" || at === "us_etf";

  const ranked: Ranked[] = [];
  let total = 0;

  if (wantThai) {
    const page = findThai({ query: query || undefined, limit: cap });
    total += page.total;
    const maxAum = Math.max(1, ...page.items.map((t) => t.aum ?? 0));
    page.items.forEach((t, i) => {
      const item = thaiToItem(t);
      ranked.push({
        ...item,
        rank: i,
        exact: matchScore(query, item.ticker, item.name) === 0,
        pop: (t.aum ?? 0) / maxAum,
      });
    });
  }

  if (wantUs) {
    const securityType = at === "us_stock" ? "stock" : at === "us_etf" ? "etf" : undefined;
    const page = findUs({
      query: query || undefined,
      securityType,
      limit: cap,
      // Idle browse leads with the most popular (alphabetical isn't useful).
      sort: hasQuery ? undefined : "popularity",
    });
    total += page.total;
    page.items.forEach((u, i) => {
      const item = usToItem(u);
      ranked.push({
        ...item,
        rank: i,
        exact: matchScore(query, item.ticker, item.name) === 0,
        // popularityScore is already 0–1; a small view-count nudge, capped.
        pop: Math.min(1, u.popularityScore + Math.min(u.viewCount, 100) / 500),
      });
    });
  }

  return { items: rankAssets(ranked, hasQuery, offset, limit), total };
}
