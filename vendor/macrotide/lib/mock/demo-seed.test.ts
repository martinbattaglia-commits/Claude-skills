// Contract for the demo seed AFTER the database split.
//
// A demo session's in-memory database is an app.db only: it carries the
// persona's buckets / holdings / plan / journal / models. Market data is NOT
// seeded here — demo sessions read the shared real market.db (see
// lib/api/with-db.ts, lib/market/cache.ts). So this seed must:
//   1. populate buckets + holdings (one per data.ts holding),
//   2. seed the plan, journal entries, and built-in model portfolios,
//   3. point holdings at the real Thai-fund tickers from data.ts so the live
//      NAV path can price them against real SEC NAVs.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { PORTFOLIOS } from "./data";
import { DEMO_CASH, seedDemoData } from "./demo-seed";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // App baseline only — the demo session DB has no market tables.
  const migrationsDir = resolve("lib/db/migrations/app");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

describe("seedDemoData (app-only demo DB)", () => {
  it("seeds buckets and one holding row per data.ts holding", () => {
    const { sqlite, db } = freshDb();
    seedDemoData(db);

    const bucketCount = (sqlite.prepare("SELECT COUNT(*) AS n FROM buckets").get() as { n: number })
      .n;
    expect(bucketCount).toBe(PORTFOLIOS.length);

    // Holdings split by quote source: Thai funds (default) vs direct US positions
    // seeded with quoteSource "market".
    const allHoldings = PORTFOLIOS.flatMap((p) => p.holdings);
    const expectedFundHoldings = allHoldings.filter((h) => h.quoteSource !== "market").length;
    const expectedMarketHoldings = allHoldings.filter((h) => h.quoteSource === "market").length;
    const fundHoldings = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM holdings WHERE quote_source = 'thai_mutual_fund'")
        .get() as { n: number }
    ).n;
    expect(fundHoldings).toBe(expectedFundHoldings);

    const marketHoldings = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM holdings WHERE quote_source = 'market'").get() as {
        n: number;
      }
    ).n;
    expect(marketHoldings).toBe(expectedMarketHoldings);

    const cashHoldings = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM holdings WHERE quote_source = 'cash'").get() as {
        n: number;
      }
    ).n;
    expect(cashHoldings).toBe(DEMO_CASH.length);
  });

  it("seeds every fund holding with the thai_mutual_fund quote source and a real ticker", () => {
    const { sqlite, db } = freshDb();
    seedDemoData(db);

    const rows = sqlite
      .prepare("SELECT ticker, quote_source FROM holdings WHERE quote_source = 'thai_mutual_fund'")
      .all() as Array<{
      ticker: string;
      quote_source: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.quote_source).toBe("thai_mutual_fund");
      expect(r.ticker).toBeTruthy();
    }
  });

  it("seeds the plan, journal entries, and built-in model portfolios", () => {
    const { sqlite, db } = freshDb();
    seedDemoData(db);

    const plans = (sqlite.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n;
    expect(plans).toBe(1);

    const journal = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }
    ).n;
    expect(journal).toBeGreaterThan(0);

    const models = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM model_portfolios").get() as { n: number }
    ).n;
    expect(models).toBeGreaterThan(0);
  });

  it("seeds explicit cash accounts with cash events and a reserved earmark", () => {
    const { sqlite, db } = freshDb();
    seedDemoData(db);

    const cash = sqlite
      .prepare("SELECT asset_class, currency FROM holdings WHERE quote_source = 'cash'")
      .all() as Array<{ asset_class: string; currency: string }>;
    expect(cash.length).toBe(DEMO_CASH.length);
    for (const c of cash) {
      expect(c.asset_class).toBe("cash");
      expect(c.currency).toBe("THB");
    }

    const kinds = (
      sqlite
        .prepare("SELECT DISTINCT kind FROM transactions WHERE quote_source = 'cash'")
        .all() as Array<{ kind: string }>
    ).map((r) => r.kind);
    expect(kinds).toContain("cash_balance");
    expect(kinds).toContain("deposit");
    expect(kinds).toContain("withdraw");

    const reserved = sqlite
      .prepare("SELECT purpose FROM earmarks WHERE role = 'reserved'")
      .all() as Array<{ purpose: string }>;
    expect(reserved.length).toBe(DEMO_CASH.filter((a) => a.reserved).length);
    expect(reserved.every((r) => r.purpose)).toBe(true);
  });

  it("the three most-recent ledger rows are a cash/fund mix (two fund dividends, then cash)", () => {
    const { sqlite, db } = freshDb();
    seedDemoData(db);

    // Newest first, mirroring the "Recently recorded" peek (ORDER BY tradeDate, id).
    const recent = sqlite
      .prepare(
        "SELECT kind, quote_source FROM transactions ORDER BY trade_date DESC, id DESC LIMIT 3",
      )
      .all() as Array<{ kind: string; quote_source: string }>;
    expect(recent.map((r) => r.quote_source)).toEqual([
      "thai_mutual_fund",
      "thai_mutual_fund",
      "cash",
    ]);
    expect(recent[0].kind).toBe("dividend");
    expect(recent[2].kind).toBe("cash_balance");
  });
});
