// Full-text search over chat threads + messages.
//
// Messages are indexed by the `chat_messages_fts` external-content FTS5 table
// created in migration 0005; thread titles are short so we match them with a
// plain LIKE rather than a second virtual table. A search returns one hit per
// matching thread (newest activity first), preferring a message snippet when
// the body matched, falling back to a title-only match.
import "server-only";
import { getDbContext, getUserId } from "../context";
import type { ChatThread } from "./chat";

export interface ThreadSearchHit {
  thread: ChatThread;
  /** Highlighted excerpt from the best-matching message, or null for a title-only hit. */
  snippet: string | null;
  /** Where the query matched: a message body, the thread title, or both. */
  matchedOn: "message" | "title" | "both";
}

// Raw shape coming back from better-sqlite3 (snake_case column names).
interface ThreadRowRaw {
  id: string;
  user_id: string | null;
  title: string | null;
  status: "active" | "idle" | "archived";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  extracted_through_id: number | null;
  deleted_at: string | null;
}

function hydrateThread(r: ThreadRowRaw): ChatThread {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
    extractedThroughId: r.extracted_through_id,
    deletedAt: r.deleted_at,
  };
}

/**
 * SQL fragment + bind params scoping `chat_threads` (aliased `t`) to the
 * current user. Fail-closed, mirroring `ownedBy()` in scope.ts: a logged-in
 * user sees ONLY their own rows (`t.user_id = ?`), never the shared NULL-owned
 * set. In single-owner mode (no user in context) this is the `t.user_id IS NULL`
 * set. (A prior version OR-ed in `IS NULL` for logged-in users, which leaked the
 * owner's NULL-owned threads into any user's search results — #188.)
 */
function ownerScope(): { clause: string; params: string[] } {
  const userId = getUserId();
  if (userId === null) return { clause: "AND t.user_id IS NULL", params: [] };
  return { clause: "AND t.user_id = ?", params: [userId] };
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. We tokenize on
 * Unicode letters/numbers (dropping FTS operator characters that would
 * otherwise be a syntax error), quote each token, and append `*` so partial
 * words match as the user types. Tokens are implicitly AND-ed. Returns null
 * when the query has no usable tokens — callers should short-circuit to an
 * empty result rather than run a meaningless match.
 */
export function toFtsMatchQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

export interface SearchThreadsOptions {
  /** Max hits to return (default 20). */
  limit?: number;
  /** Include soft-deleted threads (default false). */
  includeDeleted?: boolean;
}

/**
 * Search chat threads by message body (FTS5) and title (LIKE). Returns at most
 * `limit` threads, newest activity first. Soft-deleted threads are excluded
 * unless `includeDeleted` is set.
 */
export function searchThreads(query: string, opts: SearchThreadsOptions = {}): ThreadSearchHit[] {
  const limit = opts.limit ?? 20;
  const match = toFtsMatchQuery(query);
  const trimmed = query.trim();
  if (match === null || trimmed === "") return [];

  const sqlite = getDbContext().appSqlite;
  const deletedClause = opts.includeDeleted ? "" : "AND t.deleted_at IS NULL";
  const owner = ownerScope();

  // Message-body matches, one row per matching message ordered best-first by
  // bm25 (lower = more relevant). FTS5 auxiliary functions (bm25/snippet) can't
  // be wrapped in a GROUP BY aggregate, so we dedupe to the strongest hit per
  // thread in JS below.
  const messageRows = sqlite
    .prepare(
      `SELECT t.*,
              snippet(chat_messages_fts, 0, '[', ']', '…', 10) AS snippet
       FROM chat_messages_fts
       JOIN chat_messages m ON m.id = chat_messages_fts.rowid
       JOIN chat_threads t ON t.id = m.thread_id
       WHERE chat_messages_fts MATCH ? AND m.role != 'summary' ${deletedClause} ${owner.clause}
       ORDER BY bm25(chat_messages_fts)`,
    )
    .all(match, ...owner.params) as Array<ThreadRowRaw & { snippet: string | null }>;

  // Title matches: one LIKE per token, all required (AND).
  const titleTokens = trimmed.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const titleRows =
    titleTokens.length === 0
      ? []
      : (sqlite
          .prepare(
            `SELECT t.* FROM chat_threads t
             WHERE ${titleTokens.map(() => "lower(t.title) LIKE ?").join(" AND ")} ${deletedClause} ${owner.clause}`,
          )
          .all(...titleTokens.map((t) => `%${t}%`), ...owner.params) as ThreadRowRaw[]);

  // Merge by thread id. A thread matched on body, title, or both.
  const hits = new Map<string, ThreadSearchHit>();
  for (const r of messageRows) {
    // messageRows is ordered best-first; keep the strongest snippet per thread.
    if (hits.has(r.id)) continue;
    hits.set(r.id, { thread: hydrateThread(r), snippet: r.snippet, matchedOn: "message" });
  }
  for (const r of titleRows) {
    const existing = hits.get(r.id);
    if (existing) {
      existing.matchedOn = "both";
    } else {
      hits.set(r.id, { thread: hydrateThread(r), snippet: null, matchedOn: "title" });
    }
  }

  return Array.from(hits.values())
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt))
    .slice(0, limit);
}
