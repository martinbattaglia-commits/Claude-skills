import { describe, expect, it } from "vitest";
import { estimateTokens } from "../ai/summarize";
import {
  type CheaperOutput,
  cheaperModelText,
  type FundsOutput,
  fundsModelText,
  type PerformanceOutput,
  type PortfolioOutput,
  performanceModelText,
  portfolioModelText,
  shapeForModel,
} from "./shape";

const PORTFOLIO: PortfolioOutput = {
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
    { label: "Global", pct: 50 },
    { label: "Thailand", pct: 25 },
  ],
  drift: [
    { ticker: "EXAMPLE-FUND-A", label: "Global Equity", current: 50, target: 40, drift: 10 },
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
  ledger: {
    invested: 950_000,
    realized: 12_500,
    income: 3_200,
    irrPct: 8.4,
    irrUnavailable: null,
  },
  customHoldings: [{ ticker: "EXAMPLE-CUSTOM-A", label: "Gold savings (manual)", pct: 5 }],
  position: null,
  headline: { tone: "warn", title: "Off target", body: "Bonds 15pp under target." },
  message: "Read 3 holdings; total ฿1,000,000.",
};

describe("portfolioModelText", () => {
  it("keeps the headline facts an answer needs", () => {
    const t = portfolioModelText(PORTFOLIO);
    expect(t).toContain("EXAMPLE-FUND-A");
    expect(t).toContain("50%"); // largest holding
    expect(t).toContain("0.585%"); // blended fee
    expect(t).toContain("+10pp"); // overweight direction
    expect(t).toContain("-15pp"); // underweight direction
    expect(t).toContain("Off target"); // headline
  });

  it("drops on-target sleeves and structural noise (hhi/tone)", () => {
    const t = portfolioModelText(PORTFOLIO);
    expect(t).not.toContain("CASH 0pp"); // 0-drift sleeve omitted
    expect(t).not.toContain("0.35"); // HHI dropped
    expect(t).not.toContain("warn"); // tone dropped
  });

  it("is substantially smaller than the raw JSON the model used to see", () => {
    const shaped = estimateTokens(portfolioModelText(PORTFOLIO));
    const raw = estimateTokens(JSON.stringify({ ok: true, ...PORTFOLIO }));
    expect(shaped).toBeLessThan(raw * 0.6); // ≥40% smaller
  });

  it("returns the plain message when there are no holdings", () => {
    const empty: PortfolioOutput = {
      ...PORTFOLIO,
      hasHoldings: false,
      message: "No holdings yet.",
    };
    expect(portfolioModelText(empty)).toBe("No holdings yet.");
  });

  it("surfaces lifetime ledger figures (invested, realized, income, money-weighted return)", () => {
    const t = portfolioModelText(PORTFOLIO);
    expect(t).toContain("invested ฿950,000 (cost basis)");
    expect(t).toContain("realized +฿12,500");
    expect(t).toContain("income ฿3,200");
    expect(t).toContain("money-weighted return +8.4%");
  });

  it("explains why the money-weighted return is unavailable instead of guessing", () => {
    const t = portfolioModelText({
      ...PORTFOLIO,
      ledger: {
        invested: 950_000,
        realized: 12_500,
        income: 3_200,
        irrPct: null,
        irrUnavailable: "Not enough activity yet.",
      },
    });
    expect(t).toContain("money-weighted return n/a (Not enough activity yet.)");
  });

  it("flags custom (self-priced) holdings as user-supplied", () => {
    const t = portfolioModelText(PORTFOLIO);
    expect(t).toContain("Self-priced (custom) holdings");
    expect(t).toContain("EXAMPLE-CUSTOM-A 5%");
  });

  it("omits ledger/custom/position lines when absent", () => {
    const bare: PortfolioOutput = {
      ...PORTFOLIO,
      ledger: null,
      customHoldings: [],
      position: null,
    };
    const t = portfolioModelText(bare);
    expect(t).not.toContain("Lifetime ledger");
    expect(t).not.toContain("Self-priced");
    expect(t).not.toContain("money-weighted return");
    expect(t).not.toContain("invested");
  });

  it("includes a per-fund block when a ticker was requested", () => {
    const t = portfolioModelText({
      ...PORTFOLIO,
      position: {
        ticker: "EXAMPLE-FUND-A",
        invested: 400_000,
        realized: -2_000,
        income: 1_100,
        irrPct: 6.2,
        irrUnavailable: null,
        marketValue: 500_000,
        units: 1234.5,
      },
    });
    expect(t).toContain("Fund EXAMPLE-FUND-A: invested ฿400,000");
    expect(t).toContain("realized −฿2,000");
    expect(t).toContain("value ฿500,000 (1234.5 units)");
  });

  it("renders a per-portfolio breakdown, leading with money-weighted return", () => {
    const t = portfolioModelText({
      ...PORTFOLIO,
      byBucket: [
        {
          bucketId: "core",
          name: "Core",
          typeLabel: "Free",
          totalValue: 600_000,
          pctOfTotal: 60,
          targetModel: "Bogle 3-Fund (Global)",
          topClass: { label: "Equity", pct: 90 },
          trackingGapPp: 2.1,
          blendedTer: 0.2,
          topHolding: { ticker: "EXAMPLE-FUND-A", pct: 50 },
          cashPct: 3,
          realized: 5_000,
          irrPct: 9.2,
          irrUnavailable: null,
        },
        {
          bucketId: "tax",
          name: "Tax",
          typeLabel: "SSF",
          totalValue: 400_000,
          pctOfTotal: 40,
          targetModel: null,
          topClass: { label: "Bond", pct: 80 },
          trackingGapPp: null,
          blendedTer: 0.5,
          topHolding: { ticker: "EXAMPLE-FUND-C", pct: 80 },
          cashPct: 1,
          realized: -1_000,
          irrPct: 1.3,
          irrUnavailable: null,
        },
      ],
    });
    expect(t).toContain("Per-portfolio breakdown:");
    expect(t).toContain("Core (Free): ฿600,000 (60% of total), +9.2% money-weighted");
    expect(t).toContain("Tax (SSF): ฿400,000 (40% of total), +1.3% money-weighted");
  });

  it("names the portfolio in the head when scoped to one", () => {
    const t = portfolioModelText({
      ...PORTFOLIO,
      scope: { bucketId: "tax", name: "Tax", typeLabel: "SSF" },
    });
    expect(t).toContain('"Tax" portfolio ฿1,000,000');
  });
});

describe("performanceModelText", () => {
  const perf: PerformanceOutput = {
    hasData: true,
    range: "6mo",
    startDate: "2025-11-30",
    endDate: "2026-05-30",
    periodReturnPct: 7.1,
    benchmarks: [
      { label: "SET Index", returnPct: 4.3, beating: true },
      { label: "S&P 500", returnPct: 9.8, beating: false },
    ],
    message: "raw message",
  };

  it("reports return, range, and per-benchmark beating/trailing", () => {
    const t = performanceModelText(perf);
    expect(t).toContain("+7.1%");
    expect(t).toContain("SET Index +4.3% (beating)");
    expect(t).toContain("S&P 500 +9.8% (trailing)");
  });

  it("passes through the message when there is no data", () => {
    expect(
      performanceModelText({ hasData: false, range: "6mo", message: "Not enough NAV history." }),
    ).toBe("Not enough NAV history.");
  });

  it("names the portfolio in the head when the return is scoped to one", () => {
    const t = performanceModelText({ ...perf, scope: { bucketId: "tax", name: "Tax" } });
    expect(t).toContain('"Tax" portfolio +7.1%');
  });
});

describe("fundsModelText", () => {
  const funds: FundsOutput = {
    count: 2,
    cheapestAbbr: "EXAMPLE-FUND-D",
    funds: [
      {
        abbr: "EXAMPLE-FUND-D",
        terLabel: "0.20% p.a.",
        isIndex: true,
        taxIncentiveType: null,
        investRegion: "foreign",
        isFeederFund: true,
      },
      {
        abbr: "EXAMPLE-FUND-SSF1",
        terLabel: "0.45% p.a.",
        isIndex: true,
        taxIncentiveType: "SSF",
        investRegion: "foreign",
        isFeederFund: true,
      },
    ],
    message: "Found 2 funds.",
  };

  it("renders one compact line per fund with TER + tags", () => {
    const t = fundsModelText(funds);
    expect(t).toContain("EXAMPLE-FUND-D: 0.20% p.a. (index, foreign, feeder)");
    expect(t).toContain("EXAMPLE-FUND-SSF1: 0.45% p.a. (index, SSF, foreign, feeder)");
  });

  it("returns the message on an empty result", () => {
    expect(fundsModelText({ count: 0, funds: [], message: "No funds found." })).toBe(
      "No funds found.",
    );
  });
});

describe("cheaperModelText", () => {
  const cheaper: CheaperOutput = {
    count: 1,
    referenceAbbr: "EXAMPLE-FUND-A",
    alternatives: [
      { abbr: "EXAMPLE-FUND-D", terLabel: "0.20% p.a.", isIndex: true, investRegion: "foreign" },
    ],
    message: "Found 1 cheaper alternative.",
  };

  it("names the reference and lists the cheaper option", () => {
    const t = cheaperModelText(cheaper);
    expect(t).toContain("Cheaper than EXAMPLE-FUND-A");
    expect(t).toContain("EXAMPLE-FUND-D: 0.20% p.a.");
  });
});

describe("shapeForModel registry", () => {
  it("exposes all four shapers by key", () => {
    expect(Object.keys(shapeForModel).sort()).toEqual([
      "cheaper",
      "funds",
      "performance",
      "portfolio",
    ]);
  });
});
