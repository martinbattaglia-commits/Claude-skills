// Integration contract for the fee-creep suppression filter — the composition
// GET /api/portfolio/fee-creep performs: computeFeeCreep() minus the suppressed
// set (keyed by fee_creep:{heldTicker}, resurface-aware). Covers (#74):
//   - archived findings are hidden
//   - not_for_me findings are hidden
//   - a finding resurfaces once its saving materially worsens past the bar
//   - a preference reject never resurfaces
//   - the DEMO write path (isDemo: true) records + filters within the session
//
// We replay the migration baseline into a fresh in-memory app.db so the new
// action_item_states columns are exercised end-to-end. Synthetic data only.

import { describe, expect, it } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../db/context";
import { type CurrentFinding, listSuppressed, recordActionItem } from "../db/queries/action-items";
import {
  type FundFeeInsert,
  type FundInsert,
  upsertFund,
  upsertFundFees,
} from "../db/queries/funds";
import { createHoldingViaLedger } from "../db/queries/project-holdings";
import * as schema from "../db/schema";
import { feeCreepKey } from "./action-item-key";
import { computeFeeCreep } from "./fee-creep";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

function ter(projId: string, actual: number): FundFeeInsert {
  return {
    projId,
    fundClassName: "A",
    feeType: "total_expense",
    feeTypeRaw: "ค่าธรรมเนียมและค่าใช้จ่ายรวมทั้งหมด (Total Fee and Expense)",
    actualRatePct: actual,
    rateCeilingPct: actual + 0.5,
    periodStart: "2026-01-01",
    periodEnd: null,
  };
}

/** Build a context whose app.db holds two flaggable funds (PRICEY, PRICEY2). */
function seededCtx(overrides: Partial<Pick<DbContext, "isDemo" | "sessionId" | "userId">> = {}) {
  const ctx = makeTestDbContext(overrides);
  runWithDbContext(ctx, () => {
    ctx.appDb
      .insert(schema.buckets)
      .values({ id: "b1", name: "Test", brokerage: "—", createdAt: "x", updatedAt: "x" })
      .run();
    upsertFund(fund("PRICEY"));
    upsertFund(fund("PRICEY2"));
    upsertFund(fund("CHEAP"));
    upsertFundFees([ter("PRICEY", 1.2), ter("PRICEY2", 1.0), ter("CHEAP", 0.3)]);
    createHoldingViaLedger({
      bucketId: "b1",
      ticker: "PRICEY",
      englishName: "p",
      units: 1,
      quoteSource: "thai_mutual_fund",
    });
    createHoldingViaLedger({
      bucketId: "b1",
      ticker: "PRICEY2",
      englishName: "p2",
      units: 1,
      quoteSource: "thai_mutual_fund",
    });
  });
  return ctx;
}

/** Mirror the route's composition: computeFeeCreep minus the resurface-aware suppressed set. */
function visibleFindings() {
  const findings = computeFeeCreep();
  const current: CurrentFinding[] = findings.map((f) => ({
    itemKey: feeCreepKey(f.heldTicker),
    savingsPp: f.savingsPp,
  }));
  const suppressed = new Set(listSuppressed(current).map((s) => s.itemKey));
  return findings.filter((f) => !suppressed.has(feeCreepKey(f.heldTicker)));
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("fee-creep suppression filter", () => {
  it("shows all findings when nothing is suppressed", () => {
    const ctx = seededCtx();
    runWithDbContext(ctx, () => {
      expect(
        visibleFindings()
          .map((f) => f.heldTicker)
          .sort(),
      ).toEqual(["PRICEY", "PRICEY2"]);
    });
  });

  it("hides an archived finding, leaves the others", () => {
    const ctx = seededCtx();
    runWithDbContext(ctx, () => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: feeCreepKey("PRICEY"),
        state: "archived",
        snapshotSavingsPp: 0.9, // PRICEY: 1.2 − 0.3 = 0.9pp
      });
      expect(visibleFindings().map((f) => f.heldTicker)).toEqual(["PRICEY2"]);
    });
  });

  it("hides a not_for_me finding", () => {
    const ctx = seededCtx();
    runWithDbContext(ctx, () => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: feeCreepKey("PRICEY"),
        state: "not_for_me",
        reason: "too_small",
        snapshotSavingsPp: 0.9,
      });
      expect(visibleFindings().map((f) => f.heldTicker)).toEqual(["PRICEY2"]);
    });
  });

  it("never resurfaces a preference reject even if the saving is large", () => {
    const ctx = seededCtx();
    runWithDbContext(ctx, () => {
      // Snapshot a tiny saving, but PRICEY actually saves 0.9pp now — a preference
      // reject must stay hidden regardless.
      recordActionItem({
        itemType: "fee_creep",
        itemKey: feeCreepKey("PRICEY"),
        state: "not_for_me",
        reason: "prefer_this_fund",
        snapshotSavingsPp: 0.1,
      });
      expect(visibleFindings().map((f) => f.heldTicker)).toEqual(["PRICEY2"]);
    });
  });

  it("resurfaces an archived finding once its saving materially worsens", () => {
    const ctx = seededCtx();
    runWithDbContext(ctx, () => {
      // Snapshot a small saving; the live finding (0.9pp) is now ≥ 0.20pp worse,
      // so it crosses the normal bar and comes back.
      recordActionItem({
        itemType: "fee_creep",
        itemKey: feeCreepKey("PRICEY"),
        state: "archived",
        snapshotSavingsPp: 0.3,
      });
      expect(
        visibleFindings()
          .map((f) => f.heldTicker)
          .sort(),
      ).toEqual(["PRICEY", "PRICEY2"]);
    });
  });

  it("records and filters within a DEMO session (isDemo path)", () => {
    // The demo write path: userId stays null, ownedBy collapses to user_id IS
    // NULL, isolated by the session's own in-memory app.db. No special-casing.
    const ctx = seededCtx({ isDemo: true, sessionId: "demo-1", userId: null });
    runWithDbContext(ctx, () => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: feeCreepKey("PRICEY"),
        state: "archived",
        snapshotSavingsPp: 0.9,
      });
      expect(visibleFindings().map((f) => f.heldTicker)).toEqual(["PRICEY2"]);
    });
  });
});
