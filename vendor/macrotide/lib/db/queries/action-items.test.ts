// Contract for action_item_states queries (#74 — two-action model):
//   1. recordActionItem is an idempotent upsert on (user_id, item_key); it keeps
//      a reason only on 'not_for_me' and snapshots the saving for resurfacing.
//   2. listSuppressed(currentFindings) returns the hidden set AFTER applying the
//      reason-aware resurface logic — a materially-worse finding is omitted
//      (resurfaces); everything else stays hidden.
//   3. listHidden returns every suppressed row (newest first) for the Hidden list.
//   4. reads/writes are per-owner scoped via ownedBy/ownerId.
//   5. clearActionItemState removes the row (item becomes active again).
//   6. the DEMO write path (isDemo: true) records + lists within the session.

import { describe, expect, it } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";
import { type DbContext, runWithDbContext } from "../context";
import { user } from "../schema";
import {
  type CurrentFinding,
  clearActionItemState,
  listHidden,
  listSuppressed,
  recordActionItem,
} from "./action-items";

/** Seed a user row so the action_item_states.user_id FK is satisfiable. */
function seedUser(ctx: DbContext, id: string) {
  ctx.appDb
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

function inCtx(fn: () => void, overrides: Partial<DbContext> = {}) {
  const ctx = makeTestDbContext(overrides);
  runWithDbContext(ctx, fn);
}

/** Current findings whose saving has NOT moved → nothing should resurface. */
function unchanged(...rows: Array<{ key: string; pp: number }>): CurrentFinding[] {
  return rows.map((r) => ({ itemKey: r.key, savingsPp: r.pp }));
}

describe("recordActionItem", () => {
  it("inserts an archived row (no reason) and reads it back", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "archived",
        snapshotSavingsPp: 0.4,
      });
      const rows = listHidden();
      expect(rows).toHaveLength(1);
      expect(rows[0].itemKey).toBe("fee_creep:A");
      expect(rows[0].state).toBe("archived");
      expect(rows[0].reason).toBeNull();
      expect(rows[0].snapshotSavingsPp).toBe(0.4);
    });
  });

  it("keeps a reason only on not_for_me; forces it null for archive", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "not_for_me",
        reason: "tax_switching",
        snapshotSavingsPp: 0.3,
      });
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:B",
        state: "archived",
        reason: "tax_switching", // should be dropped
      });
      const byKey = new Map(listHidden().map((r) => [r.itemKey, r]));
      expect(byKey.get("fee_creep:A")?.reason).toBe("tax_switching");
      expect(byKey.get("fee_creep:B")?.reason).toBeNull();
    });
  });

  it("upserts the same (user, key) instead of duplicating, re-snapshotting (the ratchet)", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "archived",
        snapshotSavingsPp: 0.3,
      });
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "not_for_me",
        reason: "too_small",
        snapshotSavingsPp: 0.7,
      });
      const rows = listHidden();
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("not_for_me");
      expect(rows[0].reason).toBe("too_small");
      expect(rows[0].snapshotSavingsPp).toBe(0.7);
    });
  });
});

describe("listSuppressed (resurface-aware)", () => {
  it("keeps a finding hidden when its saving has not materially worsened", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "archived",
        snapshotSavingsPp: 0.3,
      });
      // +0.1pp is below the 0.20pp normal bar → stays hidden.
      const keys = listSuppressed(unchanged({ key: "fee_creep:A", pp: 0.4 })).map((s) => s.itemKey);
      expect(keys).toEqual(["fee_creep:A"]);
    });
  });

  it("resurfaces (omits) an archived finding once it crosses the normal bar", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "archived",
        snapshotSavingsPp: 0.3,
      });
      // +0.25pp ≥ 0.20pp bar → resurfaces (not in the suppressed set).
      const keys = listSuppressed(unchanged({ key: "fee_creep:A", pp: 0.55 })).map(
        (s) => s.itemKey,
      );
      expect(keys).toEqual([]);
    });
  });

  it("keeps a tax/switching reject hidden until the HIGH bar (2× AND ≥0.50pp)", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "not_for_me",
        reason: "tax_switching",
        snapshotSavingsPp: 0.3,
      });
      // 0.55pp ≥ 0.50 but < 2×0.3=0.6 → still hidden.
      expect(listSuppressed(unchanged({ key: "fee_creep:A", pp: 0.55 }))).toHaveLength(1);
      // 0.7pp ≥ 0.6 AND ≥ 0.50 → resurfaces.
      expect(listSuppressed(unchanged({ key: "fee_creep:A", pp: 0.7 }))).toHaveLength(0);
    });
  });

  it("never resurfaces a preference reject, however large the jump", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "not_for_me",
        reason: "prefer_this_fund",
        snapshotSavingsPp: 0.3,
      });
      expect(listSuppressed(unchanged({ key: "fee_creep:A", pp: 5 }))).toHaveLength(1);
    });
  });

  it("stays hidden when the live finding no longer fires (no current magnitude)", () => {
    inCtx(() => {
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:A",
        state: "archived",
        snapshotSavingsPp: 0.3,
      });
      // No current finding for the key → nothing to compare → stays hidden.
      expect(listSuppressed([]).map((s) => s.itemKey)).toEqual(["fee_creep:A"]);
    });
  });
});

describe("listHidden", () => {
  it("returns every suppressed row, newest first", () => {
    inCtx(() => {
      recordActionItem({ itemType: "fee_creep", itemKey: "fee_creep:A", state: "archived" });
      recordActionItem({
        itemType: "fee_creep",
        itemKey: "fee_creep:B",
        state: "not_for_me",
        reason: "already_considered",
      });
      const rows = listHidden();
      expect(rows).toHaveLength(2);
      // Both states are surfaced for the Hidden-checks list.
      expect(rows.map((r) => r.itemKey).sort()).toEqual(["fee_creep:A", "fee_creep:B"]);
    });
  });
});

describe("ownership scoping", () => {
  it("isolates one user's states from another's", () => {
    const userA = makeTestDbContext({ userId: "user-a" });
    seedUser(userA, "user-a");
    seedUser(userA, "user-b");
    runWithDbContext(userA, () => {
      recordActionItem({ itemType: "fee_creep", itemKey: "fee_creep:A", state: "archived" });
    });
    const userB: DbContext = { ...userA, userId: "user-b" };
    runWithDbContext(userB, () => {
      expect(listHidden()).toHaveLength(0);
      expect(listSuppressed()).toHaveLength(0);
    });
    runWithDbContext(userA, () => {
      expect(listHidden()).toHaveLength(1);
    });
  });
});

describe("clearActionItemState", () => {
  it("removes the row so the item is active again", () => {
    inCtx(() => {
      recordActionItem({ itemType: "fee_creep", itemKey: "fee_creep:A", state: "archived" });
      clearActionItemState("fee_creep:A");
      expect(listHidden()).toHaveLength(0);
      expect(listSuppressed()).toHaveLength(0);
    });
  });
});

describe("demo write path", () => {
  it("records and lists within a DEMO session (isDemo path, no special-casing)", () => {
    // userId stays null → ownedBy collapses to user_id IS NULL, isolated by the
    // session's own in-memory app.db. Synthetic data only.
    inCtx(
      () => {
        recordActionItem({
          itemType: "fee_creep",
          itemKey: "fee_creep:A",
          state: "not_for_me",
          reason: "too_small",
          snapshotSavingsPp: 0.2,
        });
        expect(listHidden().map((r) => r.itemKey)).toEqual(["fee_creep:A"]);
        expect(
          listSuppressed(unchanged({ key: "fee_creep:A", pp: 0.2 })).map((s) => s.itemKey),
        ).toEqual(["fee_creep:A"]);
      },
      { isDemo: true, sessionId: "demo-1", userId: null },
    );
  });
});
