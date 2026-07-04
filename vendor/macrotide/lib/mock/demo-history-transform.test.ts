import { describe, expect, it } from "vitest";
import {
  buildHoldingSeries,
  downsampleVariable,
  type HistoryPoint,
  trackingWobble,
} from "./demo-history-transform";

/** Build a contiguous daily series of `days` business-ish days ending today-ish. */
function dailyRange(startIso: string, days: number): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    out.push({ date: d.toISOString().slice(0, 10), value: 100 + i });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("downsampleVariable", () => {
  it("keeps the recent window daily and thins the older window to weekly", () => {
    // 400 contiguous days; keep the most recent 30 daily, older → weekly.
    const daily = dailyRange("2025-01-01", 400);
    const out = downsampleVariable(daily, { maxDays: 4000, dailyDays: 30 });

    const latest = daily[daily.length - 1].date;
    const cut = new Date(`${latest}T00:00:00Z`);
    cut.setUTCDate(cut.getUTCDate() - 30);
    const cutIso = cut.toISOString().slice(0, 10);

    const recent = out.filter((p) => p.date >= cutIso);
    const older = out.filter((p) => p.date < cutIso);

    // Recent window keeps every day; older window is sparse (~1/week).
    expect(recent.length).toBeGreaterThanOrEqual(28);
    expect(older.length).toBeLessThan(daily.length - recent.length); // thinned
    expect(older.length).toBeGreaterThan(40); // ~370 days / 7 ≈ 52 weeks
    expect(older.length).toBeLessThan(60);
  });

  it("returns ascending, de-duplicated dates", () => {
    const daily = dailyRange("2025-01-01", 120);
    const out = downsampleVariable(daily, { maxDays: 4000, dailyDays: 30 });
    const dates = out.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toEqual(dates.length);
  });

  it("caps the total span to maxDays", () => {
    const daily = dailyRange("2020-01-01", 1000);
    const out = downsampleVariable(daily, { maxDays: 100, dailyDays: 30 });
    const latest = new Date(`${out[out.length - 1].date}T00:00:00Z`);
    const earliest = new Date(`${out[0].date}T00:00:00Z`);
    const spanDays = (latest.getTime() - earliest.getTime()) / 86400000;
    expect(spanDays).toBeLessThanOrEqual(100);
  });

  it("sorts unordered input", () => {
    const daily = [
      { date: "2025-03-03", value: 3 },
      { date: "2025-01-01", value: 1 },
      { date: "2025-02-02", value: 2 },
    ];
    const out = downsampleVariable(daily, { maxDays: 4000, dailyDays: 4000 });
    expect(out.map((p) => p.value)).toEqual([1, 2, 3]);
  });

  it("returns [] for empty input", () => {
    expect(downsampleVariable([], { maxDays: 4000, dailyDays: 30 })).toEqual([]);
  });
});

describe("trackingWobble", () => {
  it("is deterministic for the same key + index", () => {
    expect(trackingWobble("a:b", 3, 0.01)).toBe(trackingWobble("a:b", 3, 0.01));
  });

  it("stays within the amplitude bound", () => {
    for (let i = 0; i < 500; i++) {
      const w = trackingWobble("thai_mutual_fund:FUND-X", i, 0.02);
      expect(Math.abs(w)).toBeLessThanOrEqual(0.02);
    }
  });

  it("differs between two keys tracking the same index", () => {
    const a = Array.from({ length: 12 }, (_, i) => trackingWobble("k:A", i, 0.01));
    const b = Array.from({ length: 12 }, (_, i) => trackingWobble("k:B", i, 0.01));
    expect(a).not.toEqual(b);
  });
});

describe("buildHoldingSeries", () => {
  // A flat DAILY index spanning ~2 years, so the time-based fee drag has room.
  const flatIndex: HistoryPoint[] = (() => {
    const out: HistoryPoint[] = [];
    const d = new Date("2024-01-01T00:00:00Z");
    for (let i = 0; i < 500; i++) {
      out.push({ date: d.toISOString().slice(0, 10), value: 100 });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  })();

  it("scales so the last point equals the seeded current value", () => {
    const out = buildHoldingSeries({
      seedKey: "thai_mutual_fund:FUND-A",
      index: flatIndex,
      terPct: 1.0,
      currentValue: 50_000,
      wobbleAmp: 0,
    });
    expect(out.at(-1)?.value).toBe(50_000); // integer THB, exact
  });

  it("applies TER as a time-based compounding drag: flat index trends DOWN pre-rescale", () => {
    const out = buildHoldingSeries({
      seedKey: "k:FEE",
      index: flatIndex,
      terPct: 2.0,
      currentValue: 1000,
      wobbleAmp: 0,
    });
    expect(out[0].value).toBeGreaterThan(out.at(-1)?.value as number);
  });

  it("a higher-TER fund trails a lower-TER fund on the same index", () => {
    const common = { index: flatIndex, currentValue: 1_000_000, wobbleAmp: 0 };
    const cheap = buildHoldingSeries({ seedKey: "k:CHEAP", terPct: 0.2, ...common });
    const pricey = buildHoldingSeries({ seedKey: "k:PRICEY", terPct: 1.8, ...common });
    expect(pricey[0].value).toBeGreaterThan(cheap[0].value);
  });

  it("tracks an index that grows: output grows too", () => {
    const rising: HistoryPoint[] = flatIndex.map((p, i) => ({
      date: p.date,
      value: 100 * 1.0005 ** i,
    }));
    const out = buildHoldingSeries({
      seedKey: "k:RISE",
      index: rising,
      terPct: 0.5,
      currentValue: 2_000_000,
      wobbleAmp: 0,
    });
    expect(out[0].value).toBeLessThan(out.at(-1)?.value as number);
  });

  it("is deterministic across runs", () => {
    const args = {
      seedKey: "k:DET",
      index: flatIndex,
      terPct: 1.0,
      currentValue: 1_234_000,
      wobbleAmp: 0.01,
    };
    expect(buildHoldingSeries(args)).toEqual(buildHoldingSeries(args));
  });

  it("preserves the input dates (one output point per index point)", () => {
    const out = buildHoldingSeries({
      seedKey: "k:DATES",
      index: flatIndex,
      terPct: 1.0,
      currentValue: 1000,
      wobbleAmp: 0,
    });
    expect(out.map((p) => p.date)).toEqual(flatIndex.map((p) => p.date));
  });

  it("returns [] for an empty index", () => {
    expect(
      buildHoldingSeries({ seedKey: "k", index: [], terPct: 1, currentValue: 1, wobbleAmp: 0 }),
    ).toEqual([]);
  });
});
