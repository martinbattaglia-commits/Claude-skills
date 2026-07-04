# Evaluating tool-using agents — a prior-art survey

*Researched May 2026 · extended June 2026 (LLM-judge built + calibrated; the dated model price/intelligence snapshot)*

## Summary

How to tell whether a change to an AI agent — a new model, a reworded prompt, a
reasoning-budget tweak — actually made it **better**, rather than better on the
one example you happened to try. The field's answer is an **eval**: a repeatable
harness that runs the agent on a fixed set of tasks and **grades** the results,
so a change produces a number you can defend instead of a vibe.

The recurring lessons across Anthropic, OpenAI, the academic LLM-as-judge
literature, and the agent-benchmark work (τ-bench, BFCL):

- An eval is a **triple** — a *task* (input + an unambiguous success criterion),
  a *harness* that runs the agent under production-identical conditions, and one
  or more *graders* that score the result.
- Grade **outcome and trajectory**, but grade *what was produced, not the exact
  path*: assert the right tools were called, not a fixed order.
- Put a **deterministic grader first** (fast, cheap, reproducible, survives model
  swaps); add an **LLM-as-judge** only for what code can't reach, and only after
  calibrating it against humans — it is biased and low-recall by default.
- **Never trust a single run.** A conversational agent is stochastic; report a
  *distribution* — `pass^k` (all runs succeed) and `avg@N` (mean) — and decide
  with **pre-declared thresholds**, not a glance.
- **Read the transcripts.** A score is not trustworthy until someone reads what
  the grader scored; a rigid grader hides real capability.

This survey is oriented to Macrotide's problem: a small, cheap model behind
OpenRouter acting as **Advisor** over a tool surface, whose signature failure is
the *empty turn* — it calls a tool then stops without answering (the
[empty-turn dead-end](../advisor-context.md)). Small models fail more, and fail
stochastically, so the
discipline here matters more, not less.

## Decision

Macrotide grades the Advisor with a **committed, deterministic** harness
(`scripts/eval/`) over a **hermetic synthetic tool surface** (`EXAMPLE-FUND-*`
codes, never the live DB) in two tiers — *retrieve-then-explain* and *complex
multi-step* — reporting dead-end rate, quality, the `pass^k` reliability number,
three sub-signals (grounded-facts / tool-trace / no-hallucination), and a
PASS/FAIL verdict against pre-declared thresholds. It runs against the live API
on demand (not in CI); a token-free vitest guards its structure. This document is
the **evidence** behind that shape; the **verdict and knobs** live in
[inference-strategy.md § Evaluation](../inference-strategy.md#7-evaluation), and
the **how-to** in [scripts/eval/README.md](../../../scripts/eval/README.md). An
opt-in, calibrated LLM-as-judge layer sits on top of it (see § LLM-as-judge below).
The harness's first sweep (Jun 2026) locked the owner model; that result + the
pick live in the verdict doc —
[inference-strategy.md § Model routing & tiers](../inference-strategy.md#1-model-routing--tiers).

## The eval triple: task, harness, grader

Anthropic frames an agent eval as three parts. The **task** is an input plus a
success criterion written so that two domain experts would grade it the same way
— ambiguous specs are the single most common source of misleading scores. The
**harness** runs the agent under production-identical conditions (same model
wiring, system prompt, tool loop). The **grader** scores the result.

Two complementary things can be graded:

- **Outcome** — did the final answer carry the right grounded fact / reach the
  right end state? Catches *that* it failed.
- **Trajectory** — were the right tools called with the right arguments, no
  spurious calls, the result actually used? Localizes *why* it failed.

The guiding rule is to *"grade what the agent produced, not the path it took"*
(Anthropic) — assert tool-call **set membership**, not a fixed sequence, so a
valid alternate path isn't penalized. Macrotide's grader already separates
`expectTools` / `mustInclude` / `mustNotInclude`; this is that split.

## Graders on a spectrum

| Grader | Use it for | Cost / caveat |
|---|---|---|
| **Programmatic / deterministic** (string, regex, set membership, tool-presence, numeric/budget) | Any dimension with a canonical answer: grounded figures, required tools, no hallucinated holdings, dead-ends, latency/token budgets | Fast, objective, reproducible, survives model swaps — but brittle to valid surface variation; can't judge coherence. Mitigate by normalizing whitespace / stripping markdown and using "any-of" matchers |
| **Trajectory / tool-call** (selection, arguments, irrelevant-call, result-utilization) | Localizing *why* an answer failed; catching over-calling and ignored tool results | Deterministic and cheap for tool *names*; argument/utilization checks need the steps captured. Don't grade an exact ordered sequence |
| **LLM-as-judge** (pointwise rubric / score-model) | Only what code can't reach: prose coherence, whether advice is genuinely grounded, complex-tier judgment | Flexible but non-deterministic, costs tokens, low recall, biased — must be calibrated (see below) |
| **Composite / multigrader** | One pass/fail gate that still localizes (e.g. tools AND grounding AND no-hallucination) | Convenient single signal — but always *also* report each sub-signal, or root cause is lost |
| **Human review** | Calibrating a judge; spot-checking a handful of transcripts every run | Highest fidelity, catches grader bugs — unscalable as a per-run gate |

The consensus shape: a **deterministic floor** as the regression gate, an LLM
judge as an **optional upper layer** added only once observed grader-vs-human
disagreement justifies its cost.

## Dataset design

- **Start small, from real failures.** 20–50 tasks mined from things the agent
  actually got wrong beat hundreds of synthetic ones — early on, changes have
  large effect sizes and small samples give clear signal.
- **Write unambiguous specs.** A 0% pass rate is *"most often a signal of a
  broken task"* (Anthropic), not an incapable agent.
- **Positive *and* negative cases.** *"Test both the cases where a behavior
  should occur and where it shouldn't"* (Anthropic) — e.g. a question where the
  agent should call **no** tool, to catch reflexive over-calling.
- **Freeze, then extend.** Once a baseline is recorded, editing questions to lift
  scores is small-team Goodharting; only *add* to a versioned extension set.
- **Grow by dimensions.** Expand coverage along axes (intent × data condition ×
  difficulty) rather than ad hoc — and prioritize the cells that are thin.

## Non-determinism and statistics

A conversational agent is stochastic, so **a single run conflates model variance
with capability**. On a ~20-item set the margin of error is roughly ±11pp; the
empty-turn failure is stochastic by nature. The metrics that matter:

- **`avg@N`** — the mean score over N runs. The cheap, stable summary.
- **`pass@k`** — at least one of k runs succeeds. Relevant when any single
  success counts (it rarely does for an advisor).
- **`pass^k`** — *all* k runs succeed. This is the load-bearing number for a
  customer-facing agent: 75% per-run is only ~42% at k=3. The mean hides a model
  that's right on average but flaky; `pass^k` surfaces the collapse.

Decide *with* the uncertainty: report a confidence interval (or a Bayesian
credible interval) and only call a model "better" when intervals don't overlap,
or a **paired** test on the shared question set clears significance — *"conducting
a paired-differences test lets us eliminate the variance in question difficulty"*
(Anthropic). And **pre-declare** numeric acceptance criteria before the run, so it
yields a verdict, not a vibe.

Macrotide's harness runs `EVAL_N` repeats and reports `avg@N` + `pass^k` + a
per-tier dead-end %, graded against pre-declared `THRESHOLDS`. Full confidence
intervals / a paired McNemar test are a noted next step, not yet implemented.

## Trajectory and tool-call evaluation

The agent-benchmark work (τ-bench, the Berkeley Function-Calling Leaderboard)
separates four failure modes a final-answer check misses: wrong **tool
selected**; right tool, wrong **arguments**; right tool, but the **result is
ignored** in the prose; and a **spurious** call on a task that needed none.
τ-bench also formalizes `pass^k` for reliability. The cheap, deterministic slice
of this — *which* tools were called and which must *not* be — is exactly what a
small advisor needs; argument- and utilization-level checks require capturing the
tool arguments from the run (a noted extension).

## LLM-as-judge, done safely

A strong judge model can reach *"over 80% agreement"* with humans (Zheng et al.,
MT-Bench) — but only with care, because judges carry **position**, **verbosity**,
**style/format**, and **self-enhancement** biases. The mitigations the literature
agrees on:

- **Chain-of-thought before the label** — *"Ask the LLM to think first before
  deciding an evaluation score"* (Anthropic). The one universally-positive,
  zero-extra-call fix.
- **Different model family** from the one under test (never Gemini judging
  Gemini), judge temperature ≈ 0, an explicit **"Unknown"** escape valve.
- **Criterion-separated** pointwise rubrics (score each dimension alone, not one
  holistic number), **evidence-anchored** (quote the figure before scoring
  grounding), run in a **stateless** context.
- **Calibrate first**: *"Use human feedback to calibrate automated scoring"*
  (OpenAI) — target ~75–90% agreement on ~20 human labels before trusting it.

Macrotide implements the judge along exactly these lines, as an **opt-in** layer
(`EVAL_JUDGE=on`) on top of — never replacing — the deterministic floor, which
stays the regression gate: a criterion-separated rubric
(grounded · complete · structured · adaptive · helpful), reasoning before the
score, evidence-anchored against the captured tool results, temperature 0, a
per-dimension *Unknown* escape, and a different-family default judge
(`openai/gpt-5.5`). It is gated on **calibration** — `npm run eval:judge:calibrate`
scores it against hand-labeled answers and only a judge clearing ~75% agreement
(with clear ideal-vs-bad separation) is trusted; the same run compares a cheaper
judge (e.g. `moonshotai/kimi-k2.6`) so the cost-vs-intelligence pick is made on
data. Code: `scripts/eval/judge.ts` + `calibration.ts`.

**Provenance / known bias (read before trusting the judge).** The judge rubric,
the golden questions, and the calibration answer key were all authored by **Claude
Opus 4.8** — the model that built this eval. Three consequences follow directly:
(1) the judge **must** be a different family — an Opus/Claude judge would be
marking its own family's key (self-consistency, not judging skill), so its
agreement number would be inflated and uninformative; (2) that is precisely why
GPT-5.5's **cross-family** 96% agreement is the trustworthy validation, and why we
did not put a Claude model in the judge bake-off; (3) for maximum rigor the
Opus-authored key should be replaced or augmented with **human** labels (per #65's
"~20 human labels") before the judge is trusted on *Claude-family* candidates. The
sweep candidates are all non-Claude, so an Opus-authored key + a GPT-5.5 judge is
sound for the current model-lock decision — but the bias is real and recorded here
so it is never forgotten.

## The dead-end / empty-turn failure as a first-class metric

A tool-call-then-silence turn is a **reliability** failure of a different kind
from a wrong answer — and a quality-only average hides it (a model that
dead-ends 30% of the time but is otherwise correct can score like a reliable
one). It must be its own metric with its own threshold. This is Macrotide's
[empty-turn dead-end](../advisor-context.md), and the harness reports dead-end
rate as a separate gated column, not a zero folded into quality.

## Reading transcripts and the maintenance loop

*"We do not take eval scores at face value until someone digs into the details"*
(Anthropic). The canonical cautionary tale: a CORE-Bench score jumped 42% → 95%
after fixing rigid graders and ambiguous specs — the model was fine; the eval was
broken. So read a handful of transcripts every run (failures + borderline) to
confirm the grader's verdicts are fair, and treat eval upkeep as *"as routine as
maintaining unit tests"* (Anthropic). Layer by cadence: a fast structural unit
test in CI, the cost-bearing live benchmark on demand, and — later — sampling of
production traces fed back into the set.

## Where the sources disagree

- **How many runs.** Practitioner guidance says k≥3–5; the Bayesian
  *Don't-Pass@k* framework argues small-k point estimates are noisy and prefers
  credible intervals (*"only declare differences when intervals do not overlap"*).
  Macrotide's stance: k≥3 for comparisons, intervals as a next step.
- **pass@k vs pass^k.** Reliability-critical work favors `pass^k`; capability
  research often reports `pass@k`. For an advisor, `pass^k` is the honest one.
- **Judge model and cost.** Some advocate a strong frontier judge; others note
  rule-based grading under-reports and a cheap judge over-trusts. The resolution
  is calibration, not a default model.

## At a glance: the agent-eval toolkit

| Eval concern | Technique | Macrotide mechanism |
|---|---|---|
| Did it get the fact right? | Outcome grading (string/regex/number) | `mustInclude` / `anyOf` → **facts** sub-signal |
| Did it use the right tools? | Trajectory set-membership | `expectTools` → **tools** sub-signal |
| Did it over-call / propose spuriously? | Negative-case grading | `mustNotCallTools` + an N-control question |
| Did it invent data? | Hallucination guard | `mustNotInclude` → **safety** sub-signal (threshold 0) |
| Did it stall (empty turn)? | Dead-end rate as its own metric | separate gated % column |
| Is it reliable, not just right-on-average? | `pass^k` / `avg@N` over N runs | `EVAL_N` repeats, `pass^k` per tier |
| Is a change actually better? | Pre-declared thresholds + paired test | `THRESHOLDS` + PASS/FAIL verdict (CIs: planned) |
| Can grading be trusted? | Read transcripts; hermetic data | per-run transcript spot-read; `EXAMPLE-FUND-*` only |
| Prose / advice quality | LLM-as-judge (calibrated) | **`EVAL_JUDGE=on`** — opt-in 5-dimension rubric, calibrated (`eval:judge:calibrate`) |

## Model price + intelligence snapshot (2026-06-11)

A **point-in-time** reference for cross-checking eval cost estimates and as the
baseline for the quarterly "has anything cheaper or smarter landed?" model-review
check. Sorted by intelligence. **Prices drift — re-pull before relying on these.**
Price `$/1M` (in / out) = **OpenRouter** (what we pay; it routes to the cheapest
provider). *Intel* = **Artificial Analysis Intelligence Index** (v4.0, reasoning/
agentic/coding-weighted); *t/s* = AA output speed. Sources confirmed from each
model's [artificialanalysis.ai](https://artificialanalysis.ai/) page, 2026-06-11.

| Model | In | Out | Intel | t/s | Note |
|---|---|---|---|---|---|
| `anthropic/claude-fable-5` | 10 | 50 | 65 | — | frontier |
| `anthropic/claude-opus-4.8` | 5 | 25 | 61 | — | frontier |
| `openai/gpt-5.5` | 5 | 30 | 60 | — | **eval judge** |
| `minimax/minimax-m3` | 0.30 | 1.20 | 55 | 51 | smart+cheapest, but **slow + verbose** |
| `google/gemini-3.5-flash` | 1.50 | 9.00 | 55 | 153 | fast output but **~18s TTFT** |
| `moonshotai/kimi-k2.6` | 0.67 | 3.39 | 54 | 54 | smart, slow |
| `x-ai/grok-4.3` | 1.25 | 2.50 | 53 | 160 | **fast AND smart**, mid price |
| `z-ai/glm-5.1` | 0.98 | 3.08 | 51 | 73 | |
| `z-ai/glm-5` | 0.60 | 1.92 | 50 | 75 | cheaper near-twin of 5.1 |
| `anthropic/claude-sonnet-4.6` | 3 | 15 | 44 | — | out-scored by cheaper models |
| `google/gemini-2.5-pro` | 1.25 | 10 | 35 | 135 | weak + output-pricey → **dominated** |
| `z-ai/glm-4.6` | 0.43 | 1.74 | 30 | 49 | **current prod** — low on this index |
| `deepseek/deepseek-chat-v3.1` | 0.21 | 0.79 | 28 | — | non-reasoning |
| `google/gemini-2.5-flash` | 0.30 | 2.50 | 21 | 180 | non-reasoning, very fast |
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 | — | — | titles/extract/public tier |

Reading:
- **Output price dominates** for chat (answers are output-heavy), so the owner
  model comes from the cheap-smart band; the judge is a one-off frontier cost.
- **Current prod `glm-4.6` scores 30** — low on this reasoning-weighted index;
  `glm-5`/`glm-5.1` (50/51) are large in-family upgrades, and `minimax-m3` /
  `kimi-k2.6` (55/54) are smarter still at comparable cost.
- **`gemini-2.5-pro` (35, $10 out) is dominated** by `gemini-3.5-flash` (55, $9
  out) — don't keep 2.5-pro as a candidate.
- The smartest cheap models (`minimax-m3`, `kimi-k2.6`) are **slow** (~51–54 t/s);
  `grok-4.3` (53, 160 t/s) and `gemini-3.5-flash` (55, 153 t/s but slow TTFT) are
  the fast-AND-smart options. **For an interactive advisor, latency is a
  first-class axis** — which is exactly why our own eval measures wall-clock
  alongside quality rather than trusting this index alone (it's reasoning-bench-
  weighted, not advisor-task-weighted).

> The first sweep using this harness (2026-06-11) locked the owner model. Per this
> folder's evidence-not-verdict rule, that result + decision live in the verdict
> doc: [inference-strategy.md § Model routing & tiers](../inference-strategy.md#1-model-routing--tiers).

## About this research

Gathered in May 2026 via web search and direct fetches of primary sources,
oriented toward Macrotide's small-model Advisor. Synthesized from a parallel
multi-reader sweep; quoted phrasings are verbatim and attributed. **Extended June
2026:** the LLM-as-judge layer was built + calibrated, and a dated model
price/intelligence snapshot added (point-in-time — re-pull before relying). The
model-lock *verdict* it produced lives in the verdict doc (linked in § Decision),
not here — this folder stays evidence, not verdict.

- **Anthropic** — [*Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  (the task/harness/grader triple, grade-the-outcome, negative cases, the
  42%→95% lesson, `pass@k`/`pass^k`), [*A statistical approach to model evals*](https://www.anthropic.com/research/statistical-approach-to-model-evals)
  (paired-differences, confidence intervals), the Claude docs
  [*Define success criteria / build evaluations*](https://platform.claude.com/docs/en/docs/build-with-claude/develop-tests)
  (CoT-before-label), and [*Building a multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system).
- **OpenAI** — [*Evaluation best practices*](https://developers.openai.com/api/docs/guides/evaluation-best-practices),
  [*Graders*](https://developers.openai.com/api/docs/guides/graders), and
  [*Evaluate agent workflows*](https://developers.openai.com/api/docs/guides/agent-evals)
  (model-graded vs programmatic, human calibration).
- **Academic** — Zheng et al., [*Judging LLM-as-a-Judge (MT-Bench / Chatbot
  Arena)*](https://arxiv.org/abs/2306.05685); bias studies
  [2410.02736](https://arxiv.org/abs/2410.02736),
  [2406.07791](https://arxiv.org/abs/2406.07791); Yao et al.,
  [*τ-bench*](https://arxiv.org/abs/2406.12045); the
  [*Don't Pass@k* Bayesian framework](https://arxiv.org/abs/2510.04265);
  [*LiveBench*](https://arxiv.org/abs/2406.19314) (contamination).
- **Benchmarks / tooling** — the [Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html),
  [DeepEval tool-correctness](https://deepeval.com/docs/metrics-tool-correctness),
  [Promptfoo](https://www.promptfoo.dev/docs/configuration/reference/) (repeat /
  min-pass-rate), [LangChain's agent-eval checklist](https://www.langchain.com/blog/agent-evaluation-readiness-checklist),
  [Braintrust](https://www.braintrust.dev/articles/ai-agent-evaluation-framework),
  and practitioner notes by [Eugene Yan](https://eugeneyan.com/writing/evals/) and
  [Hamel Husain](https://hamel.dev/blog/posts/evals-faq/) (LLM-judge limits; the
  dimensions framework for synthetic data).

Figures that are benchmark-specific (the 42%→95% CORE-Bench jump, the ">80%
agreement", the "~42% at k=3" arithmetic) are reported as the sources state them;
treat them as illustrative of the mechanism, not as Macrotide measurements.
