// Frankfurter provider — a keyless, reliable FX fallback (https://frankfurter.dev).
//
// Backed by European Central Bank reference rates: free, no API key, no
// captcha, and — unlike Yahoo — it doesn't block datacenter IPs. It only knows
// foreign-exchange pairs, so it `matches` Yahoo-style FX tickers ("THB=X") and
// nothing else, sitting in the chain as the keyless FX layer ahead of Yahoo.
//
// Endpoint: https://api.frankfurter.app/{start}..{end}?from=USD&to=THB
// Response: { base, start_date, end_date, rates: { "2026-04-01": { THB: 32.5 }, … } }
// Rates cover ECB working days only (no weekends/holidays) — fine for a daily
// series. History reaches back to 1999.

import {
  type Provider,
  ProviderError,
  type Quote,
  type SeriesInterval,
  type SeriesPoint,
  type SeriesRange,
} from "./types";

const BASE_URL = "https://api.frankfurter.app";

// Yahoo FX tickers are "XXX=X", meaning USD per 1 XXX. We quote USD→XXX.
const FX_RE = /^([A-Z]{3})=X$/;

interface FrankfurterResponse {
  base?: string;
  rates?: Record<string, Record<string, number>>;
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
              : 366 * 25; // "max" — Frankfurter history starts 1999
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export const frankfurterProvider: Provider = {
  id: "frankfurter",
  // Keyless FX only: owns Yahoo-style currency pairs, leaves everything else.
  matches(source: string, ticker: string): boolean {
    return source === "market" && FX_RE.test(ticker);
  },
  async fetchSeries(
    ticker: string,
    range: SeriesRange,
    _interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }> {
    const m = FX_RE.exec(ticker);
    if (!m) throw new ProviderError(`Not an FX pair: ${ticker}`, "frankfurter");
    const quoteCcy = m[1];

    const end = new Date().toISOString().slice(0, 10);
    const url = new URL(`${BASE_URL}/${startDate(range)}..${end}`);
    url.searchParams.set("from", "USD");
    url.searchParams.set("to", quoteCcy);

    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) {
      throw new ProviderError(
        `Frankfurter returned ${res.status} for ${ticker}`,
        "frankfurter",
        res.status,
      );
    }
    const json = (await res.json()) as FrankfurterResponse;
    const rates = json.rates ?? {};
    const series: SeriesPoint[] = [];
    // Object keys aren't guaranteed ordered — sort dates ascending ourselves.
    for (const date of Object.keys(rates).sort()) {
      const close = rates[date]?.[quoteCcy];
      const t = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      if (typeof close !== "number" || !Number.isFinite(close) || !Number.isFinite(t)) continue;
      series.push({ t, close });
    }
    if (series.length === 0) {
      throw new ProviderError(`Frankfurter returned no data for ${ticker}`, "frankfurter");
    }

    const latest = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : latest;
    const quote: Quote = {
      ticker,
      name: `USD/${quoteCcy}`,
      currency: quoteCcy,
      price: latest.close,
      previousClose: prev.close,
      asOfUnix: latest.t,
    };
    return { quote, series };
  },
};
