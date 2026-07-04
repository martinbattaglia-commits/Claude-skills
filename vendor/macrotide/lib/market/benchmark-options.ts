// Client-safe benchmark catalog. No server-only imports here so both the
// browser (the Portfolio "VS" selector) and the server (read_performance,
// the /api/market/benchmark route) can share one list. The async series
// fetchers live in ./benchmarks (server-only).

import { BENCHMARK_TR_SOURCE } from "./sources";

export interface BenchmarkOption {
  /** Stable slug used as the selection key + API param. */
  key: string;
  /** Full picker label — market/segment then the index it tracks, e.g.
   * "US tech (Nasdaq-100)". Used in the benchmark dropdown. */
  label: string;
  /** Short index name for the chart legend / tooltip, e.g. "Nasdaq-100" — precise
   * and compact where the line just needs identifying. */
  short: string;
  /** Provider source (matches the quote_source taxonomy). */
  source: string;
  /** Provider symbol. */
  ticker: string;
}

// Total-return benchmark proxies — a tracking ETF's dividend-reinvested adjusted
// close, served by the `benchmark_tr` source. These are the like-for-like
// references for the dividend-reinvesting portfolio line: a price index would
// understate the benchmark and flatter the portfolio. Global-first.
//
// All are USD ETF series (not the literal local index), so the series fetcher
// converts each to the base currency (฿) and rebases to a % return before
// comparing — never read an absolute level. The Thai entry uses the MSCI Thailand
// ETF rather than the SET index itself: SET's free route is an XLS/CSV export
// (its JSON API is paid), so the ETF gives a free, deep, daily total-return
// series with no new source type.
//
// The `short` legend name is the *index* each ETF tracks — not the ETF or its
// issuer (a brand we don't endorse, and the ticker is just plumbing). Naming the
// index is also honest: "MSCI Thailand" signals this isn't the SET price line a
// user sees elsewhere. They're accurate per proxy, so they mix providers —
// ACWI/THD track MSCI, but VEA/VWO track FTSE indices, not MSCI. The `label`
// leads with the market for the picker: a broad region carries "equity" so it
// isn't bare ("Global equity", "US equity"), while a self-describing segment
// stands alone ("US tech", "Developed ex-US", "Emerging markets"). "Total return"
// + base currency stay in the UI disclosure, not in either string.
//
// All appear in the Portfolio "VS" benchmark dropdown, in this order
// (global-first). The fuller picker (#26) adds user-defined custom benchmarks on
// top of this list.
export const BENCHMARK_TR_OPTIONS: BenchmarkOption[] = [
  {
    key: "acwi_tr",
    label: "Global equity (MSCI ACWI)",
    short: "MSCI ACWI",
    source: BENCHMARK_TR_SOURCE,
    ticker: "ACWI",
  },
  {
    key: "us_tr",
    label: "US equity (S&P 500)",
    short: "S&P 500",
    source: BENCHMARK_TR_SOURCE,
    ticker: "SPY",
  },
  {
    key: "us_tech_tr",
    label: "US tech (Nasdaq-100)",
    short: "Nasdaq-100",
    source: BENCHMARK_TR_SOURCE,
    ticker: "QQQ",
  },
  {
    key: "dev_exus_tr",
    label: "Developed ex-US (FTSE Developed)",
    short: "FTSE Developed",
    source: BENCHMARK_TR_SOURCE,
    ticker: "VEA",
  },
  {
    key: "em_tr",
    label: "Emerging markets (FTSE Emerging)",
    short: "FTSE Emerging",
    source: BENCHMARK_TR_SOURCE,
    ticker: "VWO",
  },
  {
    key: "japan_tr",
    label: "Japanese equity (MSCI Japan)",
    short: "MSCI Japan",
    source: BENCHMARK_TR_SOURCE,
    ticker: "EWJ",
  },
  {
    key: "thai_tr",
    label: "Thai equity (MSCI Thailand)",
    short: "MSCI Thailand",
    source: BENCHMARK_TR_SOURCE,
    ticker: "THD",
  },
];

export function findBenchmark(key: string): BenchmarkOption | undefined {
  return BENCHMARK_TR_OPTIONS.find((b) => b.key === key);
}
