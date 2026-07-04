// Alpaca provider — a *keyed* fallback for arbitrary US stocks & ETFs
// (https://alpaca.markets). Twelve Data is the keyed primary for the `market`
// chain (official consolidated close), but its free tier is 800 calls/day and
// can be exhausted; the keyless Yahoo last resort hard-blocks datacenter IPs
// (429 on prod). Alpaca fills that gap with the most generous free terms of the
// datacenter-safe options: 200 req/min, 7+ years of daily bars, US stocks +
// ETFs, and — unlike Tiingo / Twelve Data — its market-data API carries no
// "personal use only" clause, so it's the cleanest free fit for a multi-user app.
//
// Free tier serves the IEX feed (`feed=iex`): IEX is ~2-3% of consolidated
// volume, so a daily close is the IEX session close, not the official
// consolidated print. For a FALLBACK (only hit when the primary fails) on liquid
// US names this drift is negligible; the primary keeps serving the official close.
//
// Activated only when BOTH ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are set:
// without them `matches` returns false and the provider drops out of the chain.
// The credentials ride request headers (never the URL) and are never logged.
//
// Endpoint: https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=1Day
// Response: { bars: [{ t: "2026-05-01T04:00:00Z", c: 211.5, … }], symbol, next_page_token }

import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

const BASE_URL = "https://data.alpaca.markets/v2/stocks";

export interface AlpacaCreds {
  keyId: string;
  secretKey: string;
}

/**
 * Read both Alpaca credentials fresh each call; undefined unless BOTH are set.
 * Exported so the market-data screener (lib/market/screener.ts) shares one
 * credential reader with the price provider.
 */
export function readAlpacaCreds(): AlpacaCreds | undefined {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secretKey = process.env.ALPACA_API_SECRET_KEY?.trim();
  return keyId && secretKey ? { keyId, secretKey } : undefined;
}

// Alpaca's stock-bars endpoint serves plain US-listed equities / ETFs. It does
// NOT serve caret index levels (^GSPC) or Yahoo FX pairs (THB=X) — those stay
// with the index providers and Frankfurter. Claim only equity-shaped tickers so
// a fallback attempt never wastes a call on a symbol Alpaca can't price.
function isEquityTicker(ticker: string): boolean {
  return !ticker.startsWith("^") && !ticker.includes("=");
}

const TIMEFRAME: Record<SeriesInterval, string> = {
  "1d": "1Day",
  "1wk": "1Week",
  "1mo": "1Month",
};

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
              : 366 * 30; // "max" — Alpaca only carries ~since 2016; it returns what it has
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface AlpacaBar {
  t: string;
  c: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[] | null;
  symbol?: string;
  message?: string;
}

export const alpacaProvider: Provider = {
  id: "alpaca",
  // Owns the "market" logical source for equity-shaped tickers, but only when
  // both credentials are configured — otherwise it stays out of the chain.
  matches(source: string, ticker: string): boolean {
    return source === "market" && readAlpacaCreds() !== undefined && isEquityTicker(ticker);
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const c = readAlpacaCreds();
    if (!c) throw new ProviderError("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set", "alpaca");

    const url = new URL(`${BASE_URL}/${encodeURIComponent(ticker)}/bars`);
    url.searchParams.set("timeframe", TIMEFRAME[interval]);
    url.searchParams.set("start", startDate(range));
    url.searchParams.set("feed", "iex"); // the free feed
    // Raw (unadjusted) close — matches the rest of the `market` chain and is the
    // correct per-date price for valuing the actual share count held on that date.
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("sort", "asc"); // oldest-first
    // Daily bars over our deepest range (~7y ≈ 1.8k rows) fit one page well under
    // the 10000 cap, so a single request suffices (no next_page_token paging).
    url.searchParams.set("limit", "10000");

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": c.keyId,
        "APCA-API-SECRET-KEY": c.secretKey,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // 404 = symbol Alpaca doesn't cover; let the chain fall through.
      throw new ProviderError(`Alpaca returned ${res.status} for ${ticker}`, "alpaca", res.status);
    }
    const json = (await res.json()) as AlpacaBarsResponse;
    const bars = json.bars;
    if (!Array.isArray(bars)) {
      throw new ProviderError(json.message ?? `Alpaca error for ${ticker}`, "alpaca");
    }

    const series: SeriesPoint[] = [];
    for (const b of bars) {
      const close = Number(b.c);
      // Alpaca bar timestamps are RFC3339 ("2026-05-01T04:00:00Z"); take the date
      // half so the UNIX second aligns to the UTC day like the other providers.
      const t = Math.floor(new Date(`${b.t.slice(0, 10)}T00:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(close) || !Number.isFinite(t)) continue;
      series.push({ t, close });
    }
    if (series.length === 0) {
      throw new ProviderError(`Alpaca returned no data for ${ticker}`, "alpaca");
    }
    series.sort((a, b) => a.t - b.t);

    const latest = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : latest;
    const quote: Quote = {
      ticker,
      // The bars endpoint carries no name/currency; leave currency to the
      // holding-currency inference (bare US tickers → USD) like other providers.
      name: ticker,
      currency: "",
      price: latest.close,
      previousClose: prev.close,
      asOfUnix: latest.t,
    };
    return { quote, series };
  },
};
