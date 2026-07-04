// EODHD provider — a *keyed* source for REAL index levels (https://eodhd.com).
//
// Twelve Data's FREE tier only carries US-listed ETF proxies (SPY/QQQ/THD), not
// the raw index level. EODHD's free tier (20 calls/day) serves the actual index
// via its `{CODE}.INDX` virtual-exchange notation — including markets Twelve
// Data and FMP don't cover for free, notably the Thai SET index and the Nikkei.
//
// Activated solely by the EODHD_API_KEY env var AND only for the index symbols
// we've mapped: with no key, `matches` returns false so the provider drops out
// of the chain and behaviour falls back to the ETF-proxy path. The key is read
// from the environment at call time and never logged.
//
// Endpoint: https://eodhd.com/api/eod/{SYMBOL}?api_token=&fmt=json&order=a
// Response: [{ date: "2026-05-01", close: 5200.1 }, …] (oldest-first w/ order=a)

import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

const BASE_URL = "https://eodhd.com/api/eod";

/** Read the key fresh each call so tests / runtime env changes are honoured. */
function apiKey(): string | undefined {
  const k = process.env.EODHD_API_KEY?.trim();
  return k ? k : undefined;
}

// Yahoo-style canonical symbols (as stored in the indicator catalog) → EODHD
// `.INDX` symbols. Only real indices EODHD's free tier serves are listed here;
// anything not mapped is left to other providers (ETF proxies, FX, …).
// Codes follow EODHD's virtual INDX exchange: GSPC=S&P 500, NDX=Nasdaq-100,
// IXIC=Nasdaq Composite, DJI=Dow, N225=Nikkei 225, SET=Stock Exchange of
// Thailand index.
const SYMBOL_MAP: Record<string, string> = {
  "^GSPC": "GSPC.INDX",
  "^NDX": "NDX.INDX",
  "^IXIC": "IXIC.INDX",
  "^DJI": "DJI.INDX",
  "^RUT": "RUT.INDX",
  "^N225": "N225.INDX",
  "^SET.BK": "SET.INDX",
};

/** Translate a Yahoo-style ticker to EODHD notation, or undefined if unmapped. */
export function toEodhdSymbol(ticker: string): string | undefined {
  return SYMBOL_MAP[ticker];
}

function startDate(range: SeriesRange): string {
  const days =
    range === "1mo"
      ? 31
      : range === "3mo"
        ? 92
        : range === "6mo"
          ? 183
          : range === "1y"
            ? 366
            : range === "5y"
              ? 5 * 366
              : 366 * 30; // "max"
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface EodhdValue {
  date: string;
  close: number;
}

export const eodhdProvider: Provider = {
  id: "eodhd",
  // Owns the "market" logical source, but only when a key is configured AND the
  // ticker is a real index symbol we map — otherwise it stays out of the chain.
  matches(source: string, ticker: string): boolean {
    return source === "market" && apiKey() !== undefined && toEodhdSymbol(ticker) !== undefined;
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    _interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const key = apiKey();
    if (!key) throw new ProviderError("EODHD_API_KEY not set", "eodhd");
    const symbol = toEodhdSymbol(ticker);
    if (!symbol) throw new ProviderError(`EODHD does not cover ${ticker}`, "eodhd");

    const end = new Date().toISOString().slice(0, 10);
    const url = new URL(`${BASE_URL}/${symbol}`);
    url.searchParams.set("api_token", key);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("order", "a"); // ascending — oldest-first
    url.searchParams.set("from", startDate(range));
    url.searchParams.set("to", end);

    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) {
      throw new ProviderError(`EODHD returned ${res.status} for ${symbol}`, "eodhd", res.status);
    }
    const json = (await res.json()) as EodhdValue[] | { message?: string };
    if (!Array.isArray(json)) {
      throw new ProviderError(json.message ?? `EODHD error for ${symbol}`, "eodhd");
    }

    const series: SeriesPoint[] = [];
    for (const v of json) {
      const close = Number(v.close);
      const t = Math.floor(new Date(`${v.date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(close) || !Number.isFinite(t)) continue;
      series.push({ t, close });
    }
    if (series.length === 0) {
      throw new ProviderError(`EODHD returned no data for ${symbol}`, "eodhd");
    }
    // EODHD honours order=a, but guard against an unsorted response.
    series.sort((a, b) => a.t - b.t);

    const latest = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : latest;
    const quote: Quote = {
      ticker,
      name: symbol,
      currency: "",
      price: latest.close,
      previousClose: prev.close,
      asOfUnix: latest.t,
    };
    return { quote, series };
  },
};
