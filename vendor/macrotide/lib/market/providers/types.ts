// Provider-agnostic shape for market data sources.
//
// A provider knows how to:
//   - decide whether it owns a given (source, ticker) pair (`matches`)
//   - return a normalized quote + daily series for that pair (`fetchSeries`)
//
// `source` names the asset class (see lib/market/sources.ts — e.g. "market",
// "thai_mutual_fund"). `ticker` is the symbol exactly as it appears on a
// holding row — no namespace prefix, no provider-specific encoding. The
// registry (see lib/market/registry.ts) iterates providers in registration
// order and picks the first match.

export type SeriesRange = "1mo" | "3mo" | "6mo" | "1y" | "5y" | "max";
export type SeriesInterval = "1d" | "1wk" | "1mo";

/**
 * First UTC date (YYYY-MM-DD) covered by a range, counted back from today.
 * Day counts lean generous (31/92/183/366) so a month boundary never clips
 * the first point; "max" reaches back 50 years. Shared by the market cache
 * and the holdings series fold so their windows can't drift apart.
 */
export function rangeStartDate(range: SeriesRange): string {
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
              : 365 * 50;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface Quote {
  /** Ticker echoed back as the provider canonicalized it. */
  ticker: string;
  /** Human-friendly name when the provider has one. */
  name: string;
  currency: string;
  price: number;
  /** Previous-period close. Used to compute day-change. */
  previousClose: number;
  /** UNIX seconds. */
  asOfUnix: number;
}

export interface SeriesPoint {
  /** UNIX seconds. */
  t: number;
  close: number;
  /**
   * Fund total net assets (AUM) on this date, when the source reports it. The
   * Thai SEC daily-NAV row carries it (`net_asset`) alongside the per-unit NAV;
   * index/stock providers leave it undefined.
   */
  netAsset?: number | null;
}

export interface Provider {
  /** Stable id, used in logs and error messages. */
  readonly id: string;
  /** True when this provider handles the given (source, ticker) pair. */
  matches(source: string, ticker: string): boolean;
  /** Fetch quote + daily series. Throws on failure. */
  fetchSeries(
    ticker: string,
    range: SeriesRange,
    interval: SeriesInterval,
  ): Promise<{ quote: Quote; series: SeriesPoint[] }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
