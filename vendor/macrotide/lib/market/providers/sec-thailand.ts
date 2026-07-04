// Thai SEC Open API provider — Thai mutual fund daily NAV.
//
// Source: official Securities and Exchange Commission of Thailand.
// Portal: https://secopendata.sec.or.th/sec-open-apis (launched 2026-01-12).
//   Old portal at https://api-portal.sec.or.th/ retires 2026-06-30.
// Runtime base: https://api.sec.or.th (Azure APIM gateway).
//
// Auth: single subscription on the new portal gives you Primary + Secondary
// keys (rotation pair — both valid). One subscription covers all six product
// groups. Header: Ocp-Apim-Subscription-Key.
//
// Rate limit: 5,000 calls per 300 seconds. Min ~16ms between requests
// recommended. HTTP 421 signals over-limit; respect Retry-After.
// Refresh windows: 09:30 + 17:30 Bangkok time.
//
// Ticker format: the user-typed fund code, case-insensitive. Can be either
// a parent fund's proj_abbr_name (e.g. `HI-DIV-RMF`) for funds without share
// classes, OR a share-class name (e.g. `K-FIXED-A`, `HIDIV-D`). When a parent
// fund has share classes, the parent itself is NOT investable — typing the
// parent code returns a helpful error listing the available classes.
//
// Routing is driven by the holding's `quote_source` column (= "thai_mutual_fund"
// here), not by a prefix in the ticker. The provider sees only the bare code.
//
// Endpoints used (v2 — new portal):
//   GET /v2/fund/general-info/profiles?fund_class_name={code}   — exact lookup
//   GET /v2/fund/general-info/profiles?project_info={code}      — partial fallback
//   GET /v2/fund/daily-info/nav?proj_id={id}
//        &fund_class_name={class}                                — narrow to one class
//        &start_nav_date={YYYY-MM-DD}&end_nav_date={YYYY-MM-DD}  — date range
//
// All v2 responses are cursor-paginated:
//   { message, page_size, next_cursor, items: [...] }
// Default/max page_size = 100; empty next_cursor signals last page.

import type { SecFundFeeItem } from "../fund-fees";
import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

export const SEC_THAILAND_SOURCE = "thai_mutual_fund";
const BASE_URL = "https://api.sec.or.th";
// Portal recommends ≥16ms between requests under the 5000-per-300s ceiling.
// 20ms gives margin. With targeted (per-symbol) lookups instead of a global
// index build, a cold-start fetchSeries makes just 2–3 calls.
const REQUEST_DELAY_MS = 20;
const PAGE_SIZE = 100;
const SYMBOL_CACHE_TTL_MS = 24 * 60 * 60_000;

interface SecFund {
  unique_id: string;
  proj_id: string;
  proj_abbr_name: string;
  proj_name_th?: string;
  proj_name_en?: string;
  fund_status?: string;
  fund_class_name?: string;
}

interface SecDailyNav {
  proj_id: string;
  unique_id?: string;
  fund_class_name?: string;
  nav_date: string;
  last_val: number;
  net_asset?: number;
}

interface PaginatedEnvelope<T> {
  message?: string;
  page_size?: number;
  next_cursor?: string;
  items?: T[];
}

interface ResolvedFund {
  projId: string;
  /** Display name, falls back through proj_name_en → proj_name_th → abbr. */
  name: string;
  /**
   * The fund_class_name to filter NAV queries by. `"main"` for funds without
   * share classes; the share-class abbreviation otherwise.
   */
  fundClassName: string;
  cachedAt: number;
}

const symbolCache = new Map<string, ResolvedFund>();

function apiKey(): string {
  const k = process.env.SEC_API_KEY;
  if (!k) {
    throw new ProviderError("SEC_API_KEY is not set", "sec-thailand");
  }
  return k;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Global rate gate. The SEC ceiling is 5 000 calls / 300 s (~16.7/s). A full
// nightly catalog crawl fires ~10–15k calls across a concurrency pool, so a
// per-page sleep alone won't keep us under the cap — concurrent callers would
// burst past it. This serializes call *start times* to at least
// MIN_INTERVAL_MS apart process-wide (~14/s), leaving headroom no matter the
// concurrency. Cheap single-symbol lookups pay at most one interval.
// Tunable throttle + retry knobs. Defaults are the production values; tests
// override them via __setSecThailandRetry to avoid real backoff waits.
//
// All four are overridable via env so an operator can tune a live crawl without
// a code change. The documented quota is 5 000/300 s (over-limit → HTTP 421),
// but the APIM gateway also enforces a tighter per-second BURST cap that returns
// 429 — and a shared key means other consumers eat into both. If a bulk crawl
// sees sustained 429s, raise SEC_MIN_INTERVAL_MS (e.g. 150 ≈ 6.7/s) to back off
// below that burst cap. Read once at module load; change + restart to apply.
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const RETRY_DEFAULTS = {
  minIntervalMs: numEnv("SEC_MIN_INTERVAL_MS", 70), // ~14 calls/s default
  maxRetries: numEnv("SEC_MAX_RETRIES", 5),
  baseDelayMs: numEnv("SEC_BASE_DELAY_MS", 500),
  maxBackoffMs: numEnv("SEC_MAX_BACKOFF_MS", 30_000),
};
let retry = { ...RETRY_DEFAULTS };
let nextSlot = 0;

async function rateGate(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + retry.minIntervalMs;
  if (start > now) await sleep(start - now);
}

async function secFetch<T>(path: string, key: string): Promise<T | null> {
  const url = `${BASE_URL}${path}`;
  for (let attempt = 0; ; attempt++) {
    await rateGate();
    const res = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.status === 204) return null;
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `Thai SEC API rejected the subscription key (${res.status})`,
        "sec-thailand",
        res.status,
      );
    }
    // Retryable: rate-limit (421/429) and server errors (5xx). 401/403 above
    // are auth errors and never retried.
    if (res.status === 421 || res.status === 429 || res.status >= 500) {
      if (attempt >= retry.maxRetries) {
        throw new ProviderError(
          `Thai SEC API still failing after ${retry.maxRetries} retries (${res.status}) for ${path}`,
          "sec-thailand",
          res.status,
        );
      }
      // Honor Retry-After when present, else exponential backoff with jitter.
      const retryAfterSec = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(retry.maxBackoffMs, retry.baseDelayMs * 2 ** attempt) +
            Math.floor(Math.random() * 250);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new ProviderError(
        `Thai SEC API returned ${res.status} for ${path}`,
        "sec-thailand",
        res.status,
      );
    }
    return (await res.json()) as T;
  }
}

async function secFetchPaginated<T>(
  path: string,
  query: Record<string, string>,
  key: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  for (let safety = 0; safety < 200; safety++) {
    const params = new URLSearchParams({ ...query, page_size: String(PAGE_SIZE) });
    if (cursor) params.set("next_cursor", cursor);
    const env = await secFetch<PaginatedEnvelope<T>>(`${path}?${params.toString()}`, key);
    if (!env?.items?.length) break;
    items.push(...env.items);
    if (!env.next_cursor) break;
    cursor = env.next_cursor;
    await sleep(REQUEST_DELAY_MS);
  }
  return items;
}

function nameOf(f: SecFund): string {
  return f.proj_name_en ?? f.proj_name_th ?? f.proj_abbr_name;
}

/**
 * Resolve a user-typed fund code to a proj_id + class filter. Tries the
 * share-class endpoint first (cheap exact match), then falls back to
 * project_info partial-match against parent fund names. Caches both
 * successful and ambiguous resolutions for 24h.
 *
 * On ambiguity (parent fund with multiple share classes), throws a clear
 * error listing the available classes so the user can pick one.
 */
async function resolveSymbol(code: string): Promise<ResolvedFund> {
  const upper = code.trim().toUpperCase();
  if (!upper) {
    throw new ProviderError("empty Thai fund code", "sec-thailand");
  }
  const cached = symbolCache.get(upper);
  if (cached && Date.now() - cached.cachedAt < SYMBOL_CACHE_TTL_MS) {
    return cached;
  }

  const key = apiKey();

  // 1) Treat the input as a share-class name. Exact match, single API call.
  const byClass = await secFetchPaginated<SecFund>(
    "/v2/fund/general-info/profiles",
    { fund_class_name: upper },
    key,
  );
  const exactClass = byClass.find((f) => (f.fund_class_name ?? "").toUpperCase() === upper);
  if (exactClass) {
    const entry: ResolvedFund = {
      projId: exactClass.proj_id,
      name: nameOf(exactClass),
      fundClassName: exactClass.fund_class_name ?? upper,
      cachedAt: Date.now(),
    };
    symbolCache.set(upper, entry);
    return entry;
  }

  // 2) Treat the input as a parent proj_abbr_name. Partial match, then narrow.
  await sleep(REQUEST_DELAY_MS);
  const byProject = await secFetchPaginated<SecFund>(
    "/v2/fund/general-info/profiles",
    { project_info: upper },
    key,
  );
  const parentMatches = byProject.filter((f) => (f.proj_abbr_name ?? "").toUpperCase() === upper);

  // 2a) Single fund, no share classes (fund_class_name === "main" or absent).
  const mainRow = parentMatches.find((f) => {
    const c = (f.fund_class_name ?? "").trim().toLowerCase();
    return c === "main" || c === "" || c === "-";
  });
  if (mainRow) {
    const entry: ResolvedFund = {
      projId: mainRow.proj_id,
      name: nameOf(mainRow),
      fundClassName: "main",
      cachedAt: Date.now(),
    };
    symbolCache.set(upper, entry);
    return entry;
  }

  // 2b) Parent with multiple share classes — ambiguous. Surface the options.
  if (parentMatches.length > 0) {
    const classes = parentMatches
      .map((f) => f.fund_class_name)
      .filter((c): c is string => Boolean(c))
      .sort();
    throw new ProviderError(
      `"${upper}" is a parent fund with multiple share classes. ` +
        `Specify one of: ${classes.map((c) => `thfund:${c}`).join(", ")}`,
      "sec-thailand",
    );
  }

  throw new ProviderError(
    `Unknown Thai fund code "${upper}" — no match for share class or parent fund`,
    "sec-thailand",
  );
}

function rangeToDays(range: SeriesRange): number {
  switch (range) {
    case "1mo":
      return 31;
    case "3mo":
      return 92;
    case "6mo":
      return 183;
    case "1y":
      return 366;
    case "5y":
      return 5 * 366;
    case "max":
      return 365 * 20;
  }
}

function yyyyMmDd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const secThailandProvider: Provider = {
  id: "sec-thailand",
  matches(source: string, _ticker: string): boolean {
    return source === SEC_THAILAND_SOURCE;
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    _interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const entry = await resolveSymbol(ticker);

    const key = apiKey();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setUTCDate(startDate.getUTCDate() - rangeToDays(range));

    const navQuery: Record<string, string> = {
      proj_id: entry.projId,
      start_nav_date: yyyyMmDd(startDate),
      end_nav_date: yyyyMmDd(today),
    };
    // For share classes, narrow the response server-side. For "main" the
    // server returns just the one row per date anyway, but we still apply
    // a defensive client-side filter below.
    if (entry.fundClassName !== "main") {
      navQuery.fund_class_name = entry.fundClassName;
    }

    const rows = await secFetchPaginated<SecDailyNav>("/v2/fund/daily-info/nav", navQuery, key);

    const wantClass = entry.fundClassName.toLowerCase();
    const series: SeriesPoint[] = [];
    for (const r of rows) {
      const rc = (r.fund_class_name ?? "").trim().toLowerCase();
      // Defensive: keep rows that match the wanted class (treating "", "-",
      // "main" as equivalent for parent funds).
      const isMainLike = rc === "" || rc === "-" || rc === "main";
      const matchesWanted = wantClass === "main" ? isMainLike : rc === wantClass;
      if (!matchesWanted) continue;
      if (r.last_val == null) continue;
      const t = Math.floor(Date.parse(`${r.nav_date}T00:00:00Z`) / 1000);
      if (!Number.isFinite(t)) continue;
      series.push({ t, close: r.last_val, netAsset: r.net_asset ?? null });
    }
    series.sort((a, b) => a.t - b.t);

    if (series.length === 0) {
      throw new ProviderError(
        `No NAV data returned for ${ticker} over the requested range`,
        "sec-thailand",
      );
    }

    const latest = series[series.length - 1];
    const previous = series.length > 1 ? series[series.length - 2] : latest;
    const quote: Quote = {
      ticker,
      name: entry.name,
      currency: "THB",
      price: latest.close,
      previousClose: previous.close,
      asOfUnix: latest.t,
    };
    return { quote, series };
  },
};

// ─── Fund catalog enumeration ────────────────────────────────────────────────

/**
 * Raw profile item returned by the /v2/fund/general-info/profiles endpoint
 * when enumerating the full fund universe (no query filter).
 *
 * Field names verified against a live data-inventory spike (29 total fields).
 * NOTE: the v2 endpoint does NOT return fund_type_en/fund_type_th — those
 * fields do not exist. Asset class is derived from policy_desc (Thai label)
 * via inferAssetClass in lib/market/fund-classify.ts.
 */
export interface SecFundProfile {
  proj_id: string;
  proj_abbr_name: string;
  proj_name_th?: string | null;
  proj_name_en?: string | null;
  /** Asset management company name (e.g. "Kasikorn Asset Management"). */
  amc_name?: string | null;
  /** Raw SEC fund status: 'Registered' | 'IPO' | 'Liquidated' | 'Expired' | 'Canceled'. */
  fund_status?: string | null;
  /** Retail availability: 'R' = retail; else (e.g. 'X') not for retail (accredited/institutional). */
  proj_retail_type?: string | null;
  /** Short Thai asset-type label (ตราสารหนี้ / ตราสารทุน / ผสม / ทรัพย์สินทางเลือก / ตลาดเงิน). */
  policy_desc?: string | null;
  /** Management style code: 'AM' active | 'PN' passive/index | 'SM' systematic | 'PM' passive multi-factor | 'BH' buy-and-hold. */
  management_style?: string | null;
  /** Thai label for tax-incentive wrapper (e.g. "กองทุนรวมเพื่อการออม" → SSF). */
  fund_class_tax_incentive_type?: string | null;
  /** Thai share-class detail (จ่ายเงินปันผล = dividend, สะสมมูลค่า = accumulating). */
  fund_class_detail?: string | null;
  /** Geographic mandate flag: '1' = foreign | '3' = mixed | '4' = domestic. */
  invest_country_flag?: string | null;
  /** Master fund name if this is a feeder fund; null/undefined otherwise. */
  feederfund_master_fund?: string | null;
  /** Country where the master fund is registered (Thai name) — its DOMICILE, not mandate. */
  feederfund_country?: string | null;
  /** Full investment-policy text (HTML). Richer than the short policy_desc label. */
  investment_policy_desc?: string | null;
  /** FX-hedging policy, Thai label (ทั้งหมด / ดุลยพินิจ / บางส่วน / ไม่ป้องกัน / …). */
  exchange_rate_protection_policy?: string | null;
  /** 'Y' if the fund has a fixed maturity date. */
  proj_term_flag?: string | null;
  /** Maturity duration components for fixed-term funds (0 when not applicable). */
  proj_term_year?: number | null;
  proj_term_month?: number | null;
  proj_term_day?: number | null;
  /** Fund inception date (ISO date string). */
  init_date?: string | null;
  /** SEC registration date (ISO date string; distinct from inception). */
  regis_date?: string | null;
  /** Cancellation date for dead funds (ISO date string). */
  cancel_date?: string | null;
  /** ISIN code (~30% coverage). */
  fund_class_isin_code?: string | null;
  /** Share-class name (e.g. 'A', 'B', 'main'). Used only for symbol resolution. */
  fund_class_name?: string | null;
}

/**
 * Enumerate every fund profile from the SEC. Follows cursor pagination until
 * exhausted. De-dupes on proj_id, keeping the first occurrence (profiles
 * endpoint may return multiple rows for parent + share classes — we want one
 * catalog row per parent project).
 *
 * Limit is applied AFTER de-dup so the caller gets up to `limit` unique
 * proj_ids (useful for spike/dev runs; omit or set 0 for full crawl).
 */
export async function enumerateFundProfiles(limit = 0): Promise<SecFundProfile[]> {
  const key = apiKey();
  const seen = new Set<string>();
  const profiles: SecFundProfile[] = [];

  let cursor = "";
  for (let safety = 0; safety < 500; safety++) {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("next_cursor", cursor);
    const env = await secFetch<PaginatedEnvelope<SecFundProfile>>(
      `/v2/fund/general-info/profiles?${params.toString()}`,
      key,
    );
    if (!env?.items?.length) break;

    for (const item of env.items) {
      if (!item.proj_id) continue;
      if (seen.has(item.proj_id)) continue;
      seen.add(item.proj_id);
      profiles.push(item);
      if (limit > 0 && profiles.length >= limit) break;
    }

    if (!env.next_cursor || (limit > 0 && profiles.length >= limit)) break;
    cursor = env.next_cursor;
    await sleep(REQUEST_DELAY_MS);
  }

  return profiles;
}

/**
 * Enumerate every fund *share class* from the SEC profiles endpoint. Same
 * paginated source as `enumerateFundProfiles`, but de-duped on
 * `proj_id + fund_class_name` instead of `proj_id`, so multi-class funds yield
 * one row per class (the priceable units) rather than collapsing to the parent.
 * Zero extra API cost over the catalog enumeration — it's the same pages.
 */
export async function enumerateShareClasses(limit = 0): Promise<SecFundProfile[]> {
  const key = apiKey();
  const seen = new Set<string>();
  const classes: SecFundProfile[] = [];

  let cursor = "";
  for (let safety = 0; safety < 500; safety++) {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("next_cursor", cursor);
    const env = await secFetch<PaginatedEnvelope<SecFundProfile>>(
      `/v2/fund/general-info/profiles?${params.toString()}`,
      key,
    );
    if (!env?.items?.length) break;

    for (const item of env.items) {
      if (!item.proj_id) continue;
      const dedupeKey = `${item.proj_id}:${item.fund_class_name ?? "main"}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      classes.push(item);
      if (limit > 0 && classes.length >= limit) break;
    }

    if (!env.next_cursor || (limit > 0 && classes.length >= limit)) break;
    cursor = env.next_cursor;
    await sleep(REQUEST_DELAY_MS);
  }

  return classes;
}

/**
 * Fetch all fee rows for one fund (identified by its proj_id) from the SEC
 * factsheet fees endpoint. Returns an empty array on 204 / no data.
 */
export async function fetchFundFees(projId: string): Promise<SecFundFeeItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundFeeItem>("/v2/fund/factsheet/fees", { proj_id: projId }, key);
}

/** Raw item from /v2/fund/factsheet/risk-spectrum (latest=true snapshot). */
export interface SecRiskSpectrumItem {
  proj_id: string;
  /** Risk-spectrum code, e.g. "RS1".."RS8", plus complex "RS81"/"RS8+". */
  risk_spectrum: string;
  /** Thai description of the risk level / mandate. */
  risk_spectrum_desc?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  prospectus_type?: string | null;
  last_upd_date?: string | null;
}

/**
 * Bulk-fetch the LATEST risk-spectrum record for every fund in one paginated
 * sweep (no per-fund calls): `latest=true` returns the current effective row per
 * fund (`end_date` null). ~40 pages for the whole universe — far cheaper than a
 * per-fund fetch. Drives the SEC-native asset-class classification.
 */
export async function fetchRiskSpectrumLatest(): Promise<SecRiskSpectrumItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecRiskSpectrumItem>(
    "/v2/fund/factsheet/risk-spectrum",
    { latest: "true" },
    key,
  );
}

export interface SecBenchmarkItem {
  proj_id: string;
  /** Sequence within a blended benchmark (a fund can declare several, weighted). */
  group_seq?: number | string | null;
  /** Benchmark index name, factsheet §8.1 — e.g. "ดัชนีผลตอบแทนรวมตลาดหลักทรัพย์ฯ (SET TRI)". */
  benchmark?: string | null;
  benchmark_remark?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  prospectus_type?: string | null;
  last_upd_date?: string | null;
}

/**
 * Bulk-fetch the LATEST declared benchmark rows for every fund in one paginated
 * sweep (`latest=true`, no per-fund calls — same shape as the risk-spectrum
 * sweep). The benchmark string is the authoritative classification signal for
 * index funds: it names the index, the geography, and the hedging variant.
 */
export async function fetchBenchmarksLatest(): Promise<SecBenchmarkItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecBenchmarkItem>(
    "/v2/fund/factsheet/benchmarks",
    { latest: "true" },
    key,
  );
}

export interface SecFundStatisticsItem {
  proj_id: string;
  /** Share-class abbreviation; "main" when the fund is not a class fund. */
  fund_class_name?: string | null;
  // All figures arrive as strings (e.g. "24.63", "-0.02", "0"); the transform
  // parses them. "0" can mean either a true zero or not-applicable — the raw
  // value is preserved verbatim in sec_raw.
  portfolio_turnover_ratio?: string | null;
  recovering_period?: string | null;
  portfolio_duration_period?: string | null;
  maximum_drawdown?: string | null;
  sharpe_ratio?: string | null;
  beta?: string | null;
  alpha?: string | null;
  fx_hedging?: string | null;
  tracking_error?: string | null;
  yield_to_maturity?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  prospectus_type?: string | null;
  last_upd_date?: string | null;
}

/**
 * Bulk-fetch the LATEST factsheet statistics (per fund class) for every fund in
 * one paginated sweep — Sharpe, max drawdown, FX-hedging ratio, tracking error,
 * turnover, YTM. Tracking error + FX hedging feed like-for-like comparison.
 */
export async function fetchFundStatisticsLatest(): Promise<SecFundStatisticsItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundStatisticsItem>(
    "/v2/fund/factsheet/statistics",
    { latest: "true" },
    key,
  );
}

export interface SecFundSpecificationItem {
  proj_id: string;
  fund_class_name?: string | null;
  /** Special-characteristic code per SorNor 87/2558 Appendix 2 (e.g. "CIV", ETF, FIF). */
  spec_code?: string | null;
  spec_desc?: string | null;
  last_upd_date?: string | null;
}

/** Bulk-fetch every fund's special-characteristic codes (ETF / cross-investing / …). */
export async function fetchFundSpecifications(): Promise<SecFundSpecificationItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundSpecificationItem>(
    "/v2/fund/general-info/specifications",
    {},
    key,
  );
}

export interface SecFactsheetUrlItem {
  proj_id: string;
  fund_class_name?: string | null;
  prospectus_type?: string | null;
  /** Factsheet on the AMC's own site. */
  amc_url_factsheet?: string | null;
  /** SEC-hosted factsheet PDF. */
  pdf_factsheet?: string | null;
  as_of_date?: string | null;
  last_upd_date?: string | null;
}

/** Bulk-fetch every fund's factsheet URLs (SEC-hosted PDF + AMC page). */
export async function fetchFactsheetUrls(): Promise<SecFactsheetUrlItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFactsheetUrlItem>("/v2/fund/factsheet/urls", {}, key);
}

export interface SecSubscriptionMinimumItem {
  proj_id: string;
  fund_class_name?: string | null;
  // Amounts arrive as strings; the transform parses them.
  minimum_sub_ipo?: string | null;
  minimum_sub_ipo_cur?: string | null;
  minimum_sub?: string | null;
  minimum_sub_cur?: string | null;
  minimum_sub_unit?: string | null;
  minimum_redempt?: string | null;
  minimum_redempt_cur?: string | null;
  minimum_redempt_unit?: string | null;
  lowbal_val?: string | null;
  lowbal_val_cur?: string | null;
  lowbal_unit?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  prospectus_type?: string | null;
  last_upd_date?: string | null;
}

/** Bulk-fetch the LATEST subscription/redemption minimums per fund class. */
export async function fetchSubscriptionMinimumsLatest(): Promise<SecSubscriptionMinimumItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecSubscriptionMinimumItem>(
    "/v2/fund/factsheet/subscription-redemption-minimums",
    { latest: "true" },
    key,
  );
}

export interface SecDividendPolicyItem {
  proj_id: string;
  fund_class_name?: string | null;
  /** Formal dividend-policy code from the factsheet (authoritative vs class-detail text parsing). */
  dividend_policy?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  prospectus_type?: string | null;
  last_upd_date?: string | null;
}

/** Bulk-fetch the LATEST formal dividend-policy code per fund class. */
export async function fetchDividendPolicyLatest(): Promise<SecDividendPolicyItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecDividendPolicyItem>(
    "/v2/fund/factsheet/dividend-policy",
    { latest: "true" },
    key,
  );
}

export interface SecDividendHistoryItem {
  proj_id: string;
  unique_id?: string | null;
  class_abbr_name?: string | null;
  book_close_date?: string | null;
  dividend_date?: string | null;
  /** Dividend per unit (THB); arrives as a string or number. */
  dividend_value?: string | number | null;
  last_upd_date?: string | null;
}

/**
 * Bulk-fetch the FULL dividend payment history for every fund. The endpoint has
 * no date filter, so each sweep re-reads all history (~1k pages) — that's why
 * the crawl gates it behind SEC_INGEST_DIVIDENDS and a weekly cadence.
 */
export async function fetchDividendHistory(): Promise<SecDividendHistoryItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecDividendHistoryItem>("/v2/fund/daily-info/dividend-history", {}, key);
}

// ─── v1 FundFactsheet (separate subscription) ────────────────────────────────
// The AIMC peer-group category exists ONLY on the legacy v1 FundFactsheet API —
// it has no v2 equivalent (verified against the v2 product catalog). Same host
// and gateway, but a DIFFERENT subscription key (SEC_V1_API_KEY). Everything
// here is optional: when the key isn't configured, the crawl simply skips it.

/** Whether the optional v1 FundFactsheet subscription is configured. */
export function hasV1ApiKey(): boolean {
  return !!process.env.SEC_V1_API_KEY;
}

function v1ApiKey(): string {
  const k = process.env.SEC_V1_API_KEY;
  if (!k) {
    throw new ProviderError("SEC_V1_API_KEY is not set", "sec-thailand");
  }
  return k;
}

export interface SecFundCompareItem {
  /** AIMC peer-group code (e.g. "USEQ", "VIEQ", "EQLC", "CPM"); null = unclassified. */
  fund_compare?: string | null;
  fund_compare_link?: string | null;
  last_upd_date?: string | null;
}

/** Fetch one fund's AIMC peer-group code from the v1 FundFactsheet API. */
export async function fetchFundCompareV1(projId: string): Promise<SecFundCompareItem | null> {
  return secFetch<SecFundCompareItem>(`/FundFactsheet/fund/${projId}/fund_compare`, v1ApiKey());
}

interface SecDailyNavRow {
  proj_id: string;
  nav_date: string;
  net_asset?: number | null;
  last_val?: number | null;
}

/**
 * Fetch the most recent total net asset value (AUM) for one fund.
 * Uses a 7-day window so we catch the latest published figure even over
 * a long weekend. Returns { aum, aumDate } from the most recent row, or
 * null if no data is available. Only call this for Registered (active) funds.
 */
export async function fetchFundAum(
  projId: string,
): Promise<{ aum: number; aumDate: string } | null> {
  const key = apiKey();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 7);

  const rows = await secFetchPaginated<SecDailyNavRow>(
    "/v2/fund/daily-info/nav",
    {
      proj_id: projId,
      start_nav_date: yyyyMmDd(start),
      end_nav_date: yyyyMmDd(today),
    },
    key,
  );

  // Find the most recent row that has a net_asset value.
  const sorted = rows
    .filter((r) => r.net_asset != null && r.nav_date)
    .sort((a, b) => (b.nav_date > a.nav_date ? 1 : b.nav_date < a.nav_date ? -1 : 0));

  if (sorted.length === 0) return null;
  const best = sorted[0];
  // net_asset is guaranteed non-null due to the filter above.
  return { aum: best.net_asset as number, aumDate: best.nav_date };
}

// ─── Fund enrichment fetch helpers ──────────────────────────────────────────
// Each mirrors the fetchFundFees / secFetchPaginated pattern: same throttle,
// retry, and 204→[] handling. All use latest=true (or bare proj_id for
// portfolio) to return only the current effective snapshot.

/** Raw item from /v2/fund/factsheet/performance (latest=true snapshot). */
export interface SecFundPerformanceItem {
  proj_id: string;
  fund_class_name: string;
  start_date: string;
  end_date: string | null;
  prospectus_type?: string | null;
  performance_type_desc: string;
  reference_period: string;
  performance_value?: string | null;
  last_upd_date?: string | null;
}

/** Raw item from /v2/fund/factsheet/asset-allocation (latest=true snapshot). */
export interface SecFundAssetAllocationItem {
  proj_id: string;
  start_date: string;
  end_date: string | null;
  prospectus_type?: string | null;
  asset_seq: number;
  asset_name?: string | null;
  asset_ratio?: number | null;
  last_upd_date?: string | null;
}

/** Raw item from /v2/fund/factsheet/top5-holdings (latest=true snapshot). */
export interface SecFundTop5HoldingItem {
  proj_id: string;
  start_date: string;
  end_date: string | null;
  prospectus_type?: string | null;
  asset_seq: number;
  asset_name?: string | null;
  asset_ratio?: number | null;
  last_upd_date?: string | null;
}

/** Raw item from /v2/fund/outstanding/portfolio (bare proj_id, latest period). */
export interface SecFundPortfolioItem {
  proj_id: string;
  period: string;
  as_of_date?: string | null;
  assetliab_id?: string | null;
  assetliab_desc?: string | null;
  issue_code?: string | null;
  isin_code?: string | null;
  issuer?: string | null;
  assetliab_value?: number | null;
  percent_nav?: number | null;
  last_upd_date?: string | null;
}

/** Raw item from /v2/fund/outstanding/portfolio-asset-type (latest period). */
export interface SecFundPortfolioAssetTypeItem {
  proj_id: string;
  period: string;
  assetliab_code: string;
  assetliab_desc?: string | null;
  market_value?: number | null;
  percent_nav?: number | null;
}

/**
 * Fetch all performance rows for one fund (latest effective factsheet only).
 * Captures ALL four performance types: fund volatility, benchmark volatility,
 * fund return, benchmark return (and peer average where present).
 */
export async function fetchFundPerformance(projId: string): Promise<SecFundPerformanceItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundPerformanceItem>(
    "/v2/fund/factsheet/performance",
    { proj_id: projId, latest: "true" },
    key,
  );
}

/**
 * Fetch asset allocation rows for one fund (latest effective factsheet only).
 */
export async function fetchFundAssetAllocation(
  projId: string,
): Promise<SecFundAssetAllocationItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundAssetAllocationItem>(
    "/v2/fund/factsheet/asset-allocation",
    { proj_id: projId, latest: "true" },
    key,
  );
}

/**
 * Fetch top-5 holdings for one fund (latest effective factsheet only).
 */
export async function fetchFundTop5Holdings(projId: string): Promise<SecFundTop5HoldingItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundTop5HoldingItem>(
    "/v2/fund/factsheet/top5-holdings",
    { proj_id: projId, latest: "true" },
    key,
  );
}

/**
 * Fetch the full quarterly portfolio for one fund (bare proj_id only —
 * no date params; the API returns 400 with extra date params).
 * Returns ALL items from the latest available quarter (the API returns the
 * most recent quarter by default when no period filter is supplied).
 * NOTE: large funds may have 100+ holdings; this endpoint is paginated.
 * The full portfolio roughly doubles API calls per crawl compared to the
 * other enrichment endpoints. Controlled by SEC_INGEST_PORTFOLIO flag.
 */
export async function fetchFundPortfolio(projId: string): Promise<SecFundPortfolioItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundPortfolioItem>(
    "/v2/fund/outstanding/portfolio",
    { proj_id: projId },
    key,
  );
}

/**
 * Fetch the monthly portfolio by asset type for one fund.
 * Returns only the latest available month (no period filter).
 */
export async function fetchFundPortfolioAssetType(
  projId: string,
): Promise<SecFundPortfolioAssetTypeItem[]> {
  const key = apiKey();
  return secFetchPaginated<SecFundPortfolioAssetTypeItem>(
    "/v2/fund/outstanding/portfolio-asset-type",
    { proj_id: projId },
    key,
  );
}

/**
 * Pre-seed the symbol-resolution cache from the local catalog so a bulk crawl
 * (the NAV pre-warm job, #104) skips the 1–2 SEC `general-info/profiles` lookups
 * `resolveSymbol` would otherwise make per ticker. Each entry maps a priceable
 * ticker → its proj_id + raw SEC `fund_class_name` — exactly what `fetchSeries`
 * needs to hit the NAV endpoint directly. Cached under the same 24h TTL as a live
 * resolution and keyed identically (upper-cased ticker), so the next live request
 * for the same code also benefits. The display `name` is only a label (the cache
 * layer discards it), so the caller may pass the ticker itself.
 */
export function primeFundResolution(
  entries: Array<{ ticker: string; projId: string; fundClassName: string; name?: string }>,
): void {
  const now = Date.now();
  for (const e of entries) {
    const upper = e.ticker.trim().toUpperCase();
    if (!upper) continue;
    symbolCache.set(upper, {
      projId: e.projId,
      name: e.name ?? e.ticker,
      fundClassName: e.fundClassName,
      cachedAt: now,
    });
  }
}

/** Test-only — reset the per-symbol cache. */
export function __resetSecThailandCache(): void {
  symbolCache.clear();
  retry = { ...RETRY_DEFAULTS };
  nextSlot = 0;
}

/** Test-only: override throttle/retry timing so tests don't incur real waits. */
export function __setSecThailandRetry(overrides: Partial<typeof RETRY_DEFAULTS>): void {
  retry = { ...retry, ...overrides };
}
