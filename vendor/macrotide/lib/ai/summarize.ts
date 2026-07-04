// Context-budget compression for the chat model input.
//
// When an active session's assembled model input crosses ~80% of the model's
// context budget, we summarize the OLDER turns and replace them — in the
// MODEL'S INPUT VIEW ONLY — with a single compact summary message, keeping the
// most recent turns verbatim. The persisted chat history is never touched:
// summarization compresses what we send to the model, it does not delete rows.
// See docs/explanation/memory.md § Chat session lifecycle (mid-chat) + the
// acceptance criteria there ("a 50-turn session runs at <2× the input-token
// cost of a 5-turn one; summarization never drops messages from the DB").
//
// This is *banner-suggested, not silent*: the chat route surfaces a banner via
// a response header when the threshold is crossed (compressed or not), so the
// user is told their context is being condensed rather than having it happen
// invisibly.
import "server-only";
import { generateText, type ModelMessage } from "ai";
import { resolveExtractorProvider } from "./provider";

// Token estimation heuristic. We deliberately do NOT pull in a tokenizer
// dependency (tiktoken/gpt-tokenizer) for what is a threshold check on cheap
// free models with varied tokenizers — ~4 chars/token is the well-worn
// rule-of-thumb that's accurate enough to decide "are we near the ceiling".
export const CHARS_PER_TOKEN = 4;

// Default context budget in tokens. A conservative floor that comfortably fits
// the free-tier models behind `openrouter/free` (most expose ≥32k). It only
// drives WHEN compression triggers; callers can override per request.
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 32_000;

// Compress once the assembled input crosses this fraction of the budget.
export const SUMMARIZE_THRESHOLD = 0.8;

// How many of the most-recent messages to keep verbatim. Everything older is
// folded into the summary. Tuned so a normal back-and-forth tail survives
// intact (last ~3 turn-pairs) while long scrollback gets condensed.
export const RECENT_MESSAGES_KEPT = 6;

// Per-message token overhead (role tag + framing) baked into estimates so a
// long run of tiny messages isn't undercounted.
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

// Cap how much older transcript we feed the summarizer — bounds the auxiliary
// model cost on a very long session (mirrors lib/memory/extract.ts).
const MAX_TRANSCRIPT_CHARS = 12_000;

// Hard cap on the stored/returned summary so the compressed input stays small
// regardless of what the model returns.
export const MAX_SUMMARY_CHARS = 1_500;

// Role marker for the persisted summary row. `chat_messages.role` is free TEXT,
// so this needs no migration. Rows with this role are excluded from normal
// display and from FTS search; they exist for audit + potential reuse.
export const SUMMARY_ROLE = "summary";

const SUMMARIZATION_SYSTEM_PROMPT = `You compress the earlier part of a conversation between a user and "Advisor", an index-investing assistant for the Thai market.

Write a faithful, information-dense summary of the turns below so the assistant can keep the conversation going without the original text. Preserve:
- what the user asked about and any decisions or conclusions reached;
- durable facts the user stated about themselves (goals, risk tolerance, accounts, constraints, holdings, numbers);
- any plan changes, recommendations, or open questions still in play.

Do NOT invent anything not present. Do NOT include pleasantries. Write in plain prose (a few short paragraphs or tight bullets), third person ("The user…", "Advisor…"). Be concise.`;

/** Extract plain text from a ModelMessage (string or content-part array). */
function textOf(msg: ModelMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          !!p && typeof p === "object" && (p as { type?: string }).type === "text",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough token estimate for a list of model messages (content + overhead). */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(textOf(m)) + PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/** Default summarizer: a cheap-model call via the shared extractor provider. */
async function defaultSummarize(older: ModelMessage[]): Promise<string> {
  const provider = resolveExtractorProvider();
  if (!provider.ready || !provider.model) return "";

  const parts: string[] = [];
  for (const m of older) {
    const text = textOf(m).trim();
    if (!text) continue;
    const role = (m as { role?: string }).role;
    const speaker = role === "assistant" ? "Advisor" : role === "user" ? "User" : role;
    parts.push(`${speaker}: ${text}`);
  }
  let transcript = parts.join("\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the tail — most recent older-turns carry the freshest context.
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }
  if (!transcript) return "";

  try {
    const result = await generateText({
      model: provider.model,
      temperature: 0.2,
      maxOutputTokens: 512,
      system: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Conversation so far:\n\n${transcript}\n\nSummary:` }],
    });
    return (result.text ?? "").trim().slice(0, MAX_SUMMARY_CHARS);
  } catch {
    // Best-effort: a summarizer failure must never drop turns. The caller
    // falls back to the uncompressed input.
    return "";
  }
}

/** Wrap a summary string as the system message injected in place of older turns. */
export function summaryMessage(summary: string): ModelMessage {
  return {
    role: "system",
    content: `## Conversation so far (summarized)\n\n${summary}`,
  };
}

export interface CompressContextOptions {
  /** Context budget in tokens (default {@link DEFAULT_CONTEXT_BUDGET_TOKENS}). */
  budgetTokens?: number;
  /** Fraction of budget that triggers compression (default {@link SUMMARIZE_THRESHOLD}). */
  threshold?: number;
  /** How many recent messages to keep verbatim (default {@link RECENT_MESSAGES_KEPT}). */
  recentMessages?: number;
  /** Tokens already consumed by the top-level system prompt (counted toward the budget). */
  systemTokens?: number;
  /** Override the summarizer (tests inject a deterministic stub — no live model). */
  summarize?: (older: ModelMessage[]) => Promise<string>;
}

export interface CompressionResult {
  /** The messages to send to the model — compressed when over threshold. */
  messages: ModelMessage[];
  /** True when older turns were folded into a summary. */
  compressed: boolean;
  /** True when input crossed the threshold (whether or not we could compress). Drives the banner. */
  thresholdCrossed: boolean;
  /** The summary text, when one was produced. */
  summary: string | null;
  /** Token estimate of the original (system + messages) input. */
  originalTokens: number;
  /** Token estimate of the compressed (system + messages) input. */
  compressedTokens: number;
  /** The budget used for the decision. */
  budgetTokens: number;
}

/**
 * Compress the model input when it crosses ~80% of the context budget.
 *
 * Keeps the last `recentMessages` messages verbatim and replaces everything
 * older with a single summary system message. Returns the input unchanged when
 * under threshold, when there's nothing older to summarize, or when the
 * summarizer yields nothing (best-effort — we never silently drop turns).
 */
export async function compressContext(
  messages: ModelMessage[],
  opts: CompressContextOptions = {},
): Promise<CompressionResult> {
  const budgetTokens = opts.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const threshold = opts.threshold ?? SUMMARIZE_THRESHOLD;
  const recentMessages = opts.recentMessages ?? RECENT_MESSAGES_KEPT;
  const systemTokens = opts.systemTokens ?? 0;
  const summarize = opts.summarize ?? defaultSummarize;

  const originalTokens = systemTokens + estimateMessagesTokens(messages);
  const ceiling = budgetTokens * threshold;

  const base: CompressionResult = {
    messages,
    compressed: false,
    thresholdCrossed: false,
    summary: null,
    originalTokens,
    compressedTokens: originalTokens,
    budgetTokens,
  };

  if (originalTokens <= ceiling) return base;

  // Threshold crossed — the banner should show regardless of whether we can
  // actually compress (e.g. the recent tail alone may already be large).
  base.thresholdCrossed = true;

  const older = messages.slice(0, Math.max(0, messages.length - recentMessages));
  const recent = messages.slice(Math.max(0, messages.length - recentMessages));
  if (older.length === 0) return base; // nothing to fold — keep input as-is

  const summary = await summarize(older);
  if (!summary) return base; // summarizer unavailable/failed — keep input as-is

  const compressedMessages = [summaryMessage(summary), ...recent];
  const compressedTokens = systemTokens + estimateMessagesTokens(compressedMessages);

  return {
    messages: compressedMessages,
    compressed: true,
    thresholdCrossed: true,
    summary,
    originalTokens,
    compressedTokens,
    budgetTokens,
  };
}
