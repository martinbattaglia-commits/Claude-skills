import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../context";
import { buckets } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type Bucket = typeof buckets.$inferSelect;
export type BucketInsert = typeof buckets.$inferInsert;
export type BucketUpdate = Partial<Omit<BucketInsert, "id" | "createdAt">>;

export function listBuckets(): Bucket[] {
  // Manual `position` wins; un-positioned rows (NULL) sort last, then by
  // createdAt — so existing books render in today's order until reordered.
  return getDb()
    .select()
    .from(buckets)
    .where(ownedBy(buckets.userId))
    .orderBy(sql`${buckets.position} nulls last`, buckets.createdAt)
    .all();
}

export function getBucket(id: string): Bucket | undefined {
  return getDb()
    .select()
    .from(buckets)
    .where(and(eq(buckets.id, id), ownedBy(buckets.userId)))
    .get();
}

export function createBucket(input: BucketInsert): Bucket {
  return (
    getDb()
      .insert(buckets)
      // Stamp ownership AFTER the input spread so a client-supplied `userId` can't
      // override the server's owner scoping (#190).
      .values({ ...input, userId: ownerId() })
      .returning()
      .get()
  );
}

export function updateBucket(id: string, patch: BucketUpdate): Bucket | undefined {
  return getDb()
    .update(buckets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(and(eq(buckets.id, id), ownedBy(buckets.userId)))
    .returning()
    .get();
}

export function deleteBucket(id: string): void {
  getDb()
    .delete(buckets)
    .where(and(eq(buckets.id, id), ownedBy(buckets.userId)))
    .run();
}

/**
 * Persist a manual ordering: write `position = index` for each id in
 * `orderedIds`. Owner-scoped — each UPDATE is gated by {@link ownedBy}, so a
 * caller can only reorder their own buckets and ids they don't own are no-ops.
 * Runs in a single transaction so the new order lands atomically.
 */
export function reorderBuckets(orderedIds: string[]): void {
  const db = getDb();
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(buckets)
        .set({ position: index })
        .where(and(eq(buckets.id, id), ownedBy(buckets.userId)))
        .run();
    });
  });
}
