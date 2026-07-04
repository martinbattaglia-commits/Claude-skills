// RSS / Atom news aggregator. Feeds a long-term-investing news
// block on MarketsScreen — editorial sources only, no headline-driven noise.
//
// Cache: 30-min in-memory TTL keyed by the feed list. No DB table.
// Failure mode: one feed throwing must not kill the response — Promise.allSettled
// over fetches; partial results are surfaced with the failures count.

import "server-only";
import { XMLParser } from "fast-xml-parser";

export interface NewsItem {
  /** Stable identifier (feed-provided guid / id, or URL as fallback). */
  id: string;
  title: string;
  url: string;
  /** Human-readable feed name (e.g. "Of Dollars and Data"). */
  source: string;
  /** ISO-8601 UTC. */
  publishedAt: string;
}

export interface NewsFeedDef {
  /** Stable slug used for de-dup keys + telemetry. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  url: string;
}

export interface NewsAggregateResult {
  items: NewsItem[];
  /** Number of feeds that failed to fetch / parse. */
  failures: number;
  /** When this snapshot was assembled. */
  fetchedAt: string;
}

// Source list. Editorial picks confirmed by user via lead 2026-05-23.
// v1 (philosophy): ODAD, AWoCS, Bangkok Post Business.
// v2 added Fed Monetary Policy for rate-decision / market-context coverage.
// Considered and dropped across both rounds: Bogleheads, Morningstar,
// MarketWatch (top + marketpulse + realtime), Bloomberg markets, Reuters,
// Yahoo Finance, CNBC, Bank of Thailand (no public RSS).
export const NEWS_FEEDS: readonly NewsFeedDef[] = [
  {
    id: "ofdollarsanddata",
    name: "Of Dollars and Data",
    url: "https://ofdollarsanddata.com/feed/",
  },
  {
    id: "awealthofcommonsense",
    name: "A Wealth of Common Sense",
    url: "https://awealthofcommonsense.com/feed/",
  },
  {
    id: "bangkokpost-business",
    name: "Bangkok Post Business",
    url: "https://www.bangkokpost.com/rss/data/business.xml",
  },
  {
    id: "fed-monetary",
    name: "Federal Reserve · Monetary Policy",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
  },
] as const;

const CACHE_TTL_MS = 30 * 60_000; // 30 min
const MAX_ITEMS = 30;
const FETCH_TIMEOUT_MS = 8_000;

interface CacheEntry {
  key: string;
  result: NewsAggregateResult;
  expiresAt: number;
}

// Pin the cache on globalThis so Next's dev hot-reload doesn't blow it away.
const globalForNews = globalThis as unknown as { __macrotideNewsCache?: CacheEntry };

function cacheKeyFor(feeds: readonly NewsFeedDef[]): string {
  return feeds
    .map((f) => f.id)
    .sort()
    .join(",");
}

/**
 * Public entry: returns a deduped, sorted, capped news list. Cache-first.
 */
export async function getMarketNews(
  feeds: readonly NewsFeedDef[] = NEWS_FEEDS,
  opts: { now?: number; fetcher?: typeof fetch } = {},
): Promise<NewsAggregateResult> {
  const now = opts.now ?? Date.now();
  const key = cacheKeyFor(feeds);
  const cached = globalForNews.__macrotideNewsCache;
  if (cached && cached.key === key && cached.expiresAt > now) {
    return cached.result;
  }
  const result = await aggregateNews(feeds, opts.fetcher ?? fetch, now);
  globalForNews.__macrotideNewsCache = {
    key,
    result,
    expiresAt: now + CACHE_TTL_MS,
  };
  return result;
}

/** Test-only: drop the in-memory cache. */
export function __resetNewsCache(): void {
  globalForNews.__macrotideNewsCache = undefined;
}

async function aggregateNews(
  feeds: readonly NewsFeedDef[],
  doFetch: typeof fetch,
  now: number,
): Promise<NewsAggregateResult> {
  const results = await Promise.allSettled(feeds.map((f) => fetchAndParse(f, doFetch)));
  let failures = 0;
  const all: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      all.push(...r.value);
    } else {
      failures += 1;
    }
  }
  return {
    items: capAndSort(dedupeByUrl(all)),
    failures,
    fetchedAt: new Date(now).toISOString(),
  };
}

async function fetchAndParse(feed: NewsFeedDef, doFetch: typeof fetch): Promise<NewsItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await doFetch(feed.url, {
      signal: ctl.signal,
      headers: {
        // Some hosts (Bangkok Post, MarketWatch) reject requests without a UA.
        "User-Agent": "macrotide-news/1.0 (+https://github.com/)",
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
      },
    });
    if (!res.ok) {
      throw new Error(`feed ${feed.id} returned HTTP ${res.status}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  return parseFeed(xml, feed);
}

/**
 * Parse an RSS 2.0 or Atom 1.0 document into NewsItem[]. Tolerates missing
 * fields and CDATA-wrapped values (fast-xml-parser handles CDATA out of the
 * box). Bad items are skipped, not thrown.
 */
export function parseFeed(xml: string, feed: NewsFeedDef): NewsItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    cdataPropName: "__cdata",
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;

  const rssChannel = (root.rss as { channel?: unknown })?.channel;
  if (rssChannel) {
    const items = toArray((rssChannel as Record<string, unknown>).item);
    return items.map((it) => rssItemToNews(it, feed)).filter(isNotNull);
  }

  if (root.feed) {
    const items = toArray((root.feed as Record<string, unknown>).entry);
    return items.map((it) => atomEntryToNews(it, feed)).filter(isNotNull);
  }

  return [];
}

function rssItemToNews(raw: unknown, feed: NewsFeedDef): NewsItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const title = textValue(item.title);
  const link = textValue(item.link);
  if (!title || !link) return null;
  const url = link.trim();
  const guidRaw = item.guid;
  const guid = textValue(guidRaw) || url;
  const pub = textValue(item.pubDate) || textValue(item["dc:date"]);
  const publishedAt = normalizeDate(pub);
  return {
    id: `${feed.id}:${guid}`,
    title: decodeEntities(title.trim()),
    url,
    source: feed.name,
    publishedAt,
  };
}

function atomEntryToNews(raw: unknown, feed: NewsFeedDef): NewsItem | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const title = textValue(entry.title);
  const link = atomLinkHref(entry.link) || textValue(entry.link);
  if (!title || !link) return null;
  const id = textValue(entry.id) || link;
  const pub = textValue(entry.updated) || textValue(entry.published);
  return {
    id: `${feed.id}:${id}`,
    title: decodeEntities(title.trim()),
    url: link,
    source: feed.name,
    publishedAt: normalizeDate(pub),
  };
}

function atomLinkHref(raw: unknown): string | null {
  if (!raw) return null;
  // Atom <link> can be an element with href attr, or an array of such elements.
  if (Array.isArray(raw)) {
    // Prefer rel="alternate" or no rel.
    const alt = raw.find((l) => {
      const rel = (l as Record<string, unknown>)["@_rel"];
      return !rel || rel === "alternate";
    });
    const pick = alt ?? raw[0];
    const href = (pick as Record<string, unknown>)?.["@_href"];
    return typeof href === "string" ? href : null;
  }
  if (typeof raw === "object") {
    const href = (raw as Record<string, unknown>)["@_href"];
    if (typeof href === "string") return href;
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/**
 * Decode the HTML entities that survive XML parsing in feed titles — including
 * double-encoded ones like `&amp;#8217;` (RSS commonly ships `’` as `&#8217;`,
 * then escapes the `&`). Named first, then numeric, so one pass resolves the
 * common double-encoding.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, n: string) => NAMED_ENTITIES[n] ?? _m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number.parseInt(d, 10)));
}

function textValue(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = textValue(v);
      if (s) return s;
    }
    return "";
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.__cdata === "string") return obj.__cdata;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return "";
}

function toArray<T>(raw: T | T[] | undefined): T[] {
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function isNotNull<T>(v: T | null): v is T {
  return v !== null;
}

/**
 * Best-effort RFC-822 / ISO-8601 date normalization. Falls back to "" when the
 * string can't be parsed — callers should treat empty publishedAt as "unknown
 * date, sort to the end."
 */
function normalizeDate(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return "";
}

function dedupeByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const key = it.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function capAndSort(items: NewsItem[]): NewsItem[] {
  const sorted = [...items].sort((a, b) => {
    // Newest first. Empty publishedAt (unknown) sorts last.
    if (!a.publishedAt && !b.publishedAt) return 0;
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  return sorted.slice(0, MAX_ITEMS);
}
