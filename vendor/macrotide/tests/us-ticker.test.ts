import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { listHoldings } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger, reconcileHoldingCatalog } from "@/lib/db/queries/project-holdings";
import { getUsSecurity } from "@/lib/db/queries/us-securities";
import { holdings as holdingsTable, navHistory, transactions } from "@/lib/db/schema";
import { refreshUsSecurities } from "@/lib/jobs/refresh-us-securities";
import { quoteCacheKey } from "@/lib/market/sources";
import { makeTestDbContext } from "@/tests/db-helpers";

// Aligns with #235 for US securities: a US ticker rename (FB→META) is bridged by
// the rename-PERSISTENT composite FIGI anchor — the holding resolves to its
// current symbol + NAV at read while the ledger keeps the old code. Synthetic.

const h = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function ctx() {
  if (!h.ctx) throw new Error("no ctx");
  return h.ctx;
}
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithDbContext(ctx(), fn) as Promise<T>;
}

const BUCKET = {
  id: "b1",
  name: "Core",
  typeLabel: "Free",
  icon: "○",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

/** A synthetic Nasdaq directory line for one symbol. */
const dirLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|Q| |N|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

beforeEach(() => {
  h.ctx = makeTestDbContext();
});

describe("US ticker rename via FIGI anchor", () => {
  it("binds catalog_figi on creation, then resolves to the current symbol after a rename", async () => {
    await run(async () => {
      createBucket(BUCKET);
      // Initial catalog: OLD-X active, FIGI mapped.
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("OLD-X", "Old Corp Inc - Common Stock")),
        figiBatch: 10,
        mapFigis: async () => new Map([["OLD-X", "BBG000FIGI01"]]),
        seenAt: "2026-06-26T00:00:00Z",
      });
      expect(getUsSecurity("OLD-X")?.figi).toBe("BBG000FIGI01");

      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "OLD-X",
        englishName: "Old Corp Inc",
        quoteSource: "market",
        units: 10,
        avgCost: 100,
      });
      // Anchor bound from the catalog FIGI.
      const stored = ctx().appDb.select().from(holdingsTable).all();
      expect(stored[0]?.catalogFigi).toBe("BBG000FIGI01");

      // Rename: OLD-X leaves the directory (→ delisted), NEW-Y arrives with the SAME FIGI.
      const res = await refreshUsSecurities({
        fetchText: async () => directory(dirLine("NEW-Y", "New Corp Inc - Common Stock")),
        figiBatch: 10,
        mapFigis: async () => new Map([["NEW-Y", "BBG000FIGI01"]]),
        seenAt: "2026-06-27T00:00:00Z",
      });
      expect(res.renamed).toBe(1);
      expect(getUsSecurity("OLD-X")?.status).toBe("delisted");

      // Read model resolves to the CURRENT symbol/name via the FIGI anchor…
      const held = listHoldings("b1");
      expect(held[0].ticker).toBe("NEW-Y");
      expect(held[0].englishName).toBe("New Corp Inc");
      // …while the ledger keeps the original code as identity.
      const ledger = ctx().appDb.select().from(transactions).all();
      expect(ledger.every((t) => t.ticker === "OLD-X")).toBe(true);
    });
  });

  it("bridges the NAV cache old→new on the rename", async () => {
    await run(async () => {
      createBucket(BUCKET);
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("OLD-X", "Old Corp")),
        figiBatch: 10,
        mapFigis: async () => new Map([["OLD-X", "BBG000FIGI01"]]),
        seenAt: "2026-06-26T00:00:00Z",
      });
      // Seed cached NAV under the old symbol's key.
      ctx()
        .marketDb.insert(navHistory)
        .values({ ticker: quoteCacheKey("market", "OLD-X"), date: "2026-06-20", nav: 50 })
        .run();

      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("NEW-Y", "New Corp")),
        figiBatch: 10,
        mapFigis: async () => new Map([["NEW-Y", "BBG000FIGI01"]]),
        seenAt: "2026-06-27T00:00:00Z",
      });

      const rows = ctx().marketDb.select().from(navHistory).all();
      expect(rows.map((r) => r.ticker)).toContain(quoteCacheKey("market", "NEW-Y"));
      expect(rows.map((r) => r.ticker)).not.toContain(quoteCacheKey("market", "OLD-X"));
    });
  });
});

describe("US lifecycle — manual → market promotion", () => {
  it("promotes a custom holding once its ticker joins the US catalog", async () => {
    await run(async () => {
      createBucket(BUCKET);
      // A custom (manual) position the catalog doesn't know yet.
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "IPO-Z",
        englishName: "My IPO bet",
        quoteSource: "manual",
        units: 5,
        avgCost: 20,
      });

      // The symbol later lists.
      await refreshUsSecurities({
        fetchText: async () => directory(dirLine("IPO-Z", "Ipo Z Inc - Common Stock")),
        figiBatch: 10,
        mapFigis: async () => new Map([["IPO-Z", "BBG000FIGIPO"]]),
        seenAt: "2026-06-27T00:00:00Z",
      });

      const out = reconcileHoldingCatalog();
      expect(out.promoted).toBe(1);

      const held = listHoldings("b1");
      expect(held[0].quoteSource).toBe("market");
      expect(held[0].catalogFigi).toBe("BBG000FIGIPO");
      // The ledger rows were re-sourced too.
      const ledger = ctx().appDb.select().from(transactions).all();
      expect(ledger.every((t) => t.quoteSource === "market")).toBe(true);
    });
  });
});
