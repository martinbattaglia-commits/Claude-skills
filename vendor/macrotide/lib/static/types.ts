// Shared types for the mock data layer

export type AssetClass = "equity" | "bond" | "mixed" | "alternative" | "cash" | "unknown";

export interface Holding {
  /** DB primary key — present on adapted holdings from /api/holdings. */
  id?: number;
  /** Which bucket the holding belongs to — present on adapted holdings. */
  bucketId?: string;
  ticker: string;
  thai?: string;
  name: string;
  category: string;
  class: AssetClass;
  region: string;
  value: number;
  cost: number;
  /**
   * Whether the cost basis is known. False when the position is held but its
   * avg cost is unknown (an uncosted opening/snapshot — ADR 0004): `cost` is
   * then 0 and gain-based figures must degrade gracefully, never show a bogus
   * gain. Optional/defaults true for the many places that build a Holding from
   * fully-costed mock data.
   */
  costKnown?: boolean;
  units: number;
  nav: number;
  d1: number;
  ytd: number;
  y1: number;
  /** Total expense ratio in %. `null` when the fund's fee is not published. */
  ter: number | null;
  source: string;
  /** Data-routing key. Present on adapted holdings from /api/holdings. */
  quoteSource?: string;
  /**
   * Instrument type for a US (`market`) holding — "etf" | "stock", overlaid from
   * the us_securities catalog. Absent for Thai funds (identified by quoteSource ===
   * "thai_mutual_fund"), cash, and unresolved/custom holdings. With quoteSource,
   * drives the "Fund"/"ETF"/"Stock" chip on the holdings-list row.
   */
  instrumentType?: "etf" | "stock" | null;
  /**
   * Derived exposure region ("US" | "Intl" | "EM" | "Global") for a US ETF,
   * overlaid from us_securities (N-PORT country look-through). Absent for stocks,
   * Thai funds, cash, and ETFs not yet fetched. Drives the holdings-list line-2
   * geography for ETFs beyond the curated starter map.
   */
  exposureRegion?: string | null;
  /**
   * SEC risk-spectrum code (RS1…RS8, RS81), overlaid from the catalog. Drives
   * the holding swatch color via the risk palette; absent for non-catalog
   * holdings (color then falls back to asset class).
   */
  riskSpectrum?: string | null;
  /**
   * Broker name when this position was imported from a connected broker (e.g.
   * "Finnomena"), else null/absent. Reliable — set only for holdings with
   * broker-imported ledger rows, never from a hand-typed source. Drives the
   * "synced" icon in the holdings list.
   */
  syncedBroker?: string | null;
}

export interface PerfPct {
  d7: number;
  d30: number;
  ytd: number;
  y1: number;
}

export interface SeriesPoint {
  d: string;
  v: number;
}

export type PortfolioType = "free" | "tax-locked" | "experiment";

/**
 * Cash slices for the contribution-mode pill (#149): the value + cumulative
 * contribution of all cash vs reserved-only cash, on the same dates as `series`.
 * Lets the screen recompute the "Funds only" / "Incl. cash" return with no
 * refetch. Absent in static placeholder data.
 */
export interface CashDecomp {
  cashValue: SeriesPoint[];
  /** Held cash accounts only (excl. in-transit settlement float) — the "Funds only" slice. */
  heldCashValue: SeriesPoint[];
  reservedCashValue: SeriesPoint[];
  cashContrib: SeriesPoint[];
  reservedCashContrib: SeriesPoint[];
}

export interface Portfolio {
  id: string;
  name: string;
  icon: string;
  type: PortfolioType;
  typeLabel: string;
  color: string;
  notes: string;
  targetModelId: string | null;
  initialInvestment: number;
  totalValue: number;
  asOf: string;
  brokerage: string;
  perfPct: PerfPct;
  series: SeriesPoint[];
  /** Cumulative external money in (the chart's contribution line), same dates as `series`. Absent in static placeholder data. */
  netInvested?: SeriesPoint[];
  /** Contribution line for the time-weighted return (full proceeds at a walk-away sale). Absent in static placeholder data. */
  netInvestedForReturn?: SeriesPoint[];
  /** Cash decomposition for the return-mode pill (#149). Absent in static placeholder data. */
  cashDecomp?: CashDecomp;
  holdings: Holding[];
}

export interface AggregatePortfolio {
  totalValue: number;
  baseCurrency: string;
  initialInvestment: number;
  perfPct: PerfPct;
  asOf: string;
  brokerage: string;
  holdings: Holding[];
  series: SeriesPoint[];
  /** Cumulative external money in (the chart's contribution line), same dates as `series`. Absent in static placeholder data. */
  netInvested?: SeriesPoint[];
  /** Contribution line for the time-weighted return (full proceeds at a walk-away sale). Absent in static placeholder data. */
  netInvestedForReturn?: SeriesPoint[];
  /** Cash decomposition for the return-mode pill (#149). Absent in static placeholder data. */
  cashDecomp?: CashDecomp;
  target: { equity: number; bond: number; alternative: number; cash: number };
}

export interface MarketIndex {
  sym: string;
  name: string;
  val: number;
  d: number;
  isYield?: boolean;
}

export interface NewsItem {
  tag: string;
  time: string;
  title: string;
  summary: string;
  impact: string;
  relevance: "high" | "medium" | "low";
}

export interface Markets {
  indices: MarketIndex[];
  news: NewsItem[];
  digest: string;
}

export type InsightSeverity = "good" | "low" | "medium" | "high";

export interface Insight {
  type: string;
  severity: InsightSeverity;
  title: string;
  body: string;
}

export interface RebalanceMove {
  ticker: string;
  from: number;
  to: number;
  dir: "buy" | "sell";
  amount: number;
}

export interface Analysis {
  scores: {
    diversification: number;
    risk: number;
    fees: number;
    alignment: number;
  };
  riskTarget: number;
  insights: Insight[];
  rebalance: RebalanceMove[];
}

export interface MixSlice {
  label: string;
  pct: number;
  ticker?: string;
  color: string;
}

export type RiskBand = "conservative" | "balanced" | "growth";

export interface ModelPortfolio {
  id: string;
  name: string;
  tagline: string;
  blurb: string;
  mix: MixSlice[];
  expectedReturn: number;
  expectedVol: number;
  ter: number;
  horizon: string;
  risk: RiskBand;
  pros: string[];
  cons: string[];
  source?: string;
  isCustom?: boolean;
}

export interface Breakdown {
  label: string;
  pct: number;
  color: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  source: string;
  date: string;
  tags: string[];
}

export interface Commitment {
  text: string;
  status: "in_progress" | "ongoing" | "done";
  date: string;
}

export interface JournalPlan {
  target: string;
  monthlyContribution: number;
  nextRebalanceDate: string;
  commitments: Commitment[];
}

export interface ReadingItem {
  id: string;
  title: string;
  source: string;
  url: string;
  summary: string;
  readTime: number;
  status: "read" | "unread" | "in_progress";
  savedDate: string;
}

export interface UserJournal {
  notes: Note[];
  plan: JournalPlan;
  reading: ReadingItem[];
  savedModels: string[];
}

export interface LearnArticle {
  id: string;
  title: string;
  blurb: string;
  readTime: number;
  tag: string;
}

export interface LearnTopic {
  id: string;
  label: string;
  count: number;
}

export interface LearnContent {
  startHere: LearnArticle[];
  topics: LearnTopic[];
  recommendedForYou: LearnArticle[];
}

export interface UserPlan {
  markdown: string;
  lastUpdated: string;
  versions: { date: string; change: string }[];
}

export interface UserGoals {
  horizon: number;
  risk: RiskBand;
  monthlyContribution: number;
  targetReturn: number;
  selectedModelId: string;
}

export interface AIPersonality {
  label: string;
  blurb: string;
  promptStyle: string;
}
