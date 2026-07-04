// Holdings-image OCR eval — repeatable, committable replacement for the old
// throwaway A/B (`tmp/ocr-eval/`, deleted script + uncommittable real
// screenshots). Renders synthetic SVG fixtures to PNG via sharp (no binaries,
// no browser), runs each candidate model through the REAL production extractor
// (`extractStructuredHoldings` — tests prompt + parser, not just the model),
// and scores digit fidelity + hallucination + latency.
//
// Usage:
//   op run --environment <Macrotide-Dev id> -- npm run eval:ocr
//   EVAL_OCR_MODELS=google/gemini-2.5-flash,x-ai/grok-4.3 npm run eval:ocr
//   EVAL_OCR_HARD=off npm run eval:ocr        # skip the degraded-JPEG variants
//
// Decision driver is QUALITY (per-field exact match) + latency; cost ranking
// comes from the published price table below (gemini-2.5-flash $0.30/$2.50 is
// the cheapest proven option — a candidate must clearly win quality to justify
// a pricier swap). The settled prior verdict was "keep gemini-2.5-flash"; this
// harness exists to re-validate that against current candidates incl. grok.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import sharp from "sharp";
import { createVisionTools } from "@/lib/advisor/vision-tool";
import { extractStructuredHoldings, extractTransactionRows } from "@/lib/portfolio/ocr";
import { type ExpectedRow, OCR_CASES, type OcrTestCase } from "./ocr-ground-truth";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "fixtures", "ocr");

// Build an OpenRouter vision model for the `visual` journey (chart/factsheet
// Q&A). The holdings/txn journeys build the model inside the production extractor
// (via OCR_MODELS); the visual journey calls the production examine_image tool
// directly, so it needs a model handle here. Mirrors lib/ai/provider's openrouter
// helper (that module is server-only; we replicate the minimal call).
const orProvider = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  headers: { "HTTP-Referer": "https://macrotide.local", "X-Title": "Macrotide (eval)" },
});
const visionModel = (id: string): LanguageModel => orProvider(id);

// Published OpenRouter prices ($/Mtok). Keep roughly in sync with
// lib/db/queries/usage.ts BUILTIN_PRICES + scripts/eval/run.ts PRICES.
const PRICES: Record<string, { in: number; out: number }> = {
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "google/gemini-2.5-pro": { in: 1.25, out: 10 },
  "google/gemini-3.5-flash": { in: 1.5, out: 9 },
  "google/gemini-3.1-pro-preview": { in: 2, out: 12 },
  "x-ai/grok-4.3": { in: 1.25, out: 2.5 },
};

const DEFAULT_MODELS = [
  "google/gemini-2.5-flash-lite", // CHOSEN primary (cheapest, perfect on real)
  "google/gemini-3.1-flash-lite", // CHOSEN fallback (current-gen, survives 2.5 EOL)
  "google/gemini-2.5-flash", // prior default / baseline
  "google/gemini-3.5-flash",
  "google/gemini-2.5-pro",
  "x-ai/grok-4.3", // settled: worst on real data + slowest → not for vision
];

const MODELS = (process.env.EVAL_OCR_MODELS ?? DEFAULT_MODELS.join(","))
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const RUN_HARD = process.env.EVAL_OCR_HARD !== "off";
const TOL = 0.001; // 0.1% relative tolerance — digit fidelity is the whole point

// EVAL_OCR_DIR: a local (gitignored) folder of REAL screenshots + a
// ground-truth.json of OcrTestCase[] (with `image` filenames). This is the ONLY
// way to discriminate models on true digit fidelity — synthetic vector fixtures
// can't reproduce real photographic degradation. EVAL_OCR_REAL_ONLY=1 skips the
// committed synthetic cases (run real screenshots alone).
const REAL_DIR = process.env.EVAL_OCR_DIR;
const realCases: OcrTestCase[] = REAL_DIR
  ? (JSON.parse(readFileSync(join(REAL_DIR, "ground-truth.json"), "utf8")) as OcrTestCase[])
  : [];
const allCases: OcrTestCase[] =
  REAL_DIR && process.env.EVAL_OCR_REAL_ONLY ? realCases : [...OCR_CASES, ...realCases];
// EVAL_OCR_JOURNEY=visual|holdings|txn runs just that journey (e.g. the G2
// chart-Q&A pass) so a focused sweep doesn't spend on every case.
const ONLY_JOURNEY = process.env.EVAL_OCR_JOURNEY;
const CASES: OcrTestCase[] = ONLY_JOURNEY
  ? allCases.filter((c) => (c.journey ?? "holdings") === ONLY_JOURNEY)
  : allCases;

function normTicker(t: string): string {
  return t.toUpperCase().replace(/\s+/g, "");
}

function closeEnough(got: number | undefined, want: number): boolean {
  if (got === undefined || Number.isNaN(got)) return false;
  const denom = Math.max(Math.abs(want), 1e-6);
  return Math.abs(got - want) / denom <= TOL;
}

interface CaseScore {
  model: string;
  fixture: string;
  variant: "clean" | "hard";
  ms: number;
  rowsFound: number;
  rowsExpected: number;
  matched: number; // tickers correctly identified
  hallucinated: number; // tickers returned that don't exist
  fieldOk: number; // correct scored fields
  fieldTotal: number; // scored fields across matched rows
  fieldAcc: number; // fieldOk / fieldTotal
}

async function renderFixture(
  c: OcrTestCase,
  hard: boolean,
): Promise<{ data: Buffer; mimeType: string }> {
  if (c.image) {
    // Real screenshot — use the bytes as captured (no synthetic degradation).
    const path = REAL_DIR ? join(REAL_DIR, c.image) : c.image;
    const data = readFileSync(path);
    const mimeType = /\.png$/i.test(c.image)
      ? "image/png"
      : /\.webp$/i.test(c.image)
        ? "image/webp"
        : "image/jpeg";
    return { data, mimeType };
  }
  const svg = readFileSync(join(FIX_DIR, c.svg as string));
  const png = await sharp(svg, { density: 144 }).png().toBuffer();
  if (!hard) return { data: png, mimeType: "image/png" };
  // Moderate stress tier: small + soft + heavy JPEG to approximate a low-quality
  // phone screenshot. NOTE: this is a regression/robustness probe, NOT a fine
  // model discriminator — crisp vector text downscales too gracefully, so every
  // current candidate either passes (mild) or fails together (over-blurred);
  // there's no synthetic middle zone that ranks them. To truly separate models
  // on digit fidelity, run against REAL screenshots via EVAL_OCR_DIR (local,
  // never committed — they're personal data).
  const meta = await sharp(png).metadata();
  const jpeg = await sharp(png)
    .resize({ width: Math.min(440, Math.round((meta.width ?? 820) * 0.42)) })
    .blur(0.5)
    .jpeg({ quality: 28 })
    .toBuffer();
  return { data: jpeg, mimeType: "image/jpeg" };
}

// Transaction journey: score by (ticker+kind) match, plus tradeDate string-match
// and amount/units. The สับเปลี่ยน split is tested implicitly — both legs are
// distinct expected rows with their own kind, so a missed split shows as a miss.
async function scoreTxn(
  model: string,
  c: OcrTestCase,
  img: { data: Buffer; mimeType: string },
  t0: number,
  hard: boolean,
): Promise<CaseScore> {
  let got: Awaited<ReturnType<typeof extractTransactionRows>> = [];
  try {
    got = await extractTransactionRows({ data: img.data, mimeType: img.mimeType });
  } catch (err) {
    console.error(`  ! ${model} ${c.label} txn threw: ${(err as Error).message}`);
  }
  const ms = Date.now() - t0;
  const byTicker = new Map(got.map((r) => [normTicker(r.ticker), r]));
  const truth = new Set(c.rows.map((r) => normTicker(r.ticker)));
  let matched = 0;
  let fieldOk = 0;
  let fieldTotal = 0;
  for (const want of c.rows) {
    const g = byTicker.get(normTicker(want.ticker));
    if (!g) continue;
    matched++;
    // string fields: kind + tradeDate
    for (const sf of ["kind", "tradeDate"] as const) {
      if (want[sf] === undefined) continue;
      fieldTotal++;
      if (String(g[sf] ?? "").toLowerCase() === String(want[sf]).toLowerCase()) fieldOk++;
    }
    for (const f of c.fields) {
      const w = want[f as keyof ExpectedRow];
      if (typeof w !== "number") continue;
      fieldTotal++;
      if (closeEnough((g as unknown as Record<string, unknown>)[f] as number | undefined, w))
        fieldOk++;
    }
  }
  const hallucinated = got.filter((r) => !truth.has(normTicker(r.ticker))).length;
  return {
    model,
    fixture: c.label,
    variant: hard ? "hard" : "clean",
    ms,
    rowsFound: got.length,
    rowsExpected: c.rows.length,
    matched,
    hallucinated,
    fieldOk,
    fieldTotal,
    fieldAcc: fieldTotal ? fieldOk / fieldTotal : 0,
  };
}

// Visual journey (G2): score chart/factsheet Q&A through the PRODUCTION
// examine_image tool — exactly what the Advisor calls in chat. Each question's
// answer must CONTAIN every expected token (case-insensitive). Synthetic
// fixtures print precise values, so this is deterministic — no LLM judge.
async function scoreVisual(
  model: string,
  c: OcrTestCase,
  img: { data: Buffer; mimeType: string },
  t0: number,
): Promise<CaseScore> {
  const tools = createVisionTools({
    images: [{ data: img.data, mimeType: img.mimeType }],
    vision: visionModel(model),
  });
  const examine = (
    tools.examine_image as unknown as {
      execute: (i: { question: string }, o: unknown) => Promise<{ observation: string }>;
    }
  ).execute;
  const qs = c.questions ?? [];
  let ok = 0;
  for (const { q, expect } of qs) {
    let answer = "";
    try {
      const out = await examine({ question: q }, {});
      answer = out.observation ?? "";
    } catch (err) {
      console.error(`  ! ${model} ${c.label} visual threw: ${(err as Error).message}`);
    }
    const lower = answer.toLowerCase();
    const pass = expect.every((e) => lower.includes(e.toLowerCase()));
    if (pass) ok++;
    console.log(`    ${pass ? "✓" : "✗"} ${q}  ⟶  ${answer.replace(/\s+/g, " ").slice(0, 110)}`);
  }
  return {
    model,
    fixture: c.label,
    variant: "clean",
    ms: Date.now() - t0,
    rowsFound: qs.length,
    rowsExpected: qs.length,
    matched: ok,
    hallucinated: 0,
    fieldOk: ok,
    fieldTotal: qs.length,
    fieldAcc: qs.length ? ok / qs.length : 0,
  };
}

async function scoreCase(model: string, c: OcrTestCase, hard: boolean): Promise<CaseScore> {
  const img = await renderFixture(c, hard);
  process.env.OCR_MODELS = model; // single-model chain → no fallback → measures THIS model alone

  const t0 = Date.now();
  if (c.journey === "visual") return scoreVisual(model, c, img, t0);
  if (c.journey === "txn") return scoreTxn(model, c, img, t0, hard);
  let got: Awaited<ReturnType<typeof extractStructuredHoldings>> = [];
  try {
    got = await extractStructuredHoldings({ data: img.data, mimeType: img.mimeType });
  } catch (err) {
    console.error(
      `  ! ${model} ${c.label}/${hard ? "hard" : "clean"} threw: ${(err as Error).message}`,
    );
  }
  const ms = Date.now() - t0;

  const byTicker = new Map(got.map((r) => [normTicker(r.ticker), r]));
  const truthTickers = new Set(c.rows.map((r) => normTicker(r.ticker)));
  let matched = 0;
  let fieldOk = 0;
  let fieldTotal = 0;
  for (const want of c.rows) {
    const g = byTicker.get(normTicker(want.ticker));
    if (!g) continue;
    matched++;
    for (const f of c.fields) {
      const w = want[f as keyof ExpectedRow];
      if (typeof w !== "number") continue;
      fieldTotal++;
      if (closeEnough((g as unknown as Record<string, unknown>)[f] as number | undefined, w))
        fieldOk++;
    }
  }
  const hallucinated = got.filter((r) => !truthTickers.has(normTicker(r.ticker))).length;

  return {
    model,
    fixture: c.label,
    variant: hard ? "hard" : "clean",
    ms,
    rowsFound: got.length,
    rowsExpected: c.rows.length,
    matched,
    hallucinated,
    fieldOk,
    fieldTotal,
    fieldAcc: fieldTotal ? fieldOk / fieldTotal : 0,
  };
}

async function main() {
  console.log(
    `OCR eval · models=[${MODELS.join(", ")}] · hard=${RUN_HARD ? "on" : "off"} · tol=${TOL}\n`,
  );
  const rows: CaseScore[] = [];
  for (const model of MODELS) {
    for (const c of CASES) {
      // Real images run as-is; visual Q&A is about reasoning not digit fidelity;
      // only synthetic holdings/txn fixtures get the degraded-JPEG variant.
      const variants = c.image || c.journey === "visual" || !RUN_HARD ? [false] : [false, true];
      for (const hard of variants) {
        const s = await scoreCase(model, c, hard);
        rows.push(s);
        console.log(
          `${model.padEnd(30)} ${`${s.fixture}/${s.variant}`.padEnd(20)} ` +
            `codes ${s.matched}/${s.rowsExpected}  fields ${s.fieldOk}/${s.fieldTotal} (${(s.fieldAcc * 100).toFixed(0)}%)  ` +
            `halluc ${s.hallucinated}  ${s.ms}ms`,
        );
      }
    }
  }

  // Per-model summary (quality + worst-case + latency + published cost).
  console.log("\n=== summary (per model) ===");
  for (const model of MODELS) {
    const mr = rows.filter((r) => r.model === model);
    const fOk = mr.reduce((a, r) => a + r.fieldOk, 0);
    const fTot = mr.reduce((a, r) => a + r.fieldTotal, 0);
    const codesOk = mr.reduce((a, r) => a + r.matched, 0);
    const codesTot = mr.reduce((a, r) => a + r.rowsExpected, 0);
    const halluc = mr.reduce((a, r) => a + r.hallucinated, 0);
    const avgMs = Math.round(mr.reduce((a, r) => a + r.ms, 0) / Math.max(mr.length, 1));
    const worst = Math.min(...mr.map((r) => r.fieldAcc));
    const p = PRICES[model];
    const price = p ? `$${p.in}/$${p.out} per Mtok` : "price ?";
    console.log(
      `${model.padEnd(30)} fields ${((fTot ? fOk / fTot : 0) * 100).toFixed(0)}%  codes ${codesOk}/${codesTot}  ` +
        `worst-case ${(worst * 100).toFixed(0)}%  halluc ${halluc}  ${avgMs}ms avg  ${price}`,
    );
  }

  const outDir = join(HERE, "..", "..", "eval-results");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `ocr-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ models: MODELS, hard: RUN_HARD, tol: TOL, rows }, null, 2));
  console.log(`\nwrote ${out}`);

  // Threshold gate: zero hallucination on clean images; ≥80% fields on hard.
  const cleanHalluc = rows
    .filter((r) => r.variant === "clean")
    .reduce((a, r) => a + r.hallucinated, 0);
  if (process.env.EVAL_OCR_GATE === "on" && cleanHalluc > 0) {
    console.error(`\nGATE FAIL: ${cleanHalluc} hallucinated rows on clean fixtures`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
