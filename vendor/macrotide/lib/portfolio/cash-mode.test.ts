import { describe, expect, it } from "vitest";
import type { CashDecomp, SeriesPoint } from "@/lib/static/types";
import { applyCashMode, returnValue, uninvestedCash } from "./cash-mode";

const sp = (pairs: [string, number][]): SeriesPoint[] => pairs.map(([d, v]) => ({ d, v }));

// A book: ฿1,000 in funds + ฿500 held cash (฿200 reserved) + ฿300 in-transit
// settlement cash (a fund switch mid-flight). Total value = ฿1,800.
const decomp: CashDecomp = {
  // All cash = held (500) + in-transit float (300) — for the Mix composition.
  cashValue: sp([
    ["2026-01-01", 800],
    ["2026-02-01", 800],
  ]),
  // Held cash accounts only — the "Funds only" exclusion slice (excludes the float).
  heldCashValue: sp([
    ["2026-01-01", 500],
    ["2026-02-01", 500],
  ]),
  reservedCashValue: sp([
    ["2026-01-01", 200],
    ["2026-02-01", 200],
  ]),
  // In-transit float carries no contribution; cash contrib = the held-cash events.
  cashContrib: sp([
    ["2026-01-01", 500],
    ["2026-02-01", 500],
  ]),
  reservedCashContrib: sp([
    ["2026-01-01", 200],
    ["2026-02-01", 200],
  ]),
};

const value = sp([
  ["2026-01-01", 1700],
  ["2026-02-01", 1800],
]);
const netInvested = sp([
  ["2026-01-01", 1500],
  ["2026-02-01", 1500],
]);

describe("applyCashMode", () => {
  it("incl. cash keeps non-reserved cash, drops only reserved", () => {
    const { series, netInvested: contrib } = applyCashMode("incl", value, netInvested, decomp);
    // 1800 − 200 reserved = 1600 value; 1500 − 200 reserved = 1300 contrib.
    expect(series.at(-1)?.v).toBe(1600);
    expect(contrib.at(-1)?.v).toBe(1300);
  });

  it("funds only drops held cash but KEEPS in-transit settlement float", () => {
    const { series, netInvested: contrib } = applyCashMode("funds", value, netInvested, decomp);
    // 1800 − 500 held cash = 1300 value (the ฿300 in-transit float stays — a switch
    // is not idle cash); 1500 − 500 held-cash contrib = 1000 contrib.
    expect(series.at(-1)?.v).toBe(1300);
    expect(contrib.at(-1)?.v).toBe(1000);
  });

  it("passes inputs through unchanged when there's no decomposition", () => {
    const { series, netInvested: contrib } = applyCashMode("funds", value, netInvested, undefined);
    expect(series).toEqual(value);
    expect(contrib).toEqual(netInvested);
  });

  it("treats a missing contribution line as empty", () => {
    const { netInvested: contrib } = applyCashMode("incl", value, undefined, decomp);
    expect(contrib).toEqual([]);
  });
});

describe("returnValue", () => {
  it("removes reserved cash in incl. mode and held cash in funds mode", () => {
    expect(returnValue("incl", 1800, decomp)).toBe(1600);
    expect(returnValue("funds", 1800, decomp)).toBe(1300);
  });
  it("returns the full value when there's no decomposition", () => {
    expect(returnValue("funds", 1800, undefined)).toBe(1800);
  });
});

describe("uninvestedCash", () => {
  it("is held cash minus reserved (excludes in-transit float)", () => {
    // held 500 − reserved 200 = 300; the ฿300 in-transit float is NOT idle cash.
    expect(uninvestedCash(decomp)).toBe(300);
  });
  it("is zero without a decomposition", () => {
    expect(uninvestedCash(undefined)).toBe(0);
  });
});
