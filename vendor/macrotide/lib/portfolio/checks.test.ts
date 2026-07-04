import { describe, expect, it } from "vitest";
import type { Holding, MixSlice } from "@/lib/static/types";
import { buildNamedChecks } from "./checks";
import { computeHealth, type LookThrough } from "./health";

function holding(partial: Partial<Holding> & { ticker: string; value: number }): Holding {
  return {
    ticker: partial.ticker,
    name: partial.name ?? partial.ticker,
    category: partial.category ?? "Fund",
    class: partial.class ?? "equity",
    region: partial.region ?? "United States",
    value: partial.value,
    cost: partial.cost ?? partial.value,
    units: partial.units ?? 1,
    nav: partial.nav ?? 1,
    d1: 0,
    ytd: 0,
    y1: 0,
    ter: partial.ter === undefined ? 0.1 : partial.ter,
    source: "",
  };
}

const find = (checks: ReturnType<typeof buildNamedChecks>, key: string) =>
  checks.find((c) => c.key === key);

describe("buildNamedChecks", () => {
  it("returns the four checks in order: drift, fees, diversification, cash", () => {
    const health = computeHealth([holding({ ticker: "A", value: 1000 })], 1000, null);
    expect(buildNamedChecks(health, null).map((c) => c.key)).toEqual([
      "drift",
      "fees",
      "diversification",
      "cash",
    ]);
  });

  it("drift with no target is a CTA (status none), not a failing grade", () => {
    const health = computeHealth([holding({ ticker: "A", value: 1000 })], 1000, null);
    const drift = find(buildNamedChecks(health, null), "drift");
    expect(drift?.status).toBe("none");
    expect(drift?.value).toMatch(/no target/i);
  });

  it("fees: all-unknown reads 'Not published', never 0% index-grade", () => {
    const health = computeHealth([holding({ ticker: "A", value: 1000, ter: null })], 1000, null);
    const fees = find(buildNamedChecks(health, null), "fees");
    expect(fees?.status).toBe("none");
    expect(fees?.value).toMatch(/not published/i);
  });

  it("fees: low blended fee reads good", () => {
    const health = computeHealth([holding({ ticker: "A", value: 1000, ter: 0.2 })], 1000, null);
    expect(find(buildNamedChecks(health, null), "fees")?.status).toBe("good");
  });

  it("diversification value shows the certain fund-level fact, numbers not adjacent", () => {
    // 5 funds so the 'top 3' clause shows; each clause leads with its percentage.
    const health = computeHealth(
      [
        holding({ ticker: "A", value: 600 }),
        holding({ ticker: "B", value: 100 }),
        holding({ ticker: "C", value: 100 }),
        holding({ ticker: "D", value: 100 }),
        holding({ ticker: "E", value: 100 }),
      ],
      1000,
      null,
    );
    const value = find(buildNamedChecks(health, null), "diversification")?.value ?? "";
    expect(value).toMatch(/60% in top fund/);
    expect(value).toMatch(/in top 3/);
    // no two numbers separated only by a space (the "top 3 55%" problem)
    expect(value).not.toMatch(/\d\s\d/);
  });

  it("diversification drops the top-3 clause for small portfolios", () => {
    const health = computeHealth(
      [holding({ ticker: "A", value: 600 }), holding({ ticker: "B", value: 400 })],
      1000,
      null,
    );
    const value = find(buildNamedChecks(health, null), "diversification")?.value ?? "";
    expect(value).toBe("60% in top fund");
  });

  it("diversification reflects a high-coverage look-through finding (act)", () => {
    const lt: LookThrough = {
      maxName: { label: "Apple Inc.", pct: 12, fundCount: 2 },
      redundantPairs: [],
      equityCoverage: 0.8,
      regionDivergencePp: null,
    };
    const health = computeHealth([holding({ ticker: "A", value: 1000 })], 1000, null, null, lt);
    const div = find(buildNamedChecks(health, null), "diversification");
    expect(div?.status).toBe("action");
    expect(div?.reason).toMatch(/at least 12%/i);
  });

  it("cash: a small cash buffer reads watch", () => {
    const health = computeHealth(
      [
        holding({ ticker: "EQ", value: 920 }),
        holding({ ticker: "CASH", class: "cash", value: 80 }),
      ],
      1000,
      null,
    );
    expect(find(buildNamedChecks(health, null), "cash")?.status).toBe("watch");
  });

  it("cash: a large cash pile reads act", () => {
    const health = computeHealth(
      [
        holding({ ticker: "EQ", value: 850 }),
        holding({ ticker: "CASH", class: "cash", value: 150 }),
      ],
      1000,
      null,
    );
    expect(find(buildNamedChecks(health, null), "cash")?.status).toBe("action");
  });

  it("drift with a target reports the gap and a tone", () => {
    const holdings = [
      holding({ ticker: "A", value: 800 }),
      holding({ ticker: "B", value: 200, class: "bond" }),
    ];
    const mix: MixSlice[] = [
      { label: "Eq", pct: 50, ticker: "A", color: "var(--accent)" },
      { label: "Bond", pct: 50, ticker: "B", color: "#F4A434" },
    ];
    const health = computeHealth(holdings, 1000, mix);
    const drift = find(buildNamedChecks(health, "Balanced"), "drift");
    // 80/20 vs 50/50 → 30pp overweight equity → action
    expect(drift?.status).toBe("action");
    expect(drift?.reason).toMatch(/Balanced/);
  });
});
