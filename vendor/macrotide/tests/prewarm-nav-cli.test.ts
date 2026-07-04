// Tests for the NAV pre-warm CLI script (issue #104).
//
// Coverage: the pure CLI-layer helpers — parseArgs and exceedsErrorThreshold.
// The crawl orchestration (prewarmNav) is covered in lib/jobs/prewarm-nav.test.ts;
// this file pins the arg parsing and the (more tolerant) exit-code policy.

import { describe, expect, it } from "vitest";
import { ERROR_FLOOR, ERROR_RATE, exceedsErrorThreshold, parseArgs } from "../scripts/prewarm-nav";

describe("parseArgs", () => {
  it("defaults to no limit, concurrency 6, range max, all classes", () => {
    expect(parseArgs([])).toEqual({ limit: 0, concurrency: 6, range: "max", retailOnly: false });
  });

  it("parses every flag", () => {
    expect(parseArgs(["--limit=500", "--concurrency=10", "--range=1mo", "--retail-only"])).toEqual({
      limit: 500,
      concurrency: 10,
      range: "1mo",
      retailOnly: true,
    });
  });

  it("ignores an unknown range and keeps the default", () => {
    expect(parseArgs(["--range=decade"]).range).toBe("max");
  });

  it("ignores malformed numeric flags", () => {
    expect(parseArgs(["--limit=abc", "--concurrency=0"])).toEqual({
      limit: 0,
      concurrency: 6, // 0 rejected (min 1)
      range: "max",
      retailOnly: false,
    });
  });
});

describe("exceedsErrorThreshold", () => {
  it("tolerates the expected slice of NAV-less active funds in a full run", () => {
    // ~150 of 2300 funds with no published NAV ≈ 6.5% < 20% → tolerate.
    expect(exceedsErrorThreshold(150, 2300)).toBe(false);
  });

  it("tolerates errors up to the floor regardless of rate", () => {
    expect(exceedsErrorThreshold(ERROR_FLOOR, ERROR_FLOOR)).toBe(false);
  });

  it("fails only when both above the floor and above the rate", () => {
    // 800 / 2000 = 40% > 35% and > floor → systemic outage, fail.
    expect(exceedsErrorThreshold(800, 2000)).toBe(true);
    // 600 / 2000 = 30% < 35% → tolerated (the expected NAV-less retail baseline).
    expect(exceedsErrorThreshold(600, 2000)).toBe(false);
  });

  it("requires BOTH — high count but low rate is tolerated", () => {
    expect(exceedsErrorThreshold(ERROR_FLOOR + 10, 100_000)).toBe(false);
  });

  it("requires BOTH — high rate but tiny count is tolerated (dev --limit run)", () => {
    expect(exceedsErrorThreshold(10, 12)).toBe(false);
  });

  it("guards seen=0", () => {
    expect(exceedsErrorThreshold(5, 0)).toBe(false);
  });

  it("rate boundary is strictly-greater", () => {
    expect(exceedsErrorThreshold(ERROR_RATE * 1000, 1000)).toBe(false);
    expect(exceedsErrorThreshold(ERROR_RATE * 1000 + 1, 1000)).toBe(true);
  });
});
