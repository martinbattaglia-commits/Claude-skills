// Twelve Data provider — the *keyed* primary source for index / FX / equity
// series (https://twelvedata.com). Yahoo (keyless) now hard-blocks datacenter
// IPs with 429, so the cache tries this first and falls back to Yahoo only
// when it fails or no key is configured.
//
// Activated solely by the TWELVE_DATA_API_KEY env var: with no key, `matches`
// returns false so the provider drops out of the chain and behaviour is exactly
// the old Yahoo-only path. The key is read from the environment at call time and
// never logged.
//
// Endpoint: https://api.twelvedata.com/time_series?symbol=&interval=1day&apikey=
// We request order=asc so values arrive oldest-first, matching SeriesPoint order.
//
// Two providers share one fetch core:
//   - twelveDataProvider          → the `market` chain, raw close.
//   - twelveDataAdjustedProvider  → the `benchmark_tr` chain, `adjust=all`
//       (split + DIVIDEND adjusted close = a total-return proxy). Verified on the
//       free tier: `adjust=all` reinvests dividends and serves ~20y depth (5000
//       daily points back to 2006) — deep enough for the portfolio "All" range.
//       This is the sole benchmark_tr provider: EODHD's adjusted_close is
//       free-tier-capped to ~1y and Yahoo 429s from datacenters, so neither is a
//       usable fallback for a deep TR backfill.

import { BENCHMARK_TR_SOURCE } from "../sources";
import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

const BASE_URL = "https://api.twelvedata.com/time_series";

/** Read the key fresh each call so tests / runtime env changes are honoured. */
function apiKey(): string | undefined {
  const k = process.env.TWELVE_DATA_API_KEY?.trim();
  return k ? k : undefined;
}

// Yahoo-style symbols (as stored on holdings / in the indicator catalog) →
// Twelve Data symbols. Anything not mapped falls through to a best-effort
// transform below.
//
// Twelve Data's FREE tier does NOT serve raw index levels (GSPC/NDX/SET are
// Grow/Pro-only), but it DOES serve the US-listed tracking ETFs. So for the
// real-index canonical symbols we map to the ETF proxy here: Twelve Data is the
// ETF-proxy fallback layer in the chain, used only when the keyed real-index
// providers (FMP/EODHD) are absent or fail. The daily % move — what the Markets
// screen shows — tracks the index even though the absolute level is the ETF's.
const SYMBOL_MAP: Record<string, string> = {
  // Indices → free-tier ETF proxies (real levels need FMP/EODHD upstream).
  "^GSPC": "SPY", // S&P 500
  "^NDX": "QQQ", // Nasdaq-100
  "^IXIC": "ONEQ", // Nasdaq Composite
  "^DJI": "DIA", // Dow Jones
  "^RUT": "IWM", // Russell 2000
  "^N225": "EWJ", // Nikkei / Japan
  "^SET.BK": "THD", // Thailand (MSCI Thailand ETF)
  // Commodities (Twelve Data quotes metals/energy as FX-style pairs)
  "GC=F": "XAU/USD",
  "SI=F": "XAG/USD",
  "CL=F": "WTI",
  "BZ=F": "BRENT",
};

/** Translate a Yahoo-style ticker to Twelve Data's notation. */
export function toTwelveDataSymbol(ticker: string): string {
  const mapped = SYMBOL_MAP[ticker];
  if (mapped) return mapped;
  // Yahoo FX pairs look like "THB=X" (USD per 1 THB) → "USD/THB".
  const fx = /^([A-Z]{3})=X$/.exec(ticker);
  if (fx) return `USD/${fx[1]}`;
  // Yahoo crypto looks like "BTC-USD" → "BTC/USD".
  const crypto = /^([A-Z]{2,5})-([A-Z]{3,4})$/.exec(ticker);
  if (crypto) return `${crypto[1]}/${crypto[2]}`;
  // Strip a leading caret (ETF proxies / other symbols pass through).
  return ticker.replace(/^\^/, "");
}

/** Twelve Data daily series → SeriesPoint[] (oldest-first), plus a Quote. */
const INTERVAL_MAP: Record<SeriesInterval, string> = {
  "1d": "1day",
  "1wk": "1week",
  "1mo": "1month",
};

function outputSize(range: SeriesRange): number {
  switch (range) {
    case "1mo":
      return 30;
    case "3mo":
      return 70;
    case "6mo":
      return 140;
    case "1y":
      return 260;
    case "5y":
      return 1300;
    default:
      return 5000; // "max" — Twelve Data caps output at 5000
  }
}

interface TwelveDataValue {
  datetime: string;
  close: string;
}

interface TwelveDataResponse {
  meta?: { symbol: string; currency?: string };
  values?: TwelveDataValue[];
  status?: string;
  code?: number;
  message?: string;
}

async function fetchTwelveDataSeries(
  ticker: string,
  range: SeriesRange,
  interval: SeriesInterval,
  opts: { adjusted: boolean },
): Promise<{ quote: Quote; series: SeriesPoint[] }> {
  const key = apiKey();
  if (!key) throw new ProviderError("TWELVE_DATA_API_KEY not set", "twelvedata");

  const symbol = toTwelveDataSymbol(ticker);
  const url = new URL(BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", INTERVAL_MAP[interval]);
  url.searchParams.set("outputsize", String(outputSize(range)));
  url.searchParams.set("order", "asc"); // oldest-first
  // `adjust=all` reinvests dividends + applies splits — the total-return proxy
  // the benchmark_tr source needs. Omitted for the raw `market` chain.
  if (opts.adjusted) url.searchParams.set("adjust", "all");
  url.searchParams.set("apikey", key);

  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    throw new ProviderError(
      `Twelve Data returned ${res.status} for ${symbol}`,
      "twelvedata",
      res.status,
    );
  }
  const json = (await res.json()) as TwelveDataResponse;
  if (json.status === "error") {
    // Includes "symbol not found" / plan-restricted symbols — let the chain
    // fall through to the keyless fallback for this ticker.
    throw new ProviderError(
      json.message ?? `Twelve Data error for ${symbol}`,
      "twelvedata",
      json.code,
    );
  }
  const values = json.values ?? [];
  const series: SeriesPoint[] = [];
  for (const v of values) {
    const close = Number(v.close);
    const t = Math.floor(new Date(`${v.datetime}T00:00:00Z`).getTime() / 1000);
    if (!Number.isFinite(close) || !Number.isFinite(t)) continue;
    series.push({ t, close });
  }
  if (series.length === 0) {
    throw new ProviderError(`Twelve Data returned no data for ${symbol}`, "twelvedata");
  }

  const latest = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : latest;
  const quote: Quote = {
    ticker: json.meta?.symbol ?? symbol,
    name: json.meta?.symbol ?? symbol,
    currency: json.meta?.currency ?? "",
    price: latest.close,
    previousClose: prev.close,
    asOfUnix: latest.t,
  };
  return { quote, series };
}

export const twelveDataProvider: Provider = {
  id: "twelvedata",
  // Owns the same logical sources as Yahoo (indices / stocks / FX), but only
  // when a key is configured — otherwise it stays out of the chain entirely.
  matches(source: string, _ticker: string): boolean {
    return source === "market" && apiKey() !== undefined;
  },
  fetchSeries(ticker, range, interval) {
    return fetchTwelveDataSeries(ticker, range, interval, { adjusted: false });
  },
};

// Total-return benchmark provider: same endpoint, `adjust=all`. Matches only the
// non-holdable `benchmark_tr` source, so it never competes with the raw `market`
// chain and a benchmark ticker can't accidentally serve a holding's price.
export const twelveDataAdjustedProvider: Provider = {
  id: "twelvedata-adjusted",
  matches(source: string, _ticker: string): boolean {
    return source === BENCHMARK_TR_SOURCE && apiKey() !== undefined;
  },
  fetchSeries(ticker, range, interval) {
    return fetchTwelveDataSeries(ticker, range, interval, { adjusted: true });
  },
};
