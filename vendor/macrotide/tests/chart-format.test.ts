// Unit tests for the chart date/return helpers used by NavChart (interactive
// performance chart). These are pure functions over ISO dates + value series.

import { describe, expect, it } from "vitest";
import {
  formatDay,
  formatMonthYear,
  formatSeriesDate,
  formatTooltipDate,
  pickAxisTicks,
  seriesReturnPct,
} from "../lib/portfolio/adapter";

describe("date label formatters", () => {
  it("formatSeriesDate → MMM D", () => {
    expect(formatSeriesDate("2026-05-22")).toBe("May 22");
    expect(formatSeriesDate("2025-01-03")).toBe("Jan 3");
  });

  it("formatMonthYear → MMM 'yy", () => {
    expect(formatMonthYear("2026-05-22")).toBe("May '26");
    expect(formatMonthYear("2025-12-31")).toBe("Dec '25");
  });

  it("formatDay → bare day of month", () => {
    expect(formatDay("2026-05-22")).toBe("22");
    expect(formatDay("2026-05-06")).toBe("6");
  });

  it("formatTooltipDate → MMM D, YYYY", () => {
    expect(formatTooltipDate("2026-05-22")).toBe("May 22, 2026");
  });
});

describe("pickAxisTicks", () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ d: `2026-01-${String(i + 1).padStart(2, "0")}`, v: i }));

  it("returns every point when the series is short", () => {
    const s = series(4);
    expect(pickAxisTicks(s, 6)).toEqual(s.map((p) => p.d));
  });

  it("picks `count` ticks inset from both edges (none on the boundary)", () => {
    const ticks = pickAxisTicks(series(20), 6);
    expect(ticks).toHaveLength(6);
    // Inset: the first/last ticks are not the first/last data points, so edge
    // labels never sit on (and clip against) the chart boundary.
    expect(ticks[0]).not.toBe("2026-01-01");
    expect(ticks.at(-1)).not.toBe("2026-01-20");
    // Strictly increasing (evenly spaced, in order).
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] > ticks[i - 1]).toBe(true);
  });

  it("is empty for an empty series", () => {
    expect(pickAxisTicks([], 6)).toEqual([]);
  });
});

describe("seriesReturnPct", () => {
  it("computes first → last finite return", () => {
    expect(
      seriesReturnPct([
        { d: "a", v: 100 },
        { d: "b", v: 110 },
      ]),
    ).toBeCloseTo(10);
    expect(
      seriesReturnPct([
        { d: "a", v: 200 },
        { d: "b", v: 150 },
      ]),
    ).toBeCloseTo(-25);
  });

  it("ignores non-finite points at the ends", () => {
    expect(
      seriesReturnPct([
        { d: "a", v: Number.NaN },
        { d: "b", v: 100 },
        { d: "c", v: 120 },
        { d: "d", v: Number.NaN },
      ]),
    ).toBeCloseTo(20);
  });

  it("is null without two finite points", () => {
    expect(seriesReturnPct([])).toBeNull();
    expect(seriesReturnPct([{ d: "a", v: 100 }])).toBeNull();
    expect(
      seriesReturnPct([
        { d: "a", v: Number.NaN },
        { d: "b", v: 100 },
      ]),
    ).toBeNull();
  });

  it("is null when the start value is zero (can't divide)", () => {
    expect(
      seriesReturnPct([
        { d: "a", v: 0 },
        { d: "b", v: 100 },
      ]),
    ).toBeNull();
  });
});
