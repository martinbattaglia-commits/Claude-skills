import { describe, expect, it } from "vitest";
import { filterKnownTickers, mergeWithHoldings, type TickerSuggestion } from "./known-holdings";

const sample: TickerSuggestion[] = [
  { ticker: "K-FIXED-A", name: "K Fixed Income Fund — A", quote_source: "thai_mutual_fund" },
  { ticker: "K-USA-A(A)", name: "K USA Equity Fund — A (Accum.)", quote_source: "thai_mutual_fund" },
  { ticker: "AAPL", name: "Apple Inc.", quote_source: "market" },
  { ticker: "MSFT", name: "Microsoft Corporation", quote_source: "market" },
  { ticker: "^GSPC", name: "S&P 500 Index", quote_source: "market" },
];

describe("filterKnownTickers", () => {
  it("returns the input unchanged (up to limit) on empty query", () => {
    expect(filterKnownTickers(sample, "")).toEqual(sample);
    expect(filterKnownTickers(sample, "   ")).toEqual(sample);
  });

  it("matches case-insensitively on ticker", () => {
    const out = filterKnownTickers(sample, "aapl");
    expect(out.map((e) => e.ticker)).toContain("AAPL");
  });

  it("matches case-insensitively on name", () => {
    const out = filterKnownTickers(sample, "apple");
    expect(out.map((e) => e.ticker)).toContain("AAPL");
  });

  it("matches partial ticker substrings", () => {
    const out = filterKnownTickers(sample, "FIXED");
    expect(out.map((e) => e.ticker)).toContain("K-FIXED-A");
  });

  it("ranks ticker-prefix matches above name-substring matches", () => {
    const out = filterKnownTickers(sample, "K");
    expect(out[0].ticker.startsWith("K")).toBe(true);
    expect(out[1].ticker.startsWith("K")).toBe(true);
  });

  it("honours the limit parameter", () => {
    expect(filterKnownTickers(sample, "", 2)).toHaveLength(2);
    expect(filterKnownTickers(sample, "a", 1)).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterKnownTickers(sample, "zzz-nonexistent")).toEqual([]);
  });

  it("surfaces holdings entries ahead of others within the same match tier", () => {
    const list: TickerSuggestion[] = [
      { ticker: "AAPL", name: "Apple Inc.", quote_source: "market" },
      {
        ticker: "APPLE-FUND",
        name: "Apple Fund",
        quote_source: "thai_mutual_fund",
        fromHoldings: true,
      },
    ];
    const out = filterKnownTickers(list, "apple");
    expect(out[0].ticker).toBe("APPLE-FUND");
  });
});

describe("mergeWithHoldings", () => {
  it("returns an empty list when no holdings are provided (no static seed)", () => {
    expect(mergeWithHoldings([])).toEqual([]);
  });

  it("maps each holding to a suggestion tagged fromHoldings", () => {
    const out = mergeWithHoldings([
      { ticker: "MY-FUND", englishName: "My Custom Fund", quoteSource: "thai_mutual_fund" },
    ]);
    expect(out[0]).toMatchObject({
      ticker: "MY-FUND",
      name: "My Custom Fund",
      quote_source: "thai_mutual_fund",
      fromHoldings: true,
    });
  });

  it("dedupes duplicate holdings tickers (case-insensitive, first wins)", () => {
    const out = mergeWithHoldings([
      { ticker: "K-FIXED-A", englishName: "First", quoteSource: "thai_mutual_fund" },
      { ticker: "k-fixed-a", englishName: "Second", quoteSource: "thai_mutual_fund" },
    ]);
    const matches = out.filter((e) => e.ticker.toUpperCase() === "K-FIXED-A");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("First");
  });

  it("preserves market and manual (custom) sources; narrows anything unrecognised to custom", () => {
    expect(mergeWithHoldings([{ ticker: "VOO", englishName: "ETF", quoteSource: "market" }])[0]
      .quote_source).toBe("market");
    expect(mergeWithHoldings([{ ticker: "GOLD", englishName: "Gold", quoteSource: "manual" }])[0]
      .quote_source).toBe("manual");
    expect(mergeWithHoldings([{ ticker: "WEIRD", englishName: "Weird", quoteSource: "x" }])[0]
      .quote_source).toBe("manual");
  });
});
