// The Markets-screen indicator catalog.
//
// macrotide serves a globally-diversified, Thai-based index investor, so the
// DEFAULT set leads with global performance (US + global equity, gold) plus
// USD/THB — the FX rate that converts global returns into baht — and keeps a
// Thai gauge as one (non-headline) row. Users can edit their own list (add /
// remove / reorder) from this catalog; see lib/db/queries/market-indicators.ts.
//
// REAL index levels vs ETF proxies — `symbol` is the canonical Yahoo-style
// ticker the provider chain resolves (quote_source "market"). Where a free
// real-index source exists we use the index symbol (^GSPC, ^NDX, ^DJI, ^N225,
// ^SET.BK) and the chain serves the actual level from FMP (US) or EODHD
// (global + SET); when those keys are absent it transparently falls back to the
// tracking ETF via Twelve Data. Two rows have NO free real index and stay
// proxies on purpose: MSCI ACWI (ETF "ACWI") and the optional regional/sector
// ETFs. Gold is the XAU/USD spot commodity (GC=F), not an index. The daily %
// move — what this screen is about — tracks the index in every case.
//
// `tier` is retained in the data model for callers that key off it, but is no
// longer surfaced in the UI: the daily cron fetches each indicator once/day,
// comfortably inside every free-tier quota, so the distinction is noise to the
// user.

export type IndicatorTier = "keyless" | "free-key" | "paid";

export type IndicatorGroup = "Global equity" | "Thai" | "Commodities" | "FX" | "Crypto" | "Rates";

export interface IndicatorDef {
  /** Canonical ticker resolved by the market provider chain. */
  symbol: string;
  /** Short display label (e.g. "S&P 500"). */
  label: string;
  /** Secondary descriptor (notes the ETF proxy where applicable). */
  name: string;
  group: IndicatorGroup;
  /** Data-reliability/cost hint. Retained for callers; not rendered in the UI. */
  tier: IndicatorTier;
  /** Rendered as a percent (yields / FX shown without thousands styling). */
  isYield?: boolean;
  /** In the out-of-the-box default set (and its order among defaults). */
  defaultOrder?: number;
}

// One entry per addable indicator. `defaultOrder` marks the six shown before a
// user edits their list; everything else is opt-in from the "add" picker.
export const INDICATOR_CATALOG: IndicatorDef[] = [
  // ─ Default set: global-first + USD/THB + a Thai gauge ─
  {
    symbol: "^GSPC",
    label: "S&P 500",
    name: "US large-cap index",
    group: "Global equity",
    tier: "free-key",
    defaultOrder: 1,
  },
  {
    symbol: "^NDX",
    label: "Nasdaq-100",
    name: "US tech index",
    group: "Global equity",
    tier: "free-key",
    defaultOrder: 2,
  },
  {
    symbol: "ACWI",
    label: "MSCI ACWI",
    name: "Global equity · ACWI ETF",
    group: "Global equity",
    tier: "free-key",
    defaultOrder: 3,
  },
  {
    symbol: "GC=F",
    label: "Gold",
    name: "XAU/USD spot",
    group: "Commodities",
    tier: "free-key",
    defaultOrder: 4,
  },
  {
    symbol: "THB=X",
    label: "USD/THB",
    name: "Currency (ECB)",
    group: "FX",
    tier: "keyless",
    isYield: true,
    defaultOrder: 5,
  },
  {
    symbol: "^SET.BK",
    label: "Thailand",
    name: "SET Index",
    group: "Thai",
    tier: "free-key",
    defaultOrder: 6,
  },

  // ─ Optional adds: global equity ─
  {
    symbol: "^DJI",
    label: "Dow Jones",
    name: "US blue-chip index",
    group: "Global equity",
    tier: "free-key",
  },
  {
    symbol: "^N225",
    label: "Nikkei 225",
    name: "Japan index",
    group: "Global equity",
    tier: "free-key",
  },
  {
    symbol: "IWM",
    label: "Russell 2000",
    name: "US small-cap · IWM ETF",
    group: "Global equity",
    tier: "free-key",
  },
  {
    symbol: "EFA",
    label: "MSCI EAFE",
    name: "Developed ex-US · EFA ETF",
    group: "Global equity",
    tier: "free-key",
  },
  {
    symbol: "MCHI",
    label: "China",
    name: "MSCI China · MCHI ETF",
    group: "Global equity",
    tier: "free-key",
  },

  // ─ Optional adds: commodities ─
  { symbol: "SI=F", label: "Silver", name: "XAG/USD spot", group: "Commodities", tier: "free-key" },
  { symbol: "CL=F", label: "WTI Crude", name: "US oil", group: "Commodities", tier: "free-key" },
  {
    symbol: "BZ=F",
    label: "Brent Crude",
    name: "Global oil",
    group: "Commodities",
    tier: "free-key",
  },

  // ─ Optional adds: FX (USD-base, keyless via ECB) ─
  {
    symbol: "JPY=X",
    label: "USD/JPY",
    name: "Currency (ECB)",
    group: "FX",
    tier: "keyless",
    isYield: true,
  },
  {
    symbol: "CNY=X",
    label: "USD/CNY",
    name: "Currency (ECB)",
    group: "FX",
    tier: "keyless",
    isYield: true,
  },
  {
    symbol: "EUR=X",
    label: "USD/EUR",
    name: "Currency (ECB)",
    group: "FX",
    tier: "keyless",
    isYield: true,
  },

  // ─ Optional adds: crypto ─
  { symbol: "BTC-USD", label: "Bitcoin", name: "BTC/USD", group: "Crypto", tier: "free-key" },
  { symbol: "ETH-USD", label: "Ethereum", name: "ETH/USD", group: "Crypto", tier: "free-key" },
];

const BY_SYMBOL = new Map(INDICATOR_CATALOG.map((d) => [d.symbol, d]));

/** Catalog lookup by canonical symbol. */
export function indicatorBySymbol(symbol: string): IndicatorDef | undefined {
  return BY_SYMBOL.get(symbol);
}

/** True when `symbol` is a known, addable indicator. */
export function isKnownIndicator(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

/** True when an indicator should render as a percent rather than a level. */
export function isYield(symbol: string): boolean {
  return BY_SYMBOL.get(symbol)?.isYield === true;
}

/** Default indicator symbols, in display order, shown before a user edits. */
export const DEFAULT_INDICATOR_SYMBOLS: string[] = INDICATOR_CATALOG.filter(
  (d) => d.defaultOrder !== undefined,
)
  .sort((a, b) => (a.defaultOrder ?? 0) - (b.defaultOrder ?? 0))
  .map((d) => d.symbol);
