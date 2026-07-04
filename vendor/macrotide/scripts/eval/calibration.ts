// Judge calibration (issue #65). Before the LLM-judge can be trusted to rank
// models, it must agree with HUMAN labels. This runs the judge over a small set
// of hand-written answers — a few deliberately ideal, a few deliberately bad
// (hedged, shallow, hallucinated, jargon-for-a-beginner, off-scope) — each tagged
// with the score band a human expects per dimension, and reports agreement.
//
// Per docs/explanation/research/agent-evals.md: "Use human feedback to calibrate
// automated scoring." Target 75–90% agreement. If the judge can't rank a known-
// good answer above a known-bad one, fix the rubric BEFORE spending on a sweep.
//
//   EVAL_JUDGE_MODELS=openai/gpt-5.5,minimax/minimax-m3,moonshotai/kimi-k2.6 npm run eval:judge:calibrate
//
// Runs each judge candidate over every case and prints agreement + token cost, so
// the cheapest judge that clears the bar can be chosen (cost vs. intelligence,
// decided by data).
//
// PROVENANCE / KNOWN BIAS: the expected score bands below (the "answer key") were
// authored by Claude Opus 4.8. So agreement here measures whether a judge matches
// Opus's labels — which is meaningful for a DIFFERENT-family judge (gpt-5.5), but
// would be self-consistency (not skill) for a Claude judge. Replace/augment with
// human labels before trusting the judge on Claude-family candidates. See
// docs/explanation/research/agent-evals.md § LLM-as-judge.

import { DEFAULT_JUDGE_MODEL, JUDGE_DIMENSIONS, type JudgeDimension, judgeAnswer } from "./judge";
import type { ToolCall } from "./questions";

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("OPENROUTER_API_KEY not in env (run via: npm run eval:judge:calibrate).");
  process.exit(1);
}

// ── Synthetic tool results the answers should be grounded in (mirror fixtures) ──
const PORTFOLIO_RESULT = {
  totalValue: 1_000_000,
  blendedTer: 0.585,
  concentration: { top: { ticker: "EXAMPLE-FUND-A", pct: 50 }, top3Pct: 90, holdingCount: 3 },
  drift: [{ ticker: "EXAMPLE-FUND-C", label: "Global Bond", drift: -15 }],
  cashPct: 10,
};
const TAX_RESULT = {
  scope: { name: "Tax" },
  totalValue: 300_000,
  blendedTer: 0.75,
  concentration: { top: { ticker: "EXAMPLE-FUND-B", pct: 83 }, holdingCount: 1 },
  cashPct: 17,
  ledger: { irrPct: 1.2 },
};
const TAX_PERF_RESULT = {
  scope: { name: "Tax" },
  periodReturnPct: 0.7,
  benchmarks: [
    { label: "SET Index", returnPct: 4.3, beating: false },
    { label: "S&P 500", returnPct: 9.8, beating: false },
  ],
};

const portfolioCall = (): ToolCall => ({
  name: "read_portfolio",
  args: {},
  result: PORTFOLIO_RESULT,
});
const taxCall = (): ToolCall => ({
  name: "read_portfolio",
  args: { portfolio: "Tax" },
  result: TAX_RESULT,
});
const taxPerfCall = (): ToolCall => ({
  name: "read_performance",
  args: { portfolio: "Tax" },
  result: TAX_PERF_RESULT,
});

type Band = "high" | "low"; // high = a human expects ≥4; low = ≤2

interface CalCase {
  id: string;
  kind: "ideal" | "bad";
  question: { id: string; prompt: string; note?: string };
  toolTrace: ToolCall[];
  answer: string;
  expect: Partial<Record<JudgeDimension, Band>>;
}

// ~12 hand-labeled cases. Each labels only the dimensions a human can call
// unambiguously for that answer (a 3 is "no clear label" → omitted).
const CASES: CalCase[] = [
  {
    id: "ideal-portfolio-review",
    kind: "ideal",
    question: { id: "review", prompt: "How are my portfolios doing? What should I do?" },
    toolTrace: [portfolioCall()],
    answer:
      "Your biggest position, EXAMPLE-FUND-A, is 50% of the ฿1,000,000 book and your top three holdings are 90% — that's concentrated. Your blended fee is 0.585%, which is reasonable. The clearest gap: bonds are 15 percentage points under your target, so the single best move is to shift roughly ฿150,000 into your global bond fund (EXAMPLE-FUND-C) to get back on plan. The decision is yours, but that one rebalance fixes the biggest drift.",
    expect: { grounded: "high", complete: "high", structured: "high", helpful: "high" },
  },
  {
    id: "hallucinated-figure",
    kind: "bad",
    question: { id: "review", prompt: "How are my portfolios doing?" },
    toolTrace: [portfolioCall()],
    answer:
      "EXAMPLE-FUND-A is about 64% of your book and EXAMPLE-FUND-Z is dragging you down. Your fee is around 1.4%, which is high. I'd sell EXAMPLE-FUND-Z immediately.",
    expect: { grounded: "low" },
  },
  {
    id: "hedged-deflection",
    kind: "bad",
    question: { id: "plan", prompt: "What should I do about my Tax portfolio?" },
    toolTrace: [taxCall()],
    answer:
      "I'm not a licensed financial advisor and I can't tell you what to do with your money. Investing carries risk and you could lose money. Please consult a qualified professional who can review your full situation.",
    expect: { helpful: "low", structured: "low" },
  },
  {
    id: "shallow-vague",
    kind: "bad",
    question: { id: "review", prompt: "Give me a read on my portfolio." },
    toolTrace: [portfolioCall()],
    answer:
      "Your portfolio looks reasonable overall. Keep investing regularly and stay the course and you should be fine over the long run.",
    expect: { grounded: "low", complete: "low", helpful: "low" },
  },
  {
    id: "tax-good-structured",
    kind: "ideal",
    question: {
      id: "plan",
      prompt: "My Tax portfolio's return is low. Plan the next step.",
      note: "diagnose why it lags",
    },
    toolTrace: [taxCall()],
    answer:
      "Diagnosis: your Tax portfolio is 83% in a single fund (EXAMPLE-FUND-B) and holding 17% cash — both drag the return, and the IRR is only 1.2%. Why: one fund means no diversification, and idle cash earns nothing. Options: (1) add a second, different index fund to cut the single-fund risk; (2) put the 17% cash to work. Recommendation: this month, move most of the cash into a second index fund so no holding dominates. That directly addresses both problems.",
    expect: { grounded: "high", structured: "high", helpful: "high", complete: "high" },
  },
  {
    id: "tax-wall-of-caveats",
    kind: "bad",
    question: { id: "plan", prompt: "What should I do about my Tax portfolio?" },
    toolTrace: [taxCall()],
    answer:
      "There are many things to consider. Past performance doesn't predict the future. Your risk tolerance matters. Tax rules change. Markets are uncertain. Concentration can be good or bad depending on your views. Cash can be prudent or a drag. It really depends on many factors and your personal circumstances.",
    expect: { structured: "low", helpful: "low" },
  },
  {
    id: "beginner-jargon",
    kind: "bad",
    question: {
      id: "beginner",
      prompt: "I'm new to investing and don't understand the jargon. How am I doing?",
      note: "beginner — must define terms",
    },
    toolTrace: [taxCall()],
    answer:
      "Your money-weighted IRR is 1.2%, the HHI is 0.71 indicating high concentration, your tracking error versus the benchmark is around 2pp, and the cash allocation of 17% creates a drag on risk-adjusted returns relative to your strategic asset allocation.",
    expect: { adaptive: "low" },
  },
  {
    id: "beginner-plain-good",
    kind: "ideal",
    question: {
      id: "beginner",
      prompt: "I'm new to investing and don't understand the jargon. How am I doing?",
      note: "beginner — must define terms",
    },
    toolTrace: [taxCall()],
    answer:
      "In plain terms: about 83% of your Tax pot sits in one single fund. That's risky — if that one fund falls, almost your whole pot falls with it. Spreading money across a few funds (called diversifying) softens that. You're also holding 17% in cash, which is just sitting there not growing. A good first step is to move some of that cash into a second, different fund so you're not relying on just one.",
    expect: { adaptive: "high", helpful: "high", grounded: "high" },
  },
  {
    id: "off-scope",
    kind: "bad",
    question: { id: "review", prompt: "How are my portfolios doing?" },
    toolTrace: [portfolioCall()],
    answer:
      "When it comes to crypto, you'll want to track your cost basis carefully for US capital-gains tax, and consider tax-loss harvesting before year end. Staking rewards are taxable as income at receipt.",
    expect: { grounded: "low", complete: "low" },
  },
  {
    id: "grounded-but-unhelpful",
    kind: "bad",
    question: { id: "plan", prompt: "What should I do about my Tax portfolio?" },
    toolTrace: [taxCall()],
    answer:
      "Your Tax portfolio is 83% in EXAMPLE-FUND-B, holds 17% cash, and the IRR is 1.2%. Those are the numbers. Ultimately it's hard to say what's right for you — everyone's situation is different, so you should do your own research before making any changes.",
    expect: { grounded: "high", helpful: "low" },
  },
  {
    id: "perf-good",
    kind: "ideal",
    question: { id: "perf", prompt: "How is my Tax portfolio doing versus the market?" },
    toolTrace: [taxPerfCall()],
    answer:
      "Over the last 6 months your Tax portfolio returned 0.7%. That trails both benchmarks: the SET Index returned 4.3% and the S&P 500 returned 9.8% over the same period, so you're behind the market on both.",
    expect: { grounded: "high", complete: "high" },
  },
  {
    id: "perf-fabricated",
    kind: "bad",
    question: { id: "perf", prompt: "How is my Tax portfolio doing versus the market?" },
    toolTrace: [taxPerfCall()],
    answer:
      "Good news — your Tax portfolio is up about 8.4% recently, which is comfortably ahead of the SET and roughly in line with the S&P 500. You're beating your benchmark.",
    expect: { grounded: "low" },
  },
];

// Rough $/1M for the judge candidates — for the cost-vs-intelligence call.
const JUDGE_PRICES: Record<string, { in: number; out: number }> = {
  "openai/gpt-5.5": { in: 5, out: 30 },
  "moonshotai/kimi-k2.6": { in: 0.67, out: 3.39 },
  "anthropic/claude-sonnet-4.6": { in: 3, out: 15 },
  "google/gemini-2.5-pro": { in: 1.25, out: 5 },
};

function agrees(label: Band, score: number | null): boolean {
  if (score == null) return false; // Unknown never matches a clear human label
  return label === "high" ? score >= 4 : score <= 2;
}

async function calibrateModel(modelId: string) {
  console.log(`\n━━━ judge: ${modelId} ━━━`);
  let labeled = 0;
  let agreed = 0;
  const perDim: Record<string, { agreed: number; total: number }> = {};
  for (const d of JUDGE_DIMENSIONS) perDim[d] = { agreed: 0, total: 0 };
  const idealMeans: number[] = [];
  const badMeans: number[] = [];
  let inTok = 0;
  let outTok = 0;

  for (const c of CASES) {
    const res = await judgeAnswer(
      { question: c.question, answer: c.answer, toolTrace: c.toolTrace },
      { model: modelId },
    );
    inTok += res.inTok;
    outTok += res.outTok;
    if (!res.ok || !res.scores) {
      console.log(`  [${c.kind.padEnd(5)}] ${c.id.padEnd(24)} JUDGE ERROR: ${res.error}`);
      // CAL_DEBUG=1 prints the tail of the raw output so an "unparseable" failure
      // can be diagnosed (truncated JSON vs wrong format) without guessing.
      if (process.env.CAL_DEBUG && res.raw) {
        console.log(`        raw[${res.raw.length}]…${JSON.stringify(res.raw.slice(-180))}`);
      }
      continue;
    }
    if (res.mean != null) (c.kind === "ideal" ? idealMeans : badMeans).push(res.mean);

    const misses: string[] = [];
    for (const [dim, label] of Object.entries(c.expect) as [JudgeDimension, Band][]) {
      labeled++;
      perDim[dim].total++;
      const score = res.scores[dim].score;
      if (agrees(label, score)) {
        agreed++;
        perDim[dim].agreed++;
      } else {
        misses.push(`${dim}:want ${label} got ${score ?? "?"}`);
      }
    }
    const ok = misses.length === 0 ? "✓" : `✗ ${misses.join(", ")}`;
    console.log(
      `  [${c.kind.padEnd(5)}] ${c.id.padEnd(24)} mean ${res.mean?.toFixed(1) ?? "—"}/5  ${ok}`,
    );
  }

  const agreement = labeled ? (agreed / labeled) * 100 : 0;
  const idealAvg = idealMeans.length
    ? idealMeans.reduce((a, b) => a + b, 0) / idealMeans.length
    : null;
  const badAvg = badMeans.length ? badMeans.reduce((a, b) => a + b, 0) / badMeans.length : null;
  const price = JUDGE_PRICES[modelId];
  const cost = price ? (inTok * price.in + outTok * price.out) / 1e6 : null;

  console.log(
    `\n  AGREEMENT ${agreement.toFixed(0)}% (${agreed}/${labeled} labeled dims)` +
      `   ideal-mean ${idealAvg?.toFixed(2) ?? "—"} vs bad-mean ${badAvg?.toFixed(2) ?? "—"}` +
      (idealAvg != null && badAvg != null
        ? `  (separation ${(idealAvg - badAvg).toFixed(2)})`
        : ""),
  );
  console.log(
    `  per-dim: ${JUDGE_DIMENSIONS.map((d) => `${d.slice(0, 4)} ${perDim[d].agreed}/${perDim[d].total}`).join("  ")}`,
  );
  console.log(
    `  tokens in=${inTok} out=${outTok}${cost != null ? `  ~$${cost.toFixed(4)} for all ${CASES.length} cases` : ""}`,
  );
  const verdict =
    agreement >= 75 && (idealAvg ?? 0) > (badAvg ?? 5)
      ? "TRUST (≥75% + ideal>bad)"
      : "DO NOT TRUST — fix the rubric before the sweep";
  console.log(`  → ${verdict}`);
  return { modelId, agreement, idealAvg, badAvg, cost };
}

async function main() {
  const models = (process.env.EVAL_JUDGE_MODELS ?? DEFAULT_JUDGE_MODEL)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  console.log(
    `Judge calibration — ${CASES.length} hand-labeled cases × ${models.length} judge model(s)`,
  );
  const summary = [];
  for (const m of models) summary.push(await calibrateModel(m));

  if (summary.length > 1) {
    console.log(`\n═══ JUDGE COMPARISON (cost vs. agreement) ═══`);
    for (const s of summary) {
      console.log(
        `  ${s.modelId.padEnd(28)} agreement ${s.agreement.toFixed(0)}%  ` +
          `sep ${s.idealAvg != null && s.badAvg != null ? (s.idealAvg - s.badAvg).toFixed(2) : "—"}  ` +
          `${s.cost != null ? `$${s.cost.toFixed(4)}/run` : ""}`,
      );
    }
    console.log(
      `  → pick the CHEAPEST judge clearing ~75% agreement with clear ideal>bad separation.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
