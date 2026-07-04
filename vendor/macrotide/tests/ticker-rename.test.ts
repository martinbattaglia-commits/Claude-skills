import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { listHeldQuoteRefs, listHoldings } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger } from "@/lib/db/queries/project-holdings";
import { upsertShareClasses } from "@/lib/db/queries/share-classes";
import {
  fundCatalog,
  fundQuotes,
  fundShareClasses,
  holdings as holdingsTable,
  navHistory,
} from "@/lib/db/schema";
import { quoteCacheKey } from "@/lib/market/sources";
import { makeTestDbContext } from "@/tests/db-helpers";

// #235 — a Thai fund's CODE can change over time. The holding stores a stable
// (proj_id, class_name) anchor at creation, so after the catalog renames the
// symbol the holding still resolves to the fund's CURRENT name + code, while the
// ledger keeps the old code as its immutable identity. Synthetic codes only.

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

function seedFund(projId: string, ticker: string, englishName: string) {
  ctx().marketDb.insert(fundCatalog).values({ projId, abbrName: ticker, englishName }).run();
  ctx().marketDb.insert(fundShareClasses).values({ projId, className: "main", ticker }).run();
}

/** Simulate the nightly catalog refresh renaming a fund's code (proj_id stable). */
function renameFundCode(projId: string, newTicker: string, newName: string) {
  ctx()
    .marketDb.update(fundShareClasses)
    .set({ ticker: newTicker })
    .where(eq(fundShareClasses.projId, projId))
    .run();
  ctx()
    .marketDb.update(fundCatalog)
    .set({ abbrName: newTicker, englishName: newName })
    .where(eq(fundCatalog.projId, projId))
    .run();
}

beforeEach(() => {
  h.ctx = makeTestDbContext();
  run(() => createBucket(BUCKET));
});

describe("seamless fund code rename", () => {
  it("binds the (proj_id, class_name) anchor when a holding is created", () => {
    const row = run(() => {
      seedFund("P1", "OLD-CODE-A", "Old Fund Name");
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "OLD-CODE-A",
        englishName: "Old Fund Name",
        quoteSource: "thai_mutual_fund",
        units: 10,
      });
      return ctx().appDb.select().from(holdingsTable).where(eq(holdingsTable.bucketId, "b1")).get();
    });
    expect(row?.catalogProjId).toBe("P1");
    expect(row?.catalogClassName).toBe("main");
  });

  it("shows the CURRENT name + code after a rename, ledger keeps the old code", () => {
    const { read, stored } = run(() => {
      seedFund("P1", "OLD-CODE-A", "Old Fund Name");
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "OLD-CODE-A",
        englishName: "Old Fund Name",
        quoteSource: "thai_mutual_fund",
        units: 10,
      });
      // The fund house renames the code; proj_id is unchanged.
      renameFundCode("P1", "NEW-CODE-B", "New Fund Name");
      const read = listHoldings("b1");
      const stored = ctx()
        .appDb.select()
        .from(holdingsTable)
        .where(eq(holdingsTable.bucketId, "b1"))
        .get();
      return { read, stored };
    });
    // Read model follows the rename...
    expect(read).toHaveLength(1);
    expect(read[0].ticker).toBe("NEW-CODE-B");
    expect(read[0].englishName).toBe("New Fund Name");
    expect(read[0].quoteSource).toBe("thai_mutual_fund");
    // ...while the ledger/holdings row keeps the old code as immutable identity.
    expect(stored?.ticker).toBe("OLD-CODE-A");
    expect(stored?.catalogProjId).toBe("P1");
  });

  it("resolves held quote refs to the current code after a rename", () => {
    const refs = run(() => {
      seedFund("P1", "OLD-CODE-A", "Old Fund Name");
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "OLD-CODE-A",
        englishName: "Old Fund Name",
        quoteSource: "thai_mutual_fund",
        units: 10,
      });
      renameFundCode("P1", "NEW-CODE-B", "New Fund Name");
      return listHeldQuoteRefs();
    });
    expect(refs).toContainEqual({ source: "thai_mutual_fund", ticker: "NEW-CODE-B" });
  });

  it("re-points cached NAV to the new code so history is continuous", () => {
    const { atNew, atOld } = run(() => {
      seedFund("P1", "OLD-CODE-A", "Old Fund Name");
      const oldKey = quoteCacheKey("thai_mutual_fund", "OLD-CODE-A");
      ctx()
        .marketDb.insert(navHistory)
        .values({ ticker: oldKey, date: "2026-01-15", nav: 12.34 })
        .run();
      ctx()
        .marketDb.insert(fundQuotes)
        .values({ ticker: oldKey, nav: 12.34, updatedAt: "2026-01-15" })
        .run();
      // The refresh upserts the same (proj_id, class_name) with the new ticker.
      upsertShareClasses([{ projId: "P1", className: "main", ticker: "NEW-CODE-B" }]);
      const newKey = quoteCacheKey("thai_mutual_fund", "NEW-CODE-B");
      const atNew = ctx()
        .marketDb.select()
        .from(navHistory)
        .where(eq(navHistory.ticker, newKey))
        .all();
      const atOld = ctx()
        .marketDb.select()
        .from(navHistory)
        .where(eq(navHistory.ticker, quoteCacheKey("thai_mutual_fund", "OLD-CODE-A")))
        .all();
      return { atNew, atOld };
    });
    expect(atNew).toHaveLength(1);
    expect(atNew[0].nav).toBe(12.34);
    expect(atOld).toHaveLength(0); // moved, not duplicated
  });
});

describe("multi-class rebrand that changes class_name (ISIN-anchored)", () => {
  it("stays linked via the ISIN anchor when the (proj_id, class_name) pair moves", () => {
    const out = run(() => {
      // A multi-class fund where the holdable ticker IS the class_name, and the
      // class publishes an ISIN (a real, global security id — unlike the SEC
      // `unique_id`, which is an AMC code and can't anchor a class).
      ctx()
        .marketDb.insert(fundCatalog)
        .values({ projId: "PM", abbrName: "OLD-A", englishName: "Old Multi" })
        .run();
      ctx()
        .marketDb.insert(fundShareClasses)
        .values({ projId: "PM", className: "OLD-A", ticker: "OLD-A", isinCode: "TH-ISIN-1" })
        .run();
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "OLD-A",
        englishName: "Old Multi",
        quoteSource: "thai_mutual_fund",
        units: 7,
      });
      // The rebrand: SAME ISIN, but the class_name AND ticker both change. The new
      // class is a fresh (proj_id, class_name) row; the old one LINGERS (the refresh
      // never deletes), and read resolution prefers the freshest match.
      ctx().marketDb.update(fundCatalog).set({ abbrName: "NEW-B" }).run();
      upsertShareClasses([
        { projId: "PM", className: "NEW-B", ticker: "NEW-B", isinCode: "TH-ISIN-1" },
      ]);
      const classRows = ctx().marketDb.select().from(fundShareClasses).all();
      return { read: listHoldings("b1"), classRows };
    });
    // The holding follows the rebrand via its stored ISIN even though BOTH the
    // ticker and the class_name moved...
    expect(out.read).toHaveLength(1);
    expect(out.read[0].ticker).toBe("NEW-B");
    // ...and the rebrand was NON-DESTRUCTIVE: the stale OLD-A row still exists (one
    // row per (proj_id, class_name)); nothing was deleted.
    expect(out.classRows).toHaveLength(2);
  });

  it("resolves a DUPLICATE cross-fund ISIN to the right fund via the proj_id anchor", () => {
    const read = run(() => {
      // The SEC feed has a couple of ISINs shared across two different funds.
      // A holding anchored to fund A must resolve to A, not to B (the proj_id in
      // the stored anchor disambiguates; recency alone could land on either).
      ctx()
        .marketDb.insert(fundCatalog)
        .values([
          { projId: "PA", abbrName: "A-CODE", englishName: "Fund A" },
          { projId: "PB", abbrName: "B-CODE", englishName: "Fund B" },
        ])
        .run();
      ctx()
        .marketDb.insert(fundShareClasses)
        .values([
          { projId: "PA", className: "main", ticker: "A-CODE", isinCode: "DUP-ISIN" },
          { projId: "PB", className: "main", ticker: "B-CODE", isinCode: "DUP-ISIN" },
        ])
        .run();
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "A-CODE",
        englishName: "Fund A",
        quoteSource: "thai_mutual_fund",
        units: 1,
      });
      return listHoldings("b1");
    });
    expect(read).toHaveLength(1);
    expect(read[0].ticker).toBe("A-CODE"); // its own fund, not B-CODE
  });

  it("does NOT delete sibling classes on a normal refresh (regression: AMC-code collapse)", () => {
    // Many classes share the SEC unique_id (an AMC/company code), and most have no
    // ISIN. A refresh batch must upsert them all WITHOUT deleting siblings — the
    // bug that once collapsed the catalog to one row per AMC.
    const rows = run(() => {
      ctx()
        .marketDb.insert(fundCatalog)
        .values({ projId: "PMC", abbrName: "FAM-A", englishName: "Family" })
        .run();
      upsertShareClasses([
        { projId: "PMC", className: "FAM-A", ticker: "FAM-A" },
        { projId: "PMC", className: "FAM-B", ticker: "FAM-B" },
        { projId: "PMC", className: "FAM-C", ticker: "FAM-C" },
      ]);
      // A second (idempotent) refresh pass must also keep all three.
      upsertShareClasses([
        { projId: "PMC", className: "FAM-A", ticker: "FAM-A" },
        { projId: "PMC", className: "FAM-B", ticker: "FAM-B" },
        { projId: "PMC", className: "FAM-C", ticker: "FAM-C" },
      ]);
      return ctx().marketDb.select().from(fundShareClasses).all();
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ticker).sort()).toEqual(["FAM-A", "FAM-B", "FAM-C"]);
  });
});
