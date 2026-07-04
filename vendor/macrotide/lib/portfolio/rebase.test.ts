import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "@/lib/static/types";
import { rebaseBenchmark, rebaseBenchmarkContrib } from "./rebase";

const pf = (...vals: [string, number][]): SeriesPoint[] => vals.map(([d, v]) => ({ d, v }));
const deltas = (...vals: [string, number][]): Map<string, number> => new Map(vals);

describe("rebaseBenchmark", () => {
  it("rebases the benchmark to the portfolio value at the first common date", () => {
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1100], ["Jan 4", 1200]);
    const benchmark = pf(["Jan 2", 50], ["Jan 3", 55], ["Jan 4", 60]);

    const out = rebaseBenchmark(portfolio, benchmark);

    // Benchmark starts at portfolio's 1000 and tracks its own % move (+10%, +20%).
    expect(out).toEqual(pf(["Jan 2", 1000], ["Jan 3", 1100], ["Jan 4", 1200]));
  });

  it("renders across non-overlapping lengths by intersecting on common dates", () => {
    // Different calendars: portfolio has Jan 3 (TH holiday for the benchmark),
    // benchmark has Jan 2 the portfolio lacks. They overlap on Jan 4/5.
    const portfolio = pf(["Jan 3", 1000], ["Jan 4", 1020], ["Jan 5", 1050]);
    const benchmark = pf(["Jan 2", 200], ["Jan 4", 210], ["Jan 5", 220]);

    const out = rebaseBenchmark(portfolio, benchmark);
    expect(out).not.toBeNull();
    // First common date is Jan 4: benchmark rebased to portfolio's 1020 there.
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 4")).toBeCloseTo(1020);
    expect(byD.get("Jan 5")).toBeCloseTo((220 / 210) * 1020);
    // Jan 3 precedes the first common date → null (gap), not zero.
    expect(byD.get("Jan 3")).toBeNull();
  });

  it("forward-fills the benchmark across portfolio dates it does not cover", () => {
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1010], ["Jan 4", 1020]);
    // Benchmark missing Jan 3 — should hold Jan 2's value forward.
    const benchmark = pf(["Jan 2", 100], ["Jan 4", 110]);

    const out = rebaseBenchmark(portfolio, benchmark);
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 2")).toBeCloseTo(1000);
    expect(byD.get("Jan 3")).toBeCloseTo(1000); // forward-filled, then rebased
    expect(byD.get("Jan 4")).toBeCloseTo((110 / 100) * 1000);
  });

  it("returns null when the series never overlap", () => {
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1010]);
    const benchmark = pf(["Feb 1", 100], ["Feb 2", 110]);
    expect(rebaseBenchmark(portfolio, benchmark)).toBeNull();
  });

  it("returns null for empty / missing inputs and a zero base", () => {
    expect(rebaseBenchmark([], pf(["Jan 2", 100]))).toBeNull();
    expect(rebaseBenchmark(pf(["Jan 2", 1000]), null)).toBeNull();
    expect(rebaseBenchmark(pf(["Jan 2", 1000]), [])).toBeNull();
    // Zero benchmark base can't be rebased (division by zero).
    expect(rebaseBenchmark(pf(["Jan 2", 1000]), pf(["Jan 2", 0]))).toBeNull();
  });
});

describe("rebaseBenchmarkContrib", () => {
  it("equals rebaseBenchmark when there are no contributions", () => {
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1100], ["Jan 4", 1200]);
    const benchmark = pf(["Jan 2", 50], ["Jan 3", 55], ["Jan 4", 60]);

    const matched = rebaseBenchmarkContrib(portfolio, benchmark, deltas());
    const lump = rebaseBenchmark(portfolio, benchmark);
    expect(matched).toEqual(lump);
  });

  it("treats an all-zero delta map the same as no contributions", () => {
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1100]);
    const benchmark = pf(["Jan 2", 50], ["Jan 3", 55]);

    const matched = rebaseBenchmarkContrib(
      portfolio,
      benchmark,
      deltas(["Jan 2", 1000], ["Jan 3", 0]), // Jan 2 is at the anchor → ignored
    );
    expect(matched).toEqual(rebaseBenchmark(portfolio, benchmark));
  });

  it("buys benchmark units with a mid-window deposit", () => {
    // Benchmark flat at 100 the whole window → no market move. A +500 deposit on
    // Jan 3 should lift the benchmark value by exactly the cash added (500 / 100
    // = 5 units × 100), so the line steps with the contribution, not flat.
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1500], ["Jan 4", 1500]);
    const benchmark = pf(["Jan 2", 100], ["Jan 3", 100], ["Jan 4", 100]);

    const out = rebaseBenchmarkContrib(portfolio, benchmark, deltas(["Jan 3", 500]));
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 2")).toBeCloseTo(1000); // anchor lump (10 units)
    expect(byD.get("Jan 3")).toBeCloseTo(1500); // +5 units → 15 units × 100
    expect(byD.get("Jan 4")).toBeCloseTo(1500);
  });

  it("compounds the deposit at the benchmark's later return", () => {
    // Anchor lump 10 units @100. +500 on Jan 3 buys 5 units @100 → 15 units.
    // Jan 4 price 110 → 15 × 110 = 1650 (vs lump-only 10 × 110 = 1100).
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 1500], ["Jan 4", 1650]);
    const benchmark = pf(["Jan 2", 100], ["Jan 3", 100], ["Jan 4", 110]);

    const out = rebaseBenchmarkContrib(portfolio, benchmark, deltas(["Jan 3", 500]));
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 4")).toBeCloseTo(1650);
    // Higher than the lump-sum line, which ignores the deposit.
    const lump = new Map(rebaseBenchmark(portfolio, benchmark)?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 4") as number).toBeGreaterThan(lump.get("Jan 4") as number);
  });

  it("sells units on a withdrawal (negative delta)", () => {
    // Anchor 10 units @100. −300 on Jan 3 sells 3 units → 7 units. Jan 4 @100 → 700.
    const portfolio = pf(["Jan 2", 1000], ["Jan 3", 700], ["Jan 4", 700]);
    const benchmark = pf(["Jan 2", 100], ["Jan 3", 100], ["Jan 4", 100]);

    const out = rebaseBenchmarkContrib(portfolio, benchmark, deltas(["Jan 3", -300]));
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 3")).toBeCloseTo(700);
    expect(byD.get("Jan 4")).toBeCloseTo(700);
  });

  it("ignores deltas at/before the anchor (the lump already reflects them)", () => {
    // Benchmark starts Jan 3, so the anchor is Jan 3. A delta on Jan 2 (pre-anchor)
    // must not be applied; the anchor lump is the portfolio's Jan 3 value.
    const portfolio = pf(["Jan 2", 800], ["Jan 3", 1000], ["Jan 4", 1000]);
    const benchmark = pf(["Jan 3", 100], ["Jan 4", 100]);

    const out = rebaseBenchmarkContrib(portfolio, benchmark, deltas(["Jan 2", 200]));
    const byD = new Map(out?.map((p) => [p.d, p.v]));
    expect(byD.get("Jan 2")).toBeNull(); // pre-anchor gap
    expect(byD.get("Jan 3")).toBeCloseTo(1000); // anchor lump, delta NOT re-added
    expect(byD.get("Jan 4")).toBeCloseTo(1000);
  });

  it("returns null for the same empty / zero-base cases as rebaseBenchmark", () => {
    expect(rebaseBenchmarkContrib([], pf(["Jan 2", 100]), deltas())).toBeNull();
    expect(rebaseBenchmarkContrib(pf(["Jan 2", 1000]), null, deltas())).toBeNull();
    expect(rebaseBenchmarkContrib(pf(["Jan 2", 1000]), pf(["Jan 2", 0]), deltas())).toBeNull();
  });
});
