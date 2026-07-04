import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { listHoldings } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger, reconcileHoldingCatalog } from "@/lib/db/queries/project-holdings";
import {
  listActiveShareClassTickers,
  listHeldShareClassTickers,
} from "@/lib/db/queries/share-classes";
import { insertTransactions } from "@/lib/db/queries/transactions";
import {
  fundCatalog,
  fundQuotes,
  fundShareClasses,
  holdings as holdingsTable,
} from "@/lib/db/schema";
import { quoteCacheKey } from "@/lib/market/sources";
import { makeTestDbContext } from "@/tests/db-helpers";

// #235 — funds move through a lifecycle (IPO → registered → closed) and a custom
// asset may gain catalog data over time. Holdings transition seamlessly between
// "no market data" and "has market data" in BOTH directions. Synthetic codes only.

const h = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function ctx() {
  if (!h.ctx) throw new Error("no ctx");
  return h.ctx;
}
function run<T>(fn: () => T): T {
  return runWithDbContext(ctx(), fn) as T;
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

function seedFund(projId: string, ticker: string, status: "active" | "inactive" = "active") {
  ctx()
    .marketDb.insert(fundCatalog)
    .values({ projId, abbrName: ticker, englishName: `${ticker} Fund`, status })
    .run();
  ctx().marketDb.insert(fundShareClasses).values({ projId, className: "main", ticker }).run();
}

beforeEach(() => {
  h.ctx = makeTestDbContext();
  run(() => createBucket(BUCKET));
});

describe("no-data → data: a custom holding gains catalog data", () => {
  it("promotes a manual holding to thai_mutual_fund and binds the anchor when its ticker joins the catalog", () => {
    const before = run(() => {
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "NEWFUND-A",
        englishName: "Self-priced for now",
        quoteSource: "manual",
        units: 100,
      });
      return ctx().appDb.select().from(holdingsTable).where(eq(holdingsTable.bucketId, "b1")).get();
    });
    // Custom: no catalog link yet.
    expect(before?.quoteSource).toBe("manual");
    expect(before?.catalogProjId).toBeNull();

    const { result, after } = run(() => {
      seedFund("PNEW", "NEWFUND-A"); // the fund is now listed in the catalog
      const result = reconcileHoldingCatalog();
      const after = ctx()
        .appDb.select()
        .from(holdingsTable)
        .where(eq(holdingsTable.bucketId, "b1"))
        .get();
      return { result, after };
    });
    expect(result.promoted).toBe(1);
    expect(after?.quoteSource).toBe("thai_mutual_fund");
    expect(after?.catalogProjId).toBe("PNEW");
    // Idempotent: a second run does nothing.
    expect(run(() => reconcileHoldingCatalog())).toEqual({ promoted: 0, bound: 0 });
  });
});

describe("closed funds still get priced", () => {
  it("includes a held CLOSED fund in the warm list even though the active crawl skips it", () => {
    const { active, held } = run(() => {
      seedFund("PCLOSED", "GONE-A", "inactive"); // liquidated / closed
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "GONE-A",
        englishName: "Closed Fund",
        quoteSource: "thai_mutual_fund",
        units: 5,
      });
      return {
        active: listActiveShareClassTickers().map((t) => t.ticker),
        held: listHeldShareClassTickers().map((t) => t.ticker),
      };
    });
    expect(active).not.toContain("GONE-A"); // active-only crawl skips it
    expect(held).toContain("GONE-A"); // but it's warmed because the user holds it
  });
});

describe("data → no-data: a fund that loses live data does not vanish", () => {
  it("keeps valuing a value-only balance at its last-known NAV", () => {
    const all = run(() => {
      seedFund("PSTALE", "STALE-A");
      // Only a (stale) latest quote exists — no dated NAV, mimicking a fund that
      // stopped publishing. The fold falls back to the last-known NAV (#235): the
      // quote cache is never pruned, so a delisted fund stays valued, not dropped.
      ctx()
        .marketDb.insert(fundQuotes)
        .values({
          ticker: quoteCacheKey("thai_mutual_fund", "STALE-A"),
          nav: 25,
          updatedAt: "2025-01-01",
        })
        .run();
      // A value-only balance: ฿1000 with NO unit count — units derive from NAV.
      insertTransactions([
        {
          bucketId: "b1",
          ticker: "STALE-A",
          englishName: "Stale Fund",
          quoteSource: "thai_mutual_fund",
          kind: "opening",
          tradeDate: "2026-06-01",
          units: null,
          value: 1000,
          amount: 0,
          tradeCurrency: "THB",
          fxToThb: 1,
        },
      ]);
      return listHoldings("b1");
    });
    // The holding survives and is valued off the last-known NAV (1000 / 25 = 40).
    expect(all).toHaveLength(1);
    expect(all[0].units).toBeCloseTo(40, 5);
  });
});
