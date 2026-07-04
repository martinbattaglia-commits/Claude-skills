// Real-time session close.
//
// The Advisor saves durable facts in-chat via tools (the primary, model-driven
// path). This module is the BACKSTOP that runs when a session actually ends —
// the user starts a new chat or switches threads — not on a timer. It
// summarizes + extracts durable facts from the closing session, then marks it
// idle. Triggered in real time by POST /api/chat/threads/[id]/close, and swept
// up for missed signals by lib/jobs/close-stale-sessions.ts.
import "server-only";
import {
  type ChatThread,
  getLatestSummary,
  getThread,
  markIdle,
  setExtractedThrough,
} from "../db/queries/chat";
import { type ExtractionResult, extractSessionPreferences } from "./extract";

export interface CloseSessionOptions {
  /** Single owner: null. Threaded into extraction provenance. */
  userId?: string | null;
  /** Injectable extractor for tests; defaults to the real incremental one. */
  extract?: (threadId: string) => Promise<ExtractionResult>;
}

export interface CloseSessionResult {
  threadId: string;
  /** True only when this call transitioned the session `active` → `idle`. */
  closed: boolean;
  /** Extraction result — present only on a real close. */
  extraction?: ExtractionResult;
  /** The thread after the call (idle on a real close; unchanged otherwise). */
  thread?: ChatThread;
}

/**
 * Close a chat session: extract durable facts, then mark it idle.
 *
 * Idempotent by status — only an `active` thread is closed, so a repeat call
 * (or a call on an already-idle / archived / missing thread) is a no-op and
 * extraction never runs twice on the same session (no duplicate `extracted`
 * rows). Best-effort: the extractor swallows its own failures, and even a
 * throwing custom extractor never blocks the idle transition.
 */
export async function closeSession(
  threadId: string,
  opts: CloseSessionOptions = {},
): Promise<CloseSessionResult> {
  const userId = opts.userId ?? null;

  const thread = getThread(threadId);
  if (thread?.status !== "active") {
    return { threadId, closed: false, thread };
  }

  // Incremental: extract only turns past the watermark, giving the extractor
  // the running summary as compressed context for what came before.
  const since = thread.extractedThroughId ?? 0;
  const summary = getLatestSummary(threadId)?.content ?? undefined;
  const extract =
    opts.extract ??
    ((id: string) =>
      extractSessionPreferences(id, { userId, sinceTurnId: since, priorSummary: summary }));

  // Extract while the thread is still `active`, then transition to idle.
  let extraction: ExtractionResult | undefined;
  try {
    extraction = await extract(threadId);
  } catch {
    extraction = undefined;
  }

  // Advance the watermark when this pass covered new turns, so a future close
  // of a resumed session never re-processes them.
  if (extraction?.lastTurnId != null && extraction.lastTurnId > since) {
    setExtractedThrough(threadId, extraction.lastTurnId);
  }

  const updated = markIdle(threadId);
  return { threadId, closed: true, extraction, thread: updated };
}
