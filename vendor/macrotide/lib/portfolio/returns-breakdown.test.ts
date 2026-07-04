import { describe, expect, it } from "vitest";
import { heroReturn, summarizeReturns } from "./returns-breakdown";

describe("heroReturn", () => {
  it("uses net contributions as the basis when present", () => {
    const r = heroReturn(1320, 1000, 500);
    expect(r.usesContribution).toBe(true);
    expect(r.basis).toBe(1000);
    expect(r.pnl).toBe(320);
    expect(r.pnlPct).toBeCloseTo(32, 6);
  });

  it("falls back to cost basis when there is no contribution series", () => {
    const r = heroReturn(550, null, 500);
    expect(r.usesContribution).toBe(false);
    expect(r.basis).toBe(500);
    expect(r.pnl).toBe(50);
    expect(r.pnlPct).toBeCloseTo(10, 6);
  });

  it("falls back when net contributions are non-positive", () => {
    const r = heroReturn(550, 0, 500);
    expect(r.usesContribution).toBe(false);
    expect(r.basis).toBe(500);
  });

  it("never divides by zero — a zero basis yields 0%", () => {
    const r = heroReturn(100, null, 0);
    expect(r.pnl).toBe(100);
    expect(r.pnlPct).toBe(0);
  });

  it("reports a loss with a negative percent", () => {
    const r = heroReturn(800, 1000, 900);
    expect(r.pnl).toBe(-200);
    expect(r.pnlPct).toBeCloseTo(-20, 6);
  });
});

describe("summarizeReturns", () => {
  const base = {
    totalValue: 1320,
    netContributed: 1000,
    costBasisTotal: 900,
    realizedTotal: 200,
    incomeTotal: 30,
    expenseTotal: 5,
    irr: 0.15,
  };

  it("derives the full decomposition", () => {
    const r = summarizeReturns(base);
    expect(r.totalReturnAbs).toBe(320);
    expect(r.totalReturnPct).toBeCloseTo(32, 6);
    expect(r.unrealizedAbs).toBe(420); // 1320 − 900
    expect(r.unrealizedPct).toBeCloseTo((420 / 900) * 100, 6);
    expect(r.annualizedPct).toBeCloseTo(15, 6);
    expect(r.usesContribution).toBe(true);
  });

  it("leaves total return null without a contribution history (but still shows unrealized)", () => {
    const r = summarizeReturns({ ...base, netContributed: null });
    expect(r.totalReturnAbs).toBeNull();
    expect(r.totalReturnPct).toBeNull();
    expect(r.usesContribution).toBe(false);
    // The cost-basis decomposition is independent of contributions.
    expect(r.unrealizedAbs).toBe(420);
    expect(r.unrealizedPct).toBeCloseTo((420 / 900) * 100, 6);
  });

  it("leaves unrealized percent null when there is no cost basis", () => {
    const r = summarizeReturns({ ...base, costBasisTotal: 0 });
    expect(r.unrealizedAbs).toBe(1320);
    expect(r.unrealizedPct).toBeNull();
  });

  it("leaves annualized null when IRR is undefined", () => {
    const r = summarizeReturns({ ...base, irr: null });
    expect(r.annualizedPct).toBeNull();
  });

  it("agrees with the hero on the total-return figure (the #152 reconciliation)", () => {
    // The whole point of #152: the headline and the breakdown must be the SAME
    // number, computed from one formula, so they can never read as a bug again.
    const hero = heroReturn(base.totalValue, base.netContributed, base.costBasisTotal);
    const r = summarizeReturns(base);
    expect(r.totalReturnAbs).toBe(hero.pnl);
    expect(r.totalReturnPct).toBeCloseTo(hero.pnlPct, 9);
  });
});
