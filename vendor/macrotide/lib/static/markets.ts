import type { Markets } from "@/lib/static/types";

// Editorial market chrome (indices fallback + daily digest).
// Live SET / global indices come from /api/market/indices; the indices array
// below is the offline fallback. News ships live via /api/market/news —
// the `news` field stays empty here.
export const MARKETS: Markets = {
  indices: [
    { sym: "SET", name: "SET Index", val: 1428.42, d: -0.62 },
    { sym: "S&P 500", name: "S&P 500", val: 5821.1, d: 0.31 },
    { sym: "NASDAQ", name: "Nasdaq Comp.", val: 18942.8, d: 0.62 },
    { sym: "MSCI ACWI", name: "MSCI All-World", val: 824.55, d: 0.18 },
    { sym: "Gold", name: "Gold (USD/oz)", val: 2412.4, d: -0.21 },
    { sym: "10Y UST", name: "US 10Y Yield", val: 4.18, d: 0.03, isYield: true },
  ],

  news: [],

  digest:
    "Markets are doing what markets do — small ranges, mixed signals. Your US-heavy tilt has been the right call this year (+11.2% on SCBS&P500). The Thai equity drag is real but small (7.5% of book). Nothing requires action today; one thing worth watching: concentration in megacap tech across three of your funds.",
};
