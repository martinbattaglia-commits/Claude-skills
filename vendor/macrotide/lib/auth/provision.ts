import "server-only";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { accountTier } from "@/lib/db/schema";

/**
 * Provision a freshly-created user. Called from the better-auth
 * `databaseHooks.user.create.after` hook.
 *
 * Two side effects, both within the current DB context (the auth hook wraps
 * this in `runWithDbContext` with the new user's id so `ownerId()` stamps the
 * seeded bucket correctly):
 *   1. Insert an `account_tier` row defaulting to `'public'` (gates AI model
 *      access — see lib/db/queries/usage.ts). Idempotent via ON CONFLICT DO NOTHING.
 *   2. Seed one empty bucket so the dashboard isn't blank on first login.
 *
 * Kept pure of better-auth types so it's unit-testable with the `:memory:`
 * freshDb pattern (see lib/auth/provision.test.ts).
 */
export function provisionNewUser(userId: string): void {
  getDb()
    .insert(accountTier)
    .values({ userId, tier: "public", grantedAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();

  createBucket({
    id: randomUUID(),
    name: "My portfolio",
    // brokerage is a legacy notNull column; "—" matches POST /api/buckets default.
    brokerage: "—",
  });
}
