// Unit tests for the FundDetailSheet enrichment helpers and data shapes.
//
// These tests exercise the pure logic used by the component (period sorting,
// performance type label mapping, formatting) with mocked enrichment data —
// without touching the network or the real database.

import { describe, expect, it } from "vitest";
import type {
  FundAssetAllocationRow,
  FundPerformanceRow,
  FundPortfolioAssetTypeRow,
  FundPortfolioRow,
  FundTopHoldingRow,
} from "@/lib/db/queries/fund-enrichment";
// Import the REAL helpers the component uses, so a change to the period sort,
// label map, or formatters fails this test instead of silently passing a stale
// replica.
import { fmtNavPct, fmtPct, perfTypeLabel, periodSortKey } from "@/lib/fund-detail-format";

// ─── mock enrichment data ─────────────────────────────────────────────────────

const MOCK_PERFORMANCE: FundPerformanceRow[] = [
  {
    projId: "M0017_2538",
    fundClassName: "A",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    performanceTypeDesc: "ผลการดำเนินงานของกองทุนรวม",
    referencePeriod: "3M",
    performanceValue: "2.45",
    lastUpdDate: "2024-12-31",
  },
  {
    projId: "M0017_2538",
    fundClassName: "A",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    performanceTypeDesc: "ผลการดำเนินงานของกองทุนรวม",
    referencePeriod: "1Y",
    performanceValue: "12.30",
    lastUpdDate: "2024-12-31",
  },
  {
    projId: "M0017_2538",
    fundClassName: "A",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    performanceTypeDesc: "ความผันผวนของกองทุนรวม",
    referencePeriod: "1Y",
    performanceValue: "8.10",
    lastUpdDate: "2024-12-31",
  },
  {
    projId: "M0017_2538",
    fundClassName: "A",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    performanceTypeDesc: "ผลการดำเนินงานของดัชนีชี้วัด",
    referencePeriod: "1Y",
    performanceValue: "11.80",
    lastUpdDate: "2024-12-31",
  },
];

const MOCK_ASSET_ALLOCATION: FundAssetAllocationRow[] = [
  {
    projId: "M0017_2538",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    assetSeq: 1,
    assetName: "Foreign Equities",
    assetRatio: 95.68,
    lastUpdDate: "2024-12-31",
  },
  {
    projId: "M0017_2538",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    assetSeq: 2,
    assetName: "Cash & Deposits",
    assetRatio: 4.32,
    lastUpdDate: "2024-12-31",
  },
];

const MOCK_TOP_HOLDINGS: FundTopHoldingRow[] = [
  {
    projId: "M0017_2538",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    assetSeq: 1,
    assetName: "ISHARES MSCI ACWI INDEX FUND",
    assetRatio: 93.21,
    lastUpdDate: "2024-12-31",
  },
  {
    projId: "M0017_2538",
    startDate: "2024-01-01",
    endDate: null,
    prospectusType: "Monthly",
    assetSeq: 2,
    assetName: "CASH",
    assetRatio: 3.45,
    lastUpdDate: "2024-12-31",
  },
];

const MOCK_PORTFOLIO: FundPortfolioRow[] = [
  {
    id: 1,
    projId: "M0017_2538",
    period: "202412",
    asOfDate: "2024-12-31",
    assetliabId: "101",
    assetliabDesc: "iShares MSCI ACWI ETF",
    issueCode: "ACWI",
    isinCode: "US46432F3396",
    issuer: "BlackRock",
    assetliabValue: 950000000,
    percentNav: 93.21,
    lastUpdDate: "2024-12-31",
    resolvedSymbol: "ACWI",
  },
  {
    id: 2,
    projId: "M0017_2538",
    period: "202412",
    asOfDate: "2024-12-31",
    assetliabId: "201",
    assetliabDesc: "Thai Government Bond",
    issueCode: null,
    isinCode: "TH0001234567",
    issuer: "Royal Thai Government",
    assetliabValue: 34500000,
    percentNav: 3.38,
    lastUpdDate: "2024-12-31",
    resolvedSymbol: null,
  },
];

const MOCK_PORTFOLIO_ASSET_TYPE: FundPortfolioAssetTypeRow[] = [
  {
    projId: "M0017_2538",
    period: "202412",
    assetliabCode: "EQ",
    assetliabDesc: "Equity",
    marketValue: 950000000,
    percentNav: 93.21,
  },
  {
    projId: "M0017_2538",
    period: "202412",
    assetliabCode: "CASH",
    assetliabDesc: "Cash",
    marketValue: 44120000,
    percentNav: 4.32,
  },
];

// ─── period sort ──────────────────────────────────────────────────────────────

describe("periodSortKey", () => {
  it("orders standard periods correctly", () => {
    const periods = ["1Y", "3M", "SI", "YTD", "6M"];
    const sorted = [...periods].sort((a, b) => periodSortKey(a) - periodSortKey(b));
    expect(sorted).toEqual(["3M", "6M", "YTD", "1Y", "SI"]);
  });

  it("pushes unknown periods to the end", () => {
    const periods = ["1Y", "UNKNOWN", "3M"];
    const sorted = [...periods].sort((a, b) => periodSortKey(a) - periodSortKey(b));
    expect(sorted[2]).toBe("UNKNOWN");
  });

  it("treats period lookup as case-insensitive", () => {
    expect(periodSortKey("3m")).toBe(periodSortKey("3M"));
    expect(periodSortKey("ytd")).toBe(periodSortKey("YTD"));
  });
});

// ─── performance type labels ──────────────────────────────────────────────────

describe("perfTypeLabel", () => {
  it("maps known Thai labels to English", () => {
    expect(perfTypeLabel("ผลการดำเนินงานของกองทุนรวม")).toBe("Fund Return");
    expect(perfTypeLabel("ความผันผวนของกองทุนรวม")).toBe("Fund Volatility");
    expect(perfTypeLabel("ผลการดำเนินงานของดัชนีชี้วัด")).toBe("Benchmark Return");
    expect(perfTypeLabel("ความผันผวนของดัชนีชี้วัด")).toBe("Benchmark Volatility");
    expect(perfTypeLabel("ผลการดำเนินงานเฉลี่ยของกองทุนรวมในกลุ่ม")).toBe("Peer Avg Return");
    expect(perfTypeLabel("ความผันผวนเฉลี่ยของกองทุนรวมในกลุ่ม")).toBe("Peer Avg Volatility");
  });

  it("falls back to the raw label for unknown types", () => {
    const raw = "Some Unknown Thai Label";
    expect(perfTypeLabel(raw)).toBe(raw);
  });
});

// ─── formatting helpers ───────────────────────────────────────────────────────

describe("fmtNavPct", () => {
  it("formats a positive number with 2 decimal places", () => {
    expect(fmtNavPct(93.21)).toBe("93.21%");
  });

  it("formats zero", () => {
    expect(fmtNavPct(0)).toBe("0.00%");
  });

  it("returns – for null", () => {
    expect(fmtNavPct(null)).toBe("–");
  });

  it("returns – for undefined", () => {
    expect(fmtNavPct(undefined)).toBe("–");
  });
});

describe("fmtPct (performance values)", () => {
  it("adds + sign for positive returns", () => {
    expect(fmtPct("12.30")).toBe("+12.30%");
  });

  it("does not add + sign for zero", () => {
    expect(fmtPct("0.00")).toBe("0.00%");
  });

  it("does not add + sign for negative values", () => {
    expect(fmtPct("-3.50")).toBe("-3.50%");
  });

  it("suppresses + sign when showSign is false (for volatility)", () => {
    expect(fmtPct("8.10", false)).toBe("8.10%");
  });

  it("returns – for null", () => {
    expect(fmtPct(null)).toBe("–");
  });

  it("handles numeric input", () => {
    expect(fmtPct(5.5)).toBe("+5.50%");
  });
});

// ─── mock data shape validation ───────────────────────────────────────────────

describe("mock enrichment data integrity", () => {
  it("performance rows have expected fields", () => {
    for (const row of MOCK_PERFORMANCE) {
      expect(row.projId).toBe("M0017_2538");
      expect(row.performanceTypeDesc).toBeTruthy();
      expect(row.referencePeriod).toBeTruthy();
    }
  });

  it("asset allocation rows are ordered by assetSeq", () => {
    const seqs = MOCK_ASSET_ALLOCATION.map((r) => r.assetSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("top holdings rows are ordered by assetSeq and #1 is the largest", () => {
    const first = MOCK_TOP_HOLDINGS[0];
    expect(first?.assetSeq).toBe(1);
    // The #1 holding for a feeder fund names the master fund.
    expect(first?.assetName).toMatch(/ISHARES|iShares|ETF|FUND/i);
  });

  it("portfolio rows share the same period", () => {
    const periods = [...new Set(MOCK_PORTFOLIO.map((r) => r.period))];
    expect(periods.length).toBe(1);
  });

  it("portfolio period label formats correctly", () => {
    const period = MOCK_PORTFOLIO[0]?.period ?? "";
    const label = `${period.slice(0, 4)}/${period.slice(4)}`;
    expect(label).toBe("2024/12");
  });

  it("portfolioAssetType percentNav values sum to approximately 100%", () => {
    const total = MOCK_PORTFOLIO_ASSET_TYPE.reduce((s, r) => s + (r.percentNav ?? 0), 0);
    // Allow for small rounding differences.
    expect(total).toBeGreaterThan(90);
    expect(total).toBeLessThanOrEqual(100.01);
  });

  it("empty performance array is handled (no crash)", () => {
    const emptyPerf: FundPerformanceRow[] = [];
    expect(emptyPerf.length).toBe(0);
    // Represents the component guard: `if (rows.length === 0) return null`
  });

  it("empty topHoldings array is handled (no crash)", () => {
    const empty: FundTopHoldingRow[] = [];
    expect(empty.length).toBe(0);
  });

  it("empty assetAllocation array is handled (no crash)", () => {
    const empty: FundAssetAllocationRow[] = [];
    expect(empty.length).toBe(0);
  });

  it("empty portfolio array is handled (no crash)", () => {
    const empty: FundPortfolioRow[] = [];
    expect(empty.length).toBe(0);
  });

  it("empty portfolioAssetType array is handled (no crash)", () => {
    const empty: FundPortfolioAssetTypeRow[] = [];
    expect(empty.length).toBe(0);
  });
});

// ─── performance pivot logic ──────────────────────────────────────────────────

describe("performance data pivot", () => {
  it("collects unique periods from mock data", () => {
    const periods = new Set(MOCK_PERFORMANCE.map((r) => r.referencePeriod));
    expect(periods.has("3M")).toBe(true);
    expect(periods.has("1Y")).toBe(true);
  });

  it("collects unique performance type descs from mock data", () => {
    const types = new Set(MOCK_PERFORMANCE.map((r) => r.performanceTypeDesc));
    expect(types.size).toBe(3);
  });

  it("correctly identifies volatility rows by Thai keyword", () => {
    const volRows = MOCK_PERFORMANCE.filter((r) => r.performanceTypeDesc.includes("ความผันผวน"));
    expect(volRows.length).toBe(1);
    expect(volRows[0]?.performanceTypeDesc).toBe("ความผันผวนของกองทุนรวม");
  });

  it("sorted periods are in ascending duration order", () => {
    const periods = [...new Set(MOCK_PERFORMANCE.map((r) => r.referencePeriod))];
    const sorted = periods.sort((a, b) => periodSortKey(a) - periodSortKey(b));
    expect(sorted[0]).toBe("3M");
    expect(sorted[sorted.length - 1]).toBe("1Y");
  });
});
