import { describe, expect, it } from "vitest";
import {
  classifyEtf,
  classifyEtfAssetClass,
  classifyEtfRegion,
  type EtfHoldingInput,
} from "./etf-classify";

const h = (
  assetCat: string | null,
  country: string | null,
  weightPct: number,
): EtfHoldingInput => ({
  assetCat,
  country,
  weightPct,
});

describe("classifyEtfAssetClass", () => {
  it("names the dominant class (mostly equity → equity)", () => {
    expect(
      classifyEtfAssetClass([h("Equity (common)", "US", 90), h("Short-term investment", "US", 5)]),
    ).toBe("equity");
  });

  it("rolls debt-like categories up to bond", () => {
    expect(
      classifyEtfAssetClass([
        h("Debt", "US", 60),
        h("Mortgage-backed", "US", 20),
        h("Rate derivative", "US", 15),
      ]),
    ).toBe("bond");
  });

  it("treats commodities and real estate as alternative", () => {
    expect(classifyEtfAssetClass([h("Commodity", null, 80), h("Real estate", "US", 10)])).toBe(
      "alternative",
    );
  });

  it("returns null for a genuinely blended fund (no class clears the majority bar)", () => {
    expect(classifyEtfAssetClass([h("Equity (common)", "US", 50), h("Debt", "US", 50)])).toBeNull();
  });

  it("ignores unmapped categories and zero/negative weights", () => {
    // Forward derivative is unmapped → contributes to nothing; equity is the only
    // classified weight and dominates.
    expect(
      classifyEtfAssetClass([
        h("Forward derivative", "US", 40),
        h("Equity (common)", "US", 30),
        h("Equity (common)", "US", 0),
      ]),
    ).toBe("equity");
  });

  it("returns null when nothing is classifiable", () => {
    expect(classifyEtfAssetClass([h(null, "US", 100)])).toBeNull();
    expect(classifyEtfAssetClass([])).toBeNull();
  });
});

describe("classifyEtfRegion", () => {
  it("names a dominant single region (US)", () => {
    expect(classifyEtfRegion([h("Equity (common)", "US", 95), h("Equity (common)", "JP", 3)])).toBe(
      "US",
    );
  });

  it("maps developed-ex-US countries to Intl", () => {
    expect(
      classifyEtfRegion([h("Equity (common)", "JP", 40), h("Equity (common)", "GB", 40)]),
    ).toBe("Intl");
  });

  it("maps emerging-market countries to EM", () => {
    expect(
      classifyEtfRegion([h("Equity (common)", "CN", 50), h("Equity (common)", "IN", 40)]),
    ).toBe("EM");
  });

  it("does not count Hong Kong as developed, so an EM fund still reads EM", () => {
    // HK holdings (Chinese issuers) are uncounted; TW+IN decide → EM. If HK were
    // counted as developed it would dilute EM below the dominance bar → Global.
    expect(
      classifyEtfRegion([
        h("Equity (common)", "TW", 20),
        h("Equity (common)", "HK", 11),
        h("Equity (common)", "IN", 4),
      ]),
    ).toBe("EM");
  });

  it("returns Global when no single region dominates", () => {
    expect(
      classifyEtfRegion([
        h("Equity (common)", "US", 55),
        h("Equity (common)", "JP", 30),
        h("Equity (common)", "CN", 15),
      ]),
    ).toBe("Global");
  });

  it("ignores unmapped countries when weighing dominance", () => {
    // An unknown country (XX) is excluded; the US share of CLASSIFIED weight is 100%.
    expect(
      classifyEtfRegion([h("Equity (common)", "US", 60), h("Equity (common)", "XX", 40)]),
    ).toBe("US");
  });

  it("returns null when no country is classifiable", () => {
    expect(classifyEtfRegion([h("Equity (common)", null, 100)])).toBeNull();
    expect(classifyEtfRegion([])).toBeNull();
  });
});

describe("classifyEtf", () => {
  it("derives both attributes in one pass", () => {
    expect(
      classifyEtf([h("Debt", "GB", 70), h("Debt", "FR", 25), h("Short-term investment", "US", 5)]),
    ).toEqual({ assetClass: "bond", exposureRegion: "Intl" });
  });
});
