import { describe, expect, it } from "vitest";
import type { AssetClass } from "@/lib/static/types";
import { holdingColor, riskRampIndex, riskSpectrumColor } from "./risk-palette";

const parseOklch = (s: string) => {
  const m = s.match(/^oklch\((\d*\.?\d+) (\d*\.?\d+) (\d+)\)$/);
  if (!m) throw new Error(`not an oklch() string: ${s}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
};

const RS_CODES = ["RS1", "RS2", "RS3", "RS4", "RS5", "RS6", "RS7", "RS8", "RS81"];
const TICKERS = ["VOO", "VTI", "QQQ", "SET50", "K-EQUITY", "SCBSET", "TGOLD", "1DIV"];

describe("riskRampIndex", () => {
  it("maps RS1…RS8 to 0…7", () => {
    for (let n = 1; n <= 8; n++) expect(riskRampIndex(`RS${n}`)).toBe(n - 1);
  });

  it("treats RS81 / RS8+ as the hottest stop (8), above RS8", () => {
    expect(riskRampIndex("RS81")).toBe(8);
    expect(riskRampIndex("RS8+")).toBe(8);
    expect(riskRampIndex("RS81")).toBeGreaterThan(riskRampIndex("RS8") as number);
  });

  it("puts RS5 squarely in the middle (mixed/balanced), not a fallback", () => {
    expect(riskRampIndex("RS5")).toBe(4);
  });

  it("returns null for missing/unrecognized codes", () => {
    expect(riskRampIndex(null)).toBeNull();
    expect(riskRampIndex(undefined)).toBeNull();
    expect(riskRampIndex("")).toBeNull();
    expect(riskRampIndex("RS9")).toBeNull();
    expect(riskRampIndex("banana")).toBeNull();
  });

  it("is case/whitespace tolerant", () => {
    expect(riskRampIndex("rs6")).toBe(5);
    expect(riskRampIndex(" RS6 ")).toBe(5);
  });
});

describe("base ramp (riskSpectrumColor) — the un-jittered tone centers", () => {
  it("warms monotonically RS1→RS8+ (hue strictly falls 250°→10°)", () => {
    const hues = RS_CODES.map((c) => parseOklch(riskSpectrumColor(c)).h);
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeLessThan(hues[i - 1]);
  });

  it("pins the arc endpoints (RS1 bluest, RS81 reddest)", () => {
    expect(riskSpectrumColor("RS1")).toBe("oklch(0.55 0.1 250)");
    expect(riskSpectrumColor("RS81")).toBe("oklch(0.55 0.1 10)");
  });

  it("returns the neutral grey for unknown codes", () => {
    expect(riskSpectrumColor(null)).toBe("oklch(0.62 0.02 250)");
  });
});

describe("holdingColor — risk drives the band center", () => {
  it("for one fund, a higher RS never reads cooler (centers stay ordered)", () => {
    // Same ticker → same jitter offset, so the band centers keep their order
    // even though different funds' bands overlap.
    const hues = RS_CODES.map(
      (rs) => parseOklch(holdingColor({ class: "equity", ticker: "X", riskSpectrum: rs })).h,
    );
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeLessThanOrEqual(hues[i - 1]);
  });

  it("RS code overrides asset class (a cash fund tagged RS8 reads warm)", () => {
    const hot = parseOklch(holdingColor({ class: "cash", ticker: "X", riskSpectrum: "RS8" })).h;
    expect(hot).toBeLessThan(120); // warm half, not the cool cash blue (~250)
  });
});

describe("holdingColor — asset-class fallback when no RS code", () => {
  it("colors each class by its representative ramp center, cool→hot", () => {
    const hue = (cls: AssetClass) => parseOklch(holdingColor({ class: cls, ticker: "Z" })).h;
    expect(hue("cash")).toBeGreaterThan(hue("bond"));
    expect(hue("bond")).toBeGreaterThan(hue("equity"));
    expect(hue("equity")).toBeGreaterThan(hue("alternative"));
  });

  it("unknown sits off-ramp as a near-neutral grey", () => {
    const { c } = parseOklch(holdingColor({ class: "unknown", ticker: "Z" }));
    expect(c).toBeLessThanOrEqual(0.03);
  });
});

describe("holdingColor — mechanics", () => {
  it("is deterministic", () => {
    const a = holdingColor({ class: "equity", ticker: "VOO", riskSpectrum: "RS6" });
    const b = holdingColor({ class: "equity", ticker: "VOO", riskSpectrum: "RS6" });
    expect(a).toBe(b);
  });

  it("always stays on the palette arc — never wraps to magenta/purple", () => {
    // The key 'keep tone' guarantee: however wide the band, hue ∈ [10, 250].
    for (const rs of [...RS_CODES, null]) {
      for (const cls of ["cash", "bond", "equity", "alternative", "unknown"] as AssetClass[]) {
        for (const ticker of TICKERS) {
          const { h } = parseOklch(holdingColor({ class: cls, ticker, riskSpectrum: rs }));
          expect(h).toBeGreaterThanOrEqual(10);
          expect(h).toBeLessThanOrEqual(250);
        }
      }
    }
  });

  it("keeps lightness in the legible band and varies it by ticker", () => {
    const lights = TICKERS.map((t) => parseOklch(holdingColor({ class: "equity", ticker: t })).l);
    for (const l of lights) {
      expect(l).toBeGreaterThanOrEqual(0.5);
      expect(l).toBeLessThanOrEqual(0.62);
    }
    expect(new Set(lights).size).toBeGreaterThan(1);
  });

  it("spreads same-level funds across the band (distinct hues per ticker)", () => {
    const hues = TICKERS.map(
      (t) => parseOklch(holdingColor({ class: "equity", ticker: t, riskSpectrum: "RS6" })).h,
    );
    expect(new Set(hues).size).toBeGreaterThan(1);
  });

  it("never throws on an empty ticker", () => {
    expect(() => holdingColor({ class: "equity", ticker: "" })).not.toThrow();
  });
});
