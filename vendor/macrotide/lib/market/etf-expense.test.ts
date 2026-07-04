import { describe, expect, it } from "vitest";
import { parseExpenseRatio } from "./etf-expense";

// Mirrors the 485BPOS extracted XBRL instance: oef:ExpensesOverAssets per class,
// keyed by a contextRef embedding seriesId + classId (VOO's ETF class verified live).
const XBRL = `
<xbrl>
  <oef:ExpensesOverAssets contextRef="ETFProspectusMember_S000002839_C000092055" unitRef="pure" decimals="4">0.0003</oef:ExpensesOverAssets>
  <oef:ManagementFeesOverAssets contextRef="ETFProspectusMember_S000002839_C000092055">0.0002</oef:ManagementFeesOverAssets>
  <oef:ExpensesOverAssets contextRef="ProspectusMember_S000099999_C000099999">0.0075</oef:ExpensesOverAssets>
</xbrl>`;

describe("parseExpenseRatio", () => {
  it("picks the ExpensesOverAssets for the matching series + class", () => {
    expect(parseExpenseRatio(XBRL, "S000002839", "C000092055")).toBe(0.0003);
  });

  it("falls back to a series-only context when the class isn't present", () => {
    const xml = `<oef:ExpensesOverAssets contextRef="Series_S000002839_X">0.0009</oef:ExpensesOverAssets>`;
    expect(parseExpenseRatio(xml, "S000002839", "C000000000")).toBe(0.0009);
  });

  it("normalises a percent that slipped through (value > 1)", () => {
    const xml = `<oef:ExpensesOverAssets contextRef="c_S000002839_C000092055">0.03%</oef:ExpensesOverAssets>`;
    // "0.03%" → 0.03 (not >1, stays) — but a bare "3" would be treated as 3% → 0.03
    expect(parseExpenseRatio(xml, "S000002839", "C000092055")).toBeCloseTo(0.03, 5);
    const pct = `<oef:ExpensesOverAssets contextRef="c_S000002839_C000092055">3</oef:ExpensesOverAssets>`;
    expect(parseExpenseRatio(pct, "S000002839", "C000092055")).toBeCloseTo(0.03, 5);
  });

  it("returns null when the series isn't found", () => {
    expect(parseExpenseRatio(XBRL, "S000000000", "C000000000")).toBeNull();
  });
});
