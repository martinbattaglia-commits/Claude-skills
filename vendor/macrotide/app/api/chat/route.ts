import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  type EntryContext,
  injectEntryContext,
  parseEntryContext,
} from "@/lib/advisor/entry-context";
import {
  attachmentLimitMessage,
  composeAttachmentNote,
  countTurnImages,
  isDemoVisionEnabled,
  MAX_CHAT_ATTACHMENTS,
  visionDecisionFor,
} from "@/lib/advisor/image-turn";
import { classifyReasoningIntent } from "@/lib/advisor/intent";
import { ADVISOR_SYSTEM_PROMPT } from "@/lib/advisor/system-prompt";
import { createAdvisorTools } from "@/lib/advisor/tools";
import {
  buildParts,
  debugLogTurn,
  extractCards,
  joinStepText,
  type TurnCards,
  type TurnPart,
} from "@/lib/advisor/turn-persist";
import {
  createVisionTools,
  extractTurnImages,
  stripDriverImages,
  type TurnImage,
  VISION_TOOL_DIRECTIVE,
} from "@/lib/advisor/vision-tool";
import {
  resolveDemoProvider,
  resolveOwnerProvider,
  resolveTierProvider,
  resolveVisionEscalateProvider,
  resolveVisionProvider,
} from "@/lib/ai/provider";
import { compressContext, estimateTokens } from "@/lib/ai/summarize";
import { CHAT_RATE_LIMIT, clientIp, rateLimit } from "@/lib/api/rate-limit";
import { DEMO_COOKIE, withDb } from "@/lib/api/with-db";
import { type DbContext, getUserId, runWithDbContext } from "@/lib/db/context";
import { DEMO_CHAT_TURN_CAP, getDemoSession, incrementChatTurn } from "@/lib/db/demo";
import {
  appendMessage,
  type ChatAttachmentMeta,
  createThread,
  getThread,
  reactivateThread,
  upsertSummary,
} from "@/lib/db/queries/chat";
import {
  dailyTokenBudget,
  estimateCostMicros,
  getTier,
  isOverDailyCap,
  isOverDailyCostCap,
  recordUsage,
} from "@/lib/db/queries/usage";
import { buildMemoryBlock } from "@/lib/memory/inject";
import { createMemoryTools } from "@/lib/memory/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingPayload {
  messages: UIMessage[] | ModelMessage[];
  threadId?: string;
  /** Structured context from an Ask-Advisor entry point (untrusted; parsed). */
  entryContext?: EntryContext;
  /**
   * Per-image attachment metadata for an image turn (untrusted; validated by
   * {@link parseAttachments}). Feeds the model-facing note and is persisted —
   * never image bytes.
   */
  attachments?: unknown;
}

// Validate & clamp the client-supplied `attachments` array before it reaches
// model input or the DB. Client-controlled, so we drop anything malformed:
// require string name/mime, accept an ISO `capturedAt` only if it parses, and
// coerce an unknown `capturedAtSource` to "file". Clamped to MAX_CHAT_ATTACHMENTS.
function parseAttachments(raw: unknown): ChatAttachmentMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachmentMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.mime !== "string") continue;
    const src = o.capturedAtSource;
    const source = src === "exif" || src === "exif-assumed-tz" || src === "file" ? src : "file";
    const capturedAt =
      typeof o.capturedAt === "string" && !Number.isNaN(Date.parse(o.capturedAt))
        ? o.capturedAt
        : undefined;
    out.push({
      name: o.name.slice(0, 200),
      mime: o.mime.slice(0, 100),
      capturedAt,
      capturedAtSource: source,
    });
    if (out.length >= MAX_CHAT_ATTACHMENTS) break;
  }
  return out;
}

// Append the model-facing attachment note to the latest user message's text,
// on a shallow clone so the persisted `content` (raw text) is untouched. Image
// turns send the UIMessage `parts` shape; we fold the note into the first text
// part (or prepend one for an image-only turn) before conversion to model
// messages — keeping the note in the model input but never in the DB.
function injectAttachmentNote(
  messages: UIMessage[] | ModelMessage[],
  note: string,
): UIMessage[] | ModelMessage[] {
  const idx = messages.length - 1;
  const last = messages[idx] as { parts?: unknown };
  if (!Array.isArray(last.parts)) return messages;
  const parts = [...(last.parts as { type?: string; text?: string }[])];
  const textIdx = parts.findIndex((p) => p?.type === "text");
  if (textIdx >= 0) {
    const t = parts[textIdx];
    parts[textIdx] = { ...t, text: t.text ? `${t.text}\n\n${note}` : note };
  } else {
    parts.unshift({ type: "text", text: note });
  }
  const cloned = [...messages] as (UIMessage | ModelMessage)[];
  cloned[idx] = { ...(messages[idx] as object), parts } as UIMessage | ModelMessage;
  return cloned as UIMessage[] | ModelMessage[];
}

async function toModelMessagesAsync(
  messages: UIMessage[] | ModelMessage[],
): Promise<ModelMessage[]> {
  const first = messages[0] as { parts?: unknown };
  if (first && Array.isArray(first.parts)) {
    return await convertToModelMessages(messages as UIMessage[]);
  }
  return messages as ModelMessage[];
}

function extractText(msg: UIMessage | ModelMessage | undefined): string {
  if (!msg) return "";
  // ModelMessage shape: { role, content: string | parts }.
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
  // UIMessage shape: { role, parts: [{ type, text? }] }.
  const parts = (msg as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    return parts
      .filter(
        (p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function deriveTitle(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

// The base instruction layer lives in lib/advisor/system-prompt.ts so the
// committed eval (scripts/eval) measures the exact same prompt the route sends.
const SYSTEM_PROMPT = ADVISOR_SYSTEM_PROMPT;

// Compose the system prompt with the user's active-preference block prepended.
// The block is computed once per request (frozen-for-the-session discipline;
// see docs/explanation/memory.md § Why "frozen for the session") so the prefix
// cache hits across turns of the same session. Writes from memory tools
// during this request land in the DB but do not retroactively change this
// snapshot — they take effect on the next chat.
function composeSystemPrompt(userId: string | null): string {
  const memory = buildMemoryBlock(userId);
  return memory ? `${memory}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT;
}

function stubResponse(message: string, threadId?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  if (threadId) headers["x-thread-id"] = threadId;
  return new Response(
    `data: ${JSON.stringify({ type: "text", text: message })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers },
  );
}

// Observability for the "empty turn" failure mode (issue #21). When a turn ends
// with no assistant prose the row is otherwise dropped — losing which model
// OpenRouter routed to and whether a tool ran. Logging it lets us tell a genuine
// dead-end (no tool; the model just stopped) from a tool-only turn (a read ran
// but the closing prose never came), and pin the responsible free-tier model.
// No behaviour change — diagnostic only; see docs/explanation/advisor-context.md.
function logEmptyTurn(
  path: "demo" | "tiered" | "owner",
  text: string,
  modelId: string | null | undefined,
  finishReason: string,
  steps: readonly { finishReason: string; toolCalls: readonly { toolName: string }[] }[],
): void {
  if (text) return;
  const toolNames = steps.flatMap((s) => s.toolCalls.map((t) => t.toolName));
  const stepReasons = steps.map((s) => s.finishReason).join(">");
  console.warn(
    `[advisor] empty turn (${path}): model=${modelId ?? "unknown"} ` +
      `finishReason=${finishReason} steps=[${stepReasons}] tools=[${toolNames.join(",") || "none"}]`,
  );
}

// One forced follow-up answer when a turn reads a tool but stops before writing
// prose (issue #21). Free-tier models frequently end a turn on a tool call with
// no closing text — the "I didn't have a reply" dead-end. The data is already
// gathered; this directive just makes the model speak. Tools are omitted from
// the follow-up call so it physically cannot stall on another tool call.
const RECOVER_DIRECTIVE =
  "You looked up the data above but didn't reply. Using ONLY those tool results, " +
  "answer my previous question now, in plain language. Do not call any tools.";

// Memory-write tools that actually persist a change. If the model TELLS the user
// it changed a memory but none of these ran in the turn, the write silently never
// happened — a probabilistic failure on every model we've tried (the model
// narrates the change without emitting the tool call, ~half the time on repeated
// edits in one chat). The harness verifies and re-prompts so the write lands; the
// "Memory updated" chip is derived from these tools' structured output, so a
// missed call is also a missing chip (the UI never lied, but nothing got saved).
const MEMORY_WRITE_TOOLS = new Set([
  "save_preference",
  "update_preference",
  "forget_preference",
  "confirm_preference",
]);

const MEMORY_REDO_DIRECTIVE =
  "You told me a saved memory was changed, but you did NOT call the tool that " +
  "performs it — so nothing was actually saved. If a memory should change, call " +
  "the right memory tool now (save_preference / update_preference / " +
  "forget_preference) with the correct arguments. If you misspoke and nothing " +
  "needs saving, say so briefly. Do not repeat your previous message.";

// Served when a turn carries images but inline vision isn't available for it.
// Both point the user at the always-on Add-to-portfolio image importer so they're
// never stuck — the chat just can't look at the image on this path.
const VISION_DEMO_STUB =
  "Reading images in chat isn't available in the demo. Sign up to chat about " +
  "screenshots — or use Add to portfolio → Images to import holdings from one.";
const VISION_DISABLED_STUB =
  "Reading images in chat isn't enabled on this deployment yet. Use Add to portfolio → Images to " +
  "import holdings from a screenshot.";

interface AdvisorStreamOptions {
  ctx: DbContext;
  path: "demo" | "tiered" | "owner";
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxOutputTokens: number;
  threadId: string;
  /** The user EXPLICITLY asked to remember/forget/change a durable preference
   * (lib/advisor/intent.ts). Gates the silent memory-write backstop. */
  memoryIntent: boolean;
  setContextHeader: (res: Response) => void;
  /**
   * Persist the assistant turn. Runs inside the captured DB context. `cards`
   * carries the turn's propose_* payloads (null when none) so the in-chat tables
   * survive reload.
   */
  persist: (text: string, modelId: string | null, cards: TurnCards | null) => void;
  /**
   * Record token usage (and cost) even on an empty turn (free tier). Runs inside
   * ctx. Gets the served `modelId` so the caller can price the turn.
   */
  recordUsageFor?: (usage: {
    inputTokens: number;
    outputTokens: number;
    modelId: string | null;
  }) => void;
}

// Stream an advisor turn with a recover-on-empty safety net. When the first
// generation produces no prose but a tool DID run, issue one more generation
// seeded with the gathered tool results and NO tools, and append it to the same
// response stream. Model-agnostic: it doesn't depend on any free model behaving.
// See docs/explanation/advisor-context.md.
function streamAdvisorResponse(opts: AdvisorStreamOptions): Response {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Run one generation, merge it into the response stream, and collect its
      // outputs. A provider error (free tier) rejects the await chain — we catch
      // it here so the turn can be retried instead of dead-ending. `useTools`
      // is off for the recover-on-empty follow-up so it can't stall again.
      const run = async (
        messages: ModelMessage[],
        useTools: boolean,
        // When set, FORCE a tool call from a restricted set (the memory-write
        // backstop): `toolChoice: "required"` + only these tools, capped to ONE
        // step so "required" can't loop into repeated writes across steps.
        force?: { tools: ToolSet },
        // When true, run the generation but DON'T merge it into the visible
        // stream — used by the silent memory backstop so its bookkeeping prose
        // never reaches the user; only its structured memory result is captured.
        silent = false,
      ) => {
        const gen = streamText({
          model: opts.model,
          system: opts.system,
          messages,
          tools: force ? force.tools : useTools ? opts.tools : undefined,
          toolChoice: force ? "required" : undefined,
          // Multi-step so the model can call a read tool then answer using the
          // result (or explain a proposal after propose_plan_edit). A forced retry
          // runs a single step — emit the tool call, no follow-on generation.
          stopWhen: force ? stepCountIs(1) : stepCountIs(5),
          maxOutputTokens: opts.maxOutputTokens,
        });
        if (!silent) writer.merge(gen.toUIMessageStream());
        try {
          const [text, steps, finishReason, response, usage] = await Promise.all([
            gen.text,
            gen.steps,
            gen.finishReason,
            gen.response,
            gen.totalUsage,
          ]);
          return { ok: true as const, text, steps, finishReason, response, usage };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[advisor] generation error (${opts.path}): ${msg}`);
          return { ok: false as const };
        }
      };

      // First attempt, with tools.
      let a = await run(opts.messages, true);
      // Retry-on-error (#21): a free-tier provider error gathered nothing to
      // recover from — re-roll the turn once (the router picks a fresh model).
      if (!a.ok) {
        console.warn(`[advisor] retrying turn after error (${opts.path})`);
        a = await run(opts.messages, true);
      }

      let text = "";
      let modelId: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let cards: TurnCards | null = null;
      // The turn's prose + memory indicators in order, persisted on the row so
      // the interleaved render survives reload (see buildParts / TurnCards.parts).
      let parts: TurnPart[] = [];

      if (a.ok) {
        // Persist EVERY step's text (the UI shows all of them — e.g. prose before
        // a tool call + the closing line), not just the final step's `a.text`.
        text = joinStepText(a.steps) || a.text;
        parts = buildParts(a.steps);
        modelId = a.response.modelId ?? null;
        inputTokens = a.usage.inputTokens ?? 0;
        outputTokens = a.usage.outputTokens ?? 0;
        // Lift the turn's propose_* card payloads so they persist on the row and
        // survive reload / other devices (previously browser-only).
        cards = extractCards(a.steps);
        debugLogTurn(opts.path, modelId, a.steps);
        logEmptyTurn(opts.path, text, modelId, a.finishReason, a.steps);

        // Recover-on-empty (#21): a read tool ran but no prose came back. Re-ask
        // with the gathered tool results and NO tools so the model can only
        // write the answer.
        const ranTool = a.steps.some((s) => s.toolCalls.length > 0);
        if (!text.trim() && ranTool) {
          const followUp = [
            ...opts.messages,
            ...a.response.messages,
            { role: "user" as const, content: RECOVER_DIRECTIVE },
          ];
          const rec = await run(followUp, false);
          if (rec.ok && rec.text.trim()) {
            text = rec.text;
            // The base turn produced no prose (only the tool ran), so keep any
            // memory indicators it emitted and append the recovered prose after.
            parts = [...parts.filter((p) => p.type === "memory"), { type: "text", text: rec.text }];
            modelId = rec.response.modelId ?? modelId;
            inputTokens += rec.usage.inputTokens ?? 0;
            outputTokens += rec.usage.outputTokens ?? 0;
            console.warn(`[advisor] recovered empty turn (${opts.path}) via follow-up`);
          }
        }

        // Memory-write backstop (SILENT). The trusted tier is floored to `low`
        // reasoning, which lands an explicit save ~100% in eval, so this rarely
        // fires there; it's mainly a net for the cheaper public model (~83% at
        // `none`). Triggers on the USER'S explicit memory intent (precise patterns
        // in classifyReasoningIntent) — not the model's prose claim, which was
        // brittle and chatty. One forced attempt; we capture ONLY the resulting
        // memory indicator (the chip), never the redo's bookkeeping prose, and it
        // never streams — so no "nothing needs saving" repetition reaches the user.
        // Gated on `cards === null` so a plan/holding card-turn isn't forced into a
        // memory write. A miss falls to the session-close extraction net.
        const memoryWriteFired = a.steps.some((s) =>
          s.toolCalls.some((c) => MEMORY_WRITE_TOOLS.has(c.toolName)),
        );
        if (opts.memoryIntent && !memoryWriteFired && cards === null) {
          const memoryTools = Object.fromEntries(
            Object.entries(opts.tools).filter(([name]) => MEMORY_WRITE_TOOLS.has(name)),
          ) as ToolSet;
          if (Object.keys(memoryTools).length > 0) {
            const redo = await run(
              [
                ...opts.messages,
                ...a.response.messages,
                { role: "user" as const, content: MEMORY_REDO_DIRECTIVE },
              ],
              true,
              { tools: memoryTools },
              true, // silent — capture the write, don't show the redo
            );
            if (redo.ok) {
              inputTokens += redo.usage.inputTokens ?? 0;
              outputTokens += redo.usage.outputTokens ?? 0;
              const landed = redo.steps.some((s) =>
                s.toolCalls.some((c) => MEMORY_WRITE_TOOLS.has(c.toolName)),
              );
              // Only the memory indicator(s) — the redo's prose is bookkeeping.
              parts = [...parts, ...buildParts(redo.steps).filter((p) => p.type === "memory")];
              console.warn(
                landed
                  ? `[advisor] memory backstop landed a missed write (${opts.path})`
                  : `[advisor] memory intent but write never landed (${opts.path})`,
              );
            }
          }
        }
      }

      // Surface the served model id on the live message as a TRANSIENT data part
      // (not added to the SDK message history). The badge is admin-only on the
      // client; the value is also persisted on the row for reload. The provider's
      // served id isn't known until generation finishes, so it can't ride a
      // response header — it streams here instead.
      if (modelId) writer.write({ type: "data-model", data: modelId, transient: true });

      // Fold the ordered parts onto the persisted payload so the interleaved
      // render survives reload — even on a memory-only turn that has no cards.
      const cardsToPersist: TurnCards | null = parts.length > 0 ? { ...cards, parts } : cards;

      runWithDbContext(opts.ctx, () => {
        if (text.trim()) opts.persist(text, modelId, cardsToPersist);
        opts.recordUsageFor?.({ inputTokens, outputTokens, modelId });
      });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[advisor] stream error (${opts.path}): ${msg}`);
      return "Something interrupted that reply — your dashboard and notes are unaffected. Please try again.";
    },
  });

  const response = createUIMessageStreamResponse({ stream });
  response.headers.set("x-thread-id", opts.threadId);
  opts.setContextHeader(response);
  return response;
}

export async function POST(req: Request) {
  // IP-keyed rate limit — separate from the per-session demo turn cap; this
  // catches noisy clients regardless of whether they're owner or demo.
  const ip = clientIp(req);
  const rl = rateLimit(ip, CHAT_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rl.resetMs },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(rl.resetMs / 1000).toString() },
      },
    );
  }

  const store = await cookies();
  const demoId = store.get(DEMO_COOKIE)?.value;

  const body = (await req.json().catch(() => ({}))) as IncomingPayload;
  if (!body.messages || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "expected_messages" }, { status: 400 });
  }

  // Demo turn-cap check happens before we open a DB context — the cap is
  // independent of any thread state.
  if (demoId) {
    const session = getDemoSession(demoId);
    if (!session) {
      return NextResponse.json({ error: "demo_session_expired" }, { status: 401 });
    }
    if (session.chatTurnsUsed >= DEMO_CHAT_TURN_CAP) {
      return stubResponse(
        `You've used all ${DEMO_CHAT_TURN_CAP} demo chat turns. Sign up to keep chatting — your demo data won't carry over.`,
      );
    }
  }

  return await withDb(async (ctx) => {
    // Resolve or create a thread. A client that hasn't loaded an existing
    // thread sends no threadId — we create one here and surface it in the
    // response headers so the client can attach to it for follow-up turns.
    const lastUserText = extractText(body.messages[body.messages.length - 1]);
    let threadId = body.threadId;
    if (threadId) {
      const existing = getThread(threadId);
      if (!existing) {
        // Client referenced a thread that doesn't exist in this DB context
        // (e.g. demo session restarted). Fall through to creating a new one.
        threadId = undefined;
      }
    }
    if (!threadId) {
      const created = createThread({ title: deriveTitle(lastUserText) });
      threadId = created.id;
    }

    // Does this turn carry attached images? Detected on the RAW body (before
    // model-message conversion) so the UIMessage `file` parts are still visible.
    const imageCount = countTurnImages(body.messages);
    const hasImages = imageCount > 0;

    // Backstop the composer's per-message image cap. The UI truncates to the
    // limit, so this fires only for a caller that bypasses it — refuse with the
    // same guidance rather than feeding an unbounded image batch to the model.
    // Checked before persisting so an over-limit turn leaves no misleading marker.
    if (imageCount > MAX_CHAT_ATTACHMENTS) {
      return stubResponse(attachmentLimitMessage(imageCount), threadId);
    }

    // Validate the client-supplied attachment metadata (untrusted) once, up
    // front — it both persists and feeds the model-facing note below.
    const attachments = hasImages ? parseAttachments(body.attachments) : [];

    // Persist the latest user message before streaming. Tool-call follow-ups
    // (assistant role at the end) are server-driven and shouldn't double-write.
    // `content` holds ONLY the raw user text — images are never stored
    // server-side; their filename/timestamp metadata rides in the structured
    // `attachments` column (see SECURITY.md), from which the model-facing
    // "(Attached files: …)" note is recomposed below and never persisted. An
    // image-only turn persists `content=""` (the attachments column carries it).
    const lastMsg = body.messages[body.messages.length - 1];
    const lastRole = (lastMsg as { role?: string } | undefined)?.role;
    if (lastRole === "user" && (lastUserText || hasImages)) {
      appendMessage({
        threadId,
        role: "user",
        content: lastUserText,
        attachments: hasImages ? attachments : null,
      });
      // Resume: a new user turn on an idle/archived thread flips it back to
      // active so it's eligible to close + extract again (no-op if active).
      reactivateThread(threadId);
    }

    // The authenticated user id (or `null` in single-owner / pre-auth
    // mode, plumbed by withDb → AsyncLocalStorage). Demo sessions stay `null`:
    // they share the owner's null-namespace inside their isolated per-session
    // in-memory DB (their own preference set without threading session ids
    // through the memory layer), and they're metered by the demo turn cap, not
    // the per-user token budget.
    const userId = demoId ? null : getUserId();
    const system = composeSystemPrompt(userId);
    // Vision-as-a-tool: the chat driver stays on the turn and never receives
    // pixels. Decode this turn's image bytes from the raw body (data URLs, still
    // intact before conversion) to capture in the examine_image tool closure, and
    // strip the image parts from the driver's view. The model-facing note carries
    // the filename + EXIF/saved capture time (so the Advisor can date a snapshot)
    // plus the directive that the only way to read an attachment is the tool.
    // Composed fresh here from validated metadata; never the persisted `content`.
    // Text turns convert byte-identically to before.
    const turnImages: TurnImage[] = hasImages ? extractTurnImages(body.messages) : [];
    const bodyMessages = hasImages
      ? stripDriverImages(
          injectAttachmentNote(
            body.messages,
            `${composeAttachmentNote(attachments, imageCount)}\n${VISION_TOOL_DIRECTIVE}`,
          ),
        )
      : body.messages;
    const modelMessages = await toModelMessagesAsync(bodyMessages);

    // Context-budget compression. When the assembled input crosses
    // ~80% of the model's context budget, fold older turns into a summary and
    // send that in their place — the model INPUT VIEW shrinks, the persisted
    // history is untouched. Best-effort: a summarizer failure leaves the input
    // uncompressed. We surface a banner via the `x-context-summarized` header
    // (suggest/notify, not silent). See lib/ai/summarize.ts.
    const compression = await compressContext(modelMessages, {
      systemTokens: estimateTokens(system),
    });
    if (compression.compressed && compression.summary) {
      // Migration-free persistence: one SUMMARY_ROLE row per thread, excluded
      // from display + search. Never deletes user/assistant rows.
      upsertSummary(threadId, compression.summary);
    }
    const setContextHeader = (res: Response): void => {
      if (compression.thresholdCrossed) {
        res.headers.set("x-context-summarized", compression.compressed ? "1" : "over");
      }
    };

    // Structured entry context from an Ask-Advisor button (defensively parsed —
    // it's client-controlled). Rendered as a per-turn message spliced before the
    // user's question so the model can answer from the carried facts (the fee
    // comparison, the tracking gap) instead of forcing a tool round-trip. Absent
    // for ordinary turns → `messages` is exactly `compression.messages`.
    const entryCtx = parseEntryContext(body.entryContext);
    const messages = injectEntryContext(compression.messages, entryCtx);

    // Reasoning-intent gate (#58): cheaply classify whether THIS turn is genuine
    // multi-step judgment (rebalance/SSF-vs-RMF/tilt) and raise reasoning effort
    // for it, keeping the fast non-reasoning path for the common retrieve-then-
    // explain turn. Applied to owner/trusted only — free/demo stay pinned `none`
    // (cost). `undefined` when the gate is disabled → model-default reasoning.
    // Set REASONING_GATE=off to restore model-default behavior.
    const gateOn = process.env.REASONING_GATE !== "off";
    const reasoningDecision = classifyReasoningIntent(lastUserText, entryCtx);
    const reasoningEffort = gateOn ? reasoningDecision.effort : undefined;
    if (gateOn && reasoningDecision.analytical) {
      console.info(`[advisor] reasoning gate → medium (${reasoningDecision.signals.join(",")})`);
    }

    if (demoId) {
      // The demo chat provider drives every turn (reasoning pinned off — cost).
      // On an image turn it ALSO gets the examine_image vision tool (demo-flavored
      // vision provider, DEMO_OPENROUTER_API_KEY), gated behind the DEMO_VISION
      // opt-in; demo never escalates (cost). conversationId pins cache affinity.
      const provider = resolveDemoProvider({ conversationId: threadId });
      if (!provider.ready || !provider.model) {
        return stubResponse(
          "AI chat isn't configured for demo mode on this deployment yet — the operator needs to set DEMO_OPENROUTER_API_KEY (or share OPENROUTER_API_KEY). Everything else in the app is fully functional, give the buttons a try.",
          threadId,
        );
      }
      const model = provider.model;

      let visionTools: ToolSet = {};
      if (hasImages) {
        const demoVisionEnabled = isDemoVisionEnabled();
        const vision = demoVisionEnabled
          ? resolveVisionProvider({ reasoningEffort: "none", demo: true })
          : { model: null, ready: false, label: "Vision (demo off)" };
        const decision = visionDecisionFor("demo", true, {
          visionReady: vision.ready && !!vision.model,
          demoVisionEnabled,
        });
        if (decision === "stub") return stubResponse(VISION_DEMO_STUB, threadId);
        if (vision.model)
          visionTools = createVisionTools({ images: turnImages, vision: vision.model });
      }
      incrementChatTurn(demoId);
      const finalThreadId = threadId;
      const tools = {
        ...createMemoryTools({ userId }),
        ...createAdvisorTools({ userId }),
        ...visionTools,
      };
      return streamAdvisorResponse({
        ctx,
        path: "demo",
        model,
        system,
        messages,
        tools,
        maxOutputTokens: 1024,
        threadId: finalThreadId,
        memoryIntent: reasoningDecision.memoryIntent,
        setContextHeader,
        persist: (text, modelId, cards) =>
          appendMessage({
            threadId: finalThreadId,
            role: "assistant",
            content: text,
            model: modelId,
            cards,
          }),
      });
    }

    const finalThreadId = threadId;

    // ── Authenticated multi-user path ──────────────────────────────────────
    // A real user means tier gating + a daily token cap. Single-owner /
    // pre-auth mode (userId === null) falls through to the legacy owner path
    // below, which is uncapped and uses the owner model chain — identical to
    // single-owner behavior.
    if (userId !== null) {
      const tier = getTier(userId);

      // Hard gate BEFORE forwarding to OpenRouter: a user already at/over EITHER
      // the token cap or the optional cents cost cap never starts a (possibly
      // paid) request. Both reset at UTC midnight as the usage date key rolls
      // over. The token figure is only surfaced when the token cap is the one
      // that tripped — a cents figure is operator-internal, so a cost-cap stop
      // stays generic.
      const overTokens = isOverDailyCap(userId, tier);
      if (overTokens || isOverDailyCostCap(userId, tier)) {
        const reset =
          "It resets at midnight UTC. Your dashboard and saved notes still work — " +
          "come back tomorrow to keep chatting.";
        const message = overTokens
          ? `You've reached today's usage limit (${dailyTokenBudget(tier).toLocaleString()} tokens). ${reset}`
          : `You've reached today's usage limit. ${reset}`;
        const limit = stubResponse(message, finalThreadId);
        limit.headers.set("x-daily-limit", "reached");
        return limit;
      }

      // The tier chat chain drives every turn (public pins reasoning off; trusted
      // keeps the intent-gated effort), with cache affinity pinned by thread id.
      // On an image turn it ALSO gets the examine_image vision tool. The public-
      // tier cost invariant holds: the driver is PUBLIC_TIER_MODELS and the tool's
      // vision model is VISION_CHAT_MODELS — never TRUSTED_TIER_MODELS — and public
      // never escalates. Vision sub-model usage is a separate generation, so it's
      // folded into recordUsage below to count against the daily caps.
      const provider = resolveTierProvider(tier, {
        reasoningEffort,
        conversationId: finalThreadId,
      });
      if (!provider.ready || !provider.model) {
        return stubResponse(
          `AI chat isn't configured yet (${provider.label}). Set OPENROUTER_API_KEY in .env.local — see docs/reference/auth-and-providers.md.`,
          finalThreadId,
        );
      }
      const model = provider.model;

      const visionExtra = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
      let visionTools: ToolSet = {};
      if (hasImages) {
        const vision = resolveVisionProvider({
          reasoningEffort: tier === "public" ? "none" : reasoningEffort,
        });
        const decision = visionDecisionFor("tiered", true, {
          visionReady: vision.ready && !!vision.model,
          demoVisionEnabled: false,
        });
        if (decision === "stub") return stubResponse(VISION_DISABLED_STUB, finalThreadId);
        if (vision.model) {
          // Escalation is owner/trusted only — public never escalates (cost).
          const escalate =
            tier === "trusted" ? resolveVisionEscalateProvider({ reasoningEffort }).model : null;
          visionTools = createVisionTools({
            images: turnImages,
            vision: vision.model,
            escalate,
            onUsage: ({ inputTokens, outputTokens, modelId }) => {
              visionExtra.inputTokens += inputTokens;
              visionExtra.outputTokens += outputTokens;
              visionExtra.costMicros += estimateCostMicros(modelId, inputTokens, outputTokens);
            },
          });
        }
      }

      const tools = {
        ...createMemoryTools({ userId }),
        ...createAdvisorTools({ userId }),
        ...visionTools,
      };
      return streamAdvisorResponse({
        ctx,
        path: "tiered",
        model,
        system,
        messages,
        tools,
        maxOutputTokens: tier === "trusted" ? 2048 : 1024,
        threadId: finalThreadId,
        memoryIntent: reasoningDecision.memoryIntent,
        setContextHeader,
        persist: (text, modelId, cards) =>
          appendMessage({
            threadId: finalThreadId,
            role: "assistant",
            content: text,
            model: modelId,
            cards,
          }),
        // Log tokens (and estimated cost) regardless of whether prose came back
        // — a tool-only turn still consumes budget. The vision sub-model's tokens
        // (a separate generation) are folded in so an image turn's vision cost
        // counts. Cost is 0 for free/unpriced models, so this is additive.
        recordUsageFor: ({ inputTokens, outputTokens, modelId }) =>
          recordUsage(
            userId,
            inputTokens + visionExtra.inputTokens,
            outputTokens + visionExtra.outputTokens,
            undefined,
            estimateCostMicros(modelId, inputTokens, outputTokens) + visionExtra.costMicros,
          ),
      });
    }

    // Owner path — full chat, no cap (single-owner / pre-auth mode). The owner
    // chain drives every turn with the intent-gated effort, cache affinity pinned
    // by thread id; an image turn ALSO gets the examine_image vision tool, with
    // escalation available (VISION_CHAT_ESCALATE_MODELS, dormant unless set).
    const provider = resolveOwnerProvider({ reasoningEffort, conversationId: finalThreadId });
    if (!provider.ready || !provider.model) {
      return stubResponse(
        `AI chat isn't configured yet (${provider.label}). Set OPENROUTER_API_KEY in .env.local — see docs/reference/auth-and-providers.md.`,
        finalThreadId,
      );
    }
    const model = provider.model;

    let visionTools: ToolSet = {};
    if (hasImages) {
      const vision = resolveVisionProvider({ reasoningEffort });
      const decision = visionDecisionFor("owner", true, {
        visionReady: vision.ready && !!vision.model,
        demoVisionEnabled: false,
      });
      if (decision === "stub") return stubResponse(VISION_DISABLED_STUB, finalThreadId);
      if (vision.model) {
        visionTools = createVisionTools({
          images: turnImages,
          vision: vision.model,
          escalate: resolveVisionEscalateProvider({ reasoningEffort }).model,
        });
      }
    }

    const tools = {
      ...createMemoryTools({ userId }),
      ...createAdvisorTools({ userId }),
      ...visionTools,
    };
    return streamAdvisorResponse({
      ctx,
      path: "owner",
      model,
      system,
      messages,
      tools,
      maxOutputTokens: 2048,
      threadId: finalThreadId,
      memoryIntent: reasoningDecision.memoryIntent,
      setContextHeader,
      persist: (text, modelId, cards) =>
        appendMessage({
          threadId: finalThreadId,
          role: "assistant",
          content: text,
          model: modelId,
          cards,
        }),
    });
  });
}
