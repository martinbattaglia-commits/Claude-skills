import { describe, expect, it } from "vitest";
import type { Holding } from "@/lib/static/types";
import {
  holdingCategoryLabel,
  holdingGeography,
  holdingKind,
  translateThaiPolicy,
} from "./holding-taxonomy";

function h(p: Partial<Holding>): Holding {
  return {
    ticker: "X",
    name: "X",
    category: "",
    class: "unknown",
    region: "",
    value: 0,
    cost: 0,
    units: 0,
    nav: 0,
    d1: 0,
    ytd: 0,
    y1: 0,
    ter: null,
    source: "",
    ...p,
  };
}

describe("holdingKind — structure chip", () => {
  it("labels a Thai fund, a US ETF, and a US stock", () => {
    expect(holdingKind(h({ quoteSource: "thai_mutual_fund" }))).toBe("Fund");
    expect(holdingKind(h({ quoteSource: "market", instrumentType: "etf" }))).toBe("ETF");
    expect(holdingKind(h({ quoteSource: "market", instrumentType: "stock" }))).toBe("Stock");
  });

  it("labels cash as one type (reserved is a status marker, not a kind)", () => {
    expect(holdingKind(h({ quoteSource: "cash" }))).toBe("Cash");
  });

  it("shows no chip for a custom asset or an unresolved US holding", () => {
    expect(holdingKind(h({ quoteSource: "manual" }))).toBeNull();
    // A market holding the catalog hasn't typed yet gets no guessed chip.
    expect(holdingKind(h({ quoteSource: "market", instrumentType: null }))).toBeNull();
  });
});

describe("translateThaiPolicy — SEC policy families to English", () => {
  it("maps the canonical families", () => {
    expect(translateThaiPolicy("ตราสารทุน")).toBe("Equity");
    expect(translateThaiPolicy("ตราสารหนี้")).toBe("Fixed Income");
    expect(translateThaiPolicy("ผสม")).toBe("Mixed");
    expect(translateThaiPolicy("ทรัพย์สินทางเลือก")).toBe("Alternative");
    expect(translateThaiPolicy("อื่น ๆ")).toBe("Other");
  });

  it("collapses a verbose ผสม (…) variant to Mixed by its prefix", () => {
    expect(translateThaiPolicy("ผสม (ไม่กำหนดสัดส่วนการลงทุนในตราสารหนี้; ไม่กำหนดสัดส่วนการลงทุนอื่นๆ)")).toBe(
      "Mixed",
    );
    expect(translateThaiPolicy("ผสมแบบไม่กำหนดสัดส่วนการลงทุนในตราสารแห่งทุน")).toBe("Mixed");
  });

  it("returns null for a non-policy string", () => {
    expect(translateThaiPolicy("Global Tech")).toBeNull();
    expect(translateThaiPolicy("")).toBeNull();
    expect(translateThaiPolicy(null)).toBeNull();
  });
});

describe("holdingCategoryLabel — structure-free, translated", () => {
  it("translates a Thai fund's policy to English", () => {
    expect(holdingCategoryLabel(h({ quoteSource: "thai_mutual_fund", category: "ตราสารทุน" }))).toBe(
      "Equity",
    );
    expect(holdingCategoryLabel(h({ quoteSource: "thai_mutual_fund", category: "ผสม" }))).toBe(
      "Mixed",
    );
  });

  it("keeps a non-policy Thai category as-is (e.g. a mock English label)", () => {
    expect(
      holdingCategoryLabel(h({ quoteSource: "thai_mutual_fund", category: "Global Equity" })),
    ).toBe("Global Equity");
  });

  it("labels a US holding by asset class — never asserting exposure geography", () => {
    // A single stock is equity by definition (the chip already says Stock).
    expect(
      holdingCategoryLabel(
        h({
          quoteSource: "market",
          instrumentType: "stock",
          class: "equity",
          category: "US Stock",
        }),
      ),
    ).toBe("Equity");
    // A US bond ETF reads its class, no "US".
    expect(
      holdingCategoryLabel(h({ quoteSource: "market", instrumentType: "etf", class: "bond" })),
    ).toBe("Fixed Income");
    // A US-LISTED international equity ETF must NOT read "US Equity" — just its class,
    // since the catalog only knows the listing country, not the exposure.
    expect(
      holdingCategoryLabel(
        h({
          quoteSource: "market",
          instrumentType: "etf",
          class: "equity",
          region: "United States",
        }),
      ),
    ).toBe("Equity");
  });

  it("is empty for cash — the chip carries the Cash/Reserved type, not line 2", () => {
    expect(holdingCategoryLabel(h({ quoteSource: "cash", category: "Cash" }))).toBe("");
    expect(holdingCategoryLabel(h({ quoteSource: "cash", category: "Money Market" }))).toBe("");
  });

  it("is empty for a US ETF the catalog hasn't asset-classed yet (the chip still says ETF)", () => {
    expect(
      holdingCategoryLabel(h({ quoteSource: "market", instrumentType: "etf", class: "unknown" })),
    ).toBe("");
  });
});

describe("holdingGeography — confidence-tiered exposure region", () => {
  it("a single US stock is US exposure", () => {
    expect(
      holdingGeography(h({ quoteSource: "market", instrumentType: "stock", ticker: "AAPL" })),
    ).toBe("US");
  });

  it("maps known index ETFs to their exposure region, regardless of asset class", () => {
    const etf = (ticker: string) => h({ quoteSource: "market", instrumentType: "etf", ticker });
    expect(holdingGeography(etf("VOO"))).toBe("US");
    expect(holdingGeography(etf("BND"))).toBe("US"); // US bonds are US exposure
    expect(holdingGeography(etf("VXUS"))).toBe("Intl");
    expect(holdingGeography(etf("VWO"))).toBe("EM");
    expect(holdingGeography(etf("VT"))).toBe("Global");
    // Case-insensitive on the ticker.
    expect(holdingGeography(etf("voo"))).toBe("US");
  });

  it("covers the broadened ETF universe across regions", () => {
    const geo = (ticker: string) =>
      holdingGeography(h({ quoteSource: "market", instrumentType: "etf", ticker }));
    // US equity, US bonds, US REIT/sector
    expect(geo("VNQ")).toBe("US");
    expect(geo("JEPI")).toBe("US");
    expect(geo("SGOV")).toBe("US");
    // Developed international incl. single-country + intl bonds
    expect(geo("VGK")).toBe("Intl");
    expect(geo("EWJ")).toBe("Intl");
    expect(geo("BNDX")).toBe("Intl");
    // Emerging markets incl. single-country (MSCI: Korea/Taiwan = EM)
    expect(geo("MCHI")).toBe("EM");
    expect(geo("EWY")).toBe("EM");
    // Global
    expect(geo("IOO")).toBe("Global");
    expect(geo("REET")).toBe("Global");
  });

  it("omits geography for an ETF not in the curated map (no guess)", () => {
    expect(
      holdingGeography(h({ quoteSource: "market", instrumentType: "etf", ticker: "OBSCURE" })),
    ).toBeNull();
  });

  it("uses a Thai fund's SEC region, omitting Mixed/unknown", () => {
    expect(holdingGeography(h({ quoteSource: "thai_mutual_fund", region: "Foreign" }))).toBe(
      "Foreign",
    );
    expect(holdingGeography(h({ quoteSource: "thai_mutual_fund", region: "Thailand" }))).toBe(
      "Thailand",
    );
    expect(holdingGeography(h({ quoteSource: "thai_mutual_fund", region: "Mixed" }))).toBeNull();
  });

  it("has no geography for cash or custom holdings", () => {
    expect(holdingGeography(h({ quoteSource: "cash" }))).toBeNull();
    expect(holdingGeography(h({ quoteSource: "manual" }))).toBeNull();
  });
});
