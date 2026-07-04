// Unit tests for computeFeeCreep(). Uses the same in-memory freshDb +
// runWithDbContext pattern from lib/db/queries/funds.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../db/context";
import {
  type FundFeeInsert,
  type FundInsert,
  upsertFund,
  upsertFundFees,
} from "../db/queries/funds";
import { createHoldingViaLedger } from "../db/queries/project-holdings";
import * as schema from "../db/schema";
import { computeFeeCreep } from "./fee-creep";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

let _ctx: DbContext;

function withDb(fn: () => void) {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  _ctx = {
    appDb: db,
    appSqlite: sqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "s",
    userId: null,
  };
  // Seed a default bucket so holdings FK is satisfied.
  db.insert(schema.buckets)
    .values({
      id: "b1",
      name: "Test",
      brokerage: "—",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    })
    .run();
  runWithDbContext(_ctx, fn);
}

function fund(projId: string, over: Partial<FundInsert> = {}): FundInsert {
  return {
    projId,
    abbrName: projId,
    englishName: `${projId} Fund`,
    assetClass: "equity",
    fundType: "Foreign Investment Fund",
    status: "active",
    ...over,
  };
}

function ter(projId: string, actual: number, over: Partial<FundFeeInsert> = {}): FundFeeInsert {
  return {
    projId,
    fundClassName: "A",
    feeType: "total_expense",
    feeTypeRaw: "ค่าธรรมเนียมและค่าใช้จ่ายรวมทั้งหมด (Total Fee and Expense)",
    actualRatePct: actual,
    rateCeilingPct: actual + 0.5,
    periodStart: "2026-01-01",
    periodEnd: null,
    ...over,
  };
}

function holding(ticker: string) {
  return createHoldingViaLedger({
    bucketId: "b1",
    ticker,
    englishName: `${ticker} holding`,
    units: 100,
    quoteSource: "thai_mutual_fund",
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("computeFeeCreep", () => {
  it("returns a finding when a held fund has a cheaper same-class peer", () => {
    withDb(() => {
      upsertFund(fund("PRICEY"));
      upsertFund(fund("CHEAP1"));
      upsertFund(fund("CHEAP2"));
      upsertFundFees([ter("PRICEY", 1.2), ter("CHEAP1", 0.5), ter("CHEAP2", 0.3)]);
      holding("PRICEY");
      const findings = computeFeeCreep();
      expect(findings).toHaveLength(1);
      expect(findings[0].heldTicker).toBe("PRICEY");
      expect(findings[0].heldTer).toBe(1.2);
      expect(findings[0].savingsPp).toBe(0.9); // 1.2 − 0.3
      // Alternatives sorted cheapest-first.
      expect(findings[0].alternatives[0].projId).toBe("CHEAP2");
      expect(findings[0].alternatives[1].projId).toBe("CHEAP1");
    });
  });

  it("returns nothing when the held fund has no catalog match", () => {
    withDb(() => {
      holding("NO-CATALOG-FUND");
      expect(computeFeeCreep()).toEqual([]);
    });
  });

  it("returns nothing when the held fund has no TER", () => {
    withDb(() => {
      upsertFund(fund("NO-TER"));
      // No fund_fees rows seeded.
      holding("NO-TER");
      expect(computeFeeCreep()).toEqual([]);
    });
  });

  it("returns nothing when the held fund is already cheapest in its class", () => {
    withDb(() => {
      upsertFund(fund("CHEAPEST"));
      upsertFund(fund("DEARER"));
      upsertFundFees([ter("CHEAPEST", 0.2), ter("DEARER", 0.8)]);
      holding("CHEAPEST");
      expect(computeFeeCreep()).toEqual([]);
    });
  });

  it("deduplicates tickers held across multiple holdings", () => {
    withDb(() => {
      upsertFund(fund("HELD"));
      upsertFund(fund("ALT"));
      upsertFundFees([ter("HELD", 1.0), ter("ALT", 0.4)]);
      holding("HELD");
      holding("HELD"); // same ticker twice
      const findings = computeFeeCreep();
      expect(findings).toHaveLength(1);
      expect(findings[0].heldTicker).toBe("HELD");
    });
  });

  it("sorts findings by savingsPp descending (biggest saving first)", () => {
    withDb(() => {
      upsertFund(fund("FUND-A"));
      upsertFund(
        fund("FUND-B", { abbrName: "FUND-B", assetClass: "bond", fundType: "Fixed Income Fund" }),
      );
      upsertFund(fund("ALT-A"));
      upsertFund(
        fund("ALT-B", { abbrName: "ALT-B", assetClass: "bond", fundType: "Fixed Income Fund" }),
      );
      upsertFundFees([
        ter("FUND-A", 1.5),
        ter("FUND-B", 0.8),
        ter("ALT-A", 0.4),
        ter("ALT-B", 0.6),
      ]);
      holding("FUND-A"); // savings = 1.5 − 0.4 = 1.1
      holding("FUND-B"); // savings = 0.8 − 0.6 = 0.2
      const findings = computeFeeCreep();
      expect(findings[0].heldTicker).toBe("FUND-A");
      expect(findings[1].heldTicker).toBe("FUND-B");
    });
  });

  it("returns empty array when there are no holdings", () => {
    withDb(() => {
      expect(computeFeeCreep()).toEqual([]);
    });
  });

  it("does not suggest a different-region fund as a cheaper alternative", () => {
    withDb(() => {
      // Held: a global/foreign-exposure equity fund. The catalog also holds a
      // cheaper DOMESTIC equity fund (same broad asset class, wrong exposure)
      // and a cheaper GLOBAL equity fund (genuinely equivalent). Only the
      // genuinely-equivalent one may be offered.
      upsertFund(fund("GLOBAL-EQUITY", { investRegion: "foreign" }));
      upsertFund(
        fund("DOMESTIC-EQUITY", { abbrName: "DOMESTIC-EQUITY", investRegion: "domestic" }),
      );
      upsertFund(
        fund("GLOBAL-EQUITY-CHEAP", { abbrName: "GLOBAL-EQUITY-CHEAP", investRegion: "foreign" }),
      );
      upsertFundFees([
        ter("GLOBAL-EQUITY", 1.2),
        ter("DOMESTIC-EQUITY", 0.2), // cheaper but wrong region — must NOT appear
        ter("GLOBAL-EQUITY-CHEAP", 0.5), // cheaper and same exposure — must appear
      ]);
      holding("GLOBAL-EQUITY");
      const findings = computeFeeCreep();
      expect(findings).toHaveLength(1);
      const altIds = findings[0].alternatives.map((a) => a.projId);
      expect(altIds).toEqual(["GLOBAL-EQUITY-CHEAP"]);
      expect(altIds).not.toContain("DOMESTIC-EQUITY");
      expect(findings[0].savingsPp).toBe(0.7); // 1.2 − 0.5, not 1.2 − 0.2
    });
  });

  it("caps alternatives at 3 per finding", () => {
    withDb(() => {
      upsertFund(fund("PRICEY2"));
      for (let i = 1; i <= 5; i++) {
        upsertFund(fund(`ALT${i}`));
        upsertFundFees([ter(`ALT${i}`, 0.1 * i)]);
      }
      upsertFundFees([ter("PRICEY2", 1.5)]);
      holding("PRICEY2");
      const findings = computeFeeCreep();
      expect(findings[0].alternatives.length).toBeLessThanOrEqual(3);
    });
  });
});
