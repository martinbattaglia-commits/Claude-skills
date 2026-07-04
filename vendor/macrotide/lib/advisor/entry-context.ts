import type { ModelMessage } from "ai";

// Structured context an "Ask Advisor" entry point hands the server alongside the
// seeded prompt. Most launch buttons already have the relevant facts on screen
// (the tracking gap, the held fund's fee, the alternative) — passing them lets
// the model answer the question directly instead of spending a tool round-trip
// to rediscover what the UI already knew. It rides on the SeedPrompt envelope on
// the client and the /api/chat request body (`entryContext`) on the server, and
// is rendered as a PER-TURN message — never folded into the cached system prefix
// (see entryContextMessage). The shape is intentionally open so it can grow (an
// image handoff for in-chat vision; new screens) without churning its consumers.

export interface EntryContext {
  /** Screen the user launched from: "portfolio" | "funds" | "models" | "journal" | … */
  screen?: string;
  /** Coarse action the button represents: "rebalance" | "fee_switch" | "fund_lookup" | … */
  intent?: string;
  /** The thing in focus — a ticker, a target-model name, a fund abbreviation. */
  subject?: string;
  /** Compact pre-computed facts the UI already has (e.g. `{ trackingGapPp: 6.2 }`). */
  signals?: Record<string, string | number>;
  /**
   * A longer free-text block the screen already has on hand — e.g. the recall-only
   * `body` of a memory the user is editing from Journal → Memory, which is too long
   * for `subject`/`signals` and must not appear in the visible/persisted message.
   * Riding it here lets the Advisor see the whole memory without leaking its id or
   * polluting the chat title. Capped at MAX_DETAIL_LEN.
   */
  detail?: string;
  /**
   * RESERVED for a future in-chat vision handoff: an image reference. Declared so
   * the envelope is the single, forward-compatible place that work will land —
   * not parsed or rendered yet.
   */
  image?: { ref: string; mime?: string };
}

const MAX_SIGNALS = 12;
const MAX_VALUE_LEN = 80;
const MAX_FIELD_LEN = 120;
const MAX_DETAIL_LEN = 2000;

/** True when the envelope carries nothing worth injecting (ignores the unused `image`). */
export function isEmptyEntryContext(ctx: EntryContext | null | undefined): boolean {
  if (!ctx) return true;
  const hasSignals = !!ctx.signals && Object.keys(ctx.signals).length > 0;
  return !ctx.screen && !ctx.intent && !ctx.subject && !hasSignals && !ctx.detail;
}

/**
 * Defensively coerce an untrusted request-body value into an EntryContext (the
 * client controls it). Keeps only string/number fields, caps counts and lengths,
 * and returns null when nothing usable survives. `image` is intentionally not
 * parsed yet (the vision handoff isn't wired).
 */
export function parseEntryContext(raw: unknown): EntryContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_FIELD_LEN) : undefined;

  const ctx: EntryContext = {
    screen: str(r.screen),
    intent: str(r.intent),
    subject: str(r.subject),
    detail:
      typeof r.detail === "string" && r.detail.trim()
        ? r.detail.trim().slice(0, MAX_DETAIL_LEN)
        : undefined,
  };

  if (r.signals && typeof r.signals === "object" && !Array.isArray(r.signals)) {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(r.signals as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_SIGNALS) break;
      if (typeof v === "number" && Number.isFinite(v)) out[k.slice(0, 40)] = v;
      else if (typeof v === "string" && v.trim()) out[k.slice(0, 40)] = v.slice(0, MAX_VALUE_LEN);
    }
    if (Object.keys(out).length) ctx.signals = out;
  }

  return isEmptyEntryContext(ctx) ? null : ctx;
}

/**
 * Render the envelope as a terse, labeled PER-TURN message. The role is `user`,
 * NOT `system`, on purpose: it must sit AFTER the cached system + memory prefix
 * so it can never invalidate the prefix cache (the system prompt is frozen for
 * the session for exactly that reason — see app/api/chat/route.ts). Returns null
 * when there's nothing to say, so the caller can skip injection entirely.
 */
export function entryContextMessage(ctx: EntryContext): ModelMessage | null {
  if (isEmptyEntryContext(ctx)) return null;
  const lines: string[] = [];
  if (ctx.screen) lines.push(`Screen: ${ctx.screen}`);
  if (ctx.intent) lines.push(`Intent: ${ctx.intent}`);
  if (ctx.subject) lines.push(`Subject: ${ctx.subject}`);
  if (ctx.signals) {
    for (const [k, v] of Object.entries(ctx.signals)) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  // Longer free-text last, on its own line, so the labeled fields above stay
  // scannable when the detail spans several lines.
  if (ctx.detail) lines.push(`Detail:\n${ctx.detail}`);
  if (lines.length === 0) return null;
  const body =
    "[Context from the screen the user launched this question from. Use it to " +
    "answer directly; you still have your tools if you need more than this.]\n" +
    lines.join("\n");
  return { role: "user", content: body };
}

/**
 * Return `messages` with the entry context rendered and spliced in immediately
 * BEFORE the latest user turn (so the model reads context → question). A no-op
 * returning the same array when there's nothing to inject. The injected message
 * is a `user` turn that lands AFTER the cached system + memory prefix, so it can
 * never invalidate the prefix cache.
 */
export function injectEntryContext(
  messages: ModelMessage[],
  ctx: EntryContext | null | undefined,
): ModelMessage[] {
  const msg = ctx ? entryContextMessage(ctx) : null;
  if (!msg) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return [...messages.slice(0, i), msg, ...messages.slice(i)];
    }
  }
  return [...messages, msg];
}
