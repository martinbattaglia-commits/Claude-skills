import { describe, expect, it } from "vitest";
import type { FundPortfolioRow } from "@/lib/db/queries/fund-enrichment";
import { buildPortfolioDisplayRows, buildPortfolioGroups } from "./portfolio-display";

// Minimal row factory — only the fields the transform reads matter.
function row(p: Partial<FundPortfolioRow> & { id: number }): FundPortfolioRow {
  return {
    id: p.id,
    projId: "M0257_2564",
    period: "202603.0",
    asOfDate: "2026-03-31",
    assetliabId: p.assetliabId ?? null,
    assetliabDesc: p.assetliabDesc ?? null,
    issueCode: p.issueCode ?? null,
    isinCode: p.isinCode ?? null,
    issuer: p.issuer ?? null,
    assetliabValue: p.assetliabValue ?? null,
    percentNav: p.percentNav ?? null,
    lastUpdDate: null,
    resolvedSymbol: p.resolvedSymbol ?? null,
  };
}

describe("buildPortfolioDisplayRows — label leads with the security identity", () => {
  it("uses the ticker (issue_code) when the row has an ISIN — not the generic category", () => {
    const [r] = buildPortfolioDisplayRows([
      row({
        id: 1,
        assetliabDesc: "หน่วยลงทุนของกองทุนแบบอื่นๆ",
        issueCode: "EWT US",
        isinCode: "US46434G7723",
        issuer: "BlackRock Fund Advisors",
        percentNav: 19.14,
      }),
    ]);
    expect(r.label).toBe("EWT US"); // ticker, not "หน่วยลงทุน…"
    expect(r.issuer).toBe("BlackRock Fund Advisors"); // secondary line
    expect(r.category).toBe("หน่วยลงทุนของกองทุนแบบอื่นๆ"); // category for the group header
    expect(r.isin).toBe("US46434G7723");
  });

  it("uses the issuer when there's no ISIN (a deposit reads as its bank), and drops the duplicate secondary", () => {
    const [r] = buildPortfolioDisplayRows([
      row({
        id: 1,
        assetliabId: "216",
        assetliabDesc: "เงินฝากธนาคารประเภทออมทรัพย์",
        issueCode: "C277874086_AO", // internal code — not a good name
        issuer: "KASIKORNBANK PCL.",
        percentNav: 1.63,
      }),
    ]);
    expect(r.label).toBe("KASIKORNBANK PCL.");
    expect(r.issuer).toBeNull(); // would just repeat the label
    expect(r.category).toBe("เงินฝากธนาคารประเภทออมทรัพย์");
  });

  it("exposes resolvedSymbol on a single US-listed line (the master ETF drills in)", () => {
    const [r] = buildPortfolioDisplayRows([
      row({
        id: 1,
        assetliabDesc: "หน่วยลงทุนของกองทุนตราสารทุน",
        issueCode: "US46138G6492",
        isinCode: "US46138G6492",
        issuer: "Invesco Capital Management LLC.",
        percentNav: 102.63,
        resolvedSymbol: "QQQM",
      }),
    ]);
    expect(r.resolvedSymbol).toBe("QQQM");
  });

  it("nulls resolvedSymbol on a collapsed group even if a member resolves (a ladder isn't openable)", () => {
    const [r] = buildPortfolioDisplayRows([
      row({ id: 1, issuer: "X Bank", assetliabDesc: "PN", percentNav: 1, resolvedSymbol: "AAA" }),
      row({ id: 2, issuer: "X Bank", assetliabDesc: "PN", percentNav: 1, resolvedSymbol: "AAA" }),
    ]);
    expect(r.members).toHaveLength(2);
    expect(r.resolvedSymbol).toBeNull();
  });

  it("falls back to the issue_code for an anonymous single row (no issuer/ISIN)", () => {
    const [r] = buildPortfolioDisplayRows([
      row({ id: 1, assetliabDesc: "สัญญาฟอร์เวิร์ด", issueCode: "FWTHBUSD26N20C", percentNav: -0.1 }),
    ]);
    expect(r.label).toBe("FWTHBUSD26N20C");
    expect(r.category).toBe("สัญญาฟอร์เวิร์ด");
    expect(r.members).toBeUndefined();
  });
});

describe("buildPortfolioDisplayRows — collapse still folds near-identical rows", () => {
  it("collapses an anonymous FX-forward ladder into one net row (no category in the label)", () => {
    const out = buildPortfolioDisplayRows([
      row({ id: 1, assetliabDesc: "สัญญาฟอร์เวิร์ด", issueCode: "CFX1", percentNav: -0.32 }),
      row({ id: 2, assetliabDesc: "สัญญาฟอร์เวิร์ด", issueCode: "CFX2", percentNav: -0.31 }),
      row({ id: 3, assetliabDesc: "สัญญาฟอร์เวิร์ด", issueCode: "CFX3", percentNav: 0.12 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Net · 3"); // category lives in the group header
    expect(out[0].percentNav).toBeCloseTo(-0.51);
    expect(out[0].members).toHaveLength(3);
  });

  it("collapses NAMED rows sharing an issuer + desc, labelling by the shared issuer", () => {
    const out = buildPortfolioDisplayRows([
      row({ id: 1, assetliabDesc: "PN Term", issuer: "UNIQUE ENGINEERING", percentNav: 0.8 }),
      row({ id: 2, assetliabDesc: "PN Term", issuer: "UNIQUE ENGINEERING", percentNav: 0.9 }),
      row({ id: 3, assetliabDesc: "PN Term", issuer: "UNIQUE ENGINEERING", percentNav: 0.67 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("UNIQUE ENGINEERING (net · 3)");
    expect(out[0].percentNav).toBeCloseTo(2.37);
    expect(out[0].members).toHaveLength(3);
  });

  it("keeps a feeder's single master ETF as one non-collapsed row", () => {
    const out = buildPortfolioDisplayRows([
      row({
        id: 1,
        assetliabDesc: "หน่วยลงทุน",
        issueCode: "MSAIOPZLX",
        isinCode: "LU1378878604",
        issuer: "Morgan Stanley",
        percentNav: 99.5,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("MSAIOPZLX");
    expect(out[0].members).toBeUndefined();
  });
});

describe("buildPortfolioGroups — buckets by category, biggest exposure first", () => {
  it("groups holdings under their category with a summed weight, sorted by total", () => {
    const groups = buildPortfolioGroups([
      row({ id: 1, assetliabDesc: "เงินฝากธนาคาร", issuer: "Kasikornbank", percentNav: 1.63 }),
      row({
        id: 2,
        assetliabDesc: "หน่วยลงทุน",
        issueCode: "EWT US",
        isinCode: "US46434G7723",
        issuer: "BlackRock",
        percentNav: 19.14,
      }),
      row({
        id: 3,
        assetliabDesc: "หน่วยลงทุน",
        issueCode: "EWY US",
        isinCode: "US4642867729",
        issuer: "BlackRock",
        percentNav: 17.77,
      }),
    ]);

    expect(groups.map((g) => g.category)).toEqual(["หน่วยลงทุน", "เงินฝากธนาคาร"]);
    expect(groups[0].totalPct).toBeCloseTo(36.91); // 19.14 + 17.77
    expect(groups[0].rows.map((r) => r.label)).toEqual(["EWT US", "EWY US"]); // tickers, weight desc
    expect(groups[1].rows[0].label).toBe("Kasikornbank");
  });
});
