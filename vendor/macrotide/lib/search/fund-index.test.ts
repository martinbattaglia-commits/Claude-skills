// Fund search index contract. The load-bearing behaviors:
//   1. expandQuery folds index nicknames (sp500/us500 → s&p 500) for recall.
//   2. searchFundIds matches a fund by its FEEDER MASTER name — searching
//      "S&P500" surfaces a US500 fund whose master is "iShares Core S&P 500 ETF"
//      even though the fund's own name never says "S&P 500".
//   3. An empty catalog (demo mode) returns [] rather than throwing.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../db/context";
import { upsertFeederMasterMap } from "../db/queries/feeder-enrichment";
import { type FundInsert, upsertFund } from "../db/queries/funds";
import { upsertShareClasses } from "../db/queries/share-classes";
import * as schema from "../db/schema";
import { expandQuery, searchFundIds, searchFundIdsScored } from "./fund-index";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = resolve("lib/db/migrations/app");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  const market = freshMarketDb();
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    marketDb: market.db,
    marketSqlite: market.sqlite,
  };
}

function withDb(fn: () => void) {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  const ctx: DbContext = {
    appDb: db,
    appSqlite: sqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "s",
    userId: null,
  };
  runWithDbContext(ctx, fn);
}

function fund(projId: string, over: Partial<FundInsert> = {}): FundInsert {
  return { projId, abbrName: projId, englishName: projId, status: "active", ...over };
}

describe("expandQuery", () => {
  it("expands index nicknames and preserves the original query", () => {
    expect(expandQuery("us500")).toBe("us500 s&p 500");
    expect(expandQuery("S&P500")).toBe("S&P500 s&p 500");
    expect(expandQuery("qqq")).toBe("qqq nasdaq 100");
  });
  it("leaves a query with no alias untouched", () => {
    expect(expandQuery("K-FIXED")).toBe("K-FIXED");
  });
});

describe("searchFundIds", () => {
  it("surfaces a feeder fund by its master fund name (S&P500 → US500 fund)", () => {
    withDb(() => {
      // A US500 fund whose own name never contains "S&P 500" — only its feeder
      // master does. This is the case the old LIKE search could never match.
      upsertFund(
        fund("KKP_US500", {
          abbrName: "KKP US500-UH FUND",
          englishName: "KKP US500 FUND - UNHEDGED",
          feederMasterFund: "iShares Core S&P 500 ETF",
          isFeederFund: true,
        }),
      );
      upsertFeederMasterMap({
        projId: "KKP_US500",
        masterIsin: "US4642872000",
        masterName: "iShares Core S&P 500 ETF",
        provider: "manual",
      });
      upsertFund(fund("UNRELATED", { abbrName: "K-FIXED", englishName: "K Fixed Income" }));

      const ids = searchFundIds("S&P500");
      expect(ids).toContain("KKP_US500");
      expect(ids).not.toContain("UNRELATED");
    });
  });

  it("matches a fund by abbr name with prefix typing", () => {
    withDb(() => {
      upsertFund(fund("M1", { abbrName: "K-FIXED" }));
      expect(searchFundIds("K-FIX")).toContain("M1");
    });
  });

  it("finds a fund by a multi-class share-class ticker (SCBGOLDP → parent)", () => {
    withDb(() => {
      // Parent abbr is SCBGOLD; SCBGOLDP exists only as a share-class ticker, not
      // a catalog name — the case the catalog-only index could never match.
      upsertFund(fund("SCBGOLD_PROJ", { abbrName: "SCBGOLD", englishName: "SCB Gold" }));
      upsertShareClasses([
        { projId: "SCBGOLD_PROJ", className: "SCBGOLD", ticker: "SCBGOLD", investorType: "retail" },
        {
          projId: "SCBGOLD_PROJ",
          className: "SCBGOLDP",
          ticker: "SCBGOLDP",
          investorType: "retail",
        },
      ]);
      upsertFund(fund("OTHER", { abbrName: "K-FIXED" }));

      expect(searchFundIds("SCBGOLDP")).toContain("SCBGOLD_PROJ"); // the bug: was []
      expect(searchFundIds("SCBGOLD")).toContain("SCBGOLD_PROJ");
      expect(searchFundIds("SCBGOLDP")).not.toContain("OTHER");
    });
  });

  it("returns [] for an empty catalog (demo mode) and for a blank query", () => {
    withDb(() => {
      expect(searchFundIds("anything")).toEqual([]);
      upsertFund(fund("M1"));
      expect(searchFundIds("   ")).toEqual([]);
    });
  });
});

describe("searchFundIdsScored", () => {
  it("returns hits with descending scores; searchFundIds matches its id order", () => {
    withDb(() => {
      upsertFund(fund("EXACT", { abbrName: "K-GOLD", englishName: "K Gold Fund" }));
      upsertFund(fund("LOOSE", { abbrName: "K-GOLD-RMF", englishName: "K Gold for Retirement" }));
      upsertFund(fund("OTHER", { abbrName: "K-FIXED", englishName: "K Fixed Income" }));

      const scored = searchFundIdsScored("K-GOLD");
      expect(scored.length).toBeGreaterThan(0);
      // descending score order
      for (let i = 1; i < scored.length; i++) {
        expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
      }
      // wrapper parity: same ids, same order
      expect(searchFundIds("K-GOLD")).toEqual(scored.map((r) => r.id));
    });
  });

  it("returns [] for an empty catalog and blank query", () => {
    withDb(() => {
      expect(searchFundIdsScored("anything")).toEqual([]);
      upsertFund(fund("M1"));
      expect(searchFundIdsScored("   ")).toEqual([]);
    });
  });
});
