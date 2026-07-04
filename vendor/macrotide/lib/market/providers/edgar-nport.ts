// SEC EDGAR N-PORT (Form NPORT-P) holdings provider.
//
// Source of underlying holdings for feeder-fund look-through. Every
// US-registered fund (incl. ETFs structured as RICs) files Form NPORT-P
// quarterly; the filing's primary_doc.xml lists every holding with name,
// CUSIP, ISIN, percent-of-NAV weight, and asset category.
//
// Why this and not the issuer's own CSV: iShares/VanEck holdings CSVs are
// Akamai bot-gated (a datacenter fetch gets an HTML challenge page, not CSV).
// EDGAR is official, free, and returns real data to a plain server-side GET —
// it only requires a non-bot User-Agent (we send the shared browser UA; see below).
//
// Trade-off: NPORT-P is filed within ~60 days of each fiscal quarter end, so
// holdings are "as of" the last quarter — fine for an informational look-through
// (an S&P 500 / Nasdaq-100 basket barely moves quarter to quarter; we timestamp
// it with the report-period date).
//
// Flow (all free, all server-fetchable, tested live):
//   1. EFTS full-text search for the fund's EDGAR series id, date-windowed to
//      the last ~200 days, forms=NPORT-P → newest filing's accession number.
//   2. Fetch https://www.sec.gov/Archives/edgar/data/{registrantCik}/{acc}/primary_doc.xml
//   3. Parse <invstOrSec> blocks; sort by weight; keep the top N.

import { secEdgarUserAgent } from "../user-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A US fund whose NPORT-P holdings we can fetch. Keyed by the fund's own ISIN
 *  in EDGAR_FUNDS. cik is the REGISTRANT cik (used in the Archives path), which
 *  differs from the filing-agent cik in the accession number. */
export interface EdgarFundRef {
  /** Registrant CIK (the trust), used to build the Archives URL. */
  cik: string;
  /** EDGAR series id (e.g. "S000004310"), used to find the right filing. */
  seriesId: string;
  /** The fund's own ISIN, stored as the master identifier for display. */
  isin: string;
  /** Human-readable fund name. */
  displayName: string;
  /** Distinctive identifier that MUST appear (case-insensitive substring) in a
   *  master-fund name for this fund to be a match candidate. Disjoint across
   *  funds so a name can't be a candidate for two of them. Optional on the type
   *  so callers building ad-hoc refs need not supply it; every EDGAR_FUNDS
   *  entry has one (enforced by the registry test). */
  primaryKeyword?: string;
  /** Extra keywords to break ties between same-primary candidates. */
  keywords?: string[];
}

/** One parsed holding from a NPORT-P filing. */
export interface NportHolding {
  name: string;
  /** NPORT-P does not carry tickers — always null (ISIN/CUSIP identify it). */
  ticker: string | null;
  /** Human-readable asset class, mapped from the NPORT assetCat code. */
  assetClass: string | null;
  isin: string | null;
  cusip: string | null;
  /** Percent of NAV (already a percentage, e.g. 8.04 means 8.04%). */
  weightPct: number | null;
  /** ISO-2 country of the investment (`<invCountry>`, e.g. "US", "IE"). */
  country: string | null;
  /** For a derivative (swap/future), the counterparty on the other side of the
   *  contract (`<counterpartyName>`, e.g. "Cowen Group"). Null for a direct holding.
   *  The `name`/`isin` describe the UNDERLYING (the swap's reference instrument),
   *  so this is the one extra fact a derivative row carries. */
  counterparty?: string | null;
}

export interface NportResult {
  /** Report-period date (YYYY-MM-DD) the holdings are "as of", or null. */
  asOfDate: string | null;
  holdings: NportHolding[];
  /**
   * Total number of portfolio holdings in the filing, BEFORE the top-N cap — the
   * count that separates a full-replication S&P 500 fund (~505) from a total-market
   * fund (~3,600) whose top holdings look identical. 0 when no filing parsed.
   */
  totalCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// www.sec.gov (Archives) enforces SEC's "Fair Access" policy and 403s a plain
// browser UA from a datacenter IP; it serves only a UA declaring a contact. We
// send the declared SEC EDGAR UA (lib/market/user-agent.ts); SEC_EDGAR_USER_AGENT
// overrides it with a real project contact.
const EFTS_SEARCH = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
// Look back far enough to always include the latest quarterly filing (filed
// within ~60 days of a quarter end, quarters 90 days apart).
const LOOKBACK_DAYS = 200;

const userAgent = secEdgarUserAgent;

// NPORT-P asset-category codes → human labels (raw code as fallback).
const ASSET_CAT_LABELS: Record<string, string> = {
  EC: "Equity (common)",
  EP: "Equity (preferred)",
  DBT: "Debt",
  ABS: "Asset-backed",
  MBS: "Mortgage-backed",
  RA: "Repurchase agreement",
  STIV: "Short-term investment",
  DCO: "Commodity derivative",
  DE: "Equity derivative",
  DFE: "Forward derivative",
  DIR: "Rate derivative",
  DCR: "Credit derivative",
  SN: "Structured note",
  LON: "Loan",
  COMM: "Commodity",
  RE: "Real estate",
};

// ─── Fund registry ──────────────────────────────────────────────────────────
// Master funds used by Thai feeder funds that are US-registered (file NPORT-P).
// CIK + seriesId verified live against SEC's company_tickers_mf.json and EFTS.
// Add entries (with a verified ISIN) as more feeders are mapped.
export const EDGAR_FUNDS: Record<string, EdgarFundRef> = {
  US4642872265: {
    cik: "1100663",
    seriesId: "S000004310",
    isin: "US4642872265",
    displayName: "iShares Core S&P 500 ETF",
    primaryKeyword: "s&p 500",
  },
  US4642863926: {
    cik: "1100663",
    seriesId: "S000021461",
    isin: "US4642863926",
    displayName: "iShares MSCI ACWI ETF",
    primaryKeyword: "acwi",
  },
  US46090E1038: {
    cik: "1067839",
    seriesId: "S000101292",
    isin: "US46090E1038",
    displayName: "Invesco QQQ Trust",
    primaryKeyword: "qqq",
  },
  US46138G6492: {
    cik: "1378872",
    seriesId: "S000069448",
    isin: "US46138G6492",
    displayName: "Invesco NASDAQ 100 ETF",
    primaryKeyword: "nasdaq 100",
  },
};

// ─── Master-name resolution ───────────────────────────────────────────────────

/**
 * Resolve a master-fund name string (the SEC-Thai `feederfund_master_fund`
 * field) to an EDGAR_FUNDS key (the fund's ISIN), conservatively. A fund is a
 * candidate only if the name contains its `primaryKeyword`; the winner is the
 * unique highest scorer (score = primary + matched `keywords`). Returns null
 * when there is no candidate or the top score is tied — callers should then
 * defer to an explicit feeder_master_map entry rather than guess.
 */
export function matchEdgarFund(masterName: string): string | null {
  const name = masterName.toLowerCase();
  let best: { isin: string; score: number } | null = null;
  let tied = false;
  for (const [isin, ref] of Object.entries(EDGAR_FUNDS)) {
    if (!ref.primaryKeyword || !name.includes(ref.primaryKeyword.toLowerCase())) continue;
    const extra = ref.keywords?.filter((k) => name.includes(k.toLowerCase())).length ?? 0;
    const score = 1 + extra;
    if (!best || score > best.score) {
      best = { isin, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  return best && !tied ? best.isin : null;
}

// ─── Any-ETF resolution (company_tickers_mf.json) ─────────────────────────────
// The feeder registry above is hand-curated for Thai-feeder masters. For the US
// Explore/detail path we resolve an ARBITRARY ETF ticker to its EDGAR series via
// SEC's keyless fund-ticker directory, which maps every US fund/ETF ticker to its
// registrant CIK + seriesId + classId (verified: VOO→S000002839, QQQ, VTI, …).
// SPY-style unit investment trusts aren't in this file → resolve to null (caller
// degrades to "no holdings"), which is fine for v1.

const MF_TICKERS_URL = "https://www.sec.gov/files/company_tickers_mf.json";

interface MfEntry {
  cik: string;
  seriesId: string;
  classId: string;
}

let mfTickerMapCache: Map<string, MfEntry> | null = null;

export async function loadMfTickerMap(): Promise<Map<string, MfEntry>> {
  if (mfTickerMapCache) return mfTickerMapCache;
  const json = (await fetchJson(MF_TICKERS_URL)) as {
    fields?: string[];
    data?: unknown[][];
  } | null;
  const map = new Map<string, MfEntry>();
  if (json?.fields && json.data) {
    const ci = json.fields.indexOf("cik");
    const si = json.fields.indexOf("seriesId");
    const li = json.fields.indexOf("classId");
    const ti = json.fields.indexOf("symbol");
    for (const row of json.data) {
      const ticker = String(row[ti] ?? "")
        .trim()
        .toUpperCase();
      // First class wins; an ETF resolves to one series regardless of class row.
      if (!ticker || map.has(ticker)) continue;
      map.set(ticker, {
        cik: String(row[ci] ?? ""),
        seriesId: String(row[si] ?? ""),
        classId: String(row[li] ?? ""),
      });
    }
  }
  if (map.size > 0) mfTickerMapCache = map;
  return map;
}

/** Test seam — drop the memoised fund-ticker directory. */
export function __resetMfTickerMapCache(): void {
  mfTickerMapCache = null;
}

/** Resolve any US ETF ticker to an EDGAR fund ref (null for non-fund / UIT tickers). */
export async function resolveEtfFund(symbol: string): Promise<EdgarFundRef | null> {
  const e = (await loadMfTickerMap()).get(symbol.trim().toUpperCase());
  if (!e?.cik || !e.seriesId) return null;
  return { cik: e.cik, seriesId: e.seriesId, isin: "", displayName: symbol.trim().toUpperCase() };
}

/** Registrant CIK + EDGAR series/class ids for a fund ticker (the 485BPOS keys). */
export async function resolveEtfClass(
  symbol: string,
): Promise<{ cik: string; seriesId: string; classId: string } | null> {
  const e = (await loadMfTickerMap()).get(symbol.trim().toUpperCase());
  if (!e?.cik || !e.seriesId || !e.classId) return null;
  return { cik: e.cik, seriesId: e.seriesId, classId: e.classId };
}

export interface EtfHoldingsResult extends NportResult {
  /**
   * "ok"         — parsed a filing with holdings (safe to cache).
   * "unresolved" — not a fund / UIT ticker like SPY (safe to cache as empty).
   * "error"      — resolved but the EFTS/archives fetch failed or returned nothing
   *                (likely transient) → caller should NOT cache it, so it retries.
   */
  status: "ok" | "unresolved" | "error";
}

/** Latest NPORT-P holdings for any US ETF ticker, with a cache-vs-retry status. */
export async function fetchEtfHoldings(
  symbol: string,
  opts: { topN?: number } = {},
): Promise<EtfHoldingsResult> {
  // A failed SEC ticker-directory fetch yields an EMPTY map (a successful load has
  // thousands of funds), which would make every symbol look "unresolved" and get
  // its holdings CACHED AS EMPTY — a single SEC blip during a nightly run would
  // wipe real ETFs' holdings and mark them fresh for weeks. Report that as the
  // transient "error" status instead, so the caller retries rather than caches.
  const map = await loadMfTickerMap();
  if (map.size === 0) return { asOfDate: null, holdings: [], totalCount: 0, status: "error" };
  const ref = await resolveEtfFund(symbol);
  if (!ref) return { asOfDate: null, holdings: [], totalCount: 0, status: "unresolved" };
  const res = await fetchNportHoldings(ref, opts);
  return { ...res, status: res.holdings.length > 0 ? "ok" : "error" };
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

/** Decode the XML entities that appear in NPORT text nodes so a name reads
 *  "S&P 500" / "AT&T", not "S&amp;P 500". (We parse with regex, not an XML lib.) */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#0*39);/g, "'")
    .replace(/&#0*38;|&amp;/g, "&"); // ampersand last so it can't re-introduce an entity
}

/**
 * Parse a NPORT-P primary_doc.xml into the top-N holdings by weight.
 * Tolerant string parsing (no XML lib): NPORT-P is a flat, stable schema and
 * the holdings can number in the thousands, so we scan <invstOrSec> blocks.
 */
export function parseNportXml(xml: string, topN = 50): NportResult {
  const asOfDate = (xml.match(/<repPdDate>([^<]+)<\/repPdDate>/) || [])[1]?.trim() || null;
  const holdings: NportHolding[] = [];
  const blocks = xml.split("<invstOrSec>").slice(1);
  for (const raw of blocks) {
    const end = raw.indexOf("</invstOrSec>");
    const seg = end >= 0 ? raw.slice(0, end) : raw;
    const tag = (t: string): string | null => {
      const m = seg.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`));
      return m ? decodeXmlEntities(m[1].trim()) : null;
    };
    // A derivative names its holding by the COUNTERPARTY in the top-level <name>
    // (e.g. a leveraged single-stock ETF's AAPL swap is "<name>Cowen Group</name>").
    // The UNDERLYING it references lives in <derivativeInfo>…<descRefInstrmnt> with
    // its own <issueTitle>/<issuerName> + identifiers (the nested <isin> the isin
    // regex below already picks up). So for a derivative, identify the row by the
    // reference instrument and keep the counterparty as a separate fact.
    const isDeriv = seg.includes("<derivativeInfo>");
    const cpRaw = isDeriv
      ? (seg.match(/<counterpartyName>([^<]*)<\/counterpartyName>/) || [])[1]?.trim()
      : null;
    const counterparty = cpRaw ? decodeXmlEntities(cpRaw) : null;
    // Reference instrument: a single-name swap names one underlying; an index swap
    // names its index; a multi-name BASKET references several <otherRefInst> — the
    // tag()/isin regexes only see the first, so label a basket as such (with its leg
    // count) instead of silently passing off leg #1 as the whole holding, and don't
    // resolve a basket to one leg's ISIN.
    const indexName = isDeriv ? tag("indexName") : null;
    const refInstCount = isDeriv ? (seg.match(/<otherRefInst\b/g)?.length ?? 0) : 0;
    const isBasket = isDeriv && !indexName && refInstCount > 1;
    const refName = isDeriv
      ? indexName ||
        (isBasket ? `Basket (${refInstCount} holdings)` : tag("issueTitle") || tag("issuerName"))
      : null;
    const name = refName || tag("name") || tag("title");
    if (!name) continue;
    const cusip = isBasket ? null : tag("cusip");
    const isin = isBasket ? null : (seg.match(/<isin\s+value="([^"]*)"/) || [])[1] || null;
    const pctRaw = tag("pctVal");
    const pct = pctRaw != null && pctRaw !== "" ? Number(pctRaw) : null;
    const catCode = tag("assetCat");
    const country = tag("invCountry");
    holdings.push({
      name,
      ticker: null,
      assetClass: catCode ? (ASSET_CAT_LABELS[catCode] ?? catCode) : null,
      isin,
      cusip: cusip && cusip !== "N/A" ? cusip : null,
      weightPct: pct != null && Number.isFinite(pct) ? pct : null,
      country: country || null,
      counterparty,
    });
  }
  holdings.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));
  return { asOfDate, holdings: holdings.slice(0, topN), totalCount: holdings.length };
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SEC rate-limits bursts (429) and occasionally 503s; one retry after a short
// pause clears almost all of them. A hard 4xx (e.g. 404) is not retried.
async function fetchWithRetry(url: string, accept: string, retries = 1): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), Accept: accept },
        cache: "no-store",
      });
      if (res.ok) return res;
      if (attempt >= retries || (res.status < 500 && res.status !== 429)) return null;
    } catch {
      if (attempt >= retries) return null;
    }
    await sleep(1200);
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  const res = await fetchWithRetry(url, "application/json");
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch the latest NPORT-P holdings for an EDGAR fund. Returns an empty result
 * (never throws) on any lookup/fetch/parse failure so the nightly crawl is
 * never aborted by one fund.
 */
export async function fetchNportHoldings(
  ref: EdgarFundRef,
  opts: { topN?: number } = {},
): Promise<NportResult> {
  const topN = opts.topN ?? 50;
  const empty: NportResult = { asOfDate: null, holdings: [], totalCount: 0 };
  try {
    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
    const q = encodeURIComponent(`"${ref.seriesId}"`);
    const url = `${EFTS_SEARCH}?q=${q}&forms=NPORT-P&startdt=${ymd(start)}&enddt=${ymd(end)}`;
    const search = (await fetchJson(url)) as {
      hits?: { hits?: Array<{ _source?: { adsh?: string; file_date?: string } }> };
    } | null;
    const hits = search?.hits?.hits ?? [];
    if (hits.length === 0) return empty;
    // EFTS sorts by relevance, not date — pick the newest filing ourselves.
    hits.sort((a, b) => (b._source?.file_date ?? "").localeCompare(a._source?.file_date ?? ""));
    const adsh = hits[0]?._source?.adsh;
    if (!adsh) return empty;

    const acc = adsh.replace(/-/g, "");
    const xmlRes = await fetchWithRetry(`${ARCHIVES}/${ref.cik}/${acc}/primary_doc.xml`, "*/*");
    if (!xmlRes) return empty;
    return parseNportXml(await xmlRes.text(), topN);
  } catch {
    return empty;
  }
}
