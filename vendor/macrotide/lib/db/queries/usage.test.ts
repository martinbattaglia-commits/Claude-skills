// Quotas + tier gating. Locks in the invariants the chat route
// depends on:
//   - tier defaults to 'public' when there's no account_tier row;
//   - the daily cap reads env budgets with the documented defaults;
//   - usage upserts then atomically increments today's (UTC) row;
//   - the cap check flips at the budget boundary (>=).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import { accountTier, user } from "../schema";
import {
  dailyCentsBudget,
  dailyTokenBudget,
  estimateCostMicros,
  getTier,
  getTodayUsage,
  isOverDailyCap,
  isOverDailyCostCap,
  modelPrice,
  recordUsage,
  utcDate,
} from "./usage";

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
  const db = drizzle(sqlite, { schema });
  const market = freshMarketDb();
  return { sqlite, db, marketDb: market.db, marketSqlite: market.sqlite };
}

function withFresh<T>(fn: () => T): T {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  // Seed the FK target — usage + account_tier both reference user(id).
  const now = new Date();
  db.insert(user)
    .values({
      id: "u1",
      name: "U1",
      email: "u1@x.io",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return runWithDbContext(
    {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "test",
      userId: "u1",
    },
    fn,
  ) as T;
}

describe("dailyTokenBudget", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("uses documented defaults when env is unset", () => {
    process.env.DAILY_TOKEN_BUDGET_PUBLIC = undefined;
    process.env.DAILY_TOKEN_BUDGET_TRUSTED = undefined;
    expect(dailyTokenBudget("public")).toBe(20_000);
    expect(dailyTokenBudget("trusted")).toBe(200_000);
  });

  it("honors env overrides", () => {
    process.env.DAILY_TOKEN_BUDGET_PUBLIC = "5000";
    process.env.DAILY_TOKEN_BUDGET_TRUSTED = "999999";
    expect(dailyTokenBudget("public")).toBe(5000);
    expect(dailyTokenBudget("trusted")).toBe(999999);
  });

  it("falls back to the default on a malformed env value", () => {
    process.env.DAILY_TOKEN_BUDGET_PUBLIC = "not-a-number";
    process.env.DAILY_TOKEN_BUDGET_TRUSTED = "-5";
    expect(dailyTokenBudget("public")).toBe(20_000);
    expect(dailyTokenBudget("trusted")).toBe(200_000);
  });
});

describe("getTier", () => {
  it("defaults to 'public' when there's no account_tier row", () => {
    withFresh(() => {
      expect(getTier("u1")).toBe("public");
    });
  });

  it("returns the stored tier when a row exists", () => {
    // Insert a 'trusted' row, then read it back inside the same context.
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const now = new Date();
    db.insert(user)
      .values({
        id: "u1",
        name: "U1",
        email: "u1@x.io",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(accountTier)
      .values({ userId: "u1", tier: "trusted", grantedAt: now.toISOString() })
      .run();
    runWithDbContext(
      {
        appDb: db,
        appSqlite: sqlite,
        marketDb,
        marketSqlite,
        isDemo: false,
        sessionId: "test",
        userId: "u1",
      },
      () => {
        expect(getTier("u1")).toBe("trusted");
      },
    );
  });
});

describe("usage accounting", () => {
  it("getTodayUsage is zero with no row", () => {
    withFresh(() => {
      expect(getTodayUsage("u1")).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        total: 0,
        costMicros: 0,
      });
    });
  });

  it("recordUsage inserts then atomically increments today's row", () => {
    withFresh(() => {
      recordUsage("u1", 100, 50);
      expect(getTodayUsage("u1")).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        total: 150,
        costMicros: 0,
      });
      recordUsage("u1", 25, 75);
      expect(getTodayUsage("u1")).toEqual({
        inputTokens: 125,
        outputTokens: 125,
        total: 250,
        costMicros: 0,
      });
    });
  });

  it("recordUsage clamps NaN / negative token counts to 0", () => {
    withFresh(() => {
      recordUsage("u1", Number.NaN, -10);
      expect(getTodayUsage("u1").total).toBe(0);
      recordUsage("u1", 10, Number.NaN);
      expect(getTodayUsage("u1")).toEqual({
        inputTokens: 10,
        outputTokens: 0,
        total: 10,
        costMicros: 0,
      });
    });
  });

  it("usage is partitioned by UTC date (separate days don't bleed)", () => {
    withFresh(() => {
      const today = utcDate();
      const yesterday = utcDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
      recordUsage("u1", 100, 0, yesterday);
      recordUsage("u1", 5, 0, today);
      expect(getTodayUsage("u1", today).total).toBe(5);
      expect(getTodayUsage("u1", yesterday).total).toBe(100);
    });
  });
});

describe("isOverDailyCap", () => {
  const orig = { ...process.env };
  beforeEach(() => {
    process.env.DAILY_TOKEN_BUDGET_PUBLIC = "1000";
    process.env.DAILY_TOKEN_BUDGET_TRUSTED = "10000";
  });
  afterEach(() => {
    process.env = { ...orig };
  });

  it("is false under the cap", () => {
    withFresh(() => {
      recordUsage("u1", 400, 400); // 800 < 1000
      expect(isOverDailyCap("u1", "public")).toBe(false);
    });
  });

  it("is true at the cap boundary (>=)", () => {
    withFresh(() => {
      recordUsage("u1", 500, 500); // 1000 == cap
      expect(isOverDailyCap("u1", "public")).toBe(true);
    });
  });

  it("is true over the cap", () => {
    withFresh(() => {
      recordUsage("u1", 900, 900); // 1800 > 1000
      expect(isOverDailyCap("u1", "public")).toBe(true);
    });
  });

  it("the trusted budget is higher — same usage that caps public passes trusted", () => {
    withFresh(() => {
      recordUsage("u1", 600, 600); // 1200: over public (1000), under trusted (10000)
      expect(isOverDailyCap("u1", "public")).toBe(true);
      expect(isOverDailyCap("u1", "trusted")).toBe(false);
    });
  });
});

describe("model pricing", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("prices a known built-in model and returns null for an unknown one", () => {
    process.env.MODEL_PRICES = undefined;
    expect(modelPrice("google/gemini-2.5-flash")).toEqual({ in: 0.3, out: 2.5 });
    expect(modelPrice("some/free-model:free")).toBeNull();
    expect(modelPrice(null)).toBeNull();
  });

  it("matches a dated snapshot id by stripping a trailing -YYYY-MM-DD", () => {
    process.env.MODEL_PRICES = undefined;
    // OpenRouter reports openai models with a dated suffix.
    expect(modelPrice("openai/gpt-4.1-mini-2025-04-14")).toEqual({ in: 0.4, out: 1.6 });
    // …but a real variant (flash-lite) must NOT collapse onto its base (flash).
    expect(modelPrice("google/gemini-2.5-flash-lite")).toEqual({ in: 0.1, out: 0.4 });
    // The vision/OCR EOL-proof fallback is priced so its turns aren't free $0.
    expect(modelPrice("google/gemini-3.1-flash-lite")).toEqual({ in: 0.25, out: 1.5 });
  });

  it("estimateCostMicros = tokens × price (USD/Mtok == micro-USD/token)", () => {
    process.env.MODEL_PRICES = undefined;
    // 1000 in × 0.3 + 1000 out × 2.5 = 300 + 2500 = 2800 micro-dollars
    expect(estimateCostMicros("google/gemini-2.5-flash", 1000, 1000)).toBe(2800);
    // unpriced / free model → no cost accrues
    expect(estimateCostMicros("some/free-model:free", 1000, 1000)).toBe(0);
    expect(estimateCostMicros(null, 1000, 1000)).toBe(0);
  });

  it("MODEL_PRICES env overrides/extends the built-in table; malformed degrades", () => {
    process.env.MODEL_PRICES = JSON.stringify({ "x/custom": { in: 1, out: 2 } });
    expect(modelPrice("x/custom")).toEqual({ in: 1, out: 2 });
    // built-ins still present alongside the override
    expect(modelPrice("google/gemini-2.5-flash")).toEqual({ in: 0.3, out: 2.5 });
    process.env.MODEL_PRICES = "{not json";
    expect(modelPrice("google/gemini-2.5-flash")).toEqual({ in: 0.3, out: 2.5 });
    expect(modelPrice("x/custom")).toBeNull();
  });
});

describe("dailyCentsBudget", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("is null (cost gating off) when unset", () => {
    process.env.DAILY_CENTS_BUDGET_PUBLIC = undefined;
    process.env.DAILY_CENTS_BUDGET_TRUSTED = undefined;
    expect(dailyCentsBudget("public")).toBeNull();
    expect(dailyCentsBudget("trusted")).toBeNull();
  });

  it("honors a positive env value", () => {
    process.env.DAILY_CENTS_BUDGET_PUBLIC = "50";
    process.env.DAILY_CENTS_BUDGET_TRUSTED = "500";
    expect(dailyCentsBudget("public")).toBe(50);
    expect(dailyCentsBudget("trusted")).toBe(500);
  });

  it("is null (not a default) on a malformed or non-positive value", () => {
    process.env.DAILY_CENTS_BUDGET_PUBLIC = "not-a-number";
    process.env.DAILY_CENTS_BUDGET_TRUSTED = "-5";
    expect(dailyCentsBudget("public")).toBeNull();
    expect(dailyCentsBudget("trusted")).toBeNull();
  });
});

describe("cost accounting + cost cap", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("recordUsage accumulates costMicros atomically alongside tokens", () => {
    withFresh(() => {
      recordUsage("u1", 100, 50, undefined, 2800);
      expect(getTodayUsage("u1")).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        total: 150,
        costMicros: 2800,
      });
      recordUsage("u1", 10, 10, undefined, 1200);
      expect(getTodayUsage("u1").costMicros).toBe(4000);
    });
  });

  it("clamps NaN/negative cost to 0", () => {
    withFresh(() => {
      recordUsage("u1", 10, 10, undefined, Number.NaN);
      expect(getTodayUsage("u1").costMicros).toBe(0);
      recordUsage("u1", 0, 0, undefined, -500);
      expect(getTodayUsage("u1").costMicros).toBe(0);
    });
  });

  it("isOverDailyCostCap is false when no cents budget is configured", () => {
    process.env.DAILY_CENTS_BUDGET_PUBLIC = undefined;
    withFresh(() => {
      recordUsage("u1", 0, 0, undefined, 9_999_999);
      expect(isOverDailyCostCap("u1", "public")).toBe(false);
    });
  });

  it("trips at the cents boundary (1 cent = 10_000 micro-dollars, >=)", () => {
    process.env.DAILY_CENTS_BUDGET_PUBLIC = "1";
    withFresh(() => {
      recordUsage("u1", 0, 0, undefined, 9_999); // just under 1 cent
      expect(isOverDailyCostCap("u1", "public")).toBe(false);
      recordUsage("u1", 0, 0, undefined, 1); // exactly 10_000 = 1 cent
      expect(isOverDailyCostCap("u1", "public")).toBe(true);
    });
  });

  it("token cap and cost cap are independent (one trips, the other doesn't)", () => {
    process.env.DAILY_TOKEN_BUDGET_PUBLIC = "1000000"; // effectively unbounded here
    process.env.DAILY_CENTS_BUDGET_PUBLIC = "1"; // 1 cent
    withFresh(() => {
      recordUsage("u1", 100, 50, undefined, 10_000); // tiny tokens, 1 cent cost
      expect(isOverDailyCap("u1", "public")).toBe(false); // under the token cap
      expect(isOverDailyCostCap("u1", "public")).toBe(true); // at the cost cap
    });
  });
});
