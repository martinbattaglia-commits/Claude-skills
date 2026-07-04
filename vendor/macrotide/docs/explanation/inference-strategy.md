# Inference strategy — how the Advisor stays smart, fast, and token-efficient

*Last updated: 2026-06-01*

> **Living design doc.** It records the cost/latency/quality decisions for the
> Advisor — what the design does, and the principle behind each lever. Some of
> what it describes is built and some is a direction the design anticipates;
> trust the code over the doc and fix the doc when they disagree. Forward-looking
> refinements are tracked on the
> [project board](https://github.com/users/Sitthinut/projects/2).

This is the design layer between the prior-art surveys and the code. The
[LLM-platform-primitives](./research/llm-platform-primitives.md) and
[context-and-caching](./research/context-and-caching.md) surveys establish *what
the providers expose*; [context-engineering.md](./research/context-engineering.md)
surveys *the tool-use loop patterns*. This doc is **the decisions Macrotide makes
on top of them** — the cost/latency/quality strategy for an Advisor that is a
small, cheap model behind OpenRouter, driving a deliberately small tool surface.
The loop's mechanics live in
[architecture.md § the chat path](./architecture.md) and
[advisor-context.md](./advisor-context.md); this page is the *why behind the
knobs*.

The Advisor's shape: ~10 tools (memory + advisor reads/proposals), `stepCountIs(5)`,
`maxOutputTokens` 1024 (demo/public) / 2048 (trusted/owner), a frozen
system+memory prefix (`composeSystemPrompt`), a per-turn `EntryContext` user
message after it, **no prompt-cache breakpoints**, and **reasoning pinned off on
the cost-sensitive paths** — over the `openrouter/free → openrouter/auto` chain
with recover-on-empty + retry-on-error resilience.

## The five levers, at a glance

| Lever | Where Macrotide stands | Highest-value move |
|---|---|---|
| **Model routing** | public pinned to its own `PUBLIC_TIER_MODELS`; multi-model fallback; recover-on-empty net | route by tool-call reliability, not just price |
| **Prompt caching** | frozen prefix is cache-*ready* but no breakpoints sent | keep volatile data after the prefix; exploit public-chain auto-caching; clear the floor |
| **Reasoning tokens** | `effort:none` pinned on public/demo/title/extract; owner/trusted **floored at `low`**, raised to `medium` on analytical intent | push more "complex math" into tools so even complex turns need less reasoning |
| **Context loading** | JIT tool reads + the entry-context envelope | keep JIT default; app-layer compaction; shape tool results |
| **Structured output** | tool-call-as-extraction via the AI SDK | one schema to the strictest intersection + Zod re-validate |

---

## 1. Model routing & tiers

### Routing at a glance

The single map of model + reasoning per surface. **Code defaults** are authoritative
in [configuration.md § Environment variables](../reference/configuration.md#environment-variables)
(the env table); the **suggested** + **reasoning** columns are the eval-backed verdict
and live here (with the sweeps below as evidence). Reasoning per tier is
env-overridable — see the `*_REASONING_*` rows in configuration.md.

| Surface | Env var | Code default | Suggested (primary → fallback) | Reasoning |
|---|---|---|---|---|
| Owner / trusted chat | `TRUSTED_TIER_MODELS` | `openrouter/free,openrouter/auto` | `x-ai/grok-4.3,z-ai/glm-5.1` | `low` floor → `medium` analytical (`TRUSTED_REASONING_FLOOR`) |
| Public chat | `PUBLIC_TIER_MODELS` | `openrouter/free` | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite,openai/gpt-4.1-mini` | `none` (`PUBLIC_REASONING_EFFORT`; set `low` if you run grok) |
| Demo chat | `DEMO_TIER_MODELS` | `openrouter/free` | `openrouter/free` | `none` (`DEMO_REASONING_EFFORT`) + retry-on-400 |
| Title | `TITLE_MODELS` | `openrouter/free` | `openrouter/free,google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` | `none` |
| Memory extract | `EXTRACT_MODELS` | `openrouter/free` (via `TITLE_MODELS`) | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite,openai/gpt-4.1-mini` | `none` (a summarize-extract pass doesn't need CoT; reasoning just spends the output budget) |
| Memory consolidate | `CONSOLIDATE_MODELS` | `openai/gpt-oss-20b:free,cohere/north-mini-code:free,openrouter/free` | `openai/gpt-oss-20b:free,cohere/north-mini-code:free,google/gemini-3.1-flash-lite` (last = paid backstop) | `low` (`CONSOLIDATE_REASONING_EFFORT`) — reasoning **ON** |
| Vision (chat) | `VISION_CHAT_MODELS` | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` | = default | `none` (structured-output guard) |
| OCR (import) | `OCR_MODELS` | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` | = default | `none`/`low` |
| Vision escalate | `VISION_CHAT_ESCALATE_MODELS` | unset | unset (cheap vision handles charts) | owner/trusted only |

> **Every chain is capped at 3.** OpenRouter's `models[]` fallback array rejects more
> than 3 entries (a longer chain 400s and dead-fails every request), so `openrouter()`
> trims to the first 3 (best-by-order). Keep suggested chains ≤ 3.

Two cross-cutting mechanisms make the `none` pins robust: **retry-on-400** —
`openrouter()` retries once without the reasoning field when a model 400s "reasoning
is mandatory / cannot be disabled" (free models that can't disable reasoning), so a
disable-path turn isn't lost; and the **`*_REASONING_*` env overrides**, so the
reasoning policy tracks the chosen model (point public at grok → `PUBLIC_REASONING_EFFORT=low`).
Why **extract is paid-primary**: a probe found `openrouter/free` extraction is a
quality lottery (1–6 facts, and sometimes *empty/unparseable JSON* from the weak free
models it lands on — not a reasoning artefact: reasoning rides its own channel),
while `gemini-2.5-flash-lite` returned 9/9 facts, clean JSON, ~1.7s, ~$0.0005/run.
Extraction still pins reasoning `none` simply because a summarize-and-extract pass
doesn't need chain-of-thought and it would only spend the limited output budget.

Why **consolidate is reasoning-ON** while extract is `none`: the consolidation sweep
(`resolveConsolidateProvider`) is **offline + infrequent**, so it can afford
chain-of-thought to judge which saved memories are genuine duplicates and propose
merges — exactly where reasoning improves precision. Reasoning lands in OpenRouter's
**own channel** (verified 2026-06-23 — true even for the `openrouter/free` meta-router,
which *does* honour a reasoning request and routes it to a reasoning-capable free
model), so it never pollutes the JSON the proposer parses. We pin **known-good free
reasoning models** on **different providers** (`openai/gpt-oss-20b:free` + `cohere/north-mini-code:free`,
both probed clean on the real prompt 2026-06-24) ahead of `openrouter/free` not for the
JSON channel but for **quality consistency**: the meta-router picks an arbitrary free
model each call and can land on a tiny one that ignores the JSON-only instruction (a
no-op run), so it sits **last** as an availability fallback. The chain does **not**
fall back to the extractor/title chains — an unset `CONSOLIDATE_MODELS` keeps
reasoning. Free-tier limits comfortably cover a per-user daily sweep; for a reliable paid
backstop swap the trailing `openrouter/free` for `google/gemini-3.1-flash-lite` (~$0.10–0.40/M,
bounded reasoning, also probed clean) — **not** a thinking-only model like
`qwen3-235b-a22b-thinking`, whose mandatory reasoning ate the output budget and truncated
the JSON in testing.

**Route by tool-call reliability, not just price.**
For an advisor, a dropped or garbled tool call puts a *wrong number on screen* —
so emission reliability is a first-class routing criterion, not an afterthought.
OpenRouter publishes a per-provider **Tool Call Error Rate** (and orders providers
by it for tool-calling requests); filter candidates on
`supported_parameters=tools` and prefer low-error providers. The `openrouter/free`
meta-router fans across DeepSeek/Qwen/etc. with *no* such guarantee — which is
exactly why the recover-on-empty net is load-bearing, not optional.

**A cheap paid public-tier floor, bounded by caps.**
The public tier's model is now its own operator knob (`PUBLIC_TIER_MODELS`, default the
zero-cost `openrouter/free`), so a cheap paid model (the A/B picked
`google/gemini-2.5-flash-lite` / `-flash`) can remove most dead-ends *at the
source*. The cost guard the AGENTS.md invariant mandates is preserved **by
construction**: the public tier chain derives ONLY from `PUBLIC_TIER_MODELS`, never from
`TRUSTED_TIER_MODELS`, so a paid floor is a deliberate, separately-capped choice — not a
widening of the pinned chain. Spend is bounded by the daily token cap plus the
optional cents cost cap. *Watch the DeepSeek alias churn:* `deepseek-chat` /
`deepseek-reasoner` are now aliases for `deepseek-v4-flash` and deprecate
**2026-07-24** — don't hardcode the alias.

**Expect a cold cache on every failover.**
A model / route / tool-schema switch invalidates the cached prefix everywhere. The
`openrouter/free → openrouter/auto` fallback and the retry-on-error re-roll are
correct, but budget input cost for a *cold* prefix on the fallback path, and keep
the fallback's prompt structure byte-identical so it re-warms fast.

### The current suggested models (2026-06-11 sweep)

`TRUSTED_TIER_MODELS=x-ai/grok-4.3,z-ai/glm-5.1` — the first decision made with the eval
harness ([scripts/eval](../../scripts/eval); method + judge design in
[agent-evals.md](research/agent-evals.md)). Five candidates ran the complex tier
(N=3) through the real path; answers were scored on the 5-dimension rubric by
Opus-4.8 subagents (a budget-driven one-off — see the harness's calibrated
gpt-5.5 judge for the reproducible path). Quality = mean of 5 dims /5; dead-end =
no-prose rate; latency = wall-clock/turn; $/1k = complex-tier, list price:

| Model | Quality | Dead-end | Latency | $/1k | |
|---|---|---|---|---|---|
| **x-ai/grok-4.3** | 4.43 | **3%** | **9s** | ~17 | concise; best balance ← primary |
| z-ai/glm-5.1 | **4.55** | 5% | 35s | ~24 | highest quality ← fallback (diff. provider) |
| minimax/minimax-m3 | 4.01 | 5% | 78s | ~8 | cheapest, slow + verbose |
| z-ai/glm-4.6 *(prod at sweep time)* | 3.55 | **28%** | 44s | ~12 | good answers, but dead-ends sink it |
| moonshotai/kimi-k2.6 | 3.69 | 23% | **194s** | ~25 | slowest by far + dead-ends |

**Why grok-4.3:** it wins on what makes an advisor *feel* good — speed (9s vs
35–78s) and reliability (3% dead-ends) — at quality within judge-noise of glm-5.1.
This ties back to routing-by-reliability above: the model live at sweep time
(`glm-4.6`, itself only a brief interim pick) **dead-ended ~28% of complex turns**
— the intermittent-silence failure mode (#21) that makes any model *feel* broken,
which is exactly what reliability-first routing exists to avoid. glm-5.1 is the
fallback (top quality, different provider → no shared-outage risk). Input tokens
dominate and grok supports prompt caching (cached read ~16% of input), so real
cost runs **~$11–13/1k complex turns** — see § 2 and § 5 for the input-cost levers.
**Caveats:** N=3; complex tier only; Opus-authored rubric; the grok↔glm-5.1 gap is
within noise. Re-run on a trigger (new model, price/deprecation change, prompt
change) — never swap blind.

### Suggested vision & OCR models (2026-06-16 sweep)

The holdings-image OCR + in-chat vision surfaces are their own operator knobs
(`OCR_MODELS`, `VISION_CHAT_MODELS`), migrating off the
deprecating `gemini-2.5` family (`-flash` EOL 2026-10-16; implementation tracked
in [#182](https://github.com/Sitthinut/macrotide/issues/182)). **Suggested
default: `google/gemini-2.5-flash-lite` primary + `google/gemini-3.1-flash-lite`
fallback** (operators can override) — measured by
[`scripts/eval/ocr.ts`](../../scripts/eval/ocr.ts) against **real broker
screenshots** (run locally via `EVAL_OCR_DIR`; such captures are personal data and
are never committed) plus committed synthetic fixtures. $/Mtok is list price;
worst-case is the lowest per-field score across the synthetic degradation tier.

| Model | Real shots | Worst-case | Halluc | $/Mtok | |
|---|---|---|---|---|---|
| **gemini-2.5-flash-lite** | 100% | 90% | 0 | $0.10/$0.40 | cheapest + fastest ← primary |
| **gemini-3.1-flash-lite** | 100% | **95%** | 0 | $0.25/$1.50 | current-gen ← fallback (survives EOL) |
| gemini-2.5-flash | 100% | 100% | 0 | $0.30/$2.50 | prior default; robust but pricier |
| x-ai/grok-4.3 | **7/8** | — | **1** | $1.25/$2.50 | only one to err on real data + slowest → NOT for vision |

**Why this pair:** both flawless and zero-hallucination on real captures;
flash-lite is the cheapest/fastest floor; **3.1-flash-lite is genuinely
current-gen, so the fallback *is* the EOL guarantee** (it auto-takes-over when the
2.5 family dies, and on any provider hiccup) and is marginally more robust on
extreme degradation. grok reads holdings but errs more on real data at 2–3× the
latency / 4× input cost — vision stays on a dedicated cheap model, never unified
onto the chat model. **Caveat:** synthetic vector fixtures can't reproduce the
photographic degradation that separates models — the real-screenshot run is the
load-bearing evidence; the committed synthetic set is a regression net.

**This model serves a TOOL, not a whole-turn swap.** The chat driver stays on
every turn and reads an attachment by calling `examine_image` (which runs the
model above), so its prompt cache stays warm and it keeps reasoning — a spike and
a live route smoke confirmed the driver reliably calls the tool and answers
correctly. Design: [advisor-vision.md](./advisor-vision.md). **Escalation measured
and left OFF:** the tool can route a chart/factsheet to a stronger
`VISION_CHAT_ESCALATE_MODELS` (owner/trusted only), but the `visual` eval journey
found flash-lite scored 100% (8/8) on chart + factsheet Q&A — tying
gemini-3.5-flash and gemini-3.1-pro-preview while 2.5–5× faster and far cheaper —
so it stays **unset**; the hook + harness are ready if real-world charts later
show a gap.

## 2. Prompt-cache strategy

**The envelope split is correct — keep volatile data strictly AFTER the frozen
prefix.**
`composeSystemPrompt` freezes memory+system once per request, and
`injectEntryContext` splices the per-turn `EntryContext` as a `user` message
*after* that prefix. That is exactly the universal caching rule (stable
tools→system→static first, volatile last). **Do not regress it.** The standing
guard: never inject `currentDate`, a session id, or a freshly-fetched quote into
the system prefix — a 24h date string busts the cache every day, a quote block
every turn.

**Don't pay for explicit breakpoints on the public chain; do exploit automatic
caching.**
The public/auto router fans across OpenAI-shape, DeepSeek, and Gemini-2.5 models —
all of which cache **automatically** with no config and no write premium. On
OpenRouter, explicit `cache_control` breakpoints apply **only to Anthropic Claude
and Alibaba Qwen** — and Qwen *is* on the public chain, so a Qwen route could
actually benefit from breakpoints, whereas the rest get nothing from them. So:
keep the prefix stable, and add breakpoints only if you pin Claude or Qwen (then up
to 4 — after tools, system, static context, last stable turn — on the default
5-minute TTL; break-even is one read).

**Pin cache affinity per provider family — a stable prefix isn't enough.**
Through OpenRouter, automatic caching depends on requests landing on the *same*
backend (sticky routing); a multi-turn chat that scatters across servers misses
its own cache. The affinity *signal* differs by family, so it's attached by a
small registry keyed on the model id (`cacheAffinity` in
[lib/ai/provider.ts](../../lib/ai/provider.ts), fed the chat thread id as
`conversationId`): **xAI/Grok** needs the `x-grok-conv-id` header (without it grok
text turns can cache-miss under load — the app sent none before this); **Anthropic**
takes a `session_id` body field; **OpenAI/Gemini/DeepSeek** are transparent (sticky
routing + a stable prefix, nothing to inject). This is provider-agnostic by
construction: swap the chat model via env and the right signal follows; adding
explicit caching for a new family is one registry entry.

**Clear the minimum cacheable-prefix floor.**
A lean small-model system prompt can fall *under* 1,024 tokens and never cache at
all (OpenAI / Gemini-Flash floor at 1,024; Gemini-Pro and Anthropic Opus-4.5/4.6/
4.7 + Haiku-4.5 at 4,096 — though Opus 4.8 is back to 1,024). Once warm the prefix
is a ~0.1× cache *read*, so a longer stable prefix is **cheaper**, not more
expensive. Measure `composeSystemPrompt`'s token count; the memory block +
disclaimer likely already clear 1,024 — confirm rather than assume.

**Instrument it.**
Read OpenRouter's `cache_discount` and `prompt_tokens_details.cached_tokens` per
call, log hit rate, and alarm on a sudden drop — a collapse almost always means
something volatile (a reordered tool list, a timestamp, a route swap) crept into
the prefix. The most likely future leak point is a scheduled job (the AI daily
digest) injecting the date or a market snapshot into the prefix.

## 3. Reasoning-token policy

### When should the Advisor use reasoning?

A common trap: "investment questions are complex, so the Advisor should reason."
But *domain complexity* and *per-turn reasoning need* are different things.
Reasoning tokens buy exactly one thing — **more private chain-of-thought before
the model writes** — which helps with *multi-step deduction*. They do **nothing**
for the two things that actually make Advisor answers good or bad:

1. **Getting real numbers** is **tools**, not reasoning. Drift, blended TER,
   concentration, and the benchmark gap are computed deterministically
   (`lib/portfolio/health.ts`) and returned by `read_portfolio` /
   `read_performance`. The model *reads* them; it doesn't deduce them. Reasoning
   over a number it already has just adds latency.
2. **Not inventing numbers** is **grounding + strict honesty**, not reasoning. A
   reasoning model hallucinates a ticker just as confidently; what stops it is the
   "only reference what your tools returned" rule. Reasoning doesn't fix the real
   failure mode.

So most Advisor turns are **retrieve-then-explain**, where reasoning is pure cost.
The minority that genuinely benefit are **multi-step judgment the tools didn't
pre-compute**:

| Advisor turn | Reason? | Why |
|---|---|---|
| "What's my biggest holding?" / "Am I beating my index?" | **No** | A tool returns the number; report it. |
| "What is index investing?" / "Explain this fee" | **No / minimal** | Knowledge recall + clear writing, not deduction. |
| OCR extract, holdings-confirmation table | **No (never high)** | Structured output — reasoning *corrupts* strict JSON (Anthropic warns of overthinking). |
| "Step-by-step rebalance plan" | **Yes (medium)** | Compute trades across N holdings to close the gap within constraints, then sequence them. |
| "Should I tilt to gold given THB weakness?" | **Yes** | Weighs several factors against the plan. |
| "SSF vs RMF for my situation"; tracking-error / hedging comparisons | **Yes** | Rules interplay + the user's numbers → a real multi-step weighing. |
| "What do you think of all my portfolios?" / "review my portfolio" | **Yes (medium)** | A holistic review synthesizes return, fees, build, and tax into a judgment — not a single retrieval. The `review` / `health_review` / `score_review` (Discuss) intents map here. |
| "My Tax portfolio's return is low — what should I do next?" | **Yes** | Diagnose *why* it lags, then plan a prioritized next step. The `plan` intent + the diagnose-return / next-step phrase patterns map here. |

The rule of thumb: **reason when the answer requires combining several facts into
a judgment the tools didn't already calculate — not just because the topic is
finance.** A Macrotide-specific corollary: the more of that "complex math" we push
*into tools* (e.g. a future `compute_rebalance`), the less the model needs to
reason at all — cheaper *and* more reliable than mental arithmetic.

This was also measured from the model-selection side (A/B, May 2026): the popular
cheap Chinese models (GLM / MiMo / Qwen-flash / MiniMax / Kimi / Step / DeepSeek)
are **reasoning models** tuned for coding/agentic benchmarks — for a chat turn
they reason by default and run **8–29s** (and token-heavy), vs **~2s** for a
non-reasoning model like `gemini-2.5-flash-lite`. Pinning `reasoning:{effort:none}`
cut the slowest of them 2–4× with no reliability loss.

### The policy

**Disabled on the cost-sensitive paths.**
The public tier, demo, and the ancillary title/extract calls send
`reasoning:{effort:"none"}` (`openrouter()` in `lib/ai/provider.ts`), so a
reasoning-capable model the router lands on doesn't burn hidden chain-of-thought
(billed at the output rate) on a turn that doesn't need it. Public stays pinned to
`none` **even when the intent gate would raise it** — it is the cost-protected
path. Non-reasoning models ignore the flag. Beware the multiplier when you *do*
raise effort: at `high` OpenRouter allocates ~80% of `max_tokens` to reasoning,
so keep `max_tokens` tight (the public tier is already 1024).

**Gate higher effort behind analytical intent — shipped.**
The owner/trusted paths no longer inherit model-default reasoning; a cheap,
deterministic classifier (`classifyReasoningIntent`, `lib/advisor/intent.ts`)
reads the user's turn plus the `EntryContext.intent` and sends `effort:"medium"`
on genuine multi-step asks (rebalance, SSF-vs-RMF, a plan-anchored tilt) and
`effort:"none"` otherwise — so reasoning rates are paid only where they buy
something. The route consults it once per turn and passes the effort to
`resolveOwnerProvider`/`resolveTierProvider`; `REASONING_GATE=off` restores
model-default behavior. The classifier is pure (no model call) — the whole point
is to avoid paying to decide whether to pay. It errs toward `none`: only strong
signals of multi-step judgment flip it on.

*Measured (committed eval, `gemini-2.5-flash`, complex tier, n=2):* `medium`
lifted answer quality 78%→88% — and on the SSF-vs-RMF turn it was the difference
between answering from nothing and actually planning the `find_funds` calls — at
~3.5× latency (2.4s→8.3s) and ~2.7× cost. That premium is exactly why the gate
exists: pay it on the few turns that earn it, not every turn. Re-run with
`EVAL_TIER=complex EVAL_REASONING=medium` vs `none` before retuning the trigger
set. Use `reasoning:{exclude:true}` to hide chain-of-thought from the UI (still
billed) if a reasoning trace is ever surfaced, and verify per-model that
`reasoning_details` is actually returned — some silently drop it.

**Floor the trusted tier at `low` — tool-call reliability, not depth.**
Reasoning effort turns out to gate *tool-calling*, not just answer depth. On an
explicit "remember X" request the trusted primary (`x-ai/grok-4.3`) often
acknowledges in prose but never calls `save_preference` at `effort:none`. So the
owner/trusted paths floor at `low` (`atLeastTrustedFloor`, `lib/ai/provider.ts`):
the intent gate can still raise to `medium`, but never below `low`. Public/demo
keep their hard `none` pin (below) — the floor is **trusted-only** because the
cheap public model *regresses* with reasoning.

*Measured (committed eval, `EVAL_TIER=memory`, N=3, 2026-06-19), explicit
memory-save call-rate, 0 false-positives on the lookup/definition controls in
every cell:*

| Model (tier) | `effort:none` | `effort:low` |
|---|---|---|
| `x-ai/grok-4.3` (trusted) | **41%** save-rate, 0% dead-ends | **100%**, 6% dead-ends |
| `google/gemini-2.5-flash-lite` (public) | 83%, 22% dead-ends | 58%, **39%** dead-ends |

Reasoning fixes trusted (41%→100%) but breaks public (save 83%→58%, dead-ends
22%→39%) — confirming `low` is a trusted-only floor. Re-run with
`EVAL_TIER=memory EVAL_REASONING=none|low` before retuning. The reactive
"claimed-but-didn't-save" retry that this floor replaced is gone; a slim,
**silent** single-attempt backstop (`app/api/chat/route.ts`) now fires only on
explicit user memory-intent (`classifyReasoningIntent` → `memoryIntent`) when no
write landed, capturing just the resulting memory indicator — no retry prose — and
a true miss falls to the session-close extraction net.

**Never high/max effort on structured-output paths.**
Anthropic warns `max` overthinks structured tasks — costing more *and* risking
corrupt strict JSON. The holdings-confirmation table and the image-OCR extract
must run at `low`/`medium`. And don't add "think step by step" boilerplate for
reasoning-capable models — it's documented as unnecessary and wastes input tokens.

## 4. Context-loading strategy

**Keep just-in-time tool reads as the default; the envelope is the right
complement.**
"Maintain lightweight identifiers, hydrate via tools" is exactly what the
[entry-context envelope](./advisor-context.md) does — it passes the subject + on-
screen signals as facts and lets the portfolio/catalog tools recover depth. That
both cuts tool hops (fewer chances to stall) and keeps the small model's tighter
window from rotting. Extend the envelope to remaining findings as they gain on-
screen figures; keep open-ended kickoffs prose-only (correct as designed). The
reserved `image` slot is the forward-compatible home for in-chat vision.

**App-layer compaction, not a provider primitive.**
Server-side compaction (Anthropic `compact_20260112`, OpenAI `compact_threshold`)
is vendor-specific and behind beta headers; OpenRouter normalizes to a chat-
completions surface, so you can't depend on it across the public chain. Macrotide
already summarizes-and-archives over the same key — treat provider-native
compaction as a bonus, not a dependency. Tune by maximizing recall first, then
precision.

**Lean on the memory file as the durable source of truth.**
The memory block persists durable facts (risk tolerance, THB base currency,
response prefs) in the DB, so they survive the public-tier empty-turn drop — state
lives in the store, not only the volatile transcript. Re-inject only the relevant
slice each turn.

**Sub-agent isolation only for token-heavy batch tasks.**
A "scan N filings / look-through funds and summarize exposure" task fits a sub-
agent that explores in its own window and returns a 1–2k-token distilled result —
but multi-agent systems use ~15× the tokens of a single chat, so only justify it
when the quality gain is real. Ordinary Q&A stays single-window. For Macrotide's
mostly-structured corpus, prefer agentic SQL/grep queries over standing up a vector
DB (the "keyword search ≈ 90% of RAG without a vector DB" result supports skipping
the index), aligned with the [app.db / market.db split](./architecture.md).

## 5. Tool-result shaping

**Shape tool outputs to a compact, model-legible subset — highest-leverage move
for a small model.**
`read_portfolio` returns a large structured object today (flagged in
[advisor-context.md](./advisor-context.md)). Return only the few fields the answer
needs — allocation, drift, blended TER, the headline figure — not the raw blob.
Anthropic's own `concise` vs `detailed` example cut a tool result ~66% (≈72 vs 206
tokens). In AI SDK 6, implement `toModelOutput` per tool so the model-facing view
diverges from the rich object the app keeps. This directly reduces context rot and
the public-tier dead-end rate.

**Return instructive errors as results, not exceptions.**
A rate limit or missing symbol should come back as `is_error`-style content with
actionable text ("Rate limit exceeded, retry after 60 seconds" / "No quote for
TICKER — suggest the user check the symbol"), so a small model can recover or fail
gracefully rather than throwing and producing an empty turn. The AI SDK surfaces it
as `tool-error` parts; Anthropic + MCP both endorse the pattern.

**Keep the tool surface small, namespaced, unambiguous.**
~10 tools today — well under the ~20-tool soft cap where both Anthropic and OpenAI
report accuracy degrades. Favor clarity over breadth; avoid overlapping reads and
ambiguous param names. Deferred/lazy tool loading (`tool_search`/`defer_loading`)
is a >20-tool problem Macrotide doesn't have. Parallel tool calls are default-on;
keep them unless a cheap model garbles batches.

## 6. Structured output & citations

**Tool-call-as-extraction + client-side Zod re-validation is the portable floor.**
Cheap public-tier models may lack a native `json_schema` / `response_format` mode —
this is the one structured-output claim with no primary anchor for the public chain,
so treat it as **untested** (verify via
`openrouter/models?supported_parameters=structured_outputs` before relying on it).
The lowest common denominator works everywhere: define one tool whose schema *is*
the target (holdings table, OCR extract), force `toolChoice`, read validated args,
and **always** re-validate with Zod + a `jsonrepair` fallback. AI SDK 6 deprecates
`generateObject`/`streamObject` in favor of `generateText` + `Output.object`, and
OpenAI `strictJsonSchema` now defaults to `true`.

**Design extraction schemas to the strictest provider's intersection.**
So one schema works across the whole route fleet: ≤5 nesting levels (OpenAI), ≤20
strict tools / ≤24 optional params (Anthropic), scalar-only enums, no
`minLength`/`pattern`/`minimum`, and **avoid recursive schemas** (OpenAI allows
them, Anthropic doesn't). Optionals as nullable unions with
`additionalProperties:false` + all-required. Reusing identical schemas keeps the
provider grammar caches warm.

**Split the pipeline for structured-data-plus-citations.**
Anthropic Citations and Structured Outputs are **mutually exclusive** (a 400 if
both set). For "show the user where this figure came from" on an uploaded
statement, run two calls: one extracts structured data, one produces cited prose —
`cited_text` is free on tokens and points at real spans, a strong fit for the
statement-import UX *if* Anthropic is ever pinned. For market/news grounding, gate
web search behind explicit user intent (Gemini 3 bills per query). Moot on the public
chain today, which has no Anthropic route.

## 7. Evaluation

Every lever above is a hypothesis ("flash-lite is good enough", "reasoning helps
complex turns", "shaping cuts dead-ends") — the eval is how we **measure** it
before shipping, instead of guessing. The prior art is surveyed in
[research/agent-evals.md](./research/agent-evals.md); this is the decision.

**What we measure.** A committed harness (`scripts/eval/`) runs a fixed question
set over a **hermetic synthetic tool surface** (`EXAMPLE-FUND-*`, never the live
DB) in two tiers — *retrieve-then-explain* (the common path) and *complex
multi-step* (rebalance, SSF-vs-RMF, a plan-anchored tilt) — using the exact
production system prompt and OpenRouter wiring. Four metric families:
deterministic **quality** (three separately-reported sub-signals: grounded-facts
/ tool-trace / no-hallucination), **dead-end rate** (the empty-turn dead-end, its own
gated metric — never a zero folded into quality), **latency / token / cost**, and
**reliability across runs** (`pass^k` — the fraction of questions where *all* N
runs pass, the number a single-run mean hides).

**How we grade.** A **deterministic floor** (`mustInclude` / `anyOf` /
`mustNotInclude` / `expectTools` / `mustNotCallTools` / `expectToolArgs` /
`maxSteps`) — fast, reproducible, and it survives model swaps, so it's the
regression gate. It grades not just *which* tools were called but *with what
arguments* (e.g. the fee-switch question asked about the fund the user actually
holds) and *over how long a trajectory* (a lookup that loops to five generations
is thrashing), and it includes a **negative control** — an empty-holdings turn
where the only correct answer is "you have no holdings yet" and naming a fund is a
hallucination, so the harness rewards *refusing* as well as answering. On top of
this floor, an **opt-in LLM-as-judge** (`EVAL_JUDGE=on`) grades the qualities
regex can't reach — grounded · complete · structured · adaptive · helpful, a
criterion-separated rubric scored by a different-family model (default
`openai/gpt-5.5`), evidence-anchored against the captured tool results. It never
replaces the deterministic gate, and it's trusted only after **calibration**
(`eval:judge:calibrate`) clears ~75% agreement with hand labels — the same run
prices a cheaper judge so the cost-vs-intelligence choice is data-driven.

**How we decide.** Acceptance criteria are **pre-declared** per tier (`THRESHOLDS`
in `run.ts`: dead-end ≤5% retrieve / ≤15% complex, grounded-facts ≥80%/≥60%,
hallucination = 0) so a run yields a PASS/FAIL verdict, not a vibe; `EVAL_GATE=on`
makes a breach exit non-zero for a pre-change check. Use `EVAL_N≥3` for any
comparison (a single run conflates model variance with capability): quality is
reported with a **95% confidence interval** so a gap that's only run-variance is
visible, and `eval:diff` compares two result files — score deltas, pass^k flips,
and a **paired McNemar test** over the shared question set — so a before/after
A/B is mechanical and only calls a winner when the flips are significant. Each
result file is tagged with its git SHA. The run hits the live API and **stays out
of CI** (a token-free vitest guards the harness structure there).

**When we run it.** Before flipping `PUBLIC_TIER_MODELS`, editing the system prompt,
or changing the reasoning budget (§3) — exactly the changes whose effect a single
manual test would misjudge. The reasoning-gate decision in §3 was made this way:
the complex tier measured `medium` reasoning at +10pp quality for ~3.5× latency,
which is *why* the gate pays it only on the turns that earn it. The question set
is a small **golden set**: frozen once baselined, extended (not loosened) over
time — see [scripts/eval/README.md](../../../scripts/eval/README.md).

**The OCR/vision sibling.** A second harness ([`scripts/eval/ocr.ts`](../../scripts/eval/ocr.ts),
`npm run eval:ocr`) evaluates the holdings-image extractors the same way —
committed **SVG fixtures rendered to PNG via sharp** (light/dark, ฿/paren
hard-edges, RMF/SSF/ThaiESG section traps) plus the transaction-history journey
(BE dates, สับเปลี่ยน→two rows), scored on per-field digit fidelity +
hallucination + latency. Real broker screenshots run locally via `EVAL_OCR_DIR`
(personal data, never committed) — the only input that discriminates models on
true digit fidelity. The Vision & OCR pick in §1 was made with it.

> Doc map: [research/agent-evals.md](./research/agent-evals.md) (the evidence) ↔
> this section (the decision) ↔
> [scripts/eval/README.md](../../../scripts/eval/README.md) (the operation).

---

## Related

- [research/llm-platform-primitives.md](./research/llm-platform-primitives.md) —
  how providers expose tools, system prompts, reasoning, structured output.
- [research/context-and-caching.md](./research/context-and-caching.md) — the
  caching cost/latency math and context-window management.
- [research/context-engineering.md](./research/context-engineering.md) — the
  tool-use loop, failure modes, and the empty-turn recovery.
- [research/agent-evals.md](./research/agent-evals.md) — how to evaluate a
  tool-using agent (the triple, graders, `pass^k`, LLM-judge); evidence for § 7.
- [advisor-context.md](./advisor-context.md) — the three context channels, the
  entry-context envelope, and the per-turn cache-safe injection rule.
- [configuration.md § AI / model selection](../reference/configuration.md#ai--model-selection)
  — the model + cap env vars.
