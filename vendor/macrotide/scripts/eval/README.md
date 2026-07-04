# Advisor eval harness

A committed, repeatable benchmark for the Advisor chat loop. Run it **before**
flipping `FREE_TIER_MODEL`, editing the system prompt, or enabling gated
reasoning (#58) so model/prompt changes are measured, not guessed.

It runs a fixed question set through one or more models against a **synthetic**
tool surface (no real fund codes — `EXAMPLE-FUND-*` only) that mirrors the real
advisor + memory tools, using the **exact production system prompt**
(`lib/advisor/system-prompt.ts`) and OpenRouter wiring. For each turn it records, and aggregates per `(model, tier)`:

- **dead-end rate** — turns that produced no prose (the issue #21 failure mode),
  reported as its own % (a distinct reliability failure, not a zero in quality)
- **quality (avg@N) ± 95% CI** — mean deterministic score across runs, with a
  confidence interval (shown when `EVAL_N ≥ 2`) so a gap that's just run-variance
  rather than a real difference is visible at a glance
- **pass^k** — the fraction of QUESTIONS where *all* `EVAL_N` runs passed: the
  load-bearing reliability number a single-run mean hides (75%/run ≈ 42% at k=3)
- **three sub-signals**, reported separately rather than collapsed —
  **facts** (grounded completeness), **tools** (right tools called, with the right
  arguments, a bounded trajectory, no over-calling), **safety** (no invented
  holdings)
- **latency / tokens / cost** — wall-clock, in/out tokens, USD estimate
- a **PASS/FAIL verdict** against pre-declared per-tier thresholds (dead-end,
  grounded-facts floor, hallucination=0). Set `EVAL_GATE=on` to exit non-zero on
  a breach (a pre-change gate). See `questions.ts` for per-question expectations
  and `run.ts` `THRESHOLDS` for the acceptance criteria.

The deterministic grader is the **floor that survives model swaps** and stays the
regression gate. On top of it, an **opt-in LLM-as-judge** (`EVAL_JUDGE=on`) grades
the qualities regex can't reach — see [LLM-judge](#llm-judge-quality-layer) below.

Two tiers (`questions.ts`):

- **retrieve** — the common path: read a tool, report the number. Reasoning is
  pure cost here.
- **complex** — multi-step judgment the tools didn't pre-compute (rebalance
  sequencing, SSF-vs-RMF, a plan-anchored tilt). Where reasoning may earn its
  cost — the tier that lets us measure that.

## Run

```bash
npm run eval:advisor                                            # default model, all tiers
EVAL_MODELS=google/gemini-2.5-flash-lite,google/gemini-2.5-flash npm run eval:advisor
EVAL_TIER=complex EVAL_REASONING=medium npm run eval:advisor    # the #58 A/B …
EVAL_TIER=complex EVAL_REASONING=none   npm run eval:advisor    # … vs the baseline
```

It hits the live OpenRouter API and **spends real tokens** (`OPENROUTER_API_KEY`
from `.env.local`), so it is intentionally NOT part of `npm test`. The structure
of the question set, grader, statistics, and diff is guarded for free in
`tests/eval/*.test.ts`.

Each run writes its results to `eval-results/<timestamp>.json` (gitignored),
tagged with the current commit SHA, every per-turn row, the trajectory length
(`steps`), and the tool calls *with arguments* — enough to re-grade or audit a
run after the fact. A question can bound its trajectory with `maxSteps` (a simple
lookup that takes five generations is thrashing) or `minSteps`.

## Compare two runs

```bash
npm run eval:diff -- eval-results/<before>.json eval-results/<after>.json
```

Pairs questions by `(model, qid)` across the two files and reports the score
delta, which questions newly **fail** or got **fixed** (pass^k flips), and a
**paired McNemar test** over the shared set — so a before/after comparison is
mechanical, and a "winner" is only declared significant when the flips lean one
way beyond chance. The first file is the baseline; a positive delta means the
second (candidate) scored higher.

### Env knobs

| Var | Default | Meaning |
|---|---|---|
| `EVAL_MODELS` | `google/gemini-2.5-flash-lite` | comma list of OpenRouter model ids |
| `EVAL_TIER` | `all` | `retrieve` \| `complex` \| `all` |
| `EVAL_N` | `1` | repeats per question |
| `EVAL_REASONING` | _unset_ | `none`\|`minimal`\|`low`\|`medium`\|`high` (injected as `reasoning.effort`) |
| `EVAL_MAX_TOKENS` | 1024 (2048 when reasoning ≥ low) | output cap per turn |
| `EVAL_OUT` | `eval-results/<timestamp>.json` | raw per-turn results (gitignored) |
| `EVAL_GATE` | _off_ | `on` → exit non-zero when a pre-declared threshold is breached |
| `EVAL_JUDGE` | _off_ | `on` → also run the LLM-judge quality layer (extra token cost) |
| `EVAL_JUDGE_MODEL` | `openai/gpt-5.5` | judge model (a different family than the model under test) |
| `EVAL_JUDGE_REASONING` | _unset_ | optional `reasoning.effort` for the judge |

Use `EVAL_N≥3` for any comparison (a single run conflates model variance with
capability).

## LLM-judge (quality layer)

The deterministic grader proves an answer is **grounded + complete + safe**, but
can't see whether advice is well-structured, adapted to a beginner, or genuinely
helpful rather than a hedged deflection. `EVAL_JUDGE=on` adds a second model
(`scripts/eval/judge.ts`) that scores each answer on a criterion-separated rubric
— **grounded · complete · structured · adaptive · helpful**, each 1–5 with an
explicit *Unknown* escape — reasoning before the score, evidence-anchored against
the captured tool results, at temperature 0. It is **opt-in and additive**: the
deterministic floor still runs and stays the regression gate.

```bash
EVAL_JUDGE=on EVAL_TIER=complex EVAL_N=3 npm run eval:advisor   # quality sweep
```

The judge must be a **different model family** than the candidates (never grade
your own family) — default `openai/gpt-5.5`, neutral vs. the gemini/glm/minimax/
kimi candidates. Build details and the design rationale:
`docs/explanation/research/agent-evals.md § LLM-as-judge, done safely`.

### Calibrate the judge first

An uncalibrated judge is noise. Before trusting it, run it against hand-labeled
answers (a few ideal, a few deliberately bad) and confirm it agrees:

```bash
EVAL_JUDGE_MODELS=openai/gpt-5.5,moonshotai/kimi-k2.6 npm run eval:judge:calibrate
```

Reports per-judge **agreement %** (target ≥ 75) + ideal-vs-bad separation + token
cost, so the **cheapest** judge that clears the bar can be chosen. Cases live in
`scripts/eval/calibration.ts`.

## Multi-turn ("long discussion")

A question can carry follow-up `turns: string[]` after its `prompt`, turning it
into a multi-turn conversation. The run threads the assistant + tool messages back
between turns; the deterministic grader + the judge evaluate the **final** turn
(the judge also sees the whole transcript, scoring cross-turn coherence and
whether the model held earlier context). See `M1-long-discussion` in
`questions.ts`.

## Changing the question set

The questions are a small **golden set**. To keep it honest (and avoid
Goodharting a score by editing the test): treat the current set as **frozen** —
fix only genuine grader bugs (e.g. a regex missing a number format), and **add**
new questions rather than loosening existing ones. Prefer growing the complex
tier, which is where reasoning and harder grounding live.

A question can opt into a different data surface with `fixture: "empty"`, which
routes the portfolio reads to a **no-holdings** fixture — used by the
`N2-empty-holdings` *negative control*, where the only correct answer is "you
have no holdings yet" and naming a fund or an allocation % is a hallucination.
Negative controls (the right move is to *refuse*, not answer) are as important as
the positive ones. Beyond names, a question can assert a tool was called with the
right **arguments** via `expectToolArgs` (e.g. `find_cheaper_alternatives` was
asked about the fund the user actually holds), which a name-only check misses.

## Holdings-image OCR eval (`eval:ocr`)

Covers both the **image extractors** (`extractStructuredHoldings` /
`extractTransactionRows`, the Add-holdings importer) and the **chat vision tool**
(`examine_image`), not the chat loop. `npm run eval:ocr` (under `op run` for the
key) renders committed **SVG fixtures → PNG via sharp** (no binaries, no browser)
and scores each candidate model. Three journeys:

- **holdings / txn** — per-field digit fidelity, hallucination, latency on the
  extractors.
- **visual** — chart/factsheet Q&A through the production `examine_image` tool,
  scored by answer-contains-expected (synthetic fixtures print precise values, so
  it's deterministic — no LLM judge). This is the **G2** gate that decides whether
  `VISION_CHAT_ESCALATE_MODELS` earns its cost.

- **Fixtures** (`fixtures/ocr/`): holdings tables/cards + mobile variants
  (generated by `_build.mjs` — light/dark themes, ฿-prefix + (paren)-loss edges,
  RMF/SSF/ThaiESG sections with semantic traps), a transaction-history fixture
  (BE dates, สับเปลี่ยน→two rows), and hand-authored `chart-performance.svg` +
  `factsheet.svg` for the visual journey.
- **Real screenshots**: `EVAL_OCR_DIR=<dir>` reads a **gitignored**
  `<dir>/ground-truth.json` of real captures — personal data, never committed,
  and the only input that discriminates models on true digit fidelity (synthetic
  vector text downscales too gracefully). `EVAL_OCR_REAL_ONLY=1` runs those alone.
- **Knobs**: `EVAL_OCR_MODELS` (comma list), `EVAL_OCR_JOURNEY=visual|holdings|txn`
  (run one journey — e.g. a focused chart-Q&A pass), `EVAL_OCR_HARD=off` (skip the
  degraded-JPEG tier). The model verdict lives in
  `docs/explanation/inference-strategy.md` §1 (Vision & OCR pick).

## Out of scope

Fine-tuning. For a hosted-model app fronted by OpenRouter the levers are context
engineering + tool design + model selection — see
`docs/explanation/inference-strategy.md`.
