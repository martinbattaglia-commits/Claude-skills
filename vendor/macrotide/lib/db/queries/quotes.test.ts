import { describe, expect, it } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";
import { getMarketDb, runWithDbContext } from "../context";
import { navHistory } from "../schema";
import { navOnDate } from "./quotes";

function withDb<T>(fn: () => T): T {
  return runWithDbContext(makeTestDbContext(), fn) as T;
}

function seed(key: string, rows: [string, number][]): void {
  const db = getMarketDb();
  for (const [date, nav] of rows) db.insert(navHistory).values({ ticker: key, date, nav }).run();
}

describe("navOnDate — NAV on or before a date (#130)", () => {
  it("returns the most recent NAV on or before the target date", () => {
    const got = withDb(() => {
      seed("thai_mutual_fund:K-USA-A", [
        ["2026-01-01", 10],
        ["2026-02-01", 12],
        ["2026-03-01", 15],
      ]);
      return navOnDate(["thai_mutual_fund:K-USA-A"], "2026-02-15");
    });
    // 2026-02-01 (12) is the latest row ≤ 2026-02-15, not the later 2026-03-01 (15).
    expect(got.get("thai_mutual_fund:K-USA-A")).toBe(12);
  });

  it("matches an exact date when one exists", () => {
    const got = withDb(() => {
      seed("market:VOO", [
        ["2026-01-01", 400],
        ["2026-02-01", 420],
      ]);
      return navOnDate(["market:VOO"], "2026-02-01");
    });
    expect(got.get("market:VOO")).toBe(420);
  });

  it("omits a key whose only NAV rows are after the date", () => {
    const got = withDb(() => {
      seed("market:VOO", [["2026-03-01", 420]]);
      return navOnDate(["market:VOO"], "2026-02-01");
    });
    expect(got.has("market:VOO")).toBe(false);
  });

  it("resolves each key independently in one batch call", () => {
    const got = withDb(() => {
      seed("thai_mutual_fund:K-USA-A", [
        ["2026-01-01", 10],
        ["2026-02-01", 11],
      ]);
      seed("market:VOO", [["2026-01-15", 400]]);
      return navOnDate(["thai_mutual_fund:K-USA-A", "market:VOO", "market:MISSING"], "2026-01-20");
    });
    expect(got.get("thai_mutual_fund:K-USA-A")).toBe(10); // ≤ 01-20 → the 01-01 row
    expect(got.get("market:VOO")).toBe(400);
    expect(got.has("market:MISSING")).toBe(false);
  });

  it("returns an empty map for no keys without touching the DB", () => {
    expect(navOnDate([], "2026-01-01").size).toBe(0);
  });
});
