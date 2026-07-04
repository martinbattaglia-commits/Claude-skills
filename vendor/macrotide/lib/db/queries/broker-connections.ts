import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../context";
import { brokerConnections } from "../schema";
import { createBucket, getBucket } from "./buckets";
import { ownedBy, ownerId } from "./scope";

// Broker-import connections: the account_code → portfolio (bucket) mapping plus
// last-sync status. Owner-scoped like buckets (scope.ts). Uniqueness per
// (user, source, account_code) is enforced here (NULL user_id rows are distinct
// in the SQLite unique index, so we find-then-write rather than rely on it).

export type BrokerConnection = typeof brokerConnections.$inferSelect;

export function listBrokerConnections(): BrokerConnection[] {
  return getDb()
    .select()
    .from(brokerConnections)
    .where(ownedBy(brokerConnections.userId))
    .orderBy(brokerConnections.accountCode)
    .all();
}

export function getBrokerConnection(
  source: string,
  accountCode: string,
): BrokerConnection | undefined {
  return getDb()
    .select()
    .from(brokerConnections)
    .where(
      and(
        eq(brokerConnections.source, source),
        eq(brokerConnections.accountCode, accountCode),
        ownedBy(brokerConnections.userId),
      ),
    )
    .get();
}

interface ConnectionPatch {
  source: string;
  accountCode: string;
  displayName?: string | null;
  bucketId?: string | null;
  lastSyncedAt?: string | null;
  lastInserted?: number;
  lastSkipped?: number;
}

/** Create or update the connection for (source, accountCode); only provided fields change. */
export function upsertBrokerConnection(input: ConnectionPatch): BrokerConnection {
  const db = getDb();
  const existing = getBrokerConnection(input.source, input.accountCode);

  // Build a patch of only the fields the caller actually supplied.
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.bucketId !== undefined) patch.bucketId = input.bucketId;
  if (input.lastSyncedAt !== undefined) patch.lastSyncedAt = input.lastSyncedAt;
  if (input.lastInserted !== undefined) patch.lastInserted = input.lastInserted;
  if (input.lastSkipped !== undefined) patch.lastSkipped = input.lastSkipped;

  if (existing) {
    return db
      .update(brokerConnections)
      .set(patch)
      .where(eq(brokerConnections.id, existing.id))
      .returning()
      .get();
  }
  return db
    .insert(brokerConnections)
    .values({
      userId: ownerId(),
      source: input.source,
      accountCode: input.accountCode,
      displayName: input.displayName ?? null,
      bucketId: input.bucketId ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
      lastInserted: input.lastInserted ?? 0,
      lastSkipped: input.lastSkipped ?? 0,
    })
    .returning()
    .get();
}

/** Point a connection at a different portfolio (remap / merge). No-op if missing. */
export function setBrokerConnectionBucket(
  source: string,
  accountCode: string,
  bucketId: string,
): BrokerConnection | undefined {
  const existing = getBrokerConnection(source, accountCode);
  if (!existing) return undefined;
  return getDb()
    .update(brokerConnections)
    .set({ bucketId, updatedAt: new Date().toISOString() })
    .where(eq(brokerConnections.id, existing.id))
    .returning()
    .get();
}

/** Delete one connection (unlink). Returns rows removed (0 if not found). */
export function deleteBrokerConnection(source: string, accountCode: string): number {
  const existing = getBrokerConnection(source, accountCode);
  if (!existing) return 0;
  return getDb().delete(brokerConnections).where(eq(brokerConnections.id, existing.id)).run()
    .changes;
}

/**
 * The portfolio an account's orders route to: the mapped bucket if it still
 * exists, else a freshly created plan-named portfolio (recording the mapping).
 * This is the "mirror the broker by default, respect the user's mapping after"
 * rule in one place.
 */
export function resolveAccountBucket(
  source: string,
  accountCode: string,
  planName: string,
): { bucketId: string; created: boolean } {
  const conn = getBrokerConnection(source, accountCode);
  if (conn?.bucketId && getBucket(conn.bucketId)) {
    return { bucketId: conn.bucketId, created: false };
  }
  const name = planName.trim() || `Account ${accountCode}`;
  const bucket = createBucket({ id: randomUUID(), name, brokerage: accountCode });
  upsertBrokerConnection({ source, accountCode, displayName: planName, bucketId: bucket.id });
  return { bucketId: bucket.id, created: true };
}
