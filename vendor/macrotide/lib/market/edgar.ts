// SEC EDGAR company data client — profile + fundamentals for US securities.
//
// Public-domain US-government open data: the only requirement is a non-bot
// User-Agent (SEC 403s bare automated-tool UAs; we send the shared browser UA). Covers the
// detail-page fields a vendor would otherwise charge for, sourced entirely from
// SEC:
//   • profile (name, listing exchange, SIC industry, fiscal year) — submissions
//   • fundamentals (EPS, net income, revenue, equity, shares) — XBRL companyfacts
//   • ratios (market cap, P/E, P/B, net margin) — computed against OUR price feed
//
// Sibling to edgar-nport.ts (ETF holdings); kept separate because that one parses
// NPORT-P XML for funds while this hits the JSON company APIs for operating
// companies. Both send the declared SEC EDGAR UA (SEC_EDGAR_USER_AGENT overrides).
//
// Endpoints (all need the UA header):
//   ticker→CIK   https://www.sec.gov/files/company_tickers_exchange.json
//   profile      https://data.sec.gov/submissions/CIK{10pad}.json
//   facts        https://data.sec.gov/api/xbrl/companyfacts/CIK{10pad}.json

import "server-only";
import { secEdgarUserAgent } from "./user-agent";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const submissionsUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const factsUrl = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const userAgent = secEdgarUserAgent;

/** Zero-pad a CIK to the 10-digit form every data.sec.gov path expects. */
export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Ticker → CIK ─────────────────────────────────────────────────────────────

export interface CikEntry {
  /** 10-digit zero-padded CIK. */
  cik: string;
  /** Registrant name from the directory. */
  name: string;
  /** Listing exchange ("Nasdaq" | "NYSE" | …) or null. */
  exchange: string | null;
}

// The directory is one ~10k-row file shared by every symbol in a batch, so it is
// fetched once and memoised for the process. Operating companies only — ETFs use
// company_tickers_mf.json (see edgar-nport.ts), which carries seriesId instead.
let cikMapCache: Map<string, CikEntry> | null = null;

export async function loadCikMap(fetchImpl: typeof fetch = fetch): Promise<Map<string, CikEntry>> {
  if (cikMapCache) return cikMapCache;
  const json = (await fetchJson(TICKERS_URL, fetchImpl)) as {
    fields?: string[];
    data?: unknown[][];
  } | null;
  const map = new Map<string, CikEntry>();
  if (json?.fields && json.data) {
    const ci = json.fields.indexOf("cik");
    const ni = json.fields.indexOf("name");
    const ti = json.fields.indexOf("ticker");
    const ei = json.fields.indexOf("exchange");
    for (const row of json.data) {
      const ticker = String(row[ti] ?? "")
        .trim()
        .toUpperCase();
      if (!ticker || map.has(ticker)) continue;
      map.set(ticker, {
        cik: padCik(row[ci] as string | number),
        name: String(row[ni] ?? ""),
        exchange: row[ei] ? String(row[ei]) : null,
      });
    }
  }
  // Only cache a populated map; a transient fetch failure shouldn't pin an empty
  // result for the life of the process.
  if (map.size > 0) cikMapCache = map;
  return map;
}

/** Resolve a ticker to its CIK entry (null if not an EDGAR operating company). */
export async function tickerToCik(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CikEntry | null> {
  const map = await loadCikMap(fetchImpl);
  return map.get(symbol.trim().toUpperCase()) ?? null;
}

/** Test seam — drop the memoised directory. */
export function __resetCikMapCache(): void {
  cikMapCache = null;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export interface UsProfile {
  cik: string;
  name: string;
  /** Listing exchange, first of submissions.exchanges (e.g. "Nasdaq"). */
  exchange: string | null;
  /** SIC code (numeric string) — the public industry classification. */
  sic: string | null;
  /** SIC description (e.g. "Electronic Computers"). */
  sicDescription: string | null;
  /** State/country of incorporation code (e.g. "CA", "DE"). */
  stateOfIncorporation: string | null;
  /** Fiscal year end as MMDD (e.g. "0926"). */
  fiscalYearEnd: string | null;
  /** All tickers EDGAR lists for the registrant. */
  tickers: string[];
}

export async function fetchProfile(
  cik: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UsProfile | null> {
  const j = (await fetchJson(submissionsUrl(padCik(cik)), fetchImpl)) as Record<
    string,
    unknown
  > | null;
  if (!j) return null;
  const exchanges = Array.isArray(j.exchanges) ? (j.exchanges as unknown[]) : [];
  const tickers = Array.isArray(j.tickers) ? (j.tickers as unknown[]).map(String) : [];
  const str = (v: unknown): string | null => {
    const s = v == null ? "" : String(v).trim();
    return s ? s : null;
  };
  return {
    cik: padCik(cik),
    name: String(j.name ?? ""),
    exchange: exchanges.length ? String(exchanges[0]) : null,
    sic: str(j.sic),
    sicDescription: str(j.sicDescription),
    stateOfIncorporation: str(j.stateOfIncorporation),
    fiscalYearEnd: str(j.fiscalYearEnd),
    tickers,
  };
}

// ─── Fundamentals (XBRL companyfacts) ──────────────────────────────────────────

export interface UsFundamentals {
  /** Diluted EPS, latest full fiscal year. */
  epsDiluted: number | null;
  /** Net income, latest full fiscal year (USD). */
  netIncome: number | null;
  /** Revenue, latest full fiscal year (USD). */
  revenue: number | null;
  /** Total stockholders' equity, most recent (USD). */
  equity: number | null;
  /** Common shares outstanding, most recent. */
  sharesOutstanding: number | null;
  /** End date of the most recent fact used (YYYY-MM-DD). */
  asOf: string | null;
}

interface FactPoint {
  start?: string;
  end?: string;
  val?: number;
  form?: string;
  fp?: string;
  frame?: string;
}

type CompanyFacts = {
  facts?: { [taxonomy: string]: { [tag: string]: { units?: { [unit: string]: FactPoint[] } } } };
};

function unitsFor(facts: CompanyFacts, taxonomy: string, tag: string): FactPoint[] {
  const units = facts.facts?.[taxonomy]?.[tag]?.units;
  if (!units) return [];
  // Concepts come under one unit key (USD, shares, USD/shares); flatten them all.
  return Object.values(units).flat();
}

// Annual flow (EPS, income, revenue): the value for a full fiscal year. Prefer a
// 10-K-reported, ~365-day period; among those the latest by end date, then the
// largest value to break a tie. `preferEnd` pins the result to a specific fiscal
// year-end when available — used to align revenue to net income's period so the
// margin is computed from the SAME year (a filer can switch revenue concepts mid-
// history, leaving a stale annual under the old tag).
function latestAnnualFlow(points: FactPoint[], preferEnd?: string | null): FactPoint | null {
  const annual = points.filter((p) => {
    if (p.val == null || !p.end || !p.start) return false;
    const days = (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000;
    return days >= 300 && days <= 400;
  });
  const pool = annual.length ? annual : points.filter((p) => p.val != null && p.end);
  if (!pool.length) return null;
  const matched = preferEnd ? pool.filter((p) => p.end === preferEnd) : [];
  const from = matched.length ? matched : pool;
  return from.reduce((a, b) => {
    const ae = a.end ?? "";
    const be = b.end ?? "";
    if (be > ae) return b;
    if (ae > be) return a;
    return (b.val ?? Number.NEGATIVE_INFINITY) > (a.val ?? Number.NEGATIVE_INFINITY) ? b : a;
  });
}

// US-GAAP tags filers use for top-line revenue, newest-convention first. A company
// can migrate between them across years, so we pool ALL of them and pick the
// latest annual rather than trusting one tag to be current (NVDA, e.g., left
// RevenueFromContractWithCustomerExcludingAssessedTax stale at FY2022).
const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];

// Instant (equity, shares): a point-in-time value; take the latest by end date.
function latestInstant(points: FactPoint[]): FactPoint | null {
  const pool = points.filter((p) => p.val != null && p.end);
  if (!pool.length) return null;
  return pool.reduce((a, b) => ((a.end ?? "") >= (b.end ?? "") ? a : b));
}

export async function fetchFundamentals(
  cik: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UsFundamentals | null> {
  const facts = (await fetchJson(factsUrl(padCik(cik)), fetchImpl)) as CompanyFacts | null;
  if (!facts?.facts) return null;
  return fundamentalsFromFacts(facts);
}

/** Pure extraction from a companyfacts payload — exported for tests. */
export function fundamentalsFromFacts(facts: CompanyFacts): UsFundamentals {
  const eps = latestAnnualFlow(unitsFor(facts, "us-gaap", "EarningsPerShareDiluted"));
  const netIncome = latestAnnualFlow(unitsFor(facts, "us-gaap", "NetIncomeLoss"));
  // Pool every revenue tag and align to net income's fiscal year-end, so the
  // margin uses one consistent year even when the filer switched revenue concepts.
  const revenuePoints = REVENUE_TAGS.flatMap((tag) => unitsFor(facts, "us-gaap", tag));
  const revenue = latestAnnualFlow(revenuePoints, netIncome?.end ?? null);
  const equity = latestInstant(unitsFor(facts, "us-gaap", "StockholdersEquity"));
  const shares = latestInstant(unitsFor(facts, "dei", "EntityCommonStockSharesOutstanding"));
  const asOf = [eps, netIncome, revenue, equity, shares]
    .map((p) => p?.end ?? "")
    .filter(Boolean)
    .sort()
    .pop();
  return {
    epsDiluted: eps?.val ?? null,
    netIncome: netIncome?.val ?? null,
    revenue: revenue?.val ?? null,
    equity: equity?.val ?? null,
    sharesOutstanding: shares?.val ?? null,
    asOf: asOf || null,
  };
}

// ─── Ratios (computed vs our price) ─────────────────────────────────────────────

export interface UsRatios {
  /** Shares × price (USD). */
  marketCap: number | null;
  /** Price ÷ diluted EPS. Null if EPS ≤ 0 (a P/E on losses isn't meaningful). */
  peRatio: number | null;
  /** Market cap ÷ equity. Null if equity ≤ 0. */
  pbRatio: number | null;
  /** Net income ÷ revenue (fraction, e.g. 0.25). */
  netMargin: number | null;
}

/**
 * Derive the price-dependent ratios. `price` is the latest USD close from our own
 * feed — SEC has fundamentals but no price, so the join happens here. A missing
 * or non-positive denominator yields null rather than a misleading number.
 */
export function computeRatios(f: UsFundamentals, price: number | null): UsRatios {
  const shares = f.sharesOutstanding;
  const marketCap = price != null && shares != null ? price * shares : null;
  const peRatio =
    price != null && f.epsDiluted != null && f.epsDiluted > 0 ? price / f.epsDiluted : null;
  const pbRatio =
    marketCap != null && f.equity != null && f.equity > 0 ? marketCap / f.equity : null;
  const netMargin =
    f.netIncome != null && f.revenue != null && f.revenue > 0 ? f.netIncome / f.revenue : null;
  return { marketCap, peRatio, pbRatio, netMargin };
}
