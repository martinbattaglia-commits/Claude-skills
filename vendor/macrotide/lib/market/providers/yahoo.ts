// Yahoo Finance chart provider.
//
// Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}
// No API key required. Requires a User-Agent header (Yahoo rejects requests
// without one). Yahoo occasionally 429s — callers should cache.
//
// Symbols of interest:
//   ^SET.BK  — Thailand SET index
//   ^GSPC    — S&P 500
//   ^IXIC    — Nasdaq Composite
//   ^N225    — Nikkei 225
//   THB=X    — USD/THB
//   AAPL, PTT.BK, etc.

import { BROWSER_USER_AGENT } from "../user-agent";
import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

interface YahooChartResponse {
  chart: {
    result?: Array<{
      meta: {
        symbol: string;
        currency: string;
        regularMarketPrice: number;
        chartPreviousClose: number;
        previousClose?: number;
        longName?: string;
        shortName?: string;
        regularMarketTime: number;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

const BASE_URLS = [
  "https://query2.finance.yahoo.com/v8/finance/chart",
  "https://query1.finance.yahoo.com/v8/finance/chart",
];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchOnce(
  base: string,
  symbol: string,
  range: SeriesRange,
  interval: SeriesInterval,
): Promise<Response> {
  const url = new URL(`${base}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  return fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
  });
}

async function fetchChart(symbol: string, range: SeriesRange, interval: SeriesInterval) {
  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const base of BASE_URLS) {
      try {
        const res = await fetchOnce(base, symbol, range, interval);
        if (res.status === 429) {
          lastError = new ProviderError(`Yahoo returned 429 for ${symbol}`, "yahoo", 429);
          continue;
        }
        if (!res.ok) {
          throw new ProviderError(
            `Yahoo returned ${res.status} for ${symbol}`,
            "yahoo",
            res.status,
          );
        }
        const json = (await res.json()) as YahooChartResponse;
        if (json.chart.error) {
          throw new ProviderError(
            `${json.chart.error.code}: ${json.chart.error.description}`,
            "yahoo",
          );
        }
        const result = json.chart.result?.[0];
        if (!result) throw new ProviderError(`No chart result for ${symbol}`, "yahoo");
        return result;
      } catch (err) {
        lastError = err instanceof ProviderError ? err : new ProviderError(String(err), "yahoo");
        if (lastError.status && lastError.status !== 429) throw lastError;
      }
    }
    if (attempt < 2) {
      await sleep(800 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastError ?? new ProviderError(`Failed to fetch ${symbol}`, "yahoo");
}

type YahooResult = NonNullable<YahooChartResponse["chart"]["result"]>[number];

function toQuote(r: YahooResult): Quote {
  return {
    ticker: r.meta.symbol,
    name: r.meta.longName ?? r.meta.shortName ?? r.meta.symbol,
    currency: r.meta.currency,
    price: r.meta.regularMarketPrice,
    previousClose: r.meta.previousClose ?? r.meta.chartPreviousClose,
    asOfUnix: r.meta.regularMarketTime,
  };
}

export const yahooProvider: Provider = {
  id: "yahoo",
  matches(source: string, _ticker: string): boolean {
    return source === "market";
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const r = await fetchChart(ticker, range, interval);
    const timestamps = r.timestamp ?? [];
    const closes = r.indicators.quote[0]?.close ?? [];
    const series: SeriesPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      series.push({ t: timestamps[i], close: c });
    }
    return { quote: toQuote(r), series };
  },
};
