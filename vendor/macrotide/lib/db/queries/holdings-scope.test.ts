// Multi-user row scoping for the holdings read layer. Holdings carry no
// user_id of their own — ownership flows through their bucket — so these tests
// pin the invariant that no holdings read can cross user boundaries: one
// user's instrument list (and therefore the advisor portfolio tool, fee-creep
// findings, and the quotes-refresh quota) never includes another's.

import { describe, expect, it } from "vitest";
import { getDb, runWithUserScope } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { getHolding, listHeldQuoteRefs, listHoldings } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger } from "@/lib/db/queries/project-holdings";
import { user } from "@/lib/db/schema";
import { withFreshContext } from "@/tests/db-helpers";

/** Insert a registered user row (FK target for buckets.user_id). */
function seedUser(id: string): void {
  const now = new Date();
  getDb()
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Create a bucket + one held position under the CURRENT user scope. */
function seedHolding(bucketId: string, ticker: string): void {
  createBucket({
    id: bucketId,
    name: bucketId,
    typeLabel: "Test",
    icon: "wallet",
    color: "#000",
    brokerage: "TEST",
  });
  createHoldingViaLedger({
    bucketId,
    ticker,
    englishName: ticker,
    quoteSource: "thai_mutual_fund",
    units: 10,
    avgCost: 1,
  });
}

describe("holdings reads are bucket-ownership scoped", () => {
  it("listHoldings / listHeldQuoteRefs return only the current user's rows", async () => {
    await withFreshContext(async () => {
      seedUser("alice");
      seedUser("bob");
      await runWithUserScope("alice", () => seedHolding("b-alice", "EXAMPLE-FUND-A"));
      await runWithUserScope("bob", () => seedHolding("b-bob", "EXAMPLE-FUND-B"));
      seedHolding("b-owner", "EXAMPLE-FUND-C"); // NULL-owned single-owner set

      await runWithUserScope("alice", () => {
        expect(listHoldings().map((h) => h.ticker)).toEqual(["EXAMPLE-FUND-A"]);
        expect(listHeldQuoteRefs().map((r) => r.ticker)).toEqual(["EXAMPLE-FUND-A"]);
      });
      await runWithUserScope("bob", () => {
        expect(listHoldings().map((h) => h.ticker)).toEqual(["EXAMPLE-FUND-B"]);
      });
      // No user in context → the NULL-owned set only, never everyone's rows.
      expect(listHoldings().map((h) => h.ticker)).toEqual(["EXAMPLE-FUND-C"]);
      expect(listHeldQuoteRefs().map((r) => r.ticker)).toEqual(["EXAMPLE-FUND-C"]);
    });
  });

  it("an explicit foreign bucketId folds to empty, not another user's holdings", async () => {
    await withFreshContext(async () => {
      seedUser("alice");
      seedUser("bob");
      await runWithUserScope("alice", () => seedHolding("b-alice", "EXAMPLE-FUND-A"));

      await runWithUserScope("bob", () => {
        expect(listHoldings("b-alice")).toEqual([]);
      });
      await runWithUserScope("alice", () => {
        expect(listHoldings("b-alice")).toHaveLength(1);
      });
    });
  });

  it("getHolding resolves a foreign id to undefined (sequential ids aren't secret)", async () => {
    await withFreshContext(async () => {
      seedUser("alice");
      seedUser("bob");
      let id = 0;
      await runWithUserScope("alice", () => {
        seedHolding("b-alice", "EXAMPLE-FUND-A");
        id = listHoldings()[0].id;
        expect(getHolding(id)?.ticker).toBe("EXAMPLE-FUND-A");
      });
      await runWithUserScope("bob", () => {
        expect(getHolding(id)).toBeUndefined();
      });
      expect(getHolding(id)).toBeUndefined();
    });
  });
});
