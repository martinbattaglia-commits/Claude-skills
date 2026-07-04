// Backstop sweep for sessions that never got an explicit close signal — e.g.
// the user closed the browser without starting a new chat. The primary close
// path is real-time on session end (lib/memory/session-close.ts via the /close
// route); this job only catches what that missed.
//
// Runs ONCE PER USER SCOPE: the single-owner NULL set plus every registered
// user id, each entered via runWithUserScope so the user-scoped queries
// (findIdleThreads, purgeExpiredDeletedThreads) see exactly that user's rows —
// the sweep never bypasses per-user row scoping, it iterates it. Within each
// scope it closes `active` threads idle longer than `idleDays` (closeSession:
// extract durable facts + mark idle) and hard-deletes trash past its 30-day
// restore window — this sweep is the only place that purge runs. Idempotent: a
// closed thread is no longer `active` and a purged thread is gone, so a rerun
// finds nothing. Safe to schedule or run ad-hoc.
import { runWithUserScope } from "../db/context";
import { listUserIds } from "../db/queries/admin";
import { findIdleThreads, purgeExpiredDeletedThreads } from "../db/queries/chat";
import { type CloseSessionResult, closeSession } from "../memory/session-close";

/** Default idle window before a stale `active` session is force-closed. */
export const DEFAULT_IDLE_DAYS = 7;

export interface CloseStaleResult {
  /** Thread IDs transitioned active → idle this run, across all user scopes. */
  closedThreadIds: string[];
  /** Count closed this run (0 on a no-op repeat run). */
  closedCount: number;
  /** Total durable facts extracted across all closed sessions this run. */
  extractedCount: number;
  /** Soft-deleted threads hard-removed because their 30-day trash window expired. */
  purgedCount: number;
  /** User scopes swept this run (null = the single-owner row set). */
  scopesSwept: (string | null)[];
}

export interface CloseStaleOptions {
  /** Idle threshold in days; `active` threads idle longer than this are closed. */
  idleDays?: number;
  /**
   * User scopes to sweep. Defaults to the NULL single-owner set plus every
   * registered user id — override only in tests.
   */
  scopes?: (string | null)[];
  /** Close dependency — injectable for tests. Defaults to the real closeSession. */
  close?: (threadId: string, userId: string | null) => Promise<CloseSessionResult>;
  /** Trash-purge dependency — injectable for tests. Defaults to the real purge. */
  purge?: () => number;
}

/**
 * For each user scope, close every `active` thread idle for more than
 * `idleDays` days and purge expired trash.
 *
 * Idempotent by construction — `closeSession` only acts on `active` threads and
 * flips each to `idle`, so a subsequent run finds nothing. Extraction failures
 * never block the close (best-effort, inherited from `closeSession`).
 */
export async function closeStaleSessions(
  options: CloseStaleOptions = {},
): Promise<CloseStaleResult> {
  const idleDays = options.idleDays ?? DEFAULT_IDLE_DAYS;
  const close =
    options.close ?? ((id: string, userId: string | null) => closeSession(id, { userId }));
  const purge = options.purge ?? purgeExpiredDeletedThreads;
  const scopes = options.scopes ?? [null, ...listUserIds()];

  const closedThreadIds: string[] = [];
  let extractedCount = 0;
  let purgedCount = 0;

  for (const userId of scopes) {
    await runWithUserScope(userId, async () => {
      const candidates = findIdleThreads(idleDays);
      for (const thread of candidates) {
        const result = await close(thread.id, userId);
        if (result.closed) {
          closedThreadIds.push(thread.id);
          extractedCount += result.extraction?.saved.length ?? 0;
        }
      }
      purgedCount += purge();
    });
  }

  return {
    closedThreadIds,
    closedCount: closedThreadIds.length,
    extractedCount,
    purgedCount,
    scopesSwept: scopes,
  };
}
