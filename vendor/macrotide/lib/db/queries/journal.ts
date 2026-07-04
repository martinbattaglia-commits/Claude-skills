import "server-only";
import { and, desc, eq, gte, isNull, type SQL } from "drizzle-orm";
import { getDb } from "../context";
import { journalEntries } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalEntryInsert = typeof journalEntries.$inferInsert;
export type JournalEntryUpdate = Partial<Omit<JournalEntryInsert, "id" | "createdAt">>;

export type JournalKind = "note" | "decision" | "question" | "reading";

export interface JournalFilters {
  kind?: JournalKind;
  since?: string; // ISO date string
  includeArchived?: boolean;
  limit?: number;
}

export function listJournalEntries(filters: JournalFilters = {}): JournalEntry[] {
  const where: SQL[] = [ownedBy(journalEntries.userId)];
  if (filters.kind) where.push(eq(journalEntries.kind, filters.kind));
  if (filters.since) where.push(gte(journalEntries.createdAt, filters.since));
  if (!filters.includeArchived) where.push(isNull(journalEntries.archivedAt));

  const q = getDb()
    .select()
    .from(journalEntries)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(journalEntries.pinned), desc(journalEntries.createdAt));

  return (filters.limit ? q.limit(filters.limit) : q).all();
}

export function getJournalEntry(id: number): JournalEntry | undefined {
  return getDb()
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), ownedBy(journalEntries.userId)))
    .get();
}

export function createJournalEntry(input: Omit<JournalEntryInsert, "createdAt">): JournalEntry {
  return (
    getDb()
      .insert(journalEntries)
      // Stamp ownership AFTER the input spread so a client-supplied `userId` can't
      // override the server's owner scoping (#190).
      .values({ ...input, userId: ownerId(), createdAt: new Date().toISOString() })
      .returning()
      .get()
  );
}

export function updateJournalEntry(
  id: number,
  patch: JournalEntryUpdate,
): JournalEntry | undefined {
  return getDb()
    .update(journalEntries)
    .set(patch)
    .where(and(eq(journalEntries.id, id), ownedBy(journalEntries.userId)))
    .returning()
    .get();
}

export function archiveJournalEntry(id: number): void {
  getDb()
    .update(journalEntries)
    .set({ archivedAt: new Date().toISOString() })
    .where(and(eq(journalEntries.id, id), ownedBy(journalEntries.userId)))
    .run();
}

export function deleteJournalEntry(id: number): void {
  getDb()
    .delete(journalEntries)
    .where(and(eq(journalEntries.id, id), ownedBy(journalEntries.userId)))
    .run();
}
