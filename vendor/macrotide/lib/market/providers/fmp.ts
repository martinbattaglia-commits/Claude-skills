// Financial Modeling Prep (FMP) provider — a *keyed* source for REAL US index
// levels (https://financialmodelingprep.com).
//
// FMP's free tier (250 calls/day) serves the actual S&P 500 and Dow index
// levels via `^GSPC` / `^DJI` — unlike Twelve Data's free tier, which only
// exposes the tracking ETFs. With its generous daily quota FMP sits ahead of
// EODHD (20/day) in the chain for the US indices it covers. (Nasdaq-100 `^NDX`
// is premium on FMP — 402 — so it is left to EODHD; not mapped here.)
//
// Activated solely by the FMP_API_KEY env var AND only for the index symbols we
// map: with no key, `matches` returns false so the provider drops out and the
// chain falls back to EODHD → ETF proxy. The key is read from the environment
// at call time and never logged.
//
// Endpoint (FMP "stable" API — the legacy /api/v3 endpoints now 403 for keys
// issued after the 2025 deprecation):
//   https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=^GSPC
// Response: a flat array [{ symbol, date: "2026-05-27", close: 7520.4, … }, …]
// arriving newest-first, so we sort to oldest-first.

import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

const BASE_URL = "https://financialmodelingprep.com/stable/historical-price-eod/full";

/** Read the key fresh each call so tests / runtime env changes are honoured. */
function apiKey(): string | undefined {
  const k = process.env.FMP_API_KEY?.trim();
  return k ? k : undefined;
}

// Yahoo-style canonical symbols → FMP symbols. FMP uses the same caret notation
// for US indices, so this is largely a passthrough allow-list; only the indices
// FMP's free tier serves are mapped so we don't claim coverage we lack.
const SYMBOL_MAP: Record<string, string> = {
  "^GSPC": "^GSPC",
  "^DJI": "^DJI",
};

/** Translate a Yahoo-style ticker to FMP notation, or undefined if unmapped. */
export function toFmpSymbol(ticker: string): string | undefined {
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

interface FmpEodRow {
  symbol?: string;
  date: string;
  close: number;
}

export const fmpProvider: Provider = {
  id: "fmp",
  // Owns the "market" logical source, but only when a key is configured AND the
  // ticker is a US index symbol we map — otherwise it stays out of the chain.
  matches(source: string, ticker: string): boolean {
    return source === "market" && apiKey() !== undefined && toFmpSymbol(ticker) !== undefined;
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    _interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const key = apiKey();
    if (!key) throw new ProviderError("FMP_API_KEY not set", "fmp");
    const symbol = toFmpSymbol(ticker);
    if (!symbol) throw new ProviderError(`FMP does not cover ${ticker}`, "fmp");

    const end = new Date().toISOString().slice(0, 10);
    const url = new URL(BASE_URL);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("from", startDate(range));
    url.searchParams.set("to", end);
    url.searchParams.set("apikey", key);

    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) {
      throw new ProviderError(`FMP returned ${res.status} for ${symbol}`, "fmp", res.status);
    }
    const json = (await res.json()) as FmpEodRow[] | { "Error Message"?: string };
    if (!Array.isArray(json)) {
      throw new ProviderError(json["Error Message"] ?? `FMP error for ${symbol}`, "fmp");
    }

    const series: SeriesPoint[] = [];
    for (const v of json) {
      const close = Number(v.close);
      const t = Math.floor(new Date(`${v.date}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(close) || !Number.isFinite(t)) continue;
      series.push({ t, close });
    }
    if (series.length === 0) {
      throw new ProviderError(`FMP returned no data for ${symbol}`, "fmp");
    }
    // Stable API arrives newest-first — sort to oldest-first.
    series.sort((a, b) => a.t - b.t);

    const latest = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : latest;
    const quote: Quote = {
      ticker,
      name: symbol,
      currency: "USD",
      price: latest.close,
      previousClose: prev.close,
      asOfUnix: latest.t,
    };
    return { quote, series };
  },
};
