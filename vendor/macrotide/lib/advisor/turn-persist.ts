// Pure helpers for persisting an Advisor turn FAITHFULLY — no DB, network, or AI
// SDK imports, so they're unit-testable without mocking the chat route. Consumed
// by app/api/chat/route.ts at persist time.
//
// Two gaps these close (see the chat route):
//   • the UI streams every step's text, but only the FINAL step's text used to be
//     persisted → joinStepText() keeps the whole reply.
//   • tool-generated cards lived only in the browser → extractCards() lifts the
//     propose_* payloads off the turn so the route can persist them on the row.

// Minimal structural shapes — we read only the few fields we need from the AI SDK
// step objects (which carry much more). Kept loose so tests pass plain fixtures.
interface StepLike {
  text?: string;
  finishReason?: string;
  toolCalls?: ReadonlyArray<{ toolName?: string; input?: unknown; args?: unknown }>;
  toolResults?: ReadonlyArray<{ output?: unknown; result?: unknown }>;
}

/**
 * A memory write the Advisor made this turn (save/update/forget/confirm),
 * carried inside a `memory` {@link TurnPart}. The durable record is Journal →
 * Memory; this is the short status-chip payload. Mirrors the client `MemoryEvent`
 * (minus the transient ordering flag — order is now positional in `parts`).
 */
export interface MemoryEventData {
  kind: "save" | "update" | "forget" | "confirm";
  id: number;
  oldId?: number;
  category: string;
  content?: string;
}

/**
 * One ordered slice of an assistant turn: a run of prose, or a memory-write
 * indicator. Persisted in order so a turn that went prose → save → more prose
 * renders the same on reload and across devices — no above/below guessing. A
 * discriminated union so a `tool` variant can be added later without churn.
 */
export type TurnPart = { type: "text"; text: string } | { type: "memory"; event: MemoryEventData };

/**
 * The propose_* tool payloads captured from a turn, persisted as JSON on the
 * assistant message so the in-chat cards survive reload / other devices. Shape
 * mirrors the client `Message` card fields (ChatScreen).
 */
export interface TurnCards {
  holdingsImport?: unknown;
  transactionsImport?: unknown;
  holdings?: unknown[];
  proposal?: unknown;
  // The turn's prose and memory indicators in the order they occurred, so the
  // in-chat render survives reload AND crosses devices. The authoritative body
  // structure; `content` stays the flat prose join for search / copy / legacy.
  parts?: TurnPart[];
}

/**
 * Concatenate every step's assistant text. The UI shows text from all steps
 * (e.g. prose before a tool call + the closing line), so the persisted record
 * must too — not just the final step. Returns "" when there's nothing.
 */
export function joinStepText(steps: ReadonlyArray<StepLike>): string {
  return steps
    .map((s) => (typeof s.text === "string" ? s.text : ""))
    .filter((t) => t.trim() !== "")
    .join("\n\n");
}

const outputOf = (tr: { output?: unknown; result?: unknown }): unknown =>
  tr.output !== undefined ? tr.output : tr.result;

/**
 * Collect a turn's propose_* tool outputs into one payload, or null when the turn
 * produced no cards. Keyed by OUTPUT SHAPE (not tool name) so propose_holding's
 * value-only branch — which emits a `holdingsImport` rather than a `holding` —
 * is captured the same way. Multiple single-holding proposals accumulate into
 * `holdings[]` to match the client's `Message.holdings`.
 */
export function extractCards(steps: ReadonlyArray<StepLike>): TurnCards | null {
  const cards: TurnCards = {};
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      const out = outputOf(tr);
      if (!out || typeof out !== "object") continue;
      const o = out as Record<string, unknown>;
      if (o.holdingsImport) cards.holdingsImport = o.holdingsImport;
      if (o.transactionsImport) cards.transactionsImport = o.transactionsImport;
      if (o.proposal) cards.proposal = o.proposal;
      if (o.holding) {
        cards.holdings ??= [];
        cards.holdings.push(o.holding);
      }
      // Memory events are NOT collected here — they ride `parts` (see buildParts)
      // so their order relative to the prose is preserved.
    }
  }
  return Object.keys(cards).length > 0 ? cards : null;
}

const memoryEventOf = (out: unknown): MemoryEventData | null => {
  if (!out || typeof out !== "object") return null;
  const ev = (out as Record<string, unknown>).memoryEvent;
  if (ev && typeof ev === "object" && "kind" in ev && "id" in ev) {
    return ev as MemoryEventData;
  }
  return null;
};

/**
 * Walk a turn's steps in order and slice it into ordered {@link TurnPart}s: runs
 * of prose split by the memory-write indicators that fell between them. A step's
 * text is flushed as a text part before that step's memory results, so a turn
 * that said something, saved a memory, then said more renders text → memory →
 * text. Consecutive prose with no memory between is merged into one part (joined
 * like {@link joinStepText}) so the body reads as one block, matching the live
 * stream. Returns [] for an empty turn.
 */
export function buildParts(steps: ReadonlyArray<StepLike>): TurnPart[] {
  const parts: TurnPart[] = [];
  const textBuf: string[] = [];
  const flushText = () => {
    const t = textBuf.join("\n\n").trim();
    if (t) parts.push({ type: "text", text: t });
    textBuf.length = 0;
  };
  for (const step of steps) {
    if (typeof step.text === "string" && step.text.trim() !== "") textBuf.push(step.text);
    for (const tr of step.toolResults ?? []) {
      const event = memoryEventOf(outputOf(tr));
      if (event) {
        flushText();
        parts.push({ type: "memory", event });
      }
    }
  }
  flushText();
  return parts;
}

/**
 * One structured diagnostic line per turn, gated by DEBUG_ADVISOR=1 — the served
 * model, the step/finish-reason chain (with tool names), and each tool call's
 * full input (the extracted rows). Local-dev convenience for `npm run dev`; the
 * durable record is the persisted `cards` column. No-op unless the flag is set.
 */
export function debugLogTurn(
  path: string,
  modelId: string | null,
  steps: ReadonlyArray<StepLike>,
): void {
  if (process.env.DEBUG_ADVISOR !== "1") return;
  const chain = steps
    .map((s) => {
      const tools = (s.toolCalls ?? []).map((t) => t.toolName ?? "?").join("+");
      const reason = s.finishReason ?? "?";
      return tools ? `${reason}(${tools})` : reason;
    })
    .join(">");
  console.info(`[advisor] turn (${path}) model=${modelId ?? "unknown"} steps=[${chain}]`);
  for (const step of steps) {
    for (const t of step.toolCalls ?? []) {
      const input = t.input !== undefined ? t.input : t.args;
      console.info(`[advisor]   tool ${t.toolName ?? "?"} in=${JSON.stringify(input)}`);
    }
  }
}
