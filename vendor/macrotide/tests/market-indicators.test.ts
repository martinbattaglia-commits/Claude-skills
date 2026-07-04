// Integration test (real in-memory SQLite) for the per-user Markets indicator
// list: default fallback, ordered set/get, sanitization, and fail-closed
// per-user scoping (one user's list never leaks to another).

import { describe, expect, it } from "vitest";
import { freshAppDb, freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../lib/db/context";
import {
  getUserIndicatorSymbols,
  setUserIndicatorSymbols,
} from "../lib/db/queries/market-indicators";
import { DEFAULT_INDICATOR_SYMBOLS } from "../lib/market/indicators";

function freshDb() {
  // FK off AFTER migrations (some migrations re-enable the pragma) so the test
  // can use arbitrary user ids without seeding the user table — we're exercising
  // the scoping query logic, not FK enforcement.
  const app = freshAppDb({ foreignKeys: false });
  const market = freshMarketDb();
  return {
    sqlite: app.sqlite,
    db: app.db,
    marketDb: market.db,
    marketSqlite: market.sqlite,
  };
}

/** Run `fn` against a fresh DB scoped to `userId` (null = single-owner mode). */
function as<T>(db: ReturnType<typeof freshDb>, userId: string | null, fn: () => T): T {
  return runWithDbContext(
    {
      appDb: db.db,
      appSqlite: db.sqlite,
      marketDb: db.marketDb,
      marketSqlite: db.marketSqlite,
      isDemo: false,
      sessionId: "test",
      userId,
    },
    fn,
  ) as T;
}

describe("user market indicators", () => {
  it("falls back to the default set when the user has no rows", () => {
    const db = freshDb();
    as(db, null, () => {
      expect(getUserIndicatorSymbols()).toEqual(DEFAULT_INDICATOR_SYMBOLS);
    });
  });

  it("persists the chosen list and preserves order", () => {
    const db = freshDb();
    as(db, null, () => {
      setUserIndicatorSymbols(["THB=X", "^GSPC", "GC=F"]);
      expect(getUserIndicatorSymbols()).toEqual(["THB=X", "^GSPC", "GC=F"]);
    });
  });

  it("drops unknown symbols and de-dupes, keeping first position", () => {
    const db = freshDb();
    as(db, null, () => {
      const saved = setUserIndicatorSymbols(["^GSPC", "NOT_A_THING", "^GSPC", "GC=F"]);
      expect(saved).toEqual(["^GSPC", "GC=F"]);
      expect(getUserIndicatorSymbols()).toEqual(["^GSPC", "GC=F"]);
    });
  });

  it("resets to defaults when set to an empty list", () => {
    const db = freshDb();
    as(db, null, () => {
      setUserIndicatorSymbols(["^GSPC"]);
      setUserIndicatorSymbols([]);
      expect(getUserIndicatorSymbols()).toEqual(DEFAULT_INDICATOR_SYMBOLS);
    });
  });

  it("scopes lists per user — one user's list never leaks to another", () => {
    const db = freshDb();
    as(db, "user-a", () => setUserIndicatorSymbols(["^GSPC", "GC=F"]));
    as(db, "user-b", () => setUserIndicatorSymbols(["THB=X"]));

    as(db, "user-a", () => expect(getUserIndicatorSymbols()).toEqual(["^GSPC", "GC=F"]));
    as(db, "user-b", () => expect(getUserIndicatorSymbols()).toEqual(["THB=X"]));
    // A different/null owner sees neither — falls back to defaults.
    as(db, null, () => expect(getUserIndicatorSymbols()).toEqual(DEFAULT_INDICATOR_SYMBOLS));
  });
});
