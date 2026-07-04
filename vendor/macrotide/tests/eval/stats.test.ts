// Token-free guard for the eval statistics (scripts/eval/stats.ts, issue #66):
// the confidence interval and the paired McNemar test, on inputs with known
// answers so a regression in the math is caught in CI.
import { describe, expect, it } from "vitest";
import { ci95, isSignificant, mcnemar } from "../../scripts/eval/stats";

describe("ci95", () => {
  it("is undefined (NaN margin) below n=2", () => {
    expect(ci95([]).n).toBe(0);
    const one = ci95([0.8]);
    expect(one.mean).toBe(0.8);
    expect(Number.isNaN(one.margin)).toBe(true);
    expect(one.lo).toBe(0.8);
  });

  it("a constant sample has zero margin", () => {
    const c = ci95([0.5, 0.5, 0.5]);
    expect(c.mean).toBe(0.5);
    expect(c.margin).toBe(0);
  });

  it("margin grows with spread", () => {
    const tight = ci95([0.7, 0.71, 0.69]);
    const wide = ci95([0.2, 0.7, 1.0]);
    expect(wide.margin).toBeGreaterThan(tight.margin);
  });

  it("computes a known interval", () => {
    // [0,1,0,1] → mean .5, sample sd = .5774, se = .2887, margin = 1.96·se ≈ .566
    const c = ci95([0, 1, 0, 1]);
    expect(c.mean).toBeCloseTo(0.5, 6);
    expect(c.margin).toBeCloseTo(0.566, 2);
  });
});

describe("mcnemar", () => {
  it("p=1 with no discordant pairs", () => {
    const r = mcnemar([
      [true, true],
      [false, false],
    ]);
    expect(r.discordant).toBe(0);
    expect(r.pValue).toBe(1);
  });

  it("counts discordant pairs by direction", () => {
    const r = mcnemar([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(r.b).toBe(2); // a passed, b failed
    expect(r.c).toBe(1); // a failed, b passed
    expect(r.discordant).toBe(3);
  });

  it("8 flips one way is significant (exact two-sided p ≈ 0.0078)", () => {
    const pairs = Array.from({ length: 8 }, () => [false, true] as [boolean, boolean]);
    const r = mcnemar(pairs);
    expect(r.pValue).toBeCloseTo(0.0078, 4);
    expect(isSignificant(r.pValue)).toBe(true);
  });

  it("a single flip is not significant", () => {
    const r = mcnemar([[true, false]]);
    expect(r.pValue).toBe(1);
    expect(isSignificant(r.pValue)).toBe(false);
  });
});
