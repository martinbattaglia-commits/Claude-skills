// Vision-as-a-tool for the Advisor chat loop. The chat driver (e.g. grok) stays
// on every turn — including image turns — and CANNOT see pixels itself; the only
// way it reads an attachment is by calling the `examine_image` tool, whose
// executor runs a vision model (gemini) on the image bytes and returns text.
//
// Why a tool and not a whole-turn model-swap: the driver keeps its prompt-cache
// warm across the image turn (no foreign-model turn lands in history), keeps its
// own reasoning, and the tool's text result IS the reusable transcript — so a
// later turn answers from context without re-reading the image. See the spike
// verdict in docs/explanation/inference-strategy.md.
//
// Image bytes are captured here in the tool CLOSURE from the current request's
// message parts — never persisted server-side (see SECURITY.md). They live only
// for the duration of the turn that attached them.
//
// Kept out of the streaming route handler so the policy is unit-testable, mirrors
// lib/advisor/image-turn.ts.

import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { isImageFilePart, isObj } from "./image-turn";

/** One attached image's decoded bytes + its media type, ready for a vision call. */
export interface TurnImage {
  data: Buffer;
  mimeType: string;
}

/**
 * The model-only directive appended to an image turn's attachment note (NOT the
 * cached system prompt — kept per-turn so text turns stay clean and the system
 * prefix stays cache-stable). Tells the driver it can't see attachments directly
 * and must call the tool. Validated by the phase-(c) spike (4/4 tool calls).
 */
export const VISION_TOOL_DIRECTIVE =
  "(You cannot see attached images directly. To read what's in an attachment, call the " +
  "examine_image tool with a focused question — do not tell the user you can't see images.)";

// Guardrail wrapped around the user's question before it reaches the vision
// sub-model: numbers stay the vision model's job (quoted exactly), and it must
// not invent what isn't visible. It also returns a COMPLETE reading of the
// image, not just a narrow answer — that observation is captured client-side as
// the image's reusable transcript (so a later turn can reference it as text
// without re-reading the bytes), and it's one call, not a separate transcription
// pass. Mirrors the posture of lib/portfolio/ocr.ts.
const VISION_GUARDRAIL =
  "You are a vision sub-model serving a financial Advisor. Read the attached image(s) and answer " +
  "the question, THEN add a complete reading of everything else visible (every fund/ticker, number, " +
  "label, and date) so the Advisor can reference it later. Use ONLY what is visibly in the image(s); " +
  "quote tickers and numbers exactly as shown; never guess, round, or extrapolate. If something " +
  "asked isn't visible, say so plainly. Question: ";

// Cheap heuristic for the escalation hook: a chart/factsheet/graph the user is
// reasoning *about* (visual reasoning) rather than a holdings/transaction table
// to read off. Only consulted when an escalate model is actually provided (owner/
// trusted + VISION_CHAT_ESCALATE_MODELS set), so it's dormant by default.
const VISUAL_REASONING =
  /\b(chart|graph|plot|trend|curve|performance|drawdown|axis|slope)\b|กราฟ|แนวโน้ม/i;
function looksVisualReasoning(question: string): boolean {
  return VISUAL_REASONING.test(question);
}

/**
 * Decode the image attachments on the LATEST message of an incoming chat payload
 * into raw bytes, ready to hand to a vision model. Reads the AI SDK v6 UIMessage
 * file parts (`{ type:'file', mediaType:'image/…', url }`); the client normalizes
 * attachments to `data:image/jpeg;base64,…` data URLs (see ChatScreen), so the
 * bytes ride in `url`. Non-data URLs (none today) and empty parts are skipped.
 * Text-only turns return `[]`.
 */
export function extractTurnImages(messages: readonly unknown[]): TurnImage[] {
  const last = messages[messages.length - 1];
  if (!isObj(last) || !Array.isArray(last.parts)) return [];
  const out: TurnImage[] = [];
  for (const part of last.parts) {
    if (!isImageFilePart(part) || !isObj(part)) continue;
    const url = part.url;
    const mediaType = part.mediaType;
    if (typeof url !== "string" || typeof mediaType !== "string") continue;
    const comma = url.indexOf(",");
    if (!url.startsWith("data:") || comma < 0) continue; // only data URLs carry bytes
    const data = Buffer.from(url.slice(comma + 1), "base64");
    if (data.length > 0) out.push({ data, mimeType: mediaType });
  }
  return out;
}

/**
 * Return the messages with the latest user message's image file parts removed,
 * so a (text-only-as-far-as-it-knows) chat driver never receives raw pixels —
 * it reads them via examine_image instead. Pure: returns the same array when
 * there's nothing to strip; otherwise a shallow clone with a filtered last
 * message. The attachment note (text) is left intact.
 */
export function stripDriverImages(
  messages: UIMessage[] | ModelMessage[],
): UIMessage[] | ModelMessage[] {
  const idx = messages.length - 1;
  const last = messages[idx] as { parts?: unknown };
  if (!isObj(last) || !Array.isArray(last.parts)) return messages;
  const kept = last.parts.filter((p) => !isImageFilePart(p));
  if (kept.length === last.parts.length) return messages; // no image parts
  const cloned = [...messages] as (UIMessage | ModelMessage)[];
  cloned[idx] = { ...(messages[idx] as object), parts: kept } as UIMessage | ModelMessage;
  return cloned as UIMessage[] | ModelMessage[];
}

/** Pick the image(s) to examine: a 1-based index when given+valid, else all. */
function selectImages(images: TurnImage[], imageIndex?: number): TurnImage[] {
  if (imageIndex && imageIndex >= 1 && imageIndex <= images.length) return [images[imageIndex - 1]];
  return images;
}

/** Usage from one vision sub-model call, for cost metering at the call site. */
export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string | null;
}

export interface VisionToolDeps {
  /** This turn's attached images, decoded (captured in the tool closure). */
  images: TurnImage[];
  /** Cheap, common-case vision model. Required (vision was decided ready). */
  vision: LanguageModel;
  /**
   * Stronger vision model for visual-reasoning escalation. Pass `null` to keep
   * escalation off — the route passes it only for owner/trusted when
   * VISION_CHAT_ESCALATE_MODELS is set, so public/demo never escalate.
   */
  escalate?: LanguageModel | null;
  /**
   * Called after each vision read with its token usage. The sub-model call is a
   * SEPARATE generation from the chat driver, so the driver's stream usage won't
   * include it — the metered (tiered) path folds this into the recorded usage so
   * an image turn's vision cost still counts against the daily cap.
   */
  onUsage?: (usage: VisionUsage) => void;
}

/**
 * Build the `examine_image` toolset for an image-bearing turn. The driver calls
 * it with a focused question; the executor runs the vision model over this turn's
 * captured image bytes and returns the observation as text. Escalates to the
 * stronger model only when one is provided AND the question reads as visual
 * reasoning (a chart/factsheet), not a table to read off.
 */
export function createVisionTools(deps: VisionToolDeps): ToolSet {
  const { images, vision, escalate, onUsage } = deps;
  return {
    examine_image: tool({
      description:
        "Look at the image(s) the user attached to THIS message and answer a focused question " +
        "about them — fund values, the biggest gain/loss, a date, or what a chart shows. This is " +
        "the ONLY way you can see an attachment; you cannot see images yourself. Ask one focused " +
        "question per call; call again to look at something else.",
      inputSchema: z.object({
        question: z.string().describe("A single focused question about the attached image(s)."),
        imageIndex: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based index when several images are attached; omit to examine all of them."),
      }),
      execute: async ({ question, imageIndex }) => {
        const picked = selectImages(images, imageIndex);
        if (picked.length === 0) return { observation: "No image is attached to this message." };
        const model = escalate && looksVisualReasoning(question) ? escalate : vision;
        const res = await generateText({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_GUARDRAIL + question },
                ...picked.map((im) => ({
                  type: "image" as const,
                  image: im.data,
                  mediaType: im.mimeType,
                })),
              ],
            },
          ],
        });
        onUsage?.({
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
          modelId: res.response.modelId ?? null,
        });
        return { observation: res.text };
      },
    }),
  };
}
