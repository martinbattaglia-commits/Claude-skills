import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ExtractedTxnRow } from "@macrotide/connector-sdk";
import { generateText } from "ai";
import type { QuoteSource } from "@/lib/market/sources";

/**
 * Image OCR for the "Add holdings" flow. The user uploads a broker-app
 * screenshot; we ask an OpenRouter vision model to transcribe what it sees
 * into plain text and return that string for downstream use — currently the
 * UI surfaces the transcription to the user, and in the future the advisor
 * agent will turn it into structured holdings rows via chat tool calls
 * (the in-chat vision follow-up).
 *
 * **Why pure transcription instead of structured JSON.** Earlier iterations
 * asked the model to return a Zod-validated `{ rows: ProposedRow[] }`. Free
 * and OCR-specialized vision models routinely failed at the structured-output
 * contract:
 *   - Some OCR-specialized vision models don't support OpenRouter's structured-output flag.
 *   - Smaller Gemma / Llama free models return "Invalid JSON response".
 *   - Even capable models silently returned empty rows when their schema-
 *     following confidence was low (no signal back to the user about WHY).
 * Pure-text transcription compiles to a single `generateText` call that works
 * across every image-capable model. The reasoning that used to happen inside
 * the OCR call (which line is a ticker? which number is units vs. total
 * value?) is deferred to either the user (read the transcription, fill rows
 * manually) or a future advisor flow.
 *
 * Defaults to a `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite`
 * chain (primary,fallback). Override with `OCR_MODELS` (comma-separated) — see
 * `.env.example`. Each must be a vision-capable OpenRouter model.
 */

export interface OcrInput {
  data: Buffer;
  mimeType: string;
}

/** Token usage from one OCR model call, so the caller can meter + cap spend. */
export interface OcrUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string | null;
}

/** Options shared by the image extractors. */
export interface OcrOptions {
  /** Called after each model call with its token usage (for recordUsage / caps). */
  onUsage?: (usage: OcrUsage) => void;
}

function reportUsage(
  onUsage: ((u: OcrUsage) => void) | undefined,
  result: {
    usage?: { inputTokens?: number; outputTokens?: number };
    response?: { modelId?: string };
  },
): void {
  if (!onUsage) return;
  onUsage({
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    modelId: result.response?.modelId ?? null,
  });
}

export interface OcrResult {
  /**
   * Plain-text transcription of everything the model read from the image, in
   * reading order. Empty string when the model produced nothing usable —
   * the route still returns 200 in that case; the UI shows a "couldn't read"
   * empty state.
   */
  text: string;
}

/**
 * A single holding the vision model read off a broker screenshot, BEFORE any
 * NAV-derivation. Thai broker apps vary in what they show on the summary
 * screen — some list units + NAV + avg cost (the fund DETAIL view), most list
 * only market value + allocation % + gain/loss (the portfolio summary view).
 * So every numeric field is optional: the extractor reports only what it
 * actually saw, and the route fills the gaps (see `deriveRow`).
 */
export interface ExtractedRow {
  /** Fund code / ticker exactly as printed (e.g. "K-USA-A(A)", "SCBSP500-A"). */
  ticker: string;
  /** English fund name if shown (often a small subtitle under the code). */
  englishName?: string;
  /** Units held, if the screen shows them. */
  units?: number;
  /** NAV / price per unit, if shown. */
  nav?: number;
  /** Average cost per unit, if shown (the DETAIL view has this directly). */
  avgCost?: number;
  /** Market value of the position, if shown (most summary views lead with this). */
  value?: number;
  /** Unrealised profit/loss in THB, if shown (negative for a loss). */
  pl?: number;
  /**
   * Amount invested / cost-basis TOTAL in THB, if shown (ยอดเงินลงทุน / มูลค่าต้นทุน).
   * A ฿ TOTAL, never per-unit — distinct from `avgCost`. This is a read FACT; the
   * per-unit avg cost is DERIVED from it ÷ units at the fold, never frozen here.
   */
  costTotal?: number;
}

/**
 * A holding row after NAV-derivation, ready for the editable confirmation
 * table. Carries provenance so the UI can mark estimated fields and prompt
 * the user to make them exact.
 */
export interface DerivedRow extends ExtractedRow {
  quoteSource: QuoteSource;
  /** True when the unit count was computed (value÷NAV), not read from the image. */
  estimated: boolean;
  /** True when we couldn't derive units (no NAV on file) — UI asks the user to type them. */
  needsUnits: boolean;
}

/** @deprecated use {@link ExtractedRow} — kept until callers migrate. */
export interface ProposedRow {
  ticker: string;
  englishName?: string;
  units?: number;
  avgCost?: number;
  quoteSource: QuoteSource;
}

// Default model chain: a primary vision model, with a cheaper one as the
// automatic fallback when the primary rate-limits or errors. Both are Google
// Gemini Flash variants on OpenRouter — strong at reading text from
// document/table screenshots and inexpensive (~$0.0001–0.001 per image).
//
// History: the previous default `baidu/qianfan-ocr-fast(:free)` was removed
// from OpenRouter ("No endpoints found", observed 2026-05) which silently
// broke this endpoint; both the free and paid variants 404'd. The
// replacement is a maintained, no-train-by-default provider. This OCR utility
// is intentionally NOT tier-gated — it's a bounded, rate-limited one-shot
// (unlike the open-ended chat advisor, which the free-tier invariant guards),
// so it uses the same model for every user for identical UX.
//
// On primary failure (HTTP 429 / provider error) the route catches
// OcrProviderUnavailableError, retries once against the fallback model, and only
// surfaces the error if both fail.
//
// The default fallback is gemini-3.1-flash-lite — current-gen, so it survives the
// gemini-2.5 EOL (2026-10-16) as a clean resilience net (the eval verdict lives
// in docs/explanation/inference-strategy.md).
const DEFAULT_OCR_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_OCR_FALLBACK_MODEL = "google/gemini-3.1-flash-lite";

/**
 * Resolve the OCR primary + fallback from the `OCR_MODELS` chain
 * (`primary,fallback,…`). One source of truth for the four extractors, so they
 * can't drift. A pinned single-model `OCR_MODELS=foo` means no fallback (don't
 * surprise an operator who chose one model); unset → the default primary +
 * fallback pair.
 */
function resolveOcrModels(): { primary: string; fallback: string | null } {
  const chain = process.env.OCR_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (chain && chain.length > 0) return { primary: chain[0], fallback: chain[1] ?? null };
  return { primary: DEFAULT_OCR_MODEL, fallback: DEFAULT_OCR_FALLBACK_MODEL };
}

// Bounds for the post-parse sanity guard (A3): a final net against a model
// fabricating absurd digits (the "value in the billions" failure mode), applied
// regardless of which model produced them. An out-of-range field is DROPPED
// (left undefined) so the editable confirmation table asks the user, rather than
// seeding analytics with garbage. Generous on purpose — not a precise validator.
const NAV_MIN = 0.01;
const NAV_MAX = 1_000_000;
const UNITS_MAX = 1e9;
const MONEY_MAX = 1e12;

const SYSTEM_PROMPT = `You are an OCR transcription engine. Read the image and return EVERY line of visible text, in reading order. Preserve numbers, currency symbols, percent signs, and column structure exactly as they appear. Use newlines between rows of a table. Do not summarize, interpret, or add commentary — just transcribe.

If the image contains no readable text at all, return an empty string.`;

// Structured-extraction prompt. The hard-won detail (validated against real
// Thai broker screenshots) is the digit/glyph fidelity instruction: general
// vision models otherwise merge the ฿ glyph into the adjacent number
// ("฿18.45" → "818.45") and strip/garble decimals — fatal for holdings.
// We ask for prompt-driven JSON (NOT OpenRouter's structured-output flag,
// which several capable models silently fail — see the note above).
const EXTRACT_PROMPT = `You are reading a screenshot of a Thai mutual-fund / brokerage portfolio. Extract EVERY fund holding as a JSON array — output ONLY the array, no prose, no markdown code fences.

Each element has these keys (include a key ONLY if that value is actually visible for that row; omit keys you cannot read — never guess). Thai broker apps vary, so match by MEANING using these labels:
- "ticker": the fund code exactly as printed (e.g. "K-USA-A(A)", "SCBSP500-A", "TLFVMR-ASIAX")
- "englishName": the English fund name if shown as a subtitle
- "units": the holding's unit count — Thai "จำนวนหน่วย" / "หน่วย", English "units"
- "nav": the CURRENT price per unit — Thai "NAV ปัจจุบัน" / "มูลค่าหน่วยลงทุน", English "NAV" / "price"
- "avgCost": the AVERAGE COST PER UNIT you paid — Thai "NAV ต้นทุน" / "ต้นทุนต่อหน่วย", English "cost NAV" / "average cost" (a small per-unit number like 11.2912)
- "value": the CURRENT market value of the position — Thai "มูลค่าปัจจุบัน" / "มูลค่า", English "current value" / "market value" (the large baht amount)
- "pl": the unrealised profit/loss in baht — Thai "กำไร/ขาดทุน", English "P/L" (negative if it is red or has a minus sign)
- "costTotal": the amount INVESTED / cost-basis TOTAL in baht — Thai "ยอดเงินลงทุน" / "มูลค่าต้นทุน", English "amount invested" / "cost" — a large baht TOTAL (like the current value), NEVER a small per-unit number. Read it when the row shows it alongside the current value.

WHAT IS NOT A FIELD — avoid these specific mistakes:
- A "N unit" / "N units" count shown in a SECTION or CATEGORY HEADER (e.g. "LTF — 1 unit", "กองทุนรวมทั่วไป — 1 unit", "RMF — 2 units") is the NUMBER OF FUNDS in that section, NOT a holding's unit count. NEVER read it as "units".
- Keep the three baht figures distinct: "value" is the CURRENT value, "costTotal" is the INVESTED total, and they are NOT "avgCost". "avgCost" is ONLY a small per-unit cost NAV (e.g. 11.2912) — leave it out unless that per-unit figure is actually printed; never put an invested TOTAL into "avgCost".

CRITICAL number rules — read every digit and decimal EXACTLY as printed:
- The ฿ symbol is a CURRENCY MARKER, never a digit. "฿18.4521" is 18.4521, NOT 818.4521. Strip it.
- Remove thousands-separator commas: "719,193.85" → 719193.85.
- Never round, pad, or normalise. Output plain JSON numbers (no quotes, no ฿, no commas, no % sign).
- Do NOT include portfolio totals, section headers, "cash", or summary rows as holdings.

If the image shows no portfolio at all, return [].`;

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Detect an image's real type from its leading bytes (magic number), so the
 * client-declared MIME can't smuggle a non-image (or a mislabeled file) into the
 * OCR path. Returns the detected allowed type, or null if the bytes aren't a
 * supported image. Routes should trust THIS over `file.type`.
 */
export function sniffImageMime(data: Buffer): AllowedMimeType | null {
  if (data.length < 12) return null;
  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function openrouterVisionModel(apiKey: string, modelId: string) {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    headers: {
      "HTTP-Referer": process.env.PUBLIC_APP_URL ?? "https://macrotide.local",
      "X-Title": "Macrotide OCR",
    },
  });
  return provider(modelId);
}

/**
 * Transcribe a broker screenshot to plain text.
 *
 * Tries the `OCR_MODELS` primary (default gemini-2.5-flash-lite) first. If that
 * fails with a provider-unavailable error (rate limit, quota exhausted, no
 * endpoint) and the chain names a fallback (default gemini-3.1-flash-lite),
 * retries once on the fallback. Only throws if both fail.
 *
 * Returns `{ text: "" }` (not an error) when a model runs successfully but
 * can't extract anything from the image — the route handler treats an empty
 * string as "nothing recognized" so the UI can show a friendly empty state.
 *
 * Throws `OcrProviderUnavailableError` only on transport / auth / guardrail
 * errors that ALL attempts hit, so the route can surface a 502 with the
 * last provider's actual message.
 */
export async function extractHoldingsFromImage(input: OcrInput): Promise<OcrResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const { primary, fallback } = resolveOcrModels();

  try {
    return await transcribe(apiKey, primary, input);
  } catch (err) {
    if (err instanceof OcrProviderUnavailableError && fallback && fallback !== primary) {
      // Surface the FALLBACK's error — the operator already knew the primary
      // was free/quota-bound; they need to see why their no-train safety net
      // also failed.
      return await transcribe(apiKey, fallback, input);
    }
    throw err;
  }
}

async function transcribe(apiKey: string, modelId: string, input: OcrInput): Promise<OcrResult> {
  const model = openrouterVisionModel(apiKey, modelId);
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe every line of text visible in this image, in reading order. Output the transcription only — no commentary.",
            },
            {
              type: "image",
              image: input.data,
              mediaType: input.mimeType,
            },
          ],
        },
      ],
    });
    return { text: (result.text ?? "").trim() };
  } catch (err) {
    if (isProviderError(err)) {
      throw new OcrProviderUnavailableError(extractProviderMessage(err));
    }
    return { text: "" };
  }
}

/**
 * Read a broker screenshot into structured holding rows.
 *
 * Same provider + fallback policy as {@link extractHoldingsFromImage}: tries the
 * `OCR_MODELS` primary, retries once on the chain's fallback for
 * provider-unavailable errors. Returns `[]` (not an error) when a model
 * runs but reads no holdings, so the route can show a friendly empty state.
 *
 * Returns raw extracted rows — NAV-derivation (units/avgCost from market data)
 * happens in the route, which has DB access.
 */
export async function extractStructuredHoldings(
  input: OcrInput,
  opts: OcrOptions = {},
): Promise<ExtractedRow[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const { primary, fallback } = resolveOcrModels();

  try {
    return await extractWith(apiKey, primary, input, opts.onUsage);
  } catch (err) {
    if (err instanceof OcrProviderUnavailableError && fallback && fallback !== primary) {
      return await extractWith(apiKey, fallback, input, opts.onUsage);
    }
    throw err;
  }
}

async function extractWith(
  apiKey: string,
  modelId: string,
  input: OcrInput,
  onUsage?: (u: OcrUsage) => void,
): Promise<ExtractedRow[]> {
  const model = openrouterVisionModel(apiKey, modelId);
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_PROMPT },
            { type: "image", image: input.data, mediaType: input.mimeType },
          ],
        },
      ],
    });
    reportUsage(onUsage, result);
    return parseExtractedRows(result.text ?? "");
  } catch (err) {
    if (isProviderError(err)) {
      throw new OcrProviderUnavailableError(extractProviderMessage(err));
    }
    // A non-provider error here is almost always a malformed/blocked response;
    // treat as "nothing read" rather than a hard 502.
    return [];
  }
}

// ─── Holdings-snapshot vs transaction-history classification ────────────────
//
// A broker screenshot is one of two shapes the importer handles very
// differently: a HOLDINGS SNAPSHOT (current positions → Starting balances) or a
// TRANSACTION HISTORY (a dated buy/sell log → trade rows). Feeding one to the
// other's extractor mis-imports every row, so we classify FIRST and route the
// image to the matching extractor. A cheap, low-token call; the route falls back
// to asking the user when this returns "low" confidence.

export type ImportDocType = "holdings" | "transactions";

export interface ImportContext {
  /** Original file name (a hint only — e.g. "Screenshot_20260530_…jpg"). */
  filename?: string;
  /** When the file was saved (ISO) — a hint only. */
  capturedAt?: string;
}

export interface ImportClassification {
  docType: ImportDocType;
  confidence: "high" | "low";
  /** The data's as-of date (ISO), preferring a date shown IN the image. */
  asOf: string | null;
}

// Built per call so the filename/timestamp can ride as CONTEXT — they are only a
// fallback. A date shown inside the image (an "as of" header, statement date)
// always wins; the model decides, we don't regex the filename.
function classifyPrompt(ctx?: ImportContext): string {
  const hints: string[] = [];
  if (ctx?.filename) hints.push(`file name: "${ctx.filename}"`);
  if (ctx?.capturedAt) hints.push(`file saved at: ${ctx.capturedAt}`);
  const fallback = hints.length
    ? `\nDate context (a FALLBACK only — use it solely when the image itself shows no date): ${hints.join("; ")}.`
    : "";
  return `You are shown ONE screenshot from an investing / brokerage app. Do two things:
1) Classify it — "holdings" = the user's CURRENT positions (funds/stocks with units and/or market value, NO per-row transaction dates); "transactions" = a DATED LOG of activity over time (buys/sells/dividends; rows carry or inherit a date, the same fund repeats, labels like ซื้อ/ขาย/buy/sell/subscribe/redeem/สับเปลี่ยน).
2) Determine the AS-OF date — the day this data is current. PREFER a date shown ANYWHERE in the image (an "as of" / data / statement date). Thai Buddhist-era years subtract 543 (2569 → 2026). Only if the image shows no date at all, fall back to the date context below.${fallback}
Reply with ONLY a JSON object, no prose, no code fences: {"docType":"holdings"|"transactions","confidence":"high"|"low","asOf":"YYYY-MM-DD"|null}. Use confidence "low" when the type is genuinely ambiguous; asOf null only when you truly cannot determine a date.`;
}

/**
 * Classify an import screenshot as a holdings snapshot or a transaction history.
 * Same provider + fallback policy as the extractors. On an unparseable/blocked
 * response returns `{ docType: "holdings", confidence: "low" }` so the caller
 * asks the user rather than silently guessing.
 */
export async function classifyImportImage(
  input: OcrInput,
  ctx?: ImportContext,
  opts: OcrOptions = {},
): Promise<ImportClassification> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const { primary, fallback } = resolveOcrModels();

  let result: ImportClassification;
  try {
    result = await classifyWith(apiKey, primary, input, ctx, opts.onUsage);
  } catch (err) {
    if (err instanceof OcrProviderUnavailableError && fallback && fallback !== primary) {
      result = await classifyWith(apiKey, fallback, input, ctx, opts.onUsage);
    } else {
      throw err;
    }
  }
  // Deterministic safety net: a "right now" broker snapshot often shows no date in
  // the image, and the model doesn't reliably read a YYYYMMDD date out of the file
  // name — so backfill asOf from the file name when the model left it null. The
  // date matters: a value-only Balance derives its units from NAV on this date.
  if (!result.asOf && ctx?.filename) {
    const fromName = dateFromFilename(ctx.filename);
    if (fromName) return { ...result, asOf: fromName };
  }
  return result;
}

/**
 * Parse a YYYY-MM-DD / YYYY_MM_DD or packed YYYYMMDD date embedded in a file name
 * (e.g. "Screenshot_20260530_134416.jpg" → "2026-05-30"). Rejects implausible
 * month/day; returns null when there's no plausible date. Exported for tests.
 */
export function dateFromFilename(name: string): string | null {
  const m =
    name.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/) ??
    name.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function classifyWith(
  apiKey: string,
  modelId: string,
  input: OcrInput,
  ctx?: ImportContext,
  onUsage?: (u: OcrUsage) => void,
): Promise<ImportClassification> {
  const model = openrouterVisionModel(apiKey, modelId);
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 120,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: classifyPrompt(ctx) },
            { type: "image", image: input.data, mediaType: input.mimeType },
          ],
        },
      ],
    });
    reportUsage(onUsage, result);
    return parseClassification(result.text ?? "");
  } catch (err) {
    if (isProviderError(err)) {
      throw new OcrProviderUnavailableError(extractProviderMessage(err));
    }
    // Unparseable/blocked → safest is to let the user decide.
    return { docType: "holdings", confidence: "low", asOf: null };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseClassification(raw: string): ImportClassification {
  const match = raw.match(/\{[^{}]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]) as {
        docType?: unknown;
        confidence?: unknown;
        asOf?: unknown;
      };
      const asOf = typeof o.asOf === "string" && ISO_DATE.test(o.asOf) ? o.asOf : null;
      if (o.docType === "transactions" || o.docType === "holdings") {
        return { docType: o.docType, confidence: o.confidence === "high" ? "high" : "low", asOf };
      }
    } catch {
      // fall through to keyword scan
    }
  }
  // No clean JSON — scan for a keyword but never claim high confidence.
  const low = raw.toLowerCase();
  if (low.includes("transaction"))
    return { docType: "transactions", confidence: "low", asOf: null };
  return { docType: "holdings", confidence: "low", asOf: null };
}

// The OCR/paste import row IS Macrotide's import format — owned by the SDK so the
// broker parser and the host share one type. Re-exported for existing importers.
export type { ExtractedTxnRow };

const EXTRACT_TXN_PROMPT = `You are reading a screenshot of a Thai mutual-fund / brokerage TRANSACTION HISTORY — a log of buys, sells and dividends over time (many rows, often the SAME fund repeated, each row belonging to a date). Extract EVERY transaction row as a JSON array — output ONLY the array, no prose, no markdown code fences.

DATES ARE GROUP HEADERS. Thai transaction logs print the date ONCE as a bold header (e.g. "16 มีนาคม 2569", "22 ธันวาคม 2568") above a GROUP of transactions, then list several transactions under it with no date of their own. You MUST give every transaction the date of the nearest header ABOVE it. Do not leave tradeDate blank just because the row itself has no date printed.

Each element has these keys (include a key ONLY if that value is visible or inheritable; omit keys you genuinely cannot determine — never invent numbers):
- "tradeDate": ALWAYS fill this, inherited from the group header. Output ISO "YYYY-MM-DD".
  - Thai month names: มกราคม=01 กุมภาพันธ์=02 มีนาคม=03 เมษายน=04 พฤษภาคม=05 มิถุนายน=06 กรกฎาคม=07 สิงหาคม=08 กันยายน=09 ตุลาคม=10 พฤศจิกายน=11 ธันวาคม=12.
  - Years are usually BUDDHIST ERA (พ.ศ., ~2560s). Convert to Gregorian by SUBTRACTING 543: 2569 → 2026, 2568 → 2025. (If a year is already < 2200 assume it is Gregorian.)
  - So "16 มีนาคม 2569" → "2026-03-16"; "22 ธันวาคม 2568" → "2025-12-22".
- "kind": one of "buy", "sell", "dividend", "fee", "split", "reinvest". Map the Thai/English label on the row:
  - ซื้อ / subscribe / purchase → "buy"
  - ขาย / redeem / sell → "sell"
  - เงินปันผล / dividend → "dividend"
  - A สับเปลี่ยน (switch/exchange) splits into TWO rows: the ออก (out) leg → "sell", the เข้า (in) leg → "buy". Emit them as two separate transactions with their own ticker, units and amount.
- "ticker": the fund code exactly as printed (e.g. "TLFVMR-ASIAX", "K-US500X-A(A)", "SCBCOMP").
- "units": units bought/sold on this row (often labelled "หน่วย").
- "pricePerUnit": the NAV / price per unit on this row, if shown.
- "amount": the baht (฿) amount of this transaction (the total value moved).
- "fee": any fee / front-end charge on this row, in baht.

CRITICAL number rules — read every digit and decimal EXACTLY as printed:
- The ฿ symbol is a CURRENCY MARKER, never a digit. "฿18.4521" is 18.4521, NOT 818.4521. Strip it.
- Remove thousands-separator commas: "719,193.85" → 719193.85.
- Never round, pad, or normalise. Output plain JSON numbers (no quotes, no ฿, no commas, no % sign).
- "amount" is always a POSITIVE magnitude — do NOT make sells negative; the "kind" carries the direction.
- Ignore channel badges (e.g. "AMC"), status checkmarks, running balances, and section headers — they are not transactions.

If the image shows no transaction history at all, return [].`;

/**
 * Read a transaction-history screenshot into structured rows. Same provider +
 * fallback policy as {@link extractStructuredHoldings}. Returns `[]` when a model
 * runs but reads nothing. Rows come back raw — the client normalizes kind/date
 * and the route signs the amount.
 */
export async function extractTransactionRows(
  input: OcrInput,
  opts: OcrOptions = {},
): Promise<ExtractedTxnRow[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const { primary, fallback } = resolveOcrModels();

  try {
    return await extractTxnWith(apiKey, primary, input, opts.onUsage);
  } catch (err) {
    if (err instanceof OcrProviderUnavailableError && fallback && fallback !== primary) {
      return await extractTxnWith(apiKey, fallback, input, opts.onUsage);
    }
    throw err;
  }
}

async function extractTxnWith(
  apiKey: string,
  modelId: string,
  input: OcrInput,
  onUsage?: (u: OcrUsage) => void,
): Promise<ExtractedTxnRow[]> {
  const model = openrouterVisionModel(apiKey, modelId);
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_TXN_PROMPT },
            { type: "image", image: input.data, mediaType: input.mimeType },
          ],
        },
      ],
    });
    reportUsage(onUsage, result);
    return parseExtractedTxnRows(result.text ?? "");
  } catch (err) {
    if (isProviderError(err)) {
      throw new OcrProviderUnavailableError(extractProviderMessage(err));
    }
    return [];
  }
}

/** Tolerant parser for the transaction-extraction reply (see {@link parseExtractedRows}). */
export function parseExtractedTxnRows(text: string): ExtractedTxnRow[] {
  const raw = parseJsonArray(text);
  if (!raw) return [];
  const rows: ExtractedTxnRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ticker = typeof o.ticker === "string" ? o.ticker.trim() : "";
    if (!ticker) continue;
    const row: ExtractedTxnRow = { ticker };
    if (typeof o.englishName === "string" && o.englishName.trim())
      row.englishName = o.englishName.trim();
    if (typeof o.kind === "string" && o.kind.trim()) row.kind = o.kind.trim();
    if (typeof o.tradeDate === "string" && o.tradeDate.trim()) row.tradeDate = o.tradeDate.trim();
    const units = coerceNumber(o.units);
    const price = coerceNumber(o.pricePerUnit);
    const amount = coerceNumber(o.amount);
    const fee = coerceNumber(o.fee);
    // A3 bounds guard (see parseExtractedRows): drop an out-of-range fabrication.
    if (units !== null && units > 0 && units <= UNITS_MAX) row.units = units;
    if (price !== null && price >= NAV_MIN && price <= NAV_MAX) row.pricePerUnit = price;
    if (amount !== null && amount >= 0 && amount <= MONEY_MAX) row.amount = amount;
    if (fee !== null && fee >= 0 && fee <= MONEY_MAX) row.fee = fee;
    rows.push(row);
  }
  return rows;
}

/** Narrow a model reply to the outermost JSON array, tolerating fences/prose. */
function parseJsonArray(text: string): unknown[] | null {
  if (!text) return null;
  let s = text.trim();
  s = s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try {
    const parsed = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tolerant parser for the model's JSON-array reply. Handles markdown fences,
 * leading prose, and stray ฿/comma residue the prompt should have removed but
 * a weaker model might leave in. Drops rows without a usable ticker.
 */
export function parseExtractedRows(text: string): ExtractedRow[] {
  if (!text) return [];
  let s = text.trim();
  // Strip ```json … ``` fences if present.
  s = s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  // Narrow to the outermost array.
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  s = s.slice(a, b + 1);

  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const rows: ExtractedRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ticker = typeof o.ticker === "string" ? o.ticker.trim() : "";
    if (!ticker) continue;
    const row: ExtractedRow = { ticker };
    if (typeof o.englishName === "string" && o.englishName.trim()) {
      row.englishName = o.englishName.trim();
    }
    const units = coerceNumber(o.units);
    const nav = coerceNumber(o.nav);
    const avgCost = coerceNumber(o.avgCost);
    const value = coerceNumber(o.value);
    const pl = coerceNumber(o.pl);
    const costTotal = coerceNumber(o.costTotal);
    // A3 bounds guard: keep a field only when it's within plausible range, so a
    // fabricated absurd digit is dropped (→ confirmation table asks the user)
    // rather than poisoning derivation.
    if (units !== null && units > 0 && units <= UNITS_MAX) row.units = units;
    if (nav !== null && nav >= NAV_MIN && nav <= NAV_MAX) row.nav = nav;
    if (avgCost !== null && avgCost >= NAV_MIN && avgCost <= NAV_MAX) row.avgCost = avgCost;
    if (value !== null && value >= 0 && value <= MONEY_MAX) row.value = value;
    if (pl !== null && Math.abs(pl) <= MONEY_MAX) row.pl = pl;
    if (costTotal !== null && costTotal >= 0 && costTotal <= MONEY_MAX) row.costTotal = costTotal;
    rows.push(row);
  }
  return rows;
}

/**
 * Fill in `units`/`avgCost` for a row that only had market value, using a NAV
 * from market data. Pure + synchronous so it's unit-testable; the route looks
 * up `nav` (via `listFundQuotes`) and passes it in.
 *
 * Precedence: trust what the image showed. Only derive a missing field — and
 * derive only the UNIT COUNT off NAV, never a money fact:
 *  - units     = value ÷ nav        (when units absent but value + nav present)
 *  - costTotal = value − pl         (the invested ฿ TOTAL, when not read directly)
 *
 * We do NOT fabricate a per-unit avg cost here: that would mean dividing the
 * invested total by the NAV-derived unit count and freezing a NAV-dependent figure
 * (facts-only, ADR 0004). The invested total is a fact (read, or value−pl of two
 * read facts); the per-unit avg cost is DERIVED from costTotal ÷ units at the fold.
 *
 * `estimated` flags the NAV-derived unit count so the UI can mark it and invite the
 * user to make it exact. `needsUnits` means we still have no units (no NAV on
 * file and none on the image) — the confirmation table asks the user to type
 * them, ideally from the fund's detail screen.
 */
export function deriveRow(row: ExtractedRow, nav: number | undefined): DerivedRow {
  // Default to a custom asset; deriveRowsWithNav overlays the real catalog source
  // (the single authority) — no shape guessing here.
  const quoteSource: QuoteSource = "manual";
  const out: DerivedRow = { ...row, quoteSource, estimated: false, needsUnits: false };

  // Prefer the NAV printed on the image; fall back to market-data NAV.
  const effNav = out.nav ?? (nav && nav > 0 ? nav : undefined);
  if (out.nav === undefined && effNav !== undefined) {
    out.nav = effNav;
    out.estimated = true;
  }

  // Derived figures are estimates off the NAV, so round to a sane precision (4 dp
  // for units / per-unit cost) — a raw float like 18388.007604741964 reads as
  // fabricated. A value READ from the image is never rounded.
  const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

  if (out.units === undefined && out.value !== undefined && effNav) {
    out.units = round4(out.value / effNav);
    out.estimated = true;
  }

  // Carry the invested ฿ TOTAL as a fact (read directly, or reconstructed from the
  // two read figures value − pl). NOT a per-unit avg cost: the per-unit figure is
  // derived from costTotal ÷ units at the fold, so it self-corrects with NAV and is
  // never frozen here. Round ฿ to satang. When P/L isn't shown we can't know the
  // cost — leave it absent rather than assuming zero gain (costTotal = value).
  if (out.costTotal === undefined && out.value !== undefined && out.pl !== undefined) {
    const costTotal = Math.round((out.value - out.pl) * 100) / 100;
    if (costTotal > 0) out.costTotal = costTotal;
  }

  out.needsUnits = out.units === undefined || out.units <= 0;
  return out;
}

/** Parse a model-emitted number that may still carry ฿, commas, %, or a +/- sign. */
function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[฿$,%\s]/g, "").replace(/^\+/, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export class OcrProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrProviderUnavailableError";
  }
}

function isProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  if (!name.startsWith("AI_")) return false;
  if (name === "AI_NoObjectGeneratedError") return false;
  const msg = (err as { message?: string }).message ?? "";
  if (/invalid json|schema validation|no object generated|parse/i.test(msg)) {
    return false;
  }
  return true;
}

function extractProviderMessage(err: unknown): string {
  // Walk top → lastError → cause looking for OpenRouter's structured error body.
  // The most informative field is error.metadata.raw (e.g. "google/gemma-4-31b-it:free
  // is temporarily rate-limited upstream..."); fall back to error.message.
  const candidates: unknown[] = [];
  const visited = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !visited.has(cur)) {
    visited.add(cur);
    candidates.push(cur);
    const c = cur as { lastError?: unknown; cause?: unknown };
    if (c.lastError && !visited.has(c.lastError)) {
      candidates.push(c.lastError);
      visited.add(c.lastError);
    }
    cur = c.cause;
  }
  for (const node of candidates) {
    const n = node as { responseBody?: unknown };
    if (typeof n.responseBody === "string") {
      try {
        const parsed = JSON.parse(n.responseBody) as {
          error?: { message?: string; metadata?: { raw?: string } };
        };
        const raw = parsed?.error?.metadata?.raw;
        if (raw) return raw;
        const msg = parsed?.error?.message;
        if (msg) return msg;
      } catch {
        /* fall through */
      }
    }
  }
  for (const node of candidates) {
    const m = (node as { message?: string }).message;
    if (m) return m;
  }
  return "Vision model provider is unavailable. Try again later.";
}
