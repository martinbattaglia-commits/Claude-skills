// Unit tests for the holding "view details" fallback helpers — the pure logic
// behind FundDetailSheet's non-catalog-holding path. Synthetic holdings only.

import { describe, expect, it } from "vitest";
import { assetClassLabel, buildHoldingDetailRows } from "@/lib/portfolio/holding-detail";
import type { Holding } from "@/lib/static/types";

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 1,
    bucketId: "bucket-1",
    ticker: "EXAMPLE-STOCK",
    name: "Example Stock Inc",
    category: "US Equity",
    class: "equity",
    region: "US",
    value: 12345.67,
    cost: 10000,
    units: 100,
    nav: 0,
    d1: 0,
    ytd: 0,
    y1: 0,
    ter: 0.45,
    source: "Brokerage",
    quoteSource: "market",
    ...overrides,
  };
}

describe("assetClassLabel", () => {
  it("maps known asset classes to human labels", () => {
    expect(assetClassLabel("equity")).toBe("Equity");
    expect(assetClassLabel("bond")).toBe("Bond");
    expect(assetClassLabel("alternative")).toBe("Alternative");
    expect(assetClassLabel("cash")).toBe("Cash");
  });

  it("falls back to the raw value for an unknown class", () => {
    expect(assetClassLabel("crypto")).toBe("crypto");
  });
});

describe("buildHoldingDetailRows", () => {
  it("returns a stable, labelled set of rows", () => {
    const rows = buildHoldingDetailRows(makeHolding());
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      "Name",
      "Asset class",
      "Region",
      "Category",
      "Units",
      "Market value",
      "Avg cost",
      "TER",
      "Source",
    ]);
  });

  it("formats market value as rounded THB", () => {
    const rows = buildHoldingDetailRows(makeHolding({ value: 12345.67 }));
    const mv = rows.find((r) => r.label === "Market value");
    expect(mv?.value).toBe("฿12,346");
  });

  it("derives avg cost from cost / units", () => {
    const rows = buildHoldingDetailRows(makeHolding({ cost: 10000, units: 100 }));
    const avg = rows.find((r) => r.label === "Avg cost");
    expect(avg?.value).toBe("฿100");
  });

  it("shows avg cost as null when units are zero (avoids divide-by-zero)", () => {
    const rows = buildHoldingDetailRows(makeHolding({ cost: 10000, units: 0 }));
    const avg = rows.find((r) => r.label === "Avg cost");
    expect(avg?.value).toBeNull();
  });

  it("renders TER as a percentage and null when unpublished", () => {
    expect(
      buildHoldingDetailRows(makeHolding({ ter: 0.45 })).find((r) => r.label === "TER")?.value,
    ).toBe("0.45%");
    expect(
      buildHoldingDetailRows(makeHolding({ ter: null })).find((r) => r.label === "TER")?.value,
    ).toBeNull();
  });

  it("falls back to the ticker when the name is empty", () => {
    const rows = buildHoldingDetailRows(makeHolding({ name: "", ticker: "EXAMPLE-X" }));
    expect(rows.find((r) => r.label === "Name")?.value).toBe("EXAMPLE-X");
  });

  it("returns null values (not empty strings) for absent region/category/source", () => {
    const rows = buildHoldingDetailRows(makeHolding({ region: "", category: "", source: "" }));
    expect(rows.find((r) => r.label === "Region")?.value).toBeNull();
    expect(rows.find((r) => r.label === "Category")?.value).toBeNull();
    expect(rows.find((r) => r.label === "Source")?.value).toBeNull();
  });
});
