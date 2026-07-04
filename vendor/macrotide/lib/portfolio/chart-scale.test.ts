import { describe, expect, it } from "vitest";
import { canLogScale, FULLY_OUT_THB, isFullyOut } from "./chart-scale";

describe("isFullyOut", () => {
  it("treats ~฿0 (fully divested) as out, real value as in", () => {
    expect(isFullyOut(0)).toBe(true);
    expect(isFullyOut(FULLY_OUT_THB / 2)).toBe(true);
    expect(isFullyOut(1)).toBe(false);
    expect(isFullyOut(4_500_000)).toBe(false);
  });
});

describe("canLogScale", () => {
  it("is true when at least one point is a real positive value", () => {
    // A book that was fully out mid-history (the #245 case): the zeros become
    // gaps, the positive points still draw, so a log axis is valid.
    expect(canLogScale([1000, 1200, 0, 0, 1500, 4_500_000])).toBe(true);
  });

  it("is false when every point is ~฿0 (nothing to draw on a ratio axis)", () => {
    expect(canLogScale([0, 0, 0])).toBe(false);
    expect(canLogScale([])).toBe(false);
  });
});
