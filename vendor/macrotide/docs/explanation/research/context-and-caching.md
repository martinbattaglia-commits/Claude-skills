# Prompt caching & context-window management — a prior-art survey

*Researched May 2026*

## Summary

The token-efficiency core of a tool-using agent splits into two coupled
problems. **Prompt caching** is a *billing and latency* lever: every major
provider reuses a previously-processed prompt prefix to cut input cost and
first-token latency, and the control surface splits cleanly into *manual
breakpoint* (Anthropic; Google explicit `CachedContent`; Alibaba Qwen on
OpenRouter) versus *automatic prefix* (OpenAI, Google implicit, DeepSeek, Grok,
Moonshot, Groq) caching. The one universal rule everywhere is that a cache hit
requires a byte-identical prefix from token 0, so the stable prefix (tools →
system → static context) must come first and per-turn volatile data must come
last. **Context-window management** is the orthogonal *quality* lever: a model's
context window is a finite, degrading resource, not free storage, so the job is
to curate "the smallest possible set of high-signal tokens," not to stuff
everything in. The empirical backing is solid —
[*Lost in the Middle*](https://aclanthology.org/2024.tacl-1.9/) (U-shaped recall)
and [Chroma's *Context Rot*](https://research.trychroma.com/context-rot)
(non-uniform degradation *within* the advertised window). The practical response
is a layered toolkit — just-in-time / agentic retrieval, compaction
(summarize-and-continue), context offloading to external memory, and sub-agent
isolation — all of which all three major platforms now ship as first-class
primitives. Caching and curation are independent: caching changes what you
*pay*, curation changes what the model *sees*. Conflating them is the most common
mistake.

## Decision

Macrotide runs its **Advisor** on a small/cheap OpenRouter model with a frozen
memory-block system prefix and a deliberately small tool surface. The reasoning
behind the loop shape lives in
[context-engineering.md](./context-engineering.md) and the
[memory feature guide](../memory.md); the chat-path implementation lives in
[architecture.md § The chat path](../architecture.md#the-chat-path). This survey
is the evidence behind *why prefix order is load-bearing for cost* and *why the
window is a curated resource, not storage* — not the verdict. The
Macrotide-specific consequences are collected in
[§ Macrotide implications](#macrotide-implications).

## Decision-relevant takeaways

- **The control model is binary.** *Manual-breakpoint* caching (Anthropic;
  Gemini explicit `CachedContent`; Qwen on OpenRouter) gives guaranteed,
  deterministic cache boundaries and longer/extended TTLs but charges a
  cache-**write** premium. *Automatic-prefix* caching (OpenAI, Gemini implicit,
  DeepSeek, Grok, Moonshot, Groq) is free-to-write but opportunistic, with no hit
  guarantee and shorter, non-refreshing retention. On automatic providers the
  entire economic decision collapses to "did I get a hit," making **prefix
  stability the only lever**.
- **Anthropic is the only major provider that bills cache writes as a premium**
  over base input — 1.25× for 5-minute, 2× for 1-hour — and reads at 0.1×. Its
  break-even is exact: a 5-minute write pays for itself after **one** read; a
  1-hour write needs **two**. Choose the 1-hour TTL only when you expect ≥2 hits
  inside the hour or need to survive >5-minute idle gaps.
- **The minimum cacheable prefix is not a flat number.** It is model-dependent —
  4,096 tokens on Anthropic Opus 4.5/4.6/4.7, Mythos Preview, *and* Haiku 4.5;
  1,024 on Opus 4.8/NextOpus, Sonnet 4.5/4.6, Opus 4.1; 2,048 on retired Haiku
  3.5. OpenAI and Gemini Flash floor at 1,024; Gemini Pro at 4,096. **Below the
  floor, caching silently no-ops with no error** — a lean prompt may never cache
  at all.
- **The window degrades inside its advertised limit.** Lost-in-the-middle and
  context rot are architectural, not tokenizer artifacts. A large window is not a
  substitute for curation; *the* lever for quality is "fewest high-signal tokens."
- **Just-in-time retrieval is the headline pattern.** Hold lightweight
  identifiers (file paths, ids, queries) and hydrate via tools at runtime, rather
  than pre-loading bulk context. This is both a quality win (avoids rot) and a
  cost win (smaller windows), and it is the pattern that best fits a small model
  on a token-metered gateway.
- **Caching is orthogonal to rot.** It cuts cost/latency on repeated prefixes;
  the cached tokens still occupy the window at inference and still rot. Cache the
  static, fetch the volatile, and don't expect caching to fix recall.

---

## Part I — Prompt caching / cache control

### The universal rule

Across every provider, a cache hit requires an **identical leading prefix from
token 0**. The corollary governs prompt structure: order content
**stable → volatile**. Tools and system instructions and static documents go
first; retrieved RAG, the live user turn, any per-turn timestamp, request id, or
freshly-fetched quote go **last**. A single changed token anywhere in the leading
region — a reordered tool list, a date string, a model/route swap — silently
destroys the hit for the whole prefix after it, on every provider.

### Anthropic (Claude Messages API)

**Mechanism.** Explicit prefix caching via `cache_control` breakpoints, in two
modes. *Automatic* uses a single top-level `cache_control` field and the system
advances the breakpoint as the conversation grows. *Explicit* places
`cache_control: {"type": "ephemeral"}` on individual content blocks. The cache
prefix is built in strict order **tools → system → messages**; a change at any
level invalidates that level and everything after it.

**Shape & limits.** Max **4 explicit breakpoints** per request (a 5th returns
HTTP 400). Lookback window is 20 blocks per breakpoint. Extended TTL via
`cache_control: {"type": "ephemeral", "ttl": "1h"}` (values `5m` default or
`1h`). Usage fields report the split: `cache_creation_input_tokens` (written),
`cache_read_input_tokens` (hit), `input_tokens` (after the last breakpoint); if
both creation and read are 0, nothing cached.

**Cost.** Multipliers vs base input, stated verbatim in the pricing docs:
*"5-minute cache write tokens are 1.25 times the base input tokens price, 1-hour
cache write tokens are 2 times the base input tokens price, cache read tokens are
0.1 times the base input tokens price"*
([pricing](https://platform.claude.com/docs/en/docs/about-claude/pricing)).
Concrete, on the $5/MTok Opus tier (4.5/4.6/4.7/4.8·NextOpus): 5-min write
$6.25, 1-hour write $10, read $0.50, output $25. Sonnet 4.5/4.6 ($3 base):
$3.75 / $6 / $0.30 / $15. Haiku 4.5 ($1 base): $1.25 / $2 / $0.10 / $5. (Opus 4.1
is the **old** $15 tier, not the $5 tier.)

**Invalidation cascade — hierarchical and asymmetric.** Editing a tool
definition nukes the entire cache (tools → system → messages). Web search /
citations / speed toggle invalidates system + messages. `tool_choice` / images /
thinking changes invalidate messages. Changing only the last user message
preserves the whole cached prefix. The discipline that follows: tool and system
content must be byte-stable; volatile per-turn data must live at the very end.
Caches are isolated per-workspace within an org on the Claude API (since Feb 5
2026); Bedrock/Vertex remain org-level. Thinking blocks, sub-content/citation
blocks, and empty text blocks cannot be directly marked with `cache_control`.
([caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching))

### OpenAI (Responses / Chat Completions)

**Mechanism.** Fully automatic prefix caching — no code changes, no breakpoints,
no separately-billed writes. The system routes requests sharing a long prefix to
the same machine to maximize hit rate, and caches the complete messages array,
images in user messages, the tools list, and the structured-output schema.

**Shape & limits.** No required parameter. Optional `prompt_cache_key` (a string
combined with the prefix hash) steers routing so prompts sharing a long common
prefix land on the same cache-holding machine — the routing-hint counterpart to
Anthropic's explicit byte anchors. `usage.prompt_tokens_details.cached_tokens`
reports cache-hit prompt tokens.

**Cost & retention.** *"Caching is available for prompts containing 1024 tokens
or more"*; *"Caching happens automatically, with no explicit action needed or
extra cost paid to use the caching feature"*
([guide](https://developers.openai.com/api/docs/guides/prompt-caching)). The
guide claims latency cut up to 80% and input cost up to 90%. First-party GPT-5.x
pricing lists cached input at **0.1× base** (90% off): GPT-5.5 $5 → $0.50;
GPT-5.4 $2.50 → $0.25; -mini $0.75 → $0.075; -nano $0.20 → $0.02. Retention:
cached prefixes survive 5–10 min of inactivity, up to 1 hour; an extended policy
on newer models (gpt-5.5, gpt-5.4, …) keeps prefixes up to 24 hours. Caches are
not shared across organizations.
([pricing](https://developers.openai.com/api/docs/pricing))

### Google Gemini

**Mechanism — two modes.** *Implicit* caching is on by default for Gemini 2.5 and
newer: a request sharing a common prefix with a recent one may hit cache with
savings passed back automatically (no guarantee). *Explicit* caching has the
developer create a `CachedContent` object (system instruction + contents) with a
TTL, reference it by name for a guaranteed discount, and pay a **per-token-hour
storage fee** — the only provider in this survey that charges to *store* a cache.

**Shape & limits.** Explicit: `caches.create(model=…,
config=CreateCachedContentConfig(system_instruction=…, contents=…, ttl="300s"))`
→ `cache.name`, then reference via `GenerateContentConfig(cached_content=…)`.
*"If not set, the TTL defaults to 1 hour"*
([caching docs](https://ai.google.dev/gemini-api/docs/caching)); there are no
min/max bounds on the TTL itself. Minimum input to cache (Gemini API): 2.5 Flash
1,024; 2.5 Pro 4,096; 3 Pro Preview 4,096; 3.5 Flash 1,024. (Vertex AI lists
2,048 for 2.0/2.5 and 4,096 for 3.x — a real platform difference; check per
platform.)

**Cost.** Implicit discount on current pricing is ~90% (cached input 0.1×): 2.5
Flash $0.30 → $0.03; 2.5 Pro $1.25 → $0.125 (≤200k) / $0.25 (>200k); 3.5 Flash
$1.50 → $0.15. (Gemini 2.0-era models are ~75% off.) Explicit-cache **storage**:
2.5 Flash $1.00/MTok/hr; 2.5 Pro $4.50/MTok/hr; 3.x Pro $4.50/MTok/hr — so a
cached 100k-token context held one hour on 2.5 Pro costs ~$0.45/hr just to sit
there, independent of use.
([pricing](https://ai.google.dev/gemini-api/docs/pricing)) Note that the
May-2025 implicit-caching launch blog said *"providing the same 75% token
discount"* and a 2,048-token minimum for 2.5 Pro — both superseded by current
docs (90% off, 4,096 min)
([launch blog](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)).

### DeepSeek (Context Caching on Disk)

**Mechanism.** Automatic context caching: reused prefixes stored on a distributed
disk array, retrieved on duplicate input, no API change. Only requests with
prefixes **identical from the 0th token** are deduplicated; partial mid-input
matches don't hit. A **64-token storage unit** means content under 64 tokens
isn't cached, and hits are best-effort, not guaranteed (these design facts
originate in the
[Aug-2024 announcement](https://api-docs.deepseek.com/news/news0802); the current
[kv_cache guide](https://api-docs.deepseek.com/guides/kv_cache) phrases the match
rule more softly and no longer prints the 64-token figure). Usage exposes
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.

**Cost.** As of the April-26-2026 12:15 UTC cut — *"For all models, the input
cache hit price has been reduced to 1/10 of the launch price"* — `deepseek-v4-flash`
cache-hit input is **$0.0028/MTok** vs cache-miss $0.14 (read now ~**0.02× of
miss**, i.e. 1/50 — the cheapest cached-read economics in this survey), output
$0.28. `deepseek-v4-pro` is $0.003625 hit / $0.435 miss / $0.87 output (under a
75% promo expiring May 31 2026). Storage is free. Latency: a 128K high-reference
prompt's first-token latency drops from ~13s to ~500ms.
([pricing](https://api-docs.deepseek.com/quick_start/pricing)) **Model-name
churn risk:** `deepseek-chat` and `deepseek-reasoner` are now compatibility
aliases for the non-thinking / thinking modes of `deepseek-v4-flash`, **scheduled
to deprecate July 24 2026**. The current SKUs are `deepseek-v4-flash` /
`deepseek-v4-pro`.

### OpenRouter (gateway passthrough)

**Mechanism.** Normalizes one `cache_control` syntax and forwards provider-native
caching. **Explicit/manual** breakpoints are required only for Anthropic Claude
and Alibaba Qwen; everything else — OpenAI, Grok, Moonshot, Groq, DeepSeek, and
Google Gemini 2.5 (implicit) — is **automatic** with no `cache_control`. The
block syntax matches Anthropic's
(`{"type":"text","text":"…","cache_control":{"type":"ephemeral"}}`; 1-hour TTL
via `"ttl":"1h"`).

**Instrumentation.** *"The cache_discount field in the response body will tell
you how much the response saved on cache usage"*
([docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching)) —
negative on Anthropic cache writes, positive on reads. Plus
`prompt_tokens_details.cached_tokens` (and `cache_write_tokens` where applicable).

**Caveats — multipliers partly unresolved on the live page.** OpenRouter renders
the Anthropic, DeepSeek, and Gemini multipliers as unresolved template variables
(`{ANTHROPIC_CACHE_READ_MULTIPLIER}x`, etc.); the Anthropic 1.25×/2×/0.1× and
DeepSeek read figures here are cross-confirmed from each provider's own docs, not
read literally off OpenRouter. OpenAI is the **one** provider shown with a literal
value: cache reads *"charged at 0.25x or 0.50x the price"* — which **differs from
OpenAI first-party 0.1×**, so the effective discount depends on whether you bill
first-party or via OpenRouter. OpenRouter-routed Gemini says there is *"not a
limit on the number of cache_control breakpoints"* but only the final one is
used, with a TTL noted as *"on average 3-5 minutes"* and a 5-minute write TTL
that *"does not update"* — which conflicts with Gemini's own 1-hour explicit
default (see [§ Flagged / unverified](#flagged--unverified)).

### At a glance — caching matrix

Provider × write cost × read discount × TTL × min prefix × control model:

| Provider | Control | Write cost (vs base input) | Read cost | TTL / retention | Min prefix to cache | Storage fee |
|---|---|---|---|---|---|---|
| **Anthropic** (Opus 4.5–4.8, Sonnet 4.5/4.6, Haiku 4.5) | Manual — ≤4 `cache_control` breakpoints | 1.25× (5m) / 2× (1h) | **0.1×** | 5m default / 1h opt-in; **refreshes on hit** | 4,096 (Opus 4.5/4.6/4.7, Mythos, **Haiku 4.5**); 1,024 (Opus 4.8/4.1, Sonnet 4.5/4.6); 2,048 (Haiku 3.5) | none |
| **OpenAI** (GPT-5.x) | Automatic; `prompt_cache_key` routing hint | none | **0.1×** first-party (OpenRouter shows 0.25×/0.50×) | 5–10 min idle, up to 1h; **24h** extended on newer models | 1,024 | none |
| **Google Gemini implicit** (2.5+) | Automatic | none | **~0.1×** (2.0-era ~0.25×) | opportunistic | 1,024 Flash / 4,096 Pro | none |
| **Google Gemini explicit** (`CachedContent`) | Manual — named object + TTL | none (storage billed) | **~0.1×** (guaranteed) | TTL default **1h**, no bounds | 1,024 Flash / 4,096 Pro | **$1.00/MTok/hr** Flash, **$4.50** Pro |
| **DeepSeek** (v4-flash / v4-pro) | Automatic (disk) | none | **~0.02×** of miss (v4-flash $0.0028 vs $0.14) | best-effort, not guaranteed | 64-token unit; from token 0 | free |
| **OpenRouter** (gateway) | Manual for Claude/Qwen; automatic for the rest | passes through (Anthropic 1.25×/2×) | passes through; surfaces `cache_discount` | per underlying provider | per underlying provider | per underlying provider |

**Break-even (Anthropic, exact):** 1 read covers a 5-min write; 2 reads cover a
1-hour write.

---

## Part II — Context-window management

### The governing principle

Anthropic frames the discipline as **context engineering**, *"the set of
strategies for curating and maintaining the optimal set of tokens (information)
during LLM inference"*, where the goal is to *"find the smallest possible set of
high-signal tokens that maximize the likelihood of some desired outcome"*
([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
This "right tokens, fewest tokens" framing is the successor to prompt engineering
because agents now manage the whole context state (system prompt, tools, MCP,
history) across many turns, not a single prompt. The fuller treatment of this for
Macrotide's loop lives in [context-engineering.md](./context-engineering.md);
this section is the context-window evidence that underpins it.

### Why windows degrade — the evidence

**Lost in the Middle** (Liu et al.,
[arXiv 2307.03172](https://arxiv.org/abs/2307.03172); TACL vol. 12, pp. 157–173,
2024). On multi-document QA and key-value retrieval, *"performance is often
highest when relevant information occurs at the beginning or end of the input
context, and significantly degrades when models must access relevant information
in the middle of long contexts, even for explicitly long-context models"*
([TACL](https://aclanthology.org/2024.tacl-1.9/)) — the canonical U-shaped curve.

**Context Rot** (Hong, Troynikov, Huber; July 2025;
[research.trychroma.com/context-rot](https://research.trychroma.com/context-rot),
replication at [chroma-core/context-rot](https://github.com/chroma-core/context-rot)).
All 18 tested frontier models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3 families)
degrade non-uniformly as input grows, even on trivial tasks like replicating
repeated words; for 1M-token models a clear effect often appears around
300,000–400,000 tokens. This is degradation *within* the advertised window — so a
large context window is not a substitute for curation.

**The mechanistic why** (Anthropic): transformers create *"n² pairwise
relationships for n tokens,"* and models have *"less experience with, and fewer
specialized parameters for, context-wide dependencies"* at long range. The
degradation is architectural, not a tokenizer limit — which is why no amount of
context-window inflation removes it.

### Just-in-time (progressive) context loading

The headline pattern: instead of pre-loading data, the agent *"maintain[s]
lightweight identifiers (file paths, stored queries, web links, etc.) and use[s]
these references to dynamically load data"* at runtime, assembling understanding
layer by layer and keeping only what's necessary in working memory (progressive
disclosure). The retrieval underneath can be agentic grep/file tools rather than
a vector DB. The trade-off is more tool round-trips and latency, in exchange for a
small, high-signal window per turn.

**RAG vs agentic search** is a real fork, not "RAG is dead." Hybrid dense + BM25

- reranker is still the strongest single-shot retrieval, but **agentic search**
(expose grep/list-dir/read-file, let the agent iterate — search, read, refine,
with no index to build or maintain) wins for code and structured corpora where
exact-match plus iterative refinement beat semantic similarity, and removes
embedding-drift and index-maintenance overhead. The Amazon Science / AWS paper
*Keyword search is all you need*
([arXiv 2602.23368](https://arxiv.org/abs/2602.23368),
[amazon.science](https://www.amazon.science/publications/keyword-search-is-all-you-need-achieving-rag-level-performance-without-vector-databases-using-agentic-tool-use))
reports tool-based agentic keyword search reaching **over 90% of RAG-level
performance without a vector DB** (Bedrock + LangChain). Directional — one study
— but primary-sourced.

### Compaction (summarize-and-continue)

Summarize a conversation near the window limit and reinitialize a fresh window
from the summary. Anthropic notes the model *"preserves architectural decisions,
unresolved bugs, and implementation details while discarding redundant tool
outputs"*; tune by maximizing recall first, then precision. All three platforms
now ship server-side primitives with tunable token triggers (defaults are the
load-bearing knobs):

- **Anthropic** — context editing (beta `context-management-2025-06-27`):
  tool-result clearing (`clear_tool_uses_20250919`, defaults trigger 100k input
  tokens, keep 3 tool uses) and thinking-block clearing
  (`clear_thinking_20251015`). Server-side **compaction** (beta
  `compact-2026-01-12`, edit `compact_20260112`): trigger default **150k** input
  tokens, minimum 50k, `pause_after_compaction` default false. *Caveat:* clearing
  tool results invalidates cached prefixes — use `clear_at_least` so the cache
  breakage is worth it (you pay a cache-write on each clear). Internal evals:
  memory + context-editing +39% over baseline; a 100-turn web-search eval cut
  token use 84%.
  ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing),
  [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction))
- **OpenAI** — `context_management=[{"type":"compaction","compact_threshold":N}]`
  on `responses.create` (`compact_threshold` minimum 1000, no published default —
  treat as required), plus a standalone `POST /responses/compact`. The compaction
  item is opaque/encrypted and *"carries forward key prior state and reasoning
  into the next run using fewer tokens."*
  ([guide](https://developers.openai.com/api/docs/guides/compaction))
- **`truncation` (OpenAI)** — controls behavior when input exceeds the window.
  Default is `"disabled"` (a 400 if the limit is exceeded); `"auto"` *"will
  truncate the response to fit the context window by dropping input items in the
  middle of the conversation"*
  ([API ref](https://platform.openai.com/docs/api-reference/responses/create)) —
  the "truncate the middle" wording is the correct one.

### Context offloading to external memory

The agent writes structured notes to a store outside the window and pulls them
back on demand. Anthropic's **memory tool** (`type: "memory_20250818"`, directory
`/memories`, client-owned storage, commands view/create/str_replace/insert/
delete/rename) makes the file the source of truth, not the transcript — its
auto-injected system prompt warns: *"ASSUME INTERRUPTION: Your context window
might be reset at any moment, so you risk losing any progress that is not recorded
in your memory directory"*
([memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
The broader memory-system landscape is surveyed in
[memory-systems.md](./memory-systems.md); here the relevant point is that
offloading is a *context-budget* technique, independent of which store backs it.

### Sub-agent context isolation

Each sub-agent runs in a clean window, does the token-heavy exploration, and
*"returns only a condensed, distilled summary of its work (often 1,000-2,000
tokens),"* keeping the lead agent's window focused on synthesis. Anthropic's
multi-agent research system reports *"a multi-agent system with Claude Opus 4 as
the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude
Opus 4 by 90.2% on our internal research eval"*
([multi-agent system](https://www.anthropic.com/engineering/multi-agent-research-system)).
The cost is real, though: such systems *"use about 15× more tokens than chats,"*
and on BrowseComp *"token usage by itself explains 80% of the variance."*
Isolation buys quality by spending tokens in parallel windows — a trade to weigh
deliberately on a token-budgeted stack, not a default.

### Caching ⟂ rot

Gemini / OpenAI / Anthropic caching cuts cost and latency on repeated prefixes
(Gemini 2.5+ ~90% on cached input; Gemini 2.0 ~75%) but does **not** cure
lost-in-the-middle — the cached tokens still occupy the window at inference, and
still rot. Caching is a *billing* optimization; curation is the *quality* lever.
Keep them separate in your head: you can cache a bloated prompt cheaply and still
get bad answers from it.

---

## Macrotide implications

The Advisor is a small-model, tool-using chat fronted by OpenRouter, with a
frozen memory-block system prefix (`composeSystemPrompt` in
[`app/api/chat/route.ts`](../../../app/api/chat/route.ts), built by
[`lib/memory/inject.ts`](../../../lib/memory/inject.ts)).

**The frozen prefix is cache-ready but unexploited.** `buildMemoryBlock` already
emits byte-identical output for identical inputs *specifically* so turn-2+ prefix
caching can hit — the discipline is documented in
[memory.md § Why "frozen for the session"](../memory.md) and enforced in code
(deterministic category/id ordering, hash-stable render). That work is the hard
half. The unexploited half: **no `cache_control` breakpoints are actually sent**.
On automatic providers (OpenAI, DeepSeek, Gemini implicit via OpenRouter) the
stability already earns the discount for free, but on Anthropic-routed traffic the
prefix never enters the cache without an explicit breakpoint. The frozen prefix is
the prerequisite; the breakpoint is the trigger that's missing.

**Per-turn volatile context must go AFTER the cached prefix — and largely already
does.** `entry-context.ts` is exemplary: its `EntryContext` is *"rendered as a
PER-TURN message — never folded into the cached system prefix,"* which is exactly
right. The one structural subtlety to watch: `composeSystemPrompt` prepends the
*memory block* before the *static `SYSTEM_PROMPT`*. The memory block is
per-user/per-session and the system prompt is truly static, so the more-volatile
content currently sits in front of the more-stable content. For maximum reuse
*across users* the static system prompt + tool schemas would ideally form the
leading byte-stable region, with the per-user memory block after it as its own
breakpoint. (For a single owner across turns of one session, the current order
still caches fine — the block is frozen for the session.) Never inject a current
timestamp, session id, or freshly-fetched quote ahead of the stable region: a
24h-TTL date string in the system prompt invalidates the cache every single day;
a volatile quote block invalidates it every single turn.

**Concrete moves, by route:**

- **Anthropic-routed (if pinned via OpenRouter):** add up to 4
  `cache_control: {"type":"ephemeral"}` breakpoints — one after the tool block,
  one after the system prompt, one after the static context, one after the last
  stable history turn. For sub-5-minute reply gaps the default 5-min TTL (1.25×
  write, 0.1× read) is optimal; use `"ttl":"1h"` only if sessions routinely idle
  past 5 minutes.
- **OpenAI / DeepSeek-routed:** caching is free with zero config — the only job is
  prefix stability and clearing the floor (1,024 tokens on OpenAI; 64-token unit
  on DeepSeek). Pass a stable `prompt_cache_key` per user/session on OpenAI
  traffic to lift hit rate.
- **Mind the floor.** A lean small-model system prompt may fall **under 1,024**
  and never cache at all; routing to Gemini 2.5 Pro / 3 Pro or Anthropic Opus
  4.5/4.6/4.7 / Haiku 4.5 raises the floor to **4,096**. Deliberately make the
  stable prefix long enough to clear the relevant floor — a longer stable prefix
  is *cheaper* here, not more expensive, once it's a 0.1× cache read.
- **Avoid Gemini explicit `CachedContent`** for a chat advisor unless one large
  context is reused by many users within an hour — the $1.00–$4.50/MTok/hr
  standing storage fee outweighs the gain. Prefer Gemini implicit caching (free,
  automatic, ~90% off on hits) and just keep the prefix stable.

**Instrument it.** Read `cache_discount` and
`prompt_tokens_details.cached_tokens` (and `cache_write_tokens` where present)
per call from the OpenRouter response, log hit rate, and alarm on a drop — a
sudden collapse almost always means something volatile crept into the prefix (a
reordered tool list, a new timestamp, a model/route swap).

**Caching breaks on failover.** Changing the underlying model, provider route, or
tool schema invalidates the prefix everywhere. The Advisor multi-models for
public-tier resilience (the empty-turn reliability problem), so **expect a
cache miss on every failover** — budget input cost for cold prefixes on the
fallback path, and keep the fallback's prompt structure byte-identical so it
warms quickly.

**For context management, default to just-in-time over pre-loading.** Keep the
system prompt lean and let the Advisor *fetch* per turn (get_quote / get_holdings
/ search_filings) rather than dumping the whole portfolio and market tables into
context — pre-loading wastes the small model's tighter window and triggers rot the
moment the conversation runs long. This maps cleanly onto the **app.db / market.db
split** (see [architecture.md § Two databases](../architecture.md#two-databases-split-by-lifecycle)):
expose holdings rows, SEC look-through, and market snapshots as narrow tools
returning only the few rows needed (reference a holding by id, hydrate its current
value/NAV through a tool), which directly relieves FMP/EODHD-style rate-limit and
cost pressure. Implement **compaction in the app layer** — when history crosses a
token budget, summarize older turns into a compact note and restart the window
(the summarize-and-replace pattern already noted in
[memory-systems.md](./memory-systems.md)) — and treat any provider-native
compaction as a bonus on the models that support it, not a dependency, since
OpenRouter normalizes to a chat-completions surface and the Anthropic/OpenAI
primitives are behind beta headers. Prefer **agentic keyword/grep-style search**
over standing up a vector DB for Macrotide's mostly-structured corpus; reserve
hybrid RAG for genuinely unstructured prose if that ever becomes a corpus. Use
**sub-agent isolation** selectively, weighing the ~15× token cost — a fit for a
token-heavy "scan these N filings and summarize exposure" task, overkill for
ordinary Q&A.

## About this research

This document reconstructs research carried out by scout agents in May 2026,
verified against primary sources before writing. Caching figures come from each
provider's own live docs:
[Anthropic caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)
and [pricing](https://platform.claude.com/docs/en/docs/about-claude/pricing);
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [pricing](https://developers.openai.com/api/docs/pricing);
[Gemini caching](https://ai.google.dev/gemini-api/docs/caching) and
[pricing](https://ai.google.dev/gemini-api/docs/pricing);
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing); and
[OpenRouter's prompt-caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
Context-management primitives come from the Anthropic
[context-editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
and [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
docs, the OpenAI [compaction guide](https://developers.openai.com/api/docs/guides/compaction)
and [Responses API reference](https://platform.openai.com/docs/api-reference/responses/create),
and Anthropic's engineering essays
([effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[multi-agent system](https://www.anthropic.com/engineering/multi-agent-research-system)).
The empirical degradation evidence is
[*Lost in the Middle*](https://aclanthology.org/2024.tacl-1.9/) (TACL 2024) and
Chroma's [*Context Rot*](https://research.trychroma.com/context-rot) (July 2025);
the agentic-search result is Amazon Science's
[*Keyword search is all you need*](https://arxiv.org/abs/2602.23368). Macrotide
specifics are read directly from the cited code paths.

### Flagged / unverified

- **OpenRouter passthrough multipliers.** The live OpenRouter docs page renders
  the Anthropic, DeepSeek, and Gemini cache multipliers as unresolved template
  variables (`{ANTHROPIC_CACHE_READ_MULTIPLIER}x`, etc.). Only OpenAI shows a
  literal value (0.25×/0.50×). The Anthropic 1.25×/2×/0.1× and DeepSeek read
  figures here are cross-confirmed from each provider's own docs, not read off the
  OpenRouter page.
- **OpenRouter vs first-party OpenAI cache-read price.** OpenRouter states OpenAI
  cache reads are "0.25x or 0.50x" while OpenAI's own page lists GPT-5.x cached
  input at 0.1× (90% off). Whether OpenRouter under-passes the first-party
  discount, or this reflects older/model-dependent rates, could not be reconciled
  from a single source.
- **OpenRouter-routed Gemini TTL.** The page says "on average 3-5 minutes" with a
  5-minute write TTL that "does not update," conflicting with Gemini's own 1-hour
  explicit default. Could not confirm whether OpenRouter overrides the TTL or the
  note applies only to the implicit path.
- **OpenAI extended-caching (24h) and compaction model list.** The guide names
  the policy and gpt-5.3-codex / gpt-5.5 examples, but the exact opt-in parameter,
  full qualifying-model list, and `compact_threshold` server default are not
  published (minimum 1000; treat as required when enabling compaction).
- **Gemini explicit-cache minimum tokens differ by platform** (Gemini API
  1,024/4,096 vs Vertex AI 2,048/4,096) — verify against the platform in use.
- **DeepSeek v4-pro 75% promo** expires May 31 2026; post-June numbers
  (one-quarter of original rates) are not yet published as final. The 64-token
  unit and "from the 0th token" specifics now live in the
  [Aug-2024 announcement](https://api-docs.deepseek.com/news/news0802), not the
  current guide.
- **Chroma per-model magnitudes** are summarized qualitatively; the
  ~300k–400k "effect kicks in" figure for 1M-token models is approximate — read
  exact curves off the report's figures if cited quantitatively.
