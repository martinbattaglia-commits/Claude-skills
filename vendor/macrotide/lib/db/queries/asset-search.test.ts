import { describe, expect, it, vi } from "vitest";
import { type AssetSearchDeps, matchScore, searchAssets } from "./asset-search";
import type { findShareClasses } from "./funds";
import type { UsSecurity } from "./us-securities";

describe("matchScore", () => {
  it("ranks exact > ticker-prefix > name-prefix > contains > none", () => {
    expect(matchScore("aapl", "AAPL", "Apple Inc")).toBe(0);
    expect(matchScore("aap", "AAPL", "Apple Inc")).toBe(1);
    expect(matchScore("appl", "AAPL", "Apple Inc")).toBe(2); // name starts with "appl"
    expect(matchScore("ppl", "AAPL", "Apple Inc")).toBe(3); // contained, not a prefix
    expect(matchScore("xyz", "AAPL", "Apple Inc")).toBe(9);
  });

  it("scores 0 for an empty (idle) query", () => {
    expect(matchScore("", "AAPL", "Apple")).toBe(0);
  });
});

// Minimal fixtures cast to the finder return shapes (only fields searchAssets reads).
const thaiItem = (ticker: string, name: string, aum: number) =>
  ({
    ticker,
    englishName: name,
    thaiName: null,
    assetClass: "equity",
    ter: 0.5,
    aum,
    projId: `P-${ticker}`,
  }) as unknown as ReturnType<typeof findShareClasses>["items"][number];

const usRow = (
  symbol: string,
  name: string,
  securityType: "stock" | "etf",
  popularityScore = 0,
  viewCount = 0,
): UsSecurity =>
  ({
    symbol,
    name,
    securityType,
    exchange: "Nasdaq",
    ter: securityType === "etf" ? 0.0003 : null,
    gicsSector: "Information Technology",
    industry: null,
    assetClass: null,
    popularityScore,
    viewCount,
  }) as unknown as UsSecurity;

const deps = (thai: ReturnType<typeof thaiItem>[], us: UsSecurity[]): Partial<AssetSearchDeps> => ({
  findThai: vi.fn(() => ({
    items: thai,
    total: thai.length,
  })) as unknown as typeof findShareClasses,
  findUs: vi.fn(() => ({ items: us, total: us.length })),
});

describe("searchAssets", () => {
  it("merges both sources; an exact ticker match ranks first when searching", () => {
    const r = searchAssets(
      { query: "VOO", assetType: "all" },
      deps(
        [thaiItem("ASP-SP500", "SCB S&P 500 Index", 1_000_000_000)],
        [
          usRow("VOO", "Vanguard S&P 500 ETF", "etf", 0.9),
          usRow("VOOG", "Vanguard Growth ETF", "etf", 0.3),
        ],
      ),
    );
    expect(r.items[0].ticker).toBe("VOO"); // exact match (score 0)
    expect(r.items.map((i) => i.kind)).toContain("thai_fund");
    expect(r.total).toBe(3);
  });

  it("narrows to one source via the asset-type pill (US finder not called for 'thai')", () => {
    const d = deps([thaiItem("X", "X Fund", 1_000_000_000)], []);
    const r = searchAssets({ assetType: "thai" }, d);
    expect(d.findUs).not.toHaveBeenCalled();
    expect(r.items.every((i) => i.kind === "thai_fund")).toBe(true);
  });

  it("passes securityType=etf for the 'us_etf' pill", () => {
    const findUs = vi.fn(() => ({ items: [], total: 0 }));
    searchAssets(
      { assetType: "us_etf" },
      {
        findUs,
        findThai: vi.fn(() => ({ items: [], total: 0 })) as unknown as typeof findShareClasses,
      },
    );
    expect(findUs).toHaveBeenCalledWith(expect.objectContaining({ securityType: "etf" }));
  });

  it("keeps a source's relevance order over raw popularity when searching", () => {
    // The finder returns relevance order (a real match first, a popular-but-weak
    // alias match second). The merge must preserve that, not float the high-pop
    // junk to the top — the "sp500 surfaces unrelated funds" fix.
    const r = searchAssets(
      { query: "sp500", assetType: "us" },
      deps(
        [],
        [
          usRow("VOO", "Vanguard S&P 500 ETF", "etf", 0.2), // relevant, modest pop
          usRow("BWMX", "Betterware de Mexico", "stock", 0.9), // weak alias hit, high pop
        ],
      ),
    );
    expect(r.items[0].ticker).toBe("VOO");
  });

  it("idle (no query) ranks by popularity across sources", () => {
    const r = searchAssets(
      { assetType: "all" },
      deps([thaiItem("BIG", "Big Fund", 1_000_000_000_000)], [usRow("AAA", "Alpha", "stock", 0.1)]),
    );
    // The lone Thai fund normalises to pop 1.0; the US stock is 0.1 → Thai first.
    expect(r.items[0].kind).toBe("thai_fund");
  });
});
