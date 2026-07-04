import "server-only";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, ne } from "drizzle-orm";
import type { TurnCards } from "../../advisor/turn-persist";
import { getDb } from "../context";
import { chatMessages, chatThreads } from "../schema";
import { ownedBy, ownerId } from "./scope";

export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type ChatRole = "user" | "assistant" | "tool" | "summary";

/**
 * Per-message attachment metadata for an image turn, stored JSON-encoded in
 * `chat_messages.attachments`. Holds NO image bytes (images aren't stored
 * server-side — see SECURITY.md), only the facts needed to recompose the
 * model-facing "(Attached files: …)" note at model-build time so `content`
 * stays raw user text. `capturedAtSource` records where the timestamp came
 * from: parsed EXIF (`exif`), EXIF wall-time assumed Asia/Bangkok when the
 * image carried no offset (`exif-assumed-tz`), or the file's mtime (`file`).
 */
export interface ChatAttachmentMeta {
  name: string;
  mime: string;
  /** ISO-8601 instant with offset; absent when no capture time is known. */
  capturedAt?: string;
  capturedAtSource: "exif" | "exif-assumed-tz" | "file";
}

/**
 * Role marker for the context-compression summary row. Stored in
 * the free-TEXT `chat_messages.role` column (no migration). These rows are an
 * internal model-input artifact: excluded from display ({@link listMessages}'s
 * `includeInternal` filter) and from FTS search. Keep in sync with
 * `SUMMARY_ROLE` in lib/ai/summarize.ts.
 */
export const SUMMARY_ROLE = "summary";
/**
 * Session lifecycle states. Deletion is intentionally NOT a status —
 * it lives on `deletedAt` (30-day trash) so a thread can be e.g. archived AND
 * trashed independently.
 */
export type ThreadStatus = "active" | "idle" | "archived";

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * List active (non-deleted) threads, newest activity first. Pass
 * `includeDeleted: true` to bypass the soft-delete filter (admin / debug);
 * UI listings should leave it false and use {@link listDeletedThreads} for
 * the trash group.
 */
export function listThreads(opts: { includeDeleted?: boolean } = {}): ChatThread[] {
  const owner = ownedBy(chatThreads.userId);
  const where = opts.includeDeleted ? owner : and(owner, isNull(chatThreads.deletedAt));
  return getDb().select().from(chatThreads).where(where).orderBy(desc(chatThreads.updatedAt)).all();
}

/**
 * List soft-deleted threads still within the restore window (default 30
 * days). Older trash isn't shown; a maintenance job purges it later. Order
 * is most-recently-deleted first.
 */
export function listDeletedThreads(daysAgo = 30): ChatThread[] {
  const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  return getDb()
    .select()
    .from(chatThreads)
    .where(
      and(
        ownedBy(chatThreads.userId),
        isNotNull(chatThreads.deletedAt),
        gt(chatThreads.deletedAt, cutoff),
      ),
    )
    .orderBy(desc(chatThreads.deletedAt))
    .all();
}

export function getThread(id: string): ChatThread | undefined {
  return getDb()
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, id), ownedBy(chatThreads.userId)))
    .get();
}

export function createThread(input: { title?: string | null } = {}): ChatThread {
  const now = new Date().toISOString();
  return getDb()
    .insert(chatThreads)
    .values({
      id: randomId(),
      userId: ownerId(),
      title: input.title ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function renameThread(id: string, title: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(and(eq(chatThreads.id, id), ownedBy(chatThreads.userId)))
    .returning()
    .get();
}

/**
 * Move a thread to the trash. Row stays in the table with
 * `deletedAt = now()`; {@link listThreads} hides it,
 * {@link listDeletedThreads} surfaces it for the 30-day restore window.
 * Hard-removal is {@link purgeThread}.
 */
export function softDeleteThread(id: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ deletedAt: new Date().toISOString() })
    .where(and(eq(chatThreads.id, id), ownedBy(chatThreads.userId)))
    .returning()
    .get();
}

/** Undo {@link softDeleteThread} — clears `deleted_at`. */
export function restoreThread(id: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ deletedAt: null, updatedAt: new Date().toISOString() })
    .where(and(eq(chatThreads.id, id), ownedBy(chatThreads.userId)))
    .returning()
    .get();
}

/**
 * Hard-delete a thread and its messages (cascade). Use only for "Delete
 * forever" from the trash; the regular delete button should call
 * {@link softDeleteThread}.
 */
export function purgeThread(id: string): void {
  // chat_messages cascade-delete via foreign key.
  getDb()
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, id), ownedBy(chatThreads.userId)))
    .run();
}

/**
 * Purge any soft-deleted threads older than `daysAgo` (default 30) — the
 * hard-delete half of the trash's "30-day restore window" promise. Runs from
 * the stale-session sweep job. Returns the number of threads removed.
 */
export function purgeExpiredDeletedThreads(daysAgo = 30): number {
  const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  // chat_messages cascade-delete via foreign key.
  const result = getDb()
    .delete(chatThreads)
    .where(
      and(
        ownedBy(chatThreads.userId),
        isNotNull(chatThreads.deletedAt),
        lt(chatThreads.deletedAt, cutoff),
      ),
    )
    .run();
  return result.changes;
}

// ───────────────────────────────────────────────────────────────────────────
// Session lifecycle. `status`: active → idle on session close
// (lib/memory/session-close.ts), idle → active on resume (reactivateThread).
// The lib/jobs/close-stale-sessions.ts backstop closes active threads that
// never got an explicit close. Deletion stays orthogonal on `deletedAt`.
// ───────────────────────────────────────────────────────────────────────────

/** Mark a thread idle. No-op timestamp bump — does not touch `updatedAt`. */
export function markIdle(threadId: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ status: "idle" })
    .where(and(eq(chatThreads.id, threadId), ownedBy(chatThreads.userId)))
    .returning()
    .get();
}

/**
 * Archive a thread: set `status = 'archived'` and stamp `archivedAt`. Leaves
 * `updatedAt` untouched so idle-age computation reflects real activity, not
 * the archival write.
 */
export function archiveThread(threadId: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ status: "archived", archivedAt: new Date().toISOString() })
    .where(and(eq(chatThreads.id, threadId), ownedBy(chatThreads.userId)))
    .returning()
    .get();
}

/**
 * Resume a session: flip `idle`/`archived` back to `active` (and clear
 * `archivedAt`). Called when a new message lands on an existing thread, so a
 * reopened chat becomes eligible to close + extract again. No-op on a thread
 * already `active`. The extraction watermark is intentionally left intact so
 * the next close extracts only the resumed turns.
 */
export function reactivateThread(threadId: string): ChatThread | undefined {
  return getDb()
    .update(chatThreads)
    .set({ status: "active", archivedAt: null })
    .where(
      and(
        eq(chatThreads.id, threadId),
        ne(chatThreads.status, "active"),
        ownedBy(chatThreads.userId),
      ),
    )
    .returning()
    .get();
}

/** Advance the incremental-extraction watermark to `turnId`. */
export function setExtractedThrough(threadId: string, turnId: number): void {
  getDb()
    .update(chatThreads)
    .set({ extractedThroughId: turnId })
    .where(and(eq(chatThreads.id, threadId), ownedBy(chatThreads.userId)))
    .run();
}

/**
 * List threads in a given lifecycle status, newest activity first. Excludes
 * soft-deleted threads (trash is orthogonal to lifecycle).
 */
export function listByStatus(status: ThreadStatus): ChatThread[] {
  return getDb()
    .select()
    .from(chatThreads)
    .where(
      and(
        ownedBy(chatThreads.userId),
        eq(chatThreads.status, status),
        isNull(chatThreads.deletedAt),
      ),
    )
    .orderBy(desc(chatThreads.updatedAt))
    .all();
}

/**
 * Find `status = 'active'` threads whose last activity (`updatedAt`) is older
 * than `olderThanDays` days — i.e. archival candidates. The boundary is
 * inclusive: a thread updated exactly `olderThanDays` ago (or earlier) is
 * returned. Soft-deleted threads are excluded.
 */
export function findIdleThreads(olderThanDays: number): ChatThread[] {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString();
  return getDb()
    .select()
    .from(chatThreads)
    .where(
      and(
        ownedBy(chatThreads.userId),
        eq(chatThreads.status, "active"),
        isNull(chatThreads.deletedAt),
        lte(chatThreads.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(chatThreads.updatedAt))
    .all();
}

// chat_messages has no own `user_id` — message access rides on thread
// ownership. Callers reach these only after resolving a threadId through a
// user-scoped thread read (getThread / listThreads), and route-level
// enforcement (the per-user query scoping) gates the rest. In single-owner
// mode this is a no-op.

/**
 * List a thread's messages oldest-first. By default the internal
 * context-summary rows ({@link SUMMARY_ROLE}) are excluded — they are a
 * model-input artifact, not part of the visible conversation. Pass
 * `includeInternal: true` to get them too (e.g. for audit).
 */
export function listMessages(
  threadId: string,
  opts: { includeInternal?: boolean } = {},
): ChatMessage[] {
  const rows = getDb()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .all();
  if (opts.includeInternal) return rows;
  return rows.filter((m) => m.role !== SUMMARY_ROLE);
}

/**
 * Store (or refresh) the context-compression summary for a thread.
 * Migration-free: writes a {@link SUMMARY_ROLE} row into `chat_messages`.
 * Exactly one summary row is kept per thread — a prior one is replaced. This
 * NEVER touches user/assistant rows, so the persisted conversation is intact;
 * summarization only ever compresses the model's *input view*.
 */
export function upsertSummary(threadId: string, content: string): ChatMessage {
  const db = getDb();
  db.delete(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, SUMMARY_ROLE)))
    .run();
  return db
    .insert(chatMessages)
    .values({
      threadId,
      role: SUMMARY_ROLE,
      content,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

/** Latest stored context-compression summary for a thread, if any. */
export function getLatestSummary(threadId: string): ChatMessage | undefined {
  return getDb()
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, SUMMARY_ROLE)))
    .orderBy(desc(chatMessages.id))
    .get();
}

export function appendMessage(input: {
  threadId: string;
  role: ChatRole;
  content: string;
  toolCallId?: string | null;
  /** The OpenRouter / provider model id that served this response. */
  model?: string | null;
  /**
   * Structured attachment metadata for an image turn. JSON-encoded on write;
   * omitted (NULL) for text turns and non-user rows. Never holds image bytes.
   */
  attachments?: ChatAttachmentMeta[] | null;
  /**
   * propose_* tool payloads generated by an assistant turn (the in-chat import
   * tables / proposals). JSON-encoded on write; NULL for turns with no cards.
   * Lets the cards survive reload / other devices (see {@link TurnCards}).
   */
  cards?: TurnCards | null;
}): ChatMessage {
  const now = new Date().toISOString();
  const row = getDb()
    .insert(chatMessages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      model: input.model ?? null,
      attachments: input.attachments?.length ? JSON.stringify(input.attachments) : null,
      cards: input.cards ? JSON.stringify(input.cards) : null,
      createdAt: now,
    })
    .returning()
    .get();
  // Bump the thread's updatedAt so listThreads() orders by most-recent activity.
  getDb()
    .update(chatThreads)
    .set({ updatedAt: now })
    .where(and(eq(chatThreads.id, input.threadId), ownedBy(chatThreads.userId)))
    .run();
  return row;
}

export function setMessageFeedback(
  id: number,
  threadId: string,
  feedback: "up" | "down" | null,
): ChatMessage | undefined {
  return getDb()
    .update(chatMessages)
    .set({ feedback })
    .where(and(eq(chatMessages.id, id), eq(chatMessages.threadId, threadId)))
    .returning()
    .get();
}

/**
 * Remove the thread's most recent assistant reply — the server half of
 * "Regenerate" (the client then re-asks the preceding user turn, appending a
 * fresh reply). Id-agnostic so it works whether the regenerated turn was live
 * or reloaded. Scoped to a thread the caller owns; the user turn and the
 * internal summary row are left intact. The FTS mirror cleans up via its
 * AFTER DELETE trigger. Returns true when a reply was removed.
 */
export function deleteLatestAssistantTurn(threadId: string): boolean {
  const db = getDb();
  // Only the thread's owner may regenerate it.
  const thread = db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), ownedBy(chatThreads.userId)))
    .get();
  if (!thread) return false;
  const latest = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, "assistant")))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .get();
  if (!latest) return false;
  db.delete(chatMessages).where(eq(chatMessages.id, latest.id)).run();
  return true;
}
