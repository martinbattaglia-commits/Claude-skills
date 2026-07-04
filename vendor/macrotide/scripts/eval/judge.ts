// LLM-as-judge for the Advisor eval (issue #65). An OPT-IN, additive quality
// layer on top of the deterministic floor in questions.ts — it grades the things
// regex can't reach (is the advice genuinely grounded, complete, well-structured,
// adapted to the reader, and helpful rather than hedged). The deterministic
// grader stays the regression gate; this only runs when EVAL_JUDGE=on.
//
// Built per docs/explanation/research/agent-evals.md § "LLM-as-judge, done
// safely": criterion-separated pointwise rubric, rationale BEFORE the score,
// evidence-anchored grounding, temperature ≈ 0, stateless, an explicit "Unknown"
// (null) escape per dimension, and a judge from a DIFFERENT model family than the
// model under test. Default judge = openai/gpt-5.5 (top-tier intelligence, neutral
// vs. the gemini/glm/minimax/kimi candidates). Override with EVAL_JUDGE_MODEL.
//
// Following the repo's own cross-model-robust pattern (lib/memory/extract.ts), the
// judge uses generateText + a tolerant JSON parse rather than generateObject, so a
// cheaper non-OpenAI judge (e.g. moonshotai/kimi-k2.6, validated in calibration)
// works without relying on provider-specific structured-output support.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";
import type { ToolCall } from "./questions";

export const DEFAULT_JUDGE_MODEL = "openai/gpt-5.5";

/** The criterion-separated rubric. Each is scored on its own, 1–5 or Unknown. */
export const JUDGE_DIMENSIONS = [
  "grounded",
  "complete",
  "structured",
  "adaptive",
  "helpful",
] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

/** One-line meaning of each dimension, shown to the judge and in docs. */
export const DIMENSION_RUBRIC: Record<JudgeDimension, string> = {
  grounded:
    "Every figure/claim is backed by the tool results — no invented funds, percentages, or returns. Quote the supporting figure before scoring.",
  complete:
    "Covers the lenses the question demands (e.g. return-vs-benchmark, fees, concentration/drift, tax/contributions, a concrete next step) without padding.",
  structured:
    "Reads like an advisor: diagnosis → why → options → a clear recommendation / next action, not a wall of caveats.",
  adaptive:
    "Matches the reader's level — defines jargon for a beginner, stays terse for an expert; matches the depth the question asked for.",
  helpful:
    "Genuinely useful: commits to a view and a next step. NOT a hedged deflection to 'see a professional'. (A light 'the choice is yours' note is fine; a rote disclaimer sign-off is not.)",
};

/** A score is 1–5, or null = "Unknown" (the judge declined rather than guess). */
const ScoreField = z.object({
  score: z.union([z.number().int().min(1).max(5), z.null()]),
  why: z.string().max(400),
});

const JudgeSchema = z.object({
  // Evidence first (anchors `grounded`): the figures the judge found in the trace.
  evidence: z.string().max(600),
  grounded: ScoreField,
  complete: ScoreField,
  structured: ScoreField,
  adaptive: ScoreField,
  helpful: ScoreField,
  verdict: z.string().max(300),
});
export type JudgeScores = z.infer<typeof JudgeSchema>;

export interface JudgeInput {
  question: { id: string; prompt: string; note?: string };
  /** The Advisor's final answer text (or, for multi-turn, the final turn). */
  answer: string;
  /** Tool calls the run captured (names + arguments) — the grounding source. */
  toolTrace: ToolCall[];
  /** For a multi-turn scenario: the full user/assistant transcript, so the judge
   *  can score coherence + did-it-remember-context across turns. */
  transcript?: string;
}

export interface JudgeResult {
  ok: boolean;
  scores: JudgeScores | null;
  /** Mean of the non-null dimension scores (1–5), or null if all Unknown. */
  mean: number | null;
  /** Mean normalized to 0–1 ((mean-1)/4) for ranking; null if all Unknown. */
  normalized: number | null;
  /** Count of dimensions the judge marked Unknown. */
  unknowns: number;
  inTok: number;
  outTok: number;
  raw: string;
  error?: string;
}

const JUDGE_SYSTEM = `You are a meticulous evaluator of an AI investing companion called "Advisor". You grade ONE answer against a criterion-separated rubric. You are NOT the Advisor and you do not answer the user's question — you judge the given answer.

Rules:
- Score each dimension INDEPENDENTLY from 1 (poor) to 5 (excellent). Do not let one dimension bleed into another.
- Write your reasoning (the "why") BEFORE committing to each score.
- Be evidence-anchored: to judge "grounded", first quote the specific figures/claims you can verify against the TOOL RESULTS provided. If the answer cites a number that is NOT in the tool results, that is a grounding failure.
- If you genuinely cannot assess a dimension from what you were given, set its score to null ("Unknown") rather than guessing.
- Reward a committed, useful answer; penalize hedged deflections and rote disclaimers. A single light "the decision is yours" note is acceptable and not a penalty.

Dimensions:
- grounded: ${DIMENSION_RUBRIC.grounded}
- complete: ${DIMENSION_RUBRIC.complete}
- structured: ${DIMENSION_RUBRIC.structured}
- adaptive: ${DIMENSION_RUBRIC.adaptive}
- helpful: ${DIMENSION_RUBRIC.helpful}

Respond with ONLY a JSON object, no prose around it, in exactly this shape:
{
  "evidence": "<the figures/claims you verified against the tool results>",
  "grounded":   { "why": "<reason>", "score": <1-5 or null> },
  "complete":   { "why": "<reason>", "score": <1-5 or null> },
  "structured": { "why": "<reason>", "score": <1-5 or null> },
  "adaptive":   { "why": "<reason>", "score": <1-5 or null> },
  "helpful":    { "why": "<reason>", "score": <1-5 or null> },
  "verdict": "<one-line overall take>"
}`;

/** Render the captured tool calls + RESULTS compactly for the grounding check.
 * The result is the figures the answer must be grounded in; truncate so a large
 * payload doesn't blow the judge's context. */
function formatToolTrace(trace: ToolCall[]): string {
  if (!trace.length) return "(no tools called)";
  return trace
    .map((c, i) => {
      const call = `${i + 1}. ${c.name}(${JSON.stringify(c.args ?? {})})`;
      if (c.result === undefined) return call;
      let out = JSON.stringify(c.result);
      if (out.length > 1500) out = `${out.slice(0, 1500)}…(truncated)`;
      return `${call}\n   → returned: ${out}`;
    })
    .join("\n");
}

/** Build the user message: the question, the grounding source, and the answer. */
export function buildJudgeUserMessage(input: JudgeInput): string {
  const parts = [`QUESTION (id: ${input.question.id}):`, input.question.prompt];
  if (input.question.note) parts.push(`\n(Intent of this question: ${input.question.note})`);
  parts.push(
    `\nTOOL RESULTS THE ADVISOR HAD (the only valid grounding source):\n${formatToolTrace(input.toolTrace)}`,
  );
  if (input.transcript) {
    parts.push(
      `\nFULL CONVERSATION (multi-turn — also judge coherence + whether it remembered earlier context):\n${input.transcript}`,
    );
  }
  parts.push(`\nADVISOR'S ANSWER TO JUDGE:\n${input.answer}`);
  parts.push(`\nReturn ONLY the JSON object.`);
  return parts.join("\n");
}

/** Extract the balanced {...} object starting at `start`, respecting string
 * literals (so braces inside strings don't miscount). Returns null if unbalanced
 * (a genuinely truncated response). */
function balancedObject(raw: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull the judge's JSON verdict out of a model response — tolerant of markdown
 * code fences, prose around it, and stray braces in prose. Tries each `{` as a
 * candidate start and returns the first balanced object that satisfies the
 * schema, so a chatty/fenced judge (kimi, minimax) parses as reliably as a clean
 * one. Returns null only when nothing valid is present (truly truncated/garbled). */
export function parseJudge(raw: string): JudgeScores | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const candidate = balancedObject(raw, i);
    if (!candidate) continue; // unbalanced from here — a later `{` may still close
    try {
      const parsed = JudgeSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // not valid JSON from this `{` — try the next one
    }
  }
  return null;
}

/** Aggregate the non-null dimension scores into a mean (1–5) + 0–1 normalized. */
export function aggregateScores(scores: JudgeScores): {
  mean: number | null;
  normalized: number | null;
  unknowns: number;
} {
  const vals: number[] = [];
  let unknowns = 0;
  for (const d of JUDGE_DIMENSIONS) {
    const s = scores[d].score;
    if (s == null) unknowns++;
    else vals.push(s);
  }
  if (vals.length === 0) return { mean: null, normalized: null, unknowns };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { mean, normalized: (mean - 1) / 4, unknowns };
}

/** Mirror of run.ts makeModel — single pinned model, optional reasoning effort. */
function makeJudgeModel(modelId: string, apiKey: string, reasoning: string | undefined) {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    headers: { "HTTP-Referer": "https://macrotide.local", "X-Title": "Macrotide (eval judge)" },
    fetch: !reasoning
      ? undefined
      : async (url, init) => {
          if (init && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body);
              body.reasoning = { effort: reasoning };
              init = { ...init, body: JSON.stringify(body) };
            } catch {
              // not JSON — forward untouched
            }
          }
          return fetch(url as RequestInfo, init);
        },
  });
  return provider(modelId);
}

export interface JudgeOptions {
  model?: string;
  apiKey?: string;
  /** OpenRouter reasoning.effort for the judge; default unset = model default. */
  reasoning?: string;
  maxOutputTokens?: number;
}

/**
 * Judge one Advisor answer. Network-bound (costs tokens) — used only by the eval
 * harness under EVAL_JUDGE=on and by the calibration script, never by `npm test`.
 * The pure pieces (buildJudgeUserMessage / parseJudge / aggregateScores) are unit
 * tested instead.
 */
export async function judgeAnswer(
  input: JudgeInput,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  const base: JudgeResult = {
    ok: false,
    scores: null,
    mean: null,
    normalized: null,
    unknowns: JUDGE_DIMENSIONS.length,
    inTok: 0,
    outTok: 0,
    raw: "",
  };
  if (!apiKey) return { ...base, error: "OPENROUTER_API_KEY missing" };

  const modelId = opts.model ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const reasoning = opts.reasoning ?? process.env.EVAL_JUDGE_REASONING ?? undefined;
  const model = makeJudgeModel(modelId, apiKey, reasoning);
  // Token budget for the judge's JSON. A thinking judge spends some of this on
  // reasoning, so a truncated (unparseable) verdict means raising it (or running
  // with EVAL_JUDGE_REASONING=none — the rubric already asks for visible rationale).
  const envMax = Number(process.env.EVAL_JUDGE_MAX_TOKENS);
  const maxOutputTokens =
    opts.maxOutputTokens ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 900);

  let raw: string;
  let inTok = 0;
  let outTok = 0;
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: buildJudgeUserMessage(input) }],
    });
    raw = result.text ?? "";
    inTok = result.usage?.inputTokens ?? 0;
    outTok = result.usage?.outputTokens ?? 0;
  } catch (e) {
    return { ...base, error: `judge model error: ${(e as Error).message.slice(0, 140)}` };
  }

  const scores = parseJudge(raw);
  if (!scores) return { ...base, inTok, outTok, raw, error: "unparseable judge output" };
  const { mean, normalized, unknowns } = aggregateScores(scores);
  return { ok: true, scores, mean, normalized, unknowns, inTok, outTok, raw };
}
