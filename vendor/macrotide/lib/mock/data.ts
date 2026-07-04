// Mock data for the investment agent prototype.
//
// All holdings use REAL Thai mutual fund share-class codes confirmed active in
// the SEC fund_catalog. When seeded, each gets quote_source =
// "thai_mutual_fund", so the demo's live NAV refresh resolves them against real
// SEC NAVs from the shared real market.db, which demo uses read-write like a
// real user — reading and warming the same cache (see lib/market/cache.ts).
// Source / brokerage fields use "Demo
// Broker" as a generic placeholder until a real broker integration is wired up.
//
// If you change a ticker here, verify it resolves before committing:
//   curl -H "Ocp-Apim-Subscription-Key: $SEC_API_KEY" \
//     'https://api.sec.or.th/v2/fund/general-info/profiles?fund_class_name=NEW-CODE'

import type {
  AggregatePortfolio,
  ModelPortfolio,
  Portfolio,
  SeriesPoint,
  UserGoals,
  UserJournal,
  UserPlan,
} from "@/lib/static/types";
import { TEMPLATE_PRESETS } from "@/lib/templates/presets";

// ===== PORTFOLIOS: user has multiple, each with own holdings + constraints =====
export const PORTFOLIOS: Portfolio[] = [
  {
    id: "main",
    name: "Main",
    icon: "wallet",
    type: "free",
    typeLabel: "Free",
    color: "var(--accent)",
    notes: "Long-term core portfolio. No restrictions. This is where most of my money lives.",
    targetModelId: "bogle3",
    initialInvestment: 880000,
    totalValue: 1024280,
    asOf: "20 May 2026, 14:32 ICT",
    brokerage: "Demo Broker",
    perfPct: { d7: 1.1, d30: 3.2, ytd: 8.4, y1: 12.1 },
    series: [
      { d: "Nov 25", v: 880000 },
      { d: "Dec 25", v: 894720 },
      { d: "Jan 26", v: 876160 },
      { d: "Feb 26", v: 913600 },
      { d: "Mar 26", v: 944240 },
      { d: "Apr 26", v: 974880 },
      { d: "May 26", v: 1024280 },
    ],
    holdings: [
      {
        ticker: "ASP-S&P500",
        thai: "เอสซีบี เอสแอนด์พี 500",
        name: "SCB S&P 500 Index Fund",
        category: "US Equity",
        class: "equity",
        region: "US",
        value: 365530,
        cost: 300000,
        units: 10623,
        nav: 34.4053,
        d1: 0.42,
        ytd: 11.2,
        y1: 14.8,
        ter: 0.4,
        source: "Demo Broker",
      },
      {
        ticker: "K-WORLDX",
        thai: "เค เวิลด์ เอ็กซ์",
        name: "Kasikorn World Equity Index",
        category: "Global Equity",
        class: "equity",
        region: "Global",
        value: 178200,
        cost: 160000,
        units: 14880,
        nav: 11.9748,
        d1: 0.18,
        ytd: 7.8,
        y1: 10.5,
        ter: 0.45,
        source: "Demo Broker",
      },
      {
        ticker: "K-FIXED",
        thai: "เค ตราสารหนี้ ชนิดเอ",
        name: "K Fixed Income Fund",
        category: "Thai Fixed Income",
        class: "bond",
        region: "Thailand",
        value: 178420,
        cost: 170000,
        units: 14820,
        nav: 12.0388,
        d1: 0.04,
        ytd: 2.1,
        y1: 3.4,
        ter: 0.32,
        source: "Demo Broker",
      },
      {
        ticker: "B-USALPHA",
        thai: "เค ยูเอสเอ เอ",
        name: "K USA Equity Fund (A-accumulation)",
        category: "US Equity (Active)",
        class: "equity",
        region: "US",
        value: 162800,
        cost: 140000,
        units: 8945,
        nav: 18.2008,
        d1: -0.31,
        ytd: 9.4,
        y1: 12.1,
        ter: 1.4,
        source: "Demo Broker",
      },
      {
        ticker: "DAOL-WGG",
        thai: "เคเอฟ โกลบอลแบรนด์ เอ",
        name: "Krungsri Global Brands Equity",
        category: "Global Brands",
        class: "equity",
        region: "Global",
        value: 95800,
        cost: 90000,
        units: 5380,
        nav: 17.8094,
        d1: 0.62,
        ytd: 6.4,
        y1: 8.9,
        ter: 1.85,
        source: "Demo Broker",
      },
      {
        ticker: "K-CASH",
        thai: "เคเอฟ แคช ชนิดเอ",
        name: "Krungsri Cash Management Fund",
        category: "Money Market",
        class: "cash",
        region: "Thailand",
        value: 43530,
        cost: 42000,
        units: 4236,
        nav: 10.2754,
        d1: 0.01,
        ytd: 0.8,
        y1: 1.5,
        ter: 0.18,
        source: "Demo Broker",
      },
      // Direct US positions (priced live in USD via the market chain, converted to
      // THB by the shared FX path). quoteSource "market" routes them there; the
      // static value/nav below are display placeholders — the demo prices them live.
      {
        ticker: "VOO",
        name: "Vanguard S&P 500 ETF",
        category: "US Equity",
        class: "equity",
        region: "US",
        value: 80000,
        // ฿70,000 for 4 shares = ฿17,500/share = $500 at the ฿35 seed rate — a clean
        // native cost basis so the demo's US position reads as $500 (not a float).
        cost: 70000,
        units: 4,
        nav: 560,
        d1: 0.3,
        ytd: 9.5,
        y1: 13.2,
        ter: 0.03,
        source: "US Broker",
        quoteSource: "market",
      },
      {
        ticker: "AAPL",
        name: "Apple Inc.",
        category: "US Stock",
        class: "equity",
        region: "US",
        value: 75000,
        cost: 70000,
        units: 10,
        nav: 210,
        d1: 0.5,
        ytd: 6.0,
        y1: 11.0,
        ter: null,
        source: "US Broker",
        quoteSource: "market",
      },
    ],
  },
  {
    id: "rmf",
    name: "Retirement",
    icon: "diamond",
    type: "tax-locked",
    typeLabel: "RMF · until 55",
    color: "oklch(0.55 0.10 230)",
    notes:
      "Retirement Mutual Fund. Deductible up to ฿500k/yr (combined with PVD). Locked until age 55 and ≥5 years from first investment.",
    targetModelId: "thaicore",
    initialInvestment: 180000,
    totalValue: 186940,
    asOf: "20 May 2026, 14:32 ICT",
    brokerage: "Demo Broker",
    perfPct: { d7: 0.4, d30: 1.1, ytd: 3.2, y1: 4.0 },
    series: [
      { d: "Nov 25", v: 180000 },
      { d: "Dec 25", v: 181400 },
      { d: "Jan 26", v: 179800 },
      { d: "Feb 26", v: 182300 },
      { d: "Mar 26", v: 184100 },
      { d: "Apr 26", v: 185600 },
      { d: "May 26", v: 186940 },
    ],
    holdings: [
      {
        ticker: "K-USARMF",
        thai: "เค ยูเอสเอ อาร์เอ็มเอฟ",
        name: "K USA Equity RMF",
        category: "US Equity (RMF)",
        class: "equity",
        region: "US",
        value: 96440,
        cost: 92000,
        units: 8520,
        nav: 11.32,
        d1: 0.58,
        ytd: 8.2,
        y1: 9.5,
        ter: 1.05,
        source: "Demo Broker",
      },
      {
        ticker: "K-WORLDXRMF",
        thai: "เค โกลบอลอิควิตี้พาสซีฟ อาร์เอ็มเอฟ",
        name: "K Global Equity Passive RMF",
        category: "Global Equity (RMF)",
        class: "equity",
        region: "Global",
        value: 64200,
        cost: 60000,
        units: 4810,
        nav: 13.35,
        d1: 0.21,
        ytd: 5.1,
        y1: 7.3,
        ter: 1.2,
        source: "Demo Broker",
      },
      {
        ticker: "K-GINCOMERMF",
        thai: "เค โกลบอลอินคัม อาร์เอ็มเอฟ",
        name: "K Global Income RMF",
        category: "Global Income (RMF)",
        class: "alternative",
        region: "Global",
        value: 26300,
        cost: 28000,
        units: 2160,
        nav: 12.18,
        d1: 0.02,
        ytd: 2.4,
        y1: 3.6,
        ter: 0.45,
        source: "Demo Broker",
      },
    ],
  },
  {
    id: "experiment",
    name: "Experiment",
    icon: "triangle",
    type: "experiment",
    typeLabel: "Sandbox",
    color: "oklch(0.55 0.10 50)",
    notes:
      "Small bucket for testing ideas — EM, small-cap, sector tilts. Cap at ฿100k. Not part of long-term plan.",
    targetModelId: null,
    initialInvestment: 73530,
    totalValue: 73530,
    asOf: "20 May 2026, 14:32 ICT",
    brokerage: "Demo Broker",
    perfPct: { d7: 0.8, d30: 2.4, ytd: 4.2, y1: 6.1 },
    series: [
      { d: "Nov 25", v: 73530 },
      { d: "Dec 25", v: 74100 },
      { d: "Jan 26", v: 72800 },
      { d: "Feb 26", v: 74200 },
      { d: "Mar 26", v: 75100 },
      { d: "Apr 26", v: 73900 },
      { d: "May 26", v: 73530 },
    ],
    holdings: [
      {
        ticker: "1DIV",
        thai: "อเบอร์ดีน สมาร์ทแคปปิตอล",
        name: "Aberdeen Smart Capital (Thai Eq.)",
        category: "Thai Equity",
        class: "equity",
        region: "Thailand",
        value: 28560,
        cost: 32000,
        units: 2728,
        nav: 10.47,
        d1: -0.85,
        ytd: -4.2,
        y1: -1.8,
        ter: 1.95,
        source: "Demo Broker",
      },
      {
        ticker: "B-ASIATECH",
        thai: "เคเอฟ โกลบอลเทคโนโลยี ชนิดเอ",
        name: "Krungsri Global Technology Equity Fund",
        category: "Global Tech",
        class: "equity",
        region: "Global",
        value: 30970,
        cost: 28000,
        units: 2628,
        nav: 11.7853,
        d1: 0.21,
        ytd: 1.4,
        y1: 2.7,
        ter: 1.65,
        source: "Demo Broker",
      },
      {
        ticker: "ASP-INDIA",
        thai: "เค อินเดีย เอ",
        name: "K India Equity Fund (A-accumulation)",
        category: "India Equity",
        class: "equity",
        region: "EM",
        value: 14000,
        cost: 13530,
        units: 1230,
        nav: 11.38,
        d1: 0.12,
        ytd: 3.2,
        y1: 5.4,
        ter: 1.55,
        source: "Demo Broker",
      },
    ],
  },
];

// ===== PORTFOLIO: the aggregate view (computed from PORTFOLIOS) =====
export const PORTFOLIO: AggregatePortfolio = (() => {
  const all = PORTFOLIOS;
  const allHoldings = all.flatMap((p) => p.holdings);
  const totalValue = all.reduce((s, p) => s + p.totalValue, 0);
  const initialInvestment = all.reduce((s, p) => s + p.initialInvestment, 0);
  const series: SeriesPoint[] = all[0].series.map((s, i) => ({
    d: s.d,
    v: all.reduce((sum, p) => sum + p.series[i].v, 0),
  }));
  const weighted = (key: keyof Portfolio["perfPct"]) =>
    all.reduce((sum, p) => sum + p.perfPct[key] * p.totalValue, 0) / totalValue;
  return {
    totalValue,
    baseCurrency: "THB",
    initialInvestment,
    perfPct: {
      d7: weighted("d7"),
      d30: weighted("d30"),
      ytd: weighted("ytd"),
      y1: weighted("y1"),
    },
    asOf: "20 May 2026, 14:32 ICT",
    brokerage: "Demo Broker",
    holdings: allHoldings,
    series,
    target: { equity: 70, bond: 20, alternative: 7, cash: 3 },
  };
})();

// MARKETS, ANALYSIS, AI_PERSONALITIES moved out of this file. See:
//   - lib/static/markets.ts      (market chrome — live data replaces this)
//   - lib/static/analysis.ts     (placeholder analytics — AI tool calls replace this)
//   - lib/static/personalities.ts (editorial AI persona)

// ===== Model Portfolios — for learning ideal allocations =====
//
// The built-in/curated library is the shipped factory presets — single source
// of truth in lib/templates/presets.ts, seeded into real DBs by
// `ensureTemplatePresets`. Here we only layer one synthetic *custom* model on
// top so the demo/dev seed shows both a built-in library and a user-forked
// model (built_in is derived from `!isCustom` by the seeders).
const DEMO_CUSTOM_MODELS: ModelPortfolio[] = [
  {
    id: "custom_thai_tilt",
    name: "My Thai Tilt",
    tagline: "Custom · added from chat",
    blurb:
      "Tilted toward Thai equity for home-currency stability. Conversation with the advisor on 18 May.",
    mix: [
      { label: "Thai Equity", pct: 40, ticker: "1DIV", color: "oklch(0.55 0.13 28)" },
      { label: "US Equity", pct: 30, ticker: "ASP-S&P500", color: "var(--accent)" },
      { label: "Thai Bonds", pct: 25, ticker: "K-FIXED", color: "#F4A434" },
      { label: "Cash", pct: 5, ticker: "K-CASH", color: "#9E9EA8" },
    ],
    expectedReturn: 5.8,
    expectedVol: 9.2,
    ter: 0.62,
    horizon: "10+ yrs",
    risk: "balanced",
    pros: ["FX-stable", "Familiar holdings", "Mid-volatility"],
    cons: ["Higher home bias", "Lower diversification than global"],
    source: "Built from chat · 18 May 2026",
    isCustom: true,
  },
];

export const MODEL_PORTFOLIOS: ModelPortfolio[] = [...TEMPLATE_PRESETS, ...DEMO_CUSTOM_MODELS];

export const USER_JOURNAL: UserJournal = {
  notes: [
    {
      id: "n1",
      title: "Why rebalance matters",
      body: "Advisor: 'Rebalancing isn't about timing the market — it's about not letting any one asset class become a bet you didn't choose to make. Drift = invisible risk.'",
      source: "chat",
      date: "2 days ago",
      tags: ["rebalancing", "basics"],
    },
    {
      id: "n2",
      title: "My US tech exposure is real ~18%",
      body: "Three of my funds (SCBS&P500, K-USA-A, KFGBRAND-A) all hold MSFT/NVDA/AAPL/GOOGL. Surface allocation hides the true concentration.",
      source: "analysis",
      date: "2 days ago",
      tags: ["concentration"],
    },
    {
      id: "n3",
      title: "Dollar-cost averaging beats timing",
      body: "Decades of data: investors who DCA into index funds outperform those trying to time tops/bottoms. Boring works.",
      source: "chat",
      date: "5 days ago",
      tags: ["dca", "basics"],
    },
  ],
  plan: {
    target: "bogle3",
    monthlyContribution: 15000,
    nextRebalanceDate: "1 Jun 2026",
    commitments: [
      {
        text: "Rebalance toward Bogleheads 3-Fund by end of May",
        status: "in_progress",
        date: "18 May 2026",
      },
      {
        text: "Sell down KFGBRAND-A by ฿52k (high TER, overlap)",
        status: "in_progress",
        date: "18 May 2026",
      },
      {
        text: "Add ฿78k to K-FIXED to reach 20% bond sleeve",
        status: "in_progress",
        date: "18 May 2026",
      },
      { text: "Review portfolio in 90 days, not weekly", status: "ongoing", date: "10 May 2026" },
    ],
  },
  reading: [
    {
      id: "r1",
      title: "The Bogleheads' Guide to the Three-Fund Portfolio",
      source: "bogleheads.org",
      url: "https://bogleheads.org/wiki/Three-fund_portfolio",
      summary:
        "Classic primer: total US market + international + total bond. Why simplicity beats complexity for most investors.",
      readTime: 8,
      status: "read",
      savedDate: "5 days ago",
    },
    {
      id: "r2",
      title: "Why Low Fees Win Over Decades",
      source: "Morningstar",
      url: "#",
      summary:
        "A 1% fee difference compounds to ~25% less wealth over 30 years. The single biggest factor you actually control.",
      readTime: 6,
      status: "unread",
      savedDate: "3 days ago",
    },
    {
      id: "r3",
      title: "Ray Dalio on the All-Weather Portfolio",
      source: "Bridgewater",
      url: "#",
      summary: "Hedging across four economic regimes. Why it produces smoother rides.",
      readTime: 12,
      status: "in_progress",
      savedDate: "1 week ago",
    },
    {
      id: "r4",
      title: "SET Index vs Global Equities: A 20-Year Look",
      source: "Bangkok Post",
      url: "#",
      summary:
        "Why home-bias may be hurting Thai retail investors. Global diversification arguments tailored to Thailand.",
      readTime: 10,
      status: "unread",
      savedDate: "2 weeks ago",
    },
  ],
  savedModels: ["bogle3", "allweather"],
};

// ===== User Plan (free-form markdown brief, edited in place) =====
export const USER_PLAN: UserPlan = {
  markdown: `## Target
Bogleheads 3-Fund: 50% US equity (SCBS&P500), 30% International (K-WORLDX), 20% Thai Bonds (K-FIXED).
Open to advisor's suggestion if there's a better fit.

## Principles
- Low fees first — TER under 0.7% blended.
- Global diversification over home bias.
- Boring works. I don't want to think about this weekly.
- No active funds. Index only.

## Risk
Comfortable with 20% drawdowns. 30% would make me nervous but I won't sell.
I want a portfolio I can hold through anything.

## Commitments
- I will rebalance toward Bogleheads 3-Fund by end of May.
- I will sell down KFGBRAND-A (too expensive, overlaps).
- I will only review when drift > 7pp, not weekly.
- I won't buy individual stocks or crypto.

## Open questions
- Should I tilt more toward emerging markets?
- Is dollar-cost averaging worth it if my contributions are irregular?

## Contributions
No regular schedule — lump sums when I have extra cash.
Probably ~฿15-30k every few months.`,
  lastUpdated: "2 days ago",
  versions: [
    { date: "2 days ago", change: "Added 'No crypto' rule" },
    { date: "5 days ago", change: "Set target to Bogleheads 3-Fund" },
    { date: "1 week ago", change: "First draft" },
  ],
};

// ===== User goals / risk profile =====
export const USER_GOALS: UserGoals = {
  horizon: 15,
  risk: "balanced",
  monthlyContribution: 15000,
  targetReturn: 6.5,
  selectedModelId: "bogle3",
};

// BENCHMARKS moved to lib/static/analysis.ts; plan parsers moved to
// lib/portfolio/plan-parser.ts.
