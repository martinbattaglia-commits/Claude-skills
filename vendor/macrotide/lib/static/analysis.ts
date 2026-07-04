import type { Analysis, Breakdown, SeriesPoint } from "@/lib/static/types";

// Placeholder analytics surface. Real numbers will land when AI tool
// calls (read_portfolio + computed concentration/drift/weighted TER) replace
// these. Until then, screens render these as a static fixture so the chart
// shapes are real even if the values aren't yours.

export const ANALYSIS: Analysis = {
  scores: {
    diversification: 72,
    risk: 58,
    fees: 81,
    alignment: 64,
  },
  riskTarget: 60,

  insights: [
    {
      type: "concentration",
      severity: "medium",
      title: "US equity is 46% of your book",
      body: "SCBS&P500 + K-USA-A = ฿591k. Above your target sleeve (35%). Three funds (SCBS&P500, K-USA-A, KFGBRAND-A) all hold MSFT, NVDA, AAPL, GOOGL — your true megacap-tech exposure is ~18%, not the 11% the labels suggest.",
    },
    {
      type: "drift",
      severity: "low",
      title: "Drift from target: 6.2 pp",
      body: "Equity at 79.5% vs 70% target. Bonds underweight by 6 pp. A small rebalance into K-FIXED would bring this in line.",
    },
    {
      type: "fees",
      severity: "good",
      title: "Blended TER of 0.61% — solid",
      body: "Your index-heavy mix keeps fees down. SCBS&P500 (0.40%) and K-WORLDX (0.45%) anchor this. KFGBRAND-A is your most expensive holding at 1.85%.",
    },
    {
      type: "weakness",
      severity: "medium",
      title: "ABSM has lagged 3 years running",
      body: "Aberdeen Smart Capital is -1.8% over 1y while SET is roughly flat. Consider whether the active premium is worth it vs a Thai index fund.",
    },
    {
      type: "strength",
      severity: "good",
      title: "Good behavior during March drawdown",
      body: "You added ฿40k during the Feb–Mar dip rather than selling. That contributed ~1.4 pp to YTD returns.",
    },
  ],

  rebalance: [
    { ticker: "K-FIXED", from: 13.9, to: 20.0, dir: "buy", amount: 78320 },
    { ticker: "K-USA-A", from: 12.7, to: 9.0, dir: "sell", amount: 47500 },
    { ticker: "KFGBRAND-A", from: 11.1, to: 7.0, dir: "sell", amount: 52600 },
    { ticker: "KKP-GINFRA", from: 4.4, to: 5.5, dir: "buy", amount: 14100 },
    { ticker: "ABSM", from: 7.5, to: 6.0, dir: "sell", amount: 19200 },
  ],
};

export const GEO_BREAKDOWN: Breakdown[] = [
  { label: "United States", pct: 48.3, color: "var(--accent)" },
  { label: "Thailand", pct: 32.1, color: "#F4A434" },
  { label: "Global ex-US/TH", pct: 14.6, color: "#7C7CFF" },
  { label: "Emerging Markets", pct: 5.0, color: "#C76A8F" },
];

export const SECTOR_BREAKDOWN: Breakdown[] = [
  { label: "Information Tech", pct: 26.8, color: "var(--accent)" },
  { label: "Financials", pct: 14.2, color: "#7C7CFF" },
  { label: "Government Bonds", pct: 13.9, color: "#F4A434" },
  { label: "Communication", pct: 9.4, color: "#C76A8F" },
  { label: "Consumer Disc.", pct: 8.6, color: "#5BA7B5" },
  { label: "Healthcare", pct: 7.2, color: "oklch(0.55 0.10 110)" },
  { label: "Industrials", pct: 6.8, color: "#A38A55" },
  { label: "Other", pct: 13.1, color: "#9E9EA8" },
];

export const DRIFT_SERIES: SeriesPoint[] = [
  { d: "Nov 25", v: 1.8 },
  { d: "Dec 25", v: 2.4 },
  { d: "Jan 26", v: 3.1 },
  { d: "Feb 26", v: 4.2 },
  { d: "Mar 26", v: 5.0 },
  { d: "Apr 26", v: 5.6 },
  { d: "May 26", v: 6.2 },
];

export const CONTRIB_SERIES: SeriesPoint[] = [
  { d: "Nov 25", v: 0 },
  { d: "Dec 25", v: 40000 },
  { d: "Jan 26", v: 0 },
  { d: "Feb 26", v: 30000 },
  { d: "Mar 26", v: 50000 },
  { d: "Apr 26", v: 0 },
  { d: "May 26", v: 25000 },
];
