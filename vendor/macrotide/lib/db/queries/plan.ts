import "server-only";
import { getDb } from "../context";
import { plans } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type Plan = typeof plans.$inferSelect;

// One plan row per user (UNIQUE index on user_id; see migration 0008). In
// single-owner mode (userId null) there is exactly one NULL-owned plan row,
// matching the legacy single-row behavior. Reads/writes are scoped to the
// current user via ownedBy/ownerId.

export function getPlan(): Plan | undefined {
  return getDb().select().from(plans).where(ownedBy(plans.userId)).get();
}

export function upsertPlan(input: { markdown: string; selectedModelId?: string | null }): Plan {
  const now = new Date().toISOString();
  const existing = getPlan();
  if (existing) {
    // biome-ignore lint/style/noNonNullAssertion: getPlan() returned this row, so it exists.
    return getDb()
      .update(plans)
      .set({
        markdown: input.markdown,
        selectedModelId: input.selectedModelId ?? null,
        updatedAt: now,
      })
      .where(ownedBy(plans.userId))
      .returning()
      .get()!;
  }
  return getDb()
    .insert(plans)
    .values({
      userId: ownerId(),
      markdown: input.markdown,
      selectedModelId: input.selectedModelId ?? null,
      updatedAt: now,
    })
    .returning()
    .get();
}
