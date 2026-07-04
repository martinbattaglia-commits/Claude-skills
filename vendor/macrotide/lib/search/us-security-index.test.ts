import { describe, expect, it } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { findUsSecurities, upsertUsSecurities } from "@/lib/db/queries/us-securities";
import { makeTestDbContext } from "@/tests/db-helpers";
import { searchUsSymbolsScored } from "./us-security-index";

const SEED = [
  { symbol: "AAPL", name: "Apple Inc. - Common Stock", securityType: "stock" as const },
  { symbol: "MSFT", name: "Microsoft Corporation - Common Stock", securityType: "stock" as const },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", securityType: "etf" as const },
  { symbol: "BND", name: "Vanguard Total Bond Market ETF", securityType: "etf" as const },
];

function withSeed<T>(fn: () => T): T {
  return runWithDbContext(makeTestDbContext(), () => {
    upsertUsSecurities(SEED, "2026-07-01T00:00:00Z");
    return fn();
  }) as T;
}

describe("US securities search (MiniSearch)", () => {
  it("ranks an exact symbol first", () => {
    withSeed(() => {
      const { items } = findUsSecurities({ query: "AAPL" });
      expect(items[0]?.symbol).toBe("AAPL");
    });
  });

  it("tolerates a typo in the name (vangard → Vanguard)", () => {
    withSeed(() => {
      const symbols = findUsSecurities({ query: "vangard" }).items.map((i) => i.symbol);
      expect(symbols).toEqual(expect.arrayContaining(["VOO", "BND"]));
      expect(symbols).not.toContain("AAPL");
    });
  });

  it("resolves a curated index alias (sp500 → an S&P 500 fund)", () => {
    withSeed(() => {
      const symbols = findUsSecurities({ query: "sp500" }).items.map((i) => i.symbol);
      expect(symbols).toContain("VOO");
    });
  });

  it("still honors the securityType filter under a text query", () => {
    withSeed(() => {
      const { items } = findUsSecurities({ query: "vanguard", securityType: "etf" });
      const symbols = items.map((i) => i.symbol);
      expect(symbols).toEqual(expect.arrayContaining(["VOO", "BND"]));
      expect(symbols).not.toContain("AAPL");
    });
  });

  it("returns nothing for a query that matches no security", () => {
    withSeed(() => {
      expect(findUsSecurities({ query: "zzzznotathing" }).items).toHaveLength(0);
      expect(searchUsSymbolsScored("zzzznotathing")).toHaveLength(0);
    });
  });

  it("scores hits in descending relevance order", () => {
    withSeed(() => {
      const scored = searchUsSymbolsScored("vanguard");
      expect(scored.length).toBeGreaterThan(1);
      for (let i = 1; i < scored.length; i++) {
        expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
      }
    });
  });
});
