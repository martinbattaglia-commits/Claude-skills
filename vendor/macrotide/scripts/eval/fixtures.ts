// Synthetic data + tool surface for the Advisor eval (scripts/eval).
//
// Hermetic by design: the real createAdvisorTools (lib/advisor/tools.ts) reads
// the live SQLite DB (opened eagerly by lib/db/client.ts), so the eval cannot
// reuse it without a DB and real fund codes. Instead this module mirrors the
// real tool SURFACE — same names, same input schemas, the same fee-first /
// index-first steering in the descriptions — but every execute returns fixed
// SYNTHETIC data using EXAMPLE-FUND-* codes only. The numbers are chosen to make
// answers checkable (a clear biggest holding, an unambiguous drift, a benchmark
// the portfolio beats and one it trails). Keep this in sync with the real tool
// surface when that changes; the committed guard test (tests/eval) checks the
// surface shape.
import { tool } from "ai";
import { z } from "zod";
import { shapeForModel } from "@/lib/advisor/shape";

// ─── Synthetic portfolio ────────────────────────────────────────────────────
// ฿1,000,000 across three EXAMPLE funds + 10% cash. Target model is 40/20/30/10
// (global equity / Thai equity / global bond / cash), so the portfolio is
// +10pp global equity, +5pp Thai equity, −15pp bond — an unambiguous "trim
// equity, add bonds" rebalance. EXAMPLE-FUND-A is the clear biggest holding.
export const PORTFOLIO = {
  ok: true as const,
  hasHoldings: true,
  totalValue: 1_000_000,
  baseCurrency: "THB",
  targetModel: "Bogle 3-Fund (Global)",
  byClass: [
    { label: "Equity", pct: 75 },
    { label: "Bond", pct: 15 },
    { label: "Cash", pct: 10 },
  ],
  byRegion: [
    { label: "Global ex-Thailand", pct: 50 },
    { label: "Thailand", pct: 25 },
    { label: "Bond (Global)", pct: 15 },
    { label: "Cash", pct: 10 },
  ],
  drift: [
    { ticker: "EXAMPLE-FUND-A", label: "Global Equity", current: 50, target: 40, drift: 10 },
    { ticker: "EXAMPLE-FUND-B", label: "Thai Equity", current: 25, target: 20, drift: 5 },
    { ticker: "EXAMPLE-FUND-C", label: "Global Bond", current: 15, target: 30, drift: -15 },
    { ticker: "CASH", label: "Cash", current: 10, target: 10, drift: 0 },
  ],
  trackingGapPp: 6.2,
  blendedTer: 0.585,
  targetTer: 0.3,
  concentration: {
    top: { ticker: "EXAMPLE-FUND-A", label: "Global Equity", pct: 50 },
    top3Pct: 90,
    hhi: 0.35,
    holdingCount: 3,
  },
  cashPct: 10,
  headline: {
    tone: "warn" as const,
    title: "Off target — bonds underweight",
    body: "Global equity is 10pp over target and bonds are 15pp under; consider rebalancing.",
  },
  message: "Read 3 holding(s) across 2 bucket(s); total ฿1,000,000.",
};

// ─── Empty portfolio (negative control, issue #69) ──────────────────────────
// Mirrors the real read_portfolio shape when the user has NOT added holdings:
// hasHoldings:false and nothing to analyze. The correct answer to any "how am I
// doing / rebalance me" question here is "you have no holdings yet" — NOT an
// invented allocation. The N2 question grades that the Advisor refuses rather
// than fabricating, the failure mode a synthetic-data eval most needs to guard.
export const EMPTY_PORTFOLIO = {
  ok: true as const,
  hasHoldings: false,
  totalValue: 0,
  baseCurrency: "THB",
  message: "No holdings yet — add a holding to see your allocation, drift, and fees.",
};

// Performance with no holdings: no series to compute a return from.
export const EMPTY_PERFORMANCE = {
  ok: true as const,
  hasData: false,
  message: "No performance history yet — add holdings to start tracking returns.",
};

// ─── Synthetic performance ──────────────────────────────────────────────────
// +7.1% over 6mo — BEATS the SET (+4.3%) but TRAILS the S&P 500 (+9.8%). The
// split lets a question about "beating my index" be answered with nuance.
export const PERFORMANCE = {
  ok: true as const,
  hasData: true,
  range: "6mo" as const,
  startDate: "2025-11-30",
  endDate: "2026-05-30",
  startValue: 933_700,
  endValue: 1_000_000,
  periodReturnPct: 7.1,
  asOf: "2026-05-30",
  benchmarks: [
    { key: "set", label: "SET Index", returnPct: 4.3, beating: true },
    { key: "sp500", label: "S&P 500", returnPct: 9.8, beating: false },
  ],
  message:
    "Portfolio +7.1% over 6mo (2025-11-30→2026-05-30). Benchmarks: SET Index +4.3%, S&P 500 +9.8%.",
};

// ─── Per-portfolio breakdown (the user keeps SEPARATE portfolios) ───────────
// The ฿1,000,000 book splits into two portfolios: a healthy global "Core" and a
// lagging Thai-equity-heavy "Tax" (SSF), each scored against its OWN target. The
// split lets a review spot the laggard and a "my Tax portfolio's return is low"
// question have a real diagnosis. Sums match the aggregate PORTFOLIO above.
export const BY_BUCKET = [
  {
    bucketId: "core",
    name: "Core",
    typeLabel: "Free",
    totalValue: 700_000,
    pctOfTotal: 70,
    targetModel: "Bogle 3-Fund (Global)",
    topClass: { label: "Equity", pct: 71 },
    trackingGapPp: 4.0,
    blendedTer: 0.5,
    topHolding: { ticker: "EXAMPLE-FUND-A", pct: 71 },
    cashPct: 8,
    realized: 12_000,
    irrPct: 9.4,
    irrUnavailable: null,
  },
  {
    bucketId: "tax",
    name: "Tax",
    typeLabel: "SSF",
    totalValue: 300_000,
    pctOfTotal: 30,
    targetModel: "Thai Equity Index",
    topClass: { label: "Equity", pct: 83 },
    trackingGapPp: 2.0,
    blendedTer: 0.75,
    topHolding: { ticker: "EXAMPLE-FUND-B", pct: 83 },
    cashPct: 17,
    realized: -1_500,
    irrPct: 1.2,
    irrUnavailable: null,
  },
];

// read_portfolio scoped to the "Tax" portfolio (portfolio:"Tax"): the lagging
// one — heavy in a single Thai-equity fund, high cash drag, weak money-weighted
// return. Scored against its OWN target ("Thai Equity Index"), and `scope` names
// it so the answer is unmistakably about that one portfolio.
export const TAX_PORTFOLIO = {
  ok: true as const,
  hasHoldings: true,
  totalValue: 300_000,
  baseCurrency: "THB",
  targetModel: "Thai Equity Index",
  byClass: [
    { label: "Equity", pct: 83 },
    { label: "Cash", pct: 17 },
  ],
  byRegion: [
    { label: "Thailand", pct: 83 },
    { label: "Cash", pct: 17 },
  ],
  drift: [
    { ticker: "EXAMPLE-FUND-B", label: "Thai Equity", current: 83, target: 85, drift: -2 },
    { ticker: "CASH", label: "Cash", current: 17, target: 15, drift: 2 },
  ],
  trackingGapPp: 2.0,
  blendedTer: 0.75,
  targetTer: 0.3,
  concentration: {
    top: { ticker: "EXAMPLE-FUND-B", label: "Thai Equity", pct: 83 },
    top3Pct: 83,
    hhi: 0.71,
    holdingCount: 1,
  },
  cashPct: 17,
  ledger: { invested: 295_000, realized: -1_500, income: 800, irrPct: 1.2, irrUnavailable: null },
  customHoldings: [],
  position: null,
  headline: {
    tone: "warn" as const,
    title: "Tax portfolio lagging",
    body: "A single Thai-equity fund has trailed, and 17% cash is a drag on the return.",
  },
  scope: { bucketId: "tax", name: "Tax", typeLabel: "SSF" },
  message: 'Read 1 holding(s) in the "Tax" portfolio; total ฿300,000.',
};

// read_performance scoped to "Tax": low period return, trailing BOTH indices.
export const TAX_PERFORMANCE = {
  ok: true as const,
  hasData: true,
  range: "6mo" as const,
  startDate: "2025-11-30",
  endDate: "2026-05-30",
  startValue: 298_000,
  endValue: 300_000,
  periodReturnPct: 0.7,
  asOf: "2026-05-30",
  benchmarks: [
    { key: "set", label: "SET Index", returnPct: 4.3, beating: false },
    { key: "sp500", label: "S&P 500", returnPct: 9.8, beating: false },
  ],
  scope: { bucketId: "tax", name: "Tax" },
  message:
    '"Tax" portfolio +0.7% over 6mo (2025-11-30→2026-05-30). Benchmarks: SET Index +4.3%, S&P 500 +9.8%.',
};

// ─── Synthetic fund catalog (for find_funds / find_cheaper_alternatives) ─────
// A cheaper global-equity index alternative to EXAMPLE-FUND-A, plus an SSF and
// an RMF wrapper so the "SSF vs RMF" question has real options to weigh.
interface CatalogFund {
  projId: string;
  abbr: string;
  englishName: string;
  amc: string;
  assetClass: "equity" | "bond" | "alternative" | "cash";
  terPct: number;
  managementStyle: "PN" | "AA";
  taxIncentiveType: "SSF" | "RMF" | "ThaiESG" | null;
  investRegion: "foreign" | "domestic" | "mixed";
  isFeederFund: boolean;
  feederMasterFund: string | null;
}
const CATALOG: CatalogFund[] = [
  {
    projId: "EXMP_D",
    abbr: "EXAMPLE-FUND-D",
    englishName: "Example Global Equity Index",
    amc: "Example AMC",
    assetClass: "equity",
    terPct: 0.2,
    managementStyle: "PN",
    taxIncentiveType: null,
    investRegion: "foreign",
    isFeederFund: true,
    feederMasterFund: "Example MSCI World ETF",
  },
  {
    projId: "EXMP_SSF1",
    abbr: "EXAMPLE-FUND-SSF1",
    englishName: "Example Global Equity SSF",
    amc: "Example AMC",
    assetClass: "equity",
    terPct: 0.45,
    managementStyle: "PN",
    taxIncentiveType: "SSF",
    investRegion: "foreign",
    isFeederFund: true,
    feederMasterFund: "Example MSCI World ETF",
  },
  {
    projId: "EXMP_RMF1",
    abbr: "EXAMPLE-FUND-RMF1",
    englishName: "Example Global Equity RMF",
    amc: "Example AMC",
    assetClass: "equity",
    terPct: 0.5,
    managementStyle: "PN",
    taxIncentiveType: "RMF",
    investRegion: "foreign",
    isFeederFund: true,
    feederMasterFund: "Example MSCI World ETF",
  },
  {
    projId: "EXMP_THAI",
    abbr: "EXAMPLE-FUND-THAI-IDX",
    englishName: "Example SET50 Index",
    amc: "Example AMC",
    assetClass: "equity",
    terPct: 0.3,
    managementStyle: "PN",
    taxIncentiveType: null,
    investRegion: "domestic",
    isFeederFund: false,
    feederMasterFund: null,
  },
];

function fundItem(f: CatalogFund) {
  return {
    projId: f.projId,
    abbr: f.abbr,
    englishName: f.englishName,
    amc: f.amc,
    assetClass: f.assetClass,
    terPct: f.terPct,
    terLabel: `${f.terPct.toFixed(2)}% p.a.`,
    managementStyle: f.managementStyle,
    // Real funds mark index style "PN"/"PM"; the synthetic catalog uses "PN".
    isIndex: f.managementStyle === "PN",
    taxIncentiveType: f.taxIncentiveType,
    distributionPolicy: null,
    investRegion: f.investRegion,
    isFeederFund: f.isFeederFund,
    feederMasterFund: f.feederMasterFund,
  };
}

// ─── Tool surface ───────────────────────────────────────────────────────────
// 9 advisor tools + 5 memory tools, matching the real surface size (~14) so the
// model faces the same tool-choice complexity. Descriptions on the four measured
// READS mirror the real steering; the rest are terse.

const okResult = (o: object) => ({ ok: true as const, ...o });

export interface BuildEvalToolsOptions {
  /**
   * When true, attach the production toModelOutput shapers (#60) so the eval
   * measures the SHAPED model-facing view. Default false = the raw object the
   * model saw before shaping, so the same harness can A/B the token delta.
   */
  shape?: boolean;
  /**
   * When true, the portfolio reads return the EMPTY fixture (no holdings) so a
   * question can probe whether the Advisor refuses to fabricate an analysis
   * (issue #69). A question opts in via `fixture: "empty"`; the catalog reads
   * (find_funds / find_cheaper_alternatives) are unaffected — the fund universe
   * exists regardless of what the user holds.
   */
  empty?: boolean;
}

export function buildEvalTools(opts: BuildEvalToolsOptions = {}) {
  // When shaping is on, attach the same toModelOutput shapers the real tools use
  // (lib/advisor/shape.ts). When off, omitting toModelOutput makes the AI SDK
  // serialize the raw object (the pre-#60 view) — so one harness measures both.
  const shaped = (kind: keyof typeof shapeForModel) =>
    opts.shape
      ? {
          toModelOutput: ({ output }: { output: unknown }) => ({
            type: "text" as const,
            value: shapeForModel[kind](output as never),
          }),
        }
      : {};

  return {
    read_portfolio: tool({
      description:
        "Read the user's REAL portfolio: total value, allocation by asset class and region, " +
        "per-sleeve drift from their target model, blended (value-weighted) expense ratio, " +
        "concentration (largest holding, top-3, HHI), and cash drag. Use before answering " +
        "anything about how they're doing, their mix, fees, concentration, or rebalancing. " +
        "The user keeps SEPARATE portfolios: with no arguments it adds a per-portfolio " +
        "breakdown; pass `portfolio` with a name (e.g. 'Tax') to scope the readout to one.",
      inputSchema: z.object({
        portfolio: z.string().optional(),
        ticker: z.string().optional(),
      }),
      execute: async ({ portfolio }) => {
        if (opts.empty) return EMPTY_PORTFOLIO;
        if (portfolio && /tax/i.test(portfolio)) return TAX_PORTFOLIO;
        return { ...PORTFOLIO, byBucket: BY_BUCKET };
      },
      ...shaped("portfolio"),
    }),
    read_performance: tool({
      description:
        "Read how the portfolio PERFORMED over a period: total return % AND the same-period " +
        "return of reference indices (SET, S&P 500) so you can answer 'am I matching / beating " +
        "my index?' with real numbers. Call for any question about returns or keeping up with an index. " +
        "Pass `portfolio` with a name to scope the return to a single portfolio (e.g. 'Tax').",
      inputSchema: z.object({
        range: z.enum(["1mo", "3mo", "6mo", "1y", "5y", "max"]).optional(),
        portfolio: z.string().optional(),
      }),
      execute: async ({ portfolio }) => {
        if (opts.empty) return EMPTY_PERFORMANCE;
        if (portfolio && /tax/i.test(portfolio)) return TAX_PERFORMANCE;
        return PERFORMANCE;
      },
      ...shaped("performance"),
    }),
    read_plan: tool({
      description:
        "Read the user's written investing plan (target, principles, risk, commitments).",
      inputSchema: z.object({}),
      execute: async () =>
        okResult({
          hasPlan: true,
          markdown:
            "# Investing Plan\n## Target\nBogle 3-fund, 40% global equity / 20% Thai equity / 30% global bond / 10% cash.\n## Principles\n- Index funds only, no single stocks.\n- Rebalance when any sleeve drifts more than 5pp.\n## Risk\n- Max drawdown tolerance 25%. Long horizon (20y+).",
          spine: {
            target: "Bogle 3-fund (40/20/30/10)",
            principles: ["Index funds only, no single stocks", "Rebalance when drift > 5pp"],
            risk: ["Max drawdown 25%", "20y+ horizon"],
            commitments: [],
          },
          extras: [],
          selectedModelId: "bogle-3-global",
          message: "Loaded the user's plan.",
        }),
    }),
    read_journal: tool({
      description: "Read past journal entries (note/decision/question/reading).",
      inputSchema: z.object({
        kind: z.enum(["note", "decision", "question", "reading"]).optional(),
        tag: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      execute: async () =>
        okResult({
          count: 1,
          entries: [
            {
              id: "j1",
              kind: "decision",
              title: "Trimmed global equity in January",
              body: "Sold a little EXAMPLE-FUND-A after it ran up; want to stay near target.",
              tags: ["rebalance"],
              createdAt: "2026-01-15",
            },
          ],
          message: "Found 1 journal entry.",
        }),
    }),
    write_journal: tool({
      description:
        "Save a new journal entry when the user makes a decision or asks to log something.",
      inputSchema: z.object({
        kind: z.enum(["note", "decision", "question", "reading"]),
        title: z.string().max(200).optional(),
        body: z.string().min(1).max(4000),
        tags: z.array(z.string()).max(10).optional(),
      }),
      execute: async ({ kind, title }) =>
        okResult({
          id: "j-new",
          kind,
          message: `Saved to your journal as a ${kind}${title ? `: "${title}"` : ""}.`,
        }),
    }),
    propose_plan_edit: tool({
      description:
        "Propose adding a rule/principle/risk note/target to the plan. Shows a confirm card; does NOT change the plan.",
      inputSchema: z.object({
        section: z.string().min(1),
        add: z.string().min(1),
        rationale: z.string().min(1).max(500),
      }),
      execute: async ({ section, add, rationale }) =>
        okResult({
          proposal: { section, rationale, add: `- ${add.replace(/^[-*]\s*/, "")}`, rm: null },
          message: `Drafted a change to your ${section} section — confirm on the card to apply it.`,
        }),
    }),
    propose_holding: tool({
      description:
        "Propose adding ONE holding (call once per position). Shows a confirm card; writes nothing until accepted.",
      inputSchema: z.object({
        ticker: z.string().min(1).max(40),
        englishName: z.string().min(1).max(200),
        units: z.number().positive(),
        avgCost: z.number().positive().optional(),
        assetClass: z.enum(["equity", "bond", "alternative", "cash"]).optional(),
        rationale: z.string().min(1).max(300),
      }),
      execute: async ({ ticker, units }) =>
        okResult({
          holding: { ticker: ticker.toUpperCase(), units },
          message: `Drafted ${ticker.toUpperCase()} (${units} units) — confirm on the card to add it.`,
        }),
    }),
    find_funds: tool({
      description:
        "Search the SEC-registered Thai mutual fund catalog and return funds matching a TARGET " +
        "EXPOSURE, sorted CHEAPEST FIRST by all-in annual fee (TER). Use indexOnly=true for " +
        "passive funds; taxIncentive to find SSF/ThaiESG/RMF wrappers. Fee is the controllable edge.",
      inputSchema: z.object({
        assetClass: z.enum(["equity", "bond", "alternative", "cash"]).optional(),
        indexOnly: z.boolean().optional(),
        taxIncentive: z.enum(["SSF", "ThaiESG", "RMF"]).optional(),
        region: z.enum(["foreign", "domestic", "mixed"]).optional(),
        regionFocus: z.string().optional(),
        sectorFocus: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().positive().max(30).optional(),
      }),
      execute: async ({ assetClass, taxIncentive, region, limit }) => {
        let funds = CATALOG.filter((f) => {
          if (assetClass && f.assetClass !== assetClass) return false;
          if (taxIncentive && f.taxIncentiveType !== taxIncentive) return false;
          if (region && f.investRegion !== region) return false;
          return true;
        });
        if (funds.length === 0) funds = CATALOG;
        funds = [...funds].sort((a, b) => a.terPct - b.terPct).slice(0, limit ?? 10);
        const items = funds.map(fundItem);
        return okResult({
          count: items.length,
          funds: items,
          cheapestAbbr: items[0]?.abbr ?? null,
          message: `Found ${items.length} fund(s) — sorted cheapest first. Lowest TER: ${items[0]?.terLabel} (${items[0]?.abbr}).`,
        });
      },
      ...shaped("funds"),
    }),
    find_cheaper_alternatives: tool({
      description:
        "Given a fund the user holds (by abbr or SEC project id), find cheaper funds with the " +
        "same exposure — strictly lower TER, cheapest first. Present the fee delta prominently.",
      inputSchema: z.object({
        fundAbbr: z.string().optional(),
        projId: z.string().optional(),
        limit: z.number().int().positive().max(10).optional(),
      }),
      execute: async ({ fundAbbr }) => {
        // The only held fund with a cheaper twin in the fixture is EXAMPLE-FUND-A
        // (global equity at 0.60% → EXAMPLE-FUND-D at 0.20%).
        const ref = (fundAbbr ?? "EXAMPLE-FUND-A").toUpperCase();
        const alt = fundItem(CATALOG[0]); // EXAMPLE-FUND-D @ 0.20
        return okResult({
          count: 1,
          alternatives: [alt],
          referenceAbbr: ref,
          cheapestAlternativeAbbr: alt.abbr,
          message:
            `Found 1 cheaper alternative for ${ref} — ${alt.abbr} at ${alt.terLabel} ` +
            "(vs 0.60% p.a., a 0.40pp saving). Even a 0.5% TER difference compounds materially.",
        });
      },
      ...shaped("cheaper"),
    }),
    // ─── memory tools ─────────────────────────────────────────────────────────
    // save_preference / update_preference mirror the REAL descriptions + schemas
    // (lib/memory/tools.ts) so the eval measures the model's true save-rate on
    // memory-capture turns (the metric the reasoning A/B exists to move). The
    // other three stay terse — they're here for surface fidelity, not measured.
    save_preference: tool({
      description:
        "Save a durable preference about the user so it loads automatically in future chats. " +
        "Use when the user explicitly states a stable fact, preference, account detail, or how " +
        "they want Advisor to respond. FIRST check whether this UPDATES something already saved " +
        "(it's in your memory block, or use list_preferences) — if so call update_preference " +
        "instead of saving a near-duplicate. Choose the most specific category. The saved " +
        "preference does NOT affect the current chat — it activates in the next chat. Confirm to " +
        "the user with the returned message.",
      inputSchema: z.object({
        category: z
          .enum(["profile", "finance_context", "response_style", "fact"])
          .describe(
            "profile = stable facts about the user (risk tolerance, time horizon, timezone, age). " +
              "finance_context = accounts, tax situation, constraints. response_style = how Advisor " +
              "should communicate. fact = one-off ad-hoc remembers.",
          ),
        content: z
          .string()
          .min(1)
          .max(500)
          .describe("The fact to remember, written as a short declarative phrase."),
        detail: z.string().max(2000).optional(),
      }),
      execute: async ({ content }) =>
        okResult({
          memoryEvent: { kind: "save", id: 1, category: "fact", content },
          message: `Saved: ${content}. Active in your next chat.`,
        }),
    }),
    update_preference: tool({
      description:
        "Update an existing preference. Pass either the numeric id (from a previous " +
        "list_preferences call) or a distinctive substring of the current content. If the " +
        "substring matches more than one active preference, the tool returns the candidates so " +
        "you can ask the user to clarify before retrying.",
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]).optional(),
        match: z.string().optional(),
        content: z.string().min(1).max(500),
      }),
      execute: async ({ content }) =>
        okResult({ memoryEvent: { kind: "update", id: 1, content }, message: "Updated." }),
    }),
    forget_preference: tool({
      description: "Delete a saved preference by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => okResult({ forgotten: true }),
    }),
    list_preferences: tool({
      description: "List all saved preferences.",
      inputSchema: z.object({}),
      execute: async () => okResult({ preferences: [] }),
    }),
    recall_preferences: tool({
      description: "Recall preferences relevant to a topic.",
      inputSchema: z.object({ topic: z.string().optional() }),
      execute: async () => okResult({ preferences: [] }),
    }),
  };
}

/** Tool names the eval expects to exist (guards drift against the real surface). */
export const EVAL_TOOL_NAMES = Object.keys(buildEvalTools()) as Array<
  keyof ReturnType<typeof buildEvalTools>
>;
