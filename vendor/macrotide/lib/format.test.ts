import { describe, expect, it } from "vitest";
import { fmtPct } from "./format";

describe("fmtPct — adaptive precision", () => {
  it("keeps 2 decimals under 1%", () => {
    expect(fmtPct(0.24)).toBe("+0.24%");
    expect(fmtPct(-0.2)).toBe("-0.20%");
  });

  it("keeps 1 decimal from 1% to under 100%", () => {
    expect(fmtPct(32.66)).toBe("+32.7%");
    expect(fmtPct(1)).toBe("+1.0%");
    expect(fmtPct(-12.34)).toBe("-12.3%");
  });

  it("drops to 0 decimals at 100% and above (no false precision)", () => {
    expect(fmtPct(240.7)).toBe("+241%");
    expect(fmtPct(-100)).toBe("-100%");
  });

  it("always carries a leading sign", () => {
    expect(fmtPct(0)).toBe("+0.00%");
    expect(fmtPct(5)).toBe("+5.0%");
  });

  it("honors an explicit decimals override", () => {
    expect(fmtPct(32.66, 2)).toBe("+32.66%");
    expect(fmtPct(5, 0)).toBe("+5%");
  });
});
