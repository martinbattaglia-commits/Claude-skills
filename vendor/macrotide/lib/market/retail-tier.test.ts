import { describe, expect, it } from "vitest";
import { browseTiers, isTierBuyable, RETAIL_TIER_BADGE, retailTier } from "./retail-tier";

describe("retailTier", () => {
  it("maps each SEC proj_retail_type code to its tier", () => {
    expect(retailTier("R")).toBe("retail");
    expect(retailTier("A")).toBe("accredited");
    expect(retailTier("B")).toBe("accredited");
    expect(retailTier("H")).toBe("accredited");
    expect(retailTier("X")).toBe("ultra");
    expect(retailTier("V")).toBe("provident");
    expect(retailTier("N")).toBe("institutional");
    expect(retailTier("F")).toBe("institutional");
  });

  it("falls back to retail for G (special), null, and unknown codes", () => {
    expect(retailTier("G")).toBe("retail");
    expect(retailTier(null)).toBe("retail");
    expect(retailTier(undefined)).toBe("retail");
    expect(retailTier("Z")).toBe("retail");
  });
});

describe("RETAIL_TIER_BADGE", () => {
  it("labels every non-retail tier and leaves retail unbadged", () => {
    expect(RETAIL_TIER_BADGE.retail).toBeNull();
    expect(RETAIL_TIER_BADGE.accredited).toBe("Accredited");
    expect(RETAIL_TIER_BADGE.ultra).toBe("Ultra");
    expect(RETAIL_TIER_BADGE.provident).toBe("Provident");
    expect(RETAIL_TIER_BADGE.institutional).toBe("Inst.");
  });
});

describe("browseTiers (exclusive filter)", () => {
  const set = (access?: Parameters<typeof browseTiers>[0]) => [...browseTiers(access)].sort();

  it("default (undefined) is the retail buy list only", () => {
    expect(set()).toEqual(["retail"]);
  });

  it("each restricted choice shows only that audience — not retail too", () => {
    expect(set("accredited")).toEqual(["accredited"]);
    expect(set("ultra")).toEqual(["ultra"]);
    expect(set("both")).toEqual(["accredited", "ultra"]);
  });

  it("never shows provident/institutional (no individual can subscribe)", () => {
    for (const a of [undefined, "accredited", "ultra", "both"] as const) {
      expect(set(a)).not.toContain("provident");
      expect(set(a)).not.toContain("institutional");
    }
  });
});

describe("isTierBuyable (search ranking)", () => {
  it("retail is never demoted, even with a restricted audience selected", () => {
    expect(isTierBuyable("retail")).toBe(true);
    expect(isTierBuyable("retail", "ultra")).toBe(true);
  });

  it("a restricted tier is buyable only when its access opts it in", () => {
    expect(isTierBuyable("accredited")).toBe(false);
    expect(isTierBuyable("accredited", "accredited")).toBe(true);
    expect(isTierBuyable("ultra", "ultra")).toBe(true);
    expect(isTierBuyable("ultra", "accredited")).toBe(false);
    expect(isTierBuyable("ultra", "both")).toBe(true);
  });

  it("provident/institutional are never buyable (no access choice opts them in)", () => {
    expect(isTierBuyable("provident", "both")).toBe(false);
    expect(isTierBuyable("institutional", "both")).toBe(false);
  });
});
