import { describe, expect, it } from "vitest";
import { summarizeContributions } from "./contributions";
import type { LedgerTxn } from "./lots";

const A = "EXAMPLE-FUND-A";
const tx = (kind: LedgerTxn["kind"], amount: number, tradeDate: string): LedgerTxn => ({
  ticker: A,
  kind,
  amount,
  tradeDate,
});

describe("summarizeContributions", () => {
  it("aggregates invested / withdrawn per month and overall", () => {
    const s = summarizeContributions([
      tx("buy", -1000, "2024-01-05"),
      tx("buy", -1000, "2024-02-05"),
      tx("sell", 500, "2024-02-20"),
    ]);
    expect(s.months).toHaveLength(2);
    expect(s.months[0]).toMatchObject({
      month: "2024-01",
      invested: 1000,
      withdrawn: 0,
      net: 1000,
    });
    expect(s.months[1]).toMatchObject({
      month: "2024-02",
      invested: 1000,
      withdrawn: 500,
      net: 500,
    });
    expect(s.totalInvested).toBeCloseTo(2000, 6);
    expect(s.totalWithdrawn).toBeCloseTo(500, 6);
    expect(s.averageContribution).toBeCloseTo(1000, 6);
    expect(s.contributionCount).toBe(2);
  });

  it("counts reinvested dividends as contributions", () => {
    const s = summarizeContributions([
      tx("buy", -1000, "2024-01-05"),
      tx("reinvest", -50, "2024-01-20"),
    ]);
    expect(s.totalInvested).toBeCloseTo(1050, 6);
    expect(s.contributionCount).toBe(2);
  });

  it("ignores cash dividends and fees in the contribution series", () => {
    const s = summarizeContributions([
      tx("buy", -1000, "2024-01-05"),
      tx("dividend", 30, "2024-01-10"),
      tx("fee", -20, "2024-01-15"),
    ]);
    expect(s.totalInvested).toBeCloseTo(1000, 6);
    expect(s.contributionCount).toBe(1);
  });

  it("detects a ~monthly cadence as the median gap between contributions", () => {
    const s = summarizeContributions([
      tx("buy", -100, "2024-01-01"),
      tx("buy", -100, "2024-01-31"),
      tx("buy", -100, "2024-03-01"),
    ]);
    // Gaps: 30, 30 → median 30.
    expect(s.cadenceDays).toBe(30);
  });

  it("returns null cadence with fewer than two contributions", () => {
    const s = summarizeContributions([tx("buy", -100, "2024-01-01")]);
    expect(s.cadenceDays).toBeNull();
  });

  it("counts cash deposits + Set-balance raises as contributions (mode A), out in mode B", () => {
    const txns: LedgerTxn[] = [
      tx("buy", -1000, "2024-01-05"),
      { ticker: "THB", kind: "deposit", amount: -500, tradeDate: "2024-01-10" },
      {
        ticker: "THB",
        kind: "cash_balance",
        units: 800,
        fxToThb: 1,
        amount: 0,
        tradeDate: "2024-02-01",
      },
    ];
    // Mode A: 1000 buy + 500 deposit + (800 − 500 deposited = 300 raise) = 1800.
    const a = summarizeContributions(txns);
    expect(a.totalInvested).toBeCloseTo(1800, 6);
    // Cadence/average measure BUY rhythm only — cash never enters those figures.
    expect(a.contributionCount).toBe(1);
    expect(a.averageContribution).toBeCloseTo(1000, 6);
    // Mode B: cash excluded from the totals — only the 1000 buy.
    const b = summarizeContributions(txns, { countUninvestedCash: false });
    expect(b.totalInvested).toBeCloseTo(1000, 6);
  });

  it("counts a cash withdraw / Set-balance drop as withdrawn (mode A)", () => {
    const txns: LedgerTxn[] = [
      { ticker: "THB", kind: "deposit", amount: -1000, tradeDate: "2024-01-01" },
      { ticker: "THB", kind: "withdraw", amount: 300, tradeDate: "2024-02-01" },
    ];
    const s = summarizeContributions(txns);
    expect(s.totalInvested).toBeCloseTo(1000, 6);
    expect(s.totalWithdrawn).toBeCloseTo(300, 6);
  });
});
