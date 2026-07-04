# LLM platform primitives — a prior-art survey

*Researched May 2026*

## Summary

How the major LLM platforms (Anthropic, OpenAI, Google Gemini, OpenRouter, and
the open ecosystem around MCP and the Vercel AI SDK) expose the four core
inference primitives a tool-using advisor depends on: **tool calling and the
agentic loop**, **system-prompt design**, **reasoning/thinking tokens**, and
**citations and structured output**. The headline is convergence with stubborn
edges. Every platform now passes JSON-Schema-typed tools, returns structured
tool-call requests, and loops until the model answers; every platform exposes a
privileged instruction channel, a grammar-constrained structured-output mode, and
a reasoning-budget knob — but the wire formats, the forced-tool semantics, the
recursion support, the citation model, and the reasoning-control idiom all differ
in load-bearing ways. The 2026 frontier is no longer the protocol but the
discipline on top of it: the agent-computer interface (small, namespaced,
unambiguous tool surfaces), result shaping, explicit step caps, stable-prefix
caching, and architectural (not prompt-level) defenses against indirect prompt
injection. This survey reconciles the verified facts across providers, flags the
genuine cross-provider splits, and reads the consensus off them.

## Decision

Macrotide's Advisor is a small, cheap model (the public-tier OpenRouter chain)
driving a deliberately small tool surface through the Vercel AI SDK `streamText`
loop. The *implementation* of that loop — model resolution by tier, the frozen
memory snapshot, the tool set, the structured context envelope, and the
empty-turn recovery — lives in
[architecture.md § The chat path](../architecture.md#the-chat-path),
[advisor-context.md](../advisor-context.md), and the
[memory feature guide](../memory.md). The loop-shape rationale (small tools,
result shaping, forced-answer follow-ups, repair, fallbacks) is surveyed in
[context-engineering.md](./context-engineering.md). **This document is the
evidence one layer down** — how the providers themselves expose these primitives,
where they agree, and where porting between them costs real work. It is
understanding-oriented prior art, not a how-to.

## Decision-relevant takeaways

The findings that bear on a small-model, tool-using, OpenRouter-fronted advisor,
distilled before the per-area detail:

- **Write the loop to the OpenAI Chat Completions shape.** That is exactly what
  OpenRouter normalizes every provider to (`tools[]`, `tool_calls`,
  `role:"tool"`, a fixed `finish_reason` set), so it is the least-effort,
  most-portable target across the small models a router might pick.
- **Pick models by tool reliability, not just price.** OpenRouter filters on
  `supported_parameters=tools` and publishes a per-provider **Tool Call Error
  Rate** that also drives its provider ordering. For an advisor where a dropped
  tool call means a wrong number on screen, emission reliability is a first-class
  routing criterion.
- **Enforce strict schemas and validate client-side anyway.** Provider strict
  mode is a structural guarantee, never semantic, and it is best-effort across a
  multi-model router. The portable safety net is one schema definition plus
  client-side re-validation (Zod) plus a repair fallback — the same resilience
  posture that addresses the empty-turn reliability theme.
- **Shape tool results aggressively.** Returning a compact, model-legible subset
  (`price`, `change`, `currency`, `asOf`) instead of raw provider JSON is the
  highest-leverage move for a token-efficient small model; Anthropic's own
  example shows a ~66% token cut on a "concise" result format.
- **Own the step cap and the forced answer.** No provider auto-terminates the
  agentic loop on the raw API. You set the iteration limit and force a
  natural-language answer after the final tool result so the model can't loop and
  leave the user with nothing — directly the empty-turn failure mode.
- **Default reasoning to off/low; gate effort behind intent.** Reasoning tokens
  are billed at the output rate on every platform, and you pay for the full
  hidden chain even when it's excluded from the response. Reserve higher effort
  for genuinely analytical asks.
- **Lead the system prompt with a thin, durable contract.** A right-altitude
  role + source-priority hierarchy + scope + output format survives model swaps
  far better than scripted per-case rules — and weaker models *under*-trigger
  tools, so keep tool-use instructions explicit and plain rather than relying on
  frontier-model dial-back behavior.
- **Treat every tool result as untrusted data.** Market JSON, SEC filings,
  scraped holdings, OCR'd statements — all sit at "no authority." No prompt
  wording reliably stops indirect injection; the defense is architectural
  (taint-tracking, gating outbound/state-changing actions).

---

## Tool calling and the agentic loop

### The shared primitive

Every major platform exposes the same loop: pass JSON-Schema-typed tool
definitions, the model returns one or more structured tool-call requests, you
execute them and feed a typed result back, and you repeat until the model emits a
final answer. The differences are surface details — but several of them are
load-bearing when porting a loop.

### The wire format converged but is not identical

The four primary shapes:

- **Anthropic (Messages API)** uniquely embeds `tool_use` (in *assistant*
  content) and `tool_result` (in *user* content) as content **blocks** inside
  normal messages. There is **no `tool`/`function` role**. The model returns
  `stop_reason:"tool_use"`; you reply with a user message whose content *starts
  with* `tool_result` blocks.
- **OpenAI Chat Completions** uses a dedicated `role:"tool"` message keyed by
  `tool_call_id`; the **Responses API** uses `function_call` /
  `function_call_output` items keyed by `call_id` (and reasoning models must pass
  reasoning items back alongside tool outputs).
- **Gemini** uses `FunctionCall` / `FunctionResponse` parts; **Gemini 3** adds a
  unique `id` per call that **must** be echoed in the `functionResponse`.

Porting an agent loop is mostly reshaping these envelopes, not rethinking logic
([Anthropic — define tools](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools);
[OpenAI — function calling](https://developers.openai.com/api/docs/guides/function-calling);
[Gemini — function calling](https://ai.google.dev/gemini-api/docs/function-calling)).

### Forced-tool semantics differ

The "must call a tool" lever exists everywhere but with a subtlety:

- Anthropic `tool_choice` is `{type:"auto"}` (default with tools), `{type:"any"}`
  (must call *some* tool), `{type:"tool",name}` (force a specific tool), or
  `{type:"none"}`. **`any`/`tool` prefill the assistant turn**, so the model emits
  *no* natural-language preamble before the `tool_use` block even if asked. To get
  commentary, stay on `auto` and instruct in a user message.
- OpenAI `tool_choice` is `auto` / `required` / `none` / `{type:"function",name}`
  / `{type:"allowed_tools", mode, tools}`. `required` is the "must call
  something" lever.
- Gemini `function_calling_config.mode` is `AUTO` (default for declarations
  only) / `ANY` (always predict a call) / **`VALIDATED`** (the verified default
  when *combining* tools — constrained to call-or-NL with schema adherence) /
  `NONE`.

Anthropic also pairs `disable_parallel_tool_use:true` with `any`/`tool` to
guarantee *exactly one* call (with `auto`, *at most one*)
([Anthropic — define tools](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools)).

### Parallel calls are default-on and unordered

Parallel tool calls are on by default almost everywhere (Anthropic; OpenAI
`parallel_tool_calls=true`; Gemini; OpenRouter) and are explicitly
**unordered/independent**. Anthropic states dependent calls are issued across
separate turns — so dispatch the whole batch concurrently and let a
missing-prerequisite failure (`is_error:true`) trigger a reissue rather than
pre-detecting dependencies
([Anthropic — parallel tool use](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/parallel-tool-use)).

> The single biggest parallelism footgun on Anthropic is message-history shaping:
> all `tool_result` blocks from one parallel batch must go in **one** user
> message. Splitting them across separate user messages measurably *teaches*
> Claude to stop parallelizing — a documented troubleshooting item, and a
> behavior-conditioning effect rather than a mere formatting rule.

### Strict schemas are a first-class guarantee

OpenAI `strict:true` and Anthropic `strict:true` both promise exact schema
conformance via grammar-constrained sampling. OpenAI's is structured-outputs-
backed with hard limits (`additionalProperties:false`, all fields `required` with
null-unions for optionals; nesting ≤5 levels). Crucially, the **Responses API
auto-normalizes to strict when `strict` is omitted**; Chat Completions stays
non-strict unless explicitly enabled
([OpenAI — function calling](https://developers.openai.com/api/docs/guides/function-calling)).
Anthropic recommends combining `tool_choice:any` + `strict:true` to guarantee
*both* that a tool is called *and* that inputs validate.

### Token-efficiency has graduated from feature to model property

The Anthropic `token-efficient-tools-2025-02-19` beta header (~14% average, up to
70% output-token savings) works **only on Claude 3.7 Sonnet**; every Claude 4+
model bakes it in and you must **not** send the header (no effect). The tool-use
system prompt itself still costs model-specific overhead, now spanning **264–804
tokens** depending on model and whether `tool_choice` is auto/none vs any/tool
(e.g. Opus 4.8 = 290/410, Opus 4.7 = 675/804, Haiku 3.5 = 264/355). Treat any
single row as a snapshot and prefer `count_tokens` for the model you actually call
over hard-coding constants — Opus 4.7+ also use a new tokenizer
([Anthropic — tool-use overview](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview)).

### The frontier is the agent-computer interface (ACI)

The 2026 discipline is not the protocol but the tool surface. Anthropic's
*Writing tools for agents* argues for **few thoughtful tools** over wrapping every
endpoint (one `schedule_event` over `list_users`+`list_events`+`create_event`),
**namespacing** (prefix vs suffix has non-trivial eval effects), and unambiguous
param names (`user_id`, not `user`). OpenAI independently advises keeping **fewer
than 20 functions** available at the start of a turn for accuracy. Past that soft
cap, deferred/lazy loading keeps rarely-used schemas out of the initial turn:
OpenAI's `tool_search` (gpt-5.4+) and Anthropic's `defer_loading` / `tool_search`
server tool; `tool_choice:{type:allowed_tools}` (OpenAI) and
`allowed_function_names` (Gemini) restrict the active subset without dropping
definitions (cache-friendly).

### Result shaping is an explicit, supported pattern

Returning a compact, model-legible subset rather than raw JSON has library
support. Anthropic's *Writing tools for agents* shows a `ResponseFormat` enum
(`concise` vs `detailed`) — the concise Slack example using ~72 vs 206 tokens
(~66% reduction). The Vercel AI SDK operationalizes this as **`toModelOutput`**
(renamed from `experimental_toToolResultContent` in v5), decoupling what the tool
returns from what the model sees, and is the standard way to feed multimodal
results back
([Vercel AI SDK — tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).

### Step caps live in the harness, not the model

No provider auto-stops the agentic loop on the raw API — you own the cap.
Anthropic/OpenAI/OpenRouter all describe a loop with an explicit iteration limit;
the Vercel AI SDK formalizes it with `stopWhen` + `stepCountIs(n)` (default
`stepCountIs(20)`) and `hasToolCall(name)`. Note the semantics of
`isLoopFinished()`: it is the explicit **no-cap** option (never triggers, runs
until naturally finished), *not* a "detect completion" helper.

### MCP standardizes the transport

The Model Context Protocol decouples tool definition/execution from any model
API: JSON-RPC `tools/list` + `tools/call`, `inputSchema`/`outputSchema`,
`structuredContent`, and a clean **two-channel error model** — JSON-RPC protocol
errors (`-32602` unknown tool / bad args) go to the host, while tool-**execution**
errors come back as a normal result with `isError:true` so the *model* sees and
recovers. This mirrors Anthropic's `is_error:true` convention and the shared
advice to write *instructive* errors ("Rate limit exceeded. Retry after 60
seconds.") not opaque ones. The spec advises a human-in-the-loop able to deny
invocations and treating tool annotations as untrusted unless from a trusted
server (spec version 2025-06-18)
([MCP — server tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).

### OpenRouter's value-add is normalization plus a reliability signal

OpenRouter mirrors the OpenAI Chat Completions shape, maps every provider's
`finish_reason` to a fixed set (`tool_calls|stop|length|content_filter|error`),
exposes a `supported_parameters=tools` model filter, and publishes the
**Tool Call Error Rate** per provider (which drives "Auto Exacto" provider
ordering for tool-calling requests). Its *documented* `tool_choice` surface is
only `auto` / `none` / forced-named-function plus `parallel_tool_calls`;
`required` and `allowed_tools` are **not documented** there (they may pass through
to OpenAI-family models, but undocumented — test before relying on it). Tools must
be re-sent every turn so the router can validate the schema
([OpenRouter — tool calling](https://openrouter.ai/docs/guides/features/tool-calling)).

---

## System-prompt design

### The "right altitude" principle

Frontier labs converged on a shared philosophy. Anthropic's load-bearing idea is
the **right altitude**: prompts *"specific enough to guide behavior effectively,
yet flexible enough to provide the model with strong heuristics to guide
behavior"* — the middle between brittle hardcoded logic and vague guidance. The
durable parts are role context, behavioral constraints, a source-priority
hierarchy, scope, and output format — **heuristics, not scripts**
([Anthropic — effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### Counter-intuitively, 2026 models need *less* prompting

Anthropic documents that **Claude Opus 4.5 and 4.6** are *more responsive* to the
system prompt and now **over-trigger** on aggressive phrasing: *"dial back any
aggressive language. Where you might have said 'CRITICAL: You MUST use this tool
when…', you can use more normal prompting like 'Use this tool when…'."* (This is
documented for 4.5/4.6 specifically, *not* asserted of 4.7/4.8.) OpenAI says the
same for reasoning models — skip chain-of-thought scaffolding, try zero-shot, and
don't force extra reasoning around tool calls
([Anthropic — prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices);
[OpenAI — reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)).

A related shift: Anthropic's newest Opus *"has a tendency to favor reasoning over
tool calls,"* and the **primary lever to increase tool use is raising the effort
setting**, with prompt wording secondary.

> **Caveat for a multi-model router.** The dial-back guidance is a frontier-model
> property. Weaker/free models tend to *under*-trigger tools, so keep tool-use
> instructions explicit and plain; reserve aggressive phrasing only for the
> models that demonstrably need it.

### Role and honesty are cheap, high-leverage, and engineered in

Anthropic: *"Setting a role in the system prompt focuses Claude's behavior and
tone… Even a single sentence makes a difference."* Honesty/grounding is engineered
directly into production prompts — for coding agents Anthropic recommends the
literal rule *"Never speculate about code you have not opened… you MUST read the
file before answering."* The finance analogue is a defer-to-tool-data and
knowledge-cutoff-transparency rule.

### The instruction hierarchy is a formal, trained safety primitive

All three providers expose a privileged instruction channel (Anthropic's `system`
param; OpenAI's `system`/`developer` roles; Gemini's `system_instruction`). OpenAI
codifies this as the **chain of command** in the Model Spec, whose Dec 18 2025
levels (high→low) are **Root > System > Developer > User > Guideline > No
Authority**. Root (renamed from Platform, mostly prohibitive) sits strictly above
System. Critically, *"quoted text… in ANY message, multimodal data, file
attachments, and tool outputs are assumed to contain untrusted data and have no
authority by default… any instructions contained within them MUST be treated as
information rather than instructions to follow"* unless higher-authority unquoted
text explicitly delegates. This makes "wrap untrusted input in quotes/tags" a real
security control
([OpenAI Model Spec, 2025-12-18](https://model-spec.openai.com/2025-12-18.html)).
Reasoning models replace `system` with `developer` messages
([OpenAI — reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)).

### Stable-prefix-first ordering is universal because caching rewards it

All three providers reward putting invariant content first (tools → system →
static context) and volatile content last, because that keeps the cached prefix
warm. OpenAI: *"place static content like instructions and examples at the
beginning of your prompt, and put variable content… at the end."* The caching
economics (read discount ≈90% at the top end across all three) make the
stable-prefix-first layout near-universal
([OpenAI — prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)).

The caching mechanics differ:

- **Anthropic** is the most controllable: explicit `cache_control` breakpoints
  (max 4), 5-min (1.25× write) or 1-hour (2× write) TTL, **0.1× read**, and
  per-model minimums. The live minimums are 4,096 tokens for Opus 4.5/4.6/4.7 and
  Haiku 4.5, but **1,024 tokens for Sonnet 4.6/4.5 and the newest Opus** (4.8),
  and 2,048 for Haiku 3.5 — i.e. the "4,096 on Opus 4.5+" generalization is *wrong*
  for the newest Opus
  ([Anthropic — prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- **OpenAI** auto-caches prefixes ≥1,024 tokens; optional `prompt_cache_key`
  influences routing; in-memory retention 5–10 min of inactivity up to 1h
  (extended up to 24h); cached-input discount is model-dependent (**50/75/90%**,
  not a flat multiplier).
- **Gemini** caches implicitly by default on all 2.5+ models (implicit-cache
  minimums 1,024 Flash / 4,096 Pro), with explicit `cachedContent` (default TTL
  1h, minimum reduced from the old 32,768 to ~4,096); exact discount rates defer
  to the pricing page
  ([Gemini — caching](https://ai.google.dev/gemini-api/docs/caching)).

A volatile token inside the cached prefix silently busts the cache every request —
never inject the current date/time or per-request data *into* the cached prefix.

### No prompt wording stops indirect injection

For tool-using agents, the live frontier defense is **architectural**. Simon
Willison's **lethal trifecta** (private data + untrusted content + an exfiltration
channel) and Meta's operationalization — the **Agents Rule of Two**, *"agents must
satisfy no more than two of the following three properties within a session"*:
(A) process untrustworthy inputs, (B) access sensitive/private data, (C) change
state or communicate externally — needing all three without a fresh context
requires human-in-the-loop. Mitigations are taint-tracking and policy-gating
outbound actions, not prompt phrasing
([Meta — Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/)).

---

## Reasoning / thinking tokens

### Two idioms, converging on the effort knob

Every platform exposes a reasoning-budget primitive, and the control surface has
bifurcated into two idioms:

- **Explicit token budget** — Anthropic legacy `budget_tokens`, Gemini 2.5
  `thinkingBudget`, OpenRouter `reasoning.max_tokens`.
- **Coarse qualitative effort/level** — OpenAI `reasoning.effort`, Anthropic's
  newer `effort` (in `output_config`) + adaptive thinking, Gemini 3
  `thinkingLevel`, OpenRouter `reasoning.effort`.

The field is converging on the **effort knob + model-decided adaptive/dynamic
thinking**. Anthropic's newest models (Opus 4.8/4.7) have *removed* manual
`budget_tokens` (returns 400) in favor of `thinking:{type:"adaptive"}` + `effort`;
Opus 4.6 and Sonnet 4.6 still accept `budget_tokens` but deprecate it. Gemini 2.5
defaults to dynamic thinking (`thinkingBudget:-1`); Gemini 3 moves to
`thinkingLevel` (with `thinkingBudget` accepted only for backwards-compat, and
*"may result in unexpected performance"* on Gemini 3 Pro)
([Anthropic — extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking);
[Anthropic — effort](https://platform.claude.com/docs/en/build-with-claude/effort);
[OpenAI — reasoning](https://developers.openai.com/api/docs/guides/reasoning);
[Gemini — thinking](https://ai.google.dev/gemini-api/docs/thinking)).

### Reasoning tokens are paid output tokens, everywhere

On Anthropic, OpenAI, and Gemini the model's internal thinking is billed at the
standard **output-token rate**, and you pay for the **full** hidden chain even when
only a short summary (or nothing) is returned. Anthropic: *"You're charged for the
full thinking tokens generated by the original request, not the summary tokens."*
Gemini: *"When thinking is turned on, response pricing is the sum of output tokens
and thinking tokens."* Hiding reasoning (OpenRouter `exclude:true`, Anthropic
`display:"omitted"`, OpenAI not requesting a summary) reduces **latency**, not
**cost**.

### Effort is a behavioral signal, not a hard cap (on Anthropic)

Anthropic is explicit: *"Effort is a behavioral signal, not a strict token budget.
At lower effort levels, Claude will still think on sufficiently difficult problems,
but it will think less."* Its `effort` is also **broader** than a thinking budget —
it governs *all* response tokens (text, tool-call verbosity, *and* thinking), so
lower effort means fewer tool calls and terser output, not just less reasoning. By
contrast Gemini's `thinkingBudget` is closer to a real ceiling, and OpenRouter's
`max_tokens` is applied directly. Only OpenRouter publishes an effort→budget
mapping (`xhigh≈95% / high≈80% / medium≈50% / low≈20% / minimal≈10%` of
`max_tokens`), and on OpenRouter `effort` and `max_tokens` are **mutually
exclusive**
([OpenRouter — reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)).

### Multi-turn coherence requires passing reasoning state back

In tool loops you must round-trip the reasoning state or the model loses its
place, but the mechanism differs: Anthropic returns an opaque `signature` per
thinking block (and `redacted_thinking` for safety-flagged content) that must be
returned **unmodified**; Gemini returns `thoughtSignatures` on function-calling
turns (which add input tokens when returned); OpenAI uses persisted reasoning
items (`previous_response_id`) or `reasoning.encrypted_content` for
stateless/ZDR; **OpenRouter normalizes to `reasoning_details`**. And on Anthropic,
*"changes to thinking parameters (enabled/disabled or budget allocation)
invalidate message cache breakpoints"* (system + tools stay cached) — so keep
effort stable per session if you cache a long prompt.

### Reasoning-helps-vs-hurts is now documented guidance

OpenAI frames reasoning (o-series) models as **planners** — *"use o-series models
to plan out the strategy… and use GPT models to execute specific tasks,
particularly when speed and cost are more important than perfect accuracy"* — and
says to *"Avoid chain-of-thought prompts… prompting them to 'think step by step'…
is unnecessary."* Anthropic warns that `max` effort *"can lead to overthinking"* on
structured-output tasks.

---

## Citations and structured output

### Schema adherence everywhere is the same trick

OpenAI Structured Outputs, Anthropic strict tool use + native Structured Outputs,
and local engines (llama.cpp GBNF) all constrain the decoder to schema-valid
tokens — **grammar-constrained sampling**. The guarantee is **structural** (valid
JSON matching the schema), never **semantic** (correct values). Anthropic's
wording: *"constraining the model's token sampling to schema-valid outputs."*

### Two "strict modes" are easy to conflate

- **OpenAI**: `strict:true` lives on `response_format.json_schema` (Chat) /
  `text.format` (Responses) **and** on tool/function definitions.
- **Anthropic**: `strict:true` lives on the *tool* (strict tool use), while
  `output_config.format` is the separate native text-output path — both share one
  compiler (24h grammar cache, 180s compile timeout, *"Schema is too complex for
  compilation"* over the limit).

Schema rules are nearly identical across the two: every object needs
`additionalProperties:false`, all properties in `required` (optionals as
null-unions), and most validation keywords (`minLength`, `pattern`, `minimum`,
`multipleOf`, `format`) are dropped
([OpenAI — structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs);
[Anthropic — strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use);
[Anthropic — structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).

### …but recursion and limits genuinely diverge

- **Recursion**: OpenAI **supports** recursive schemas (root recursion via
  `$ref:"#"`, explicit via `$defs`); Anthropic explicitly does **not**. A real
  cross-provider incompatibility, not a shared limitation.
- **Limits**: OpenAI raised its limits ~5× in 2025 (object properties 100→5,000;
  schema chars 15,000→120,000; enum values 500→1,000), nesting depth unchanged at
  **5 levels** — but **Azure OpenAI / Foundry docs (updated 2026-05-13) still list
  the old 100-property/5-level ceiling**, so Azure deployments may lag.
- **Anthropic caps** OpenAI doesn't surface: max 20 strict tools/request, 24
  total optional params across strict schemas, 16 params with union types.

### Gemini has two schema dialects and silent-ignore semantics

Gemini uses `responseMimeType:"application/json"` + `responseSchema` (OpenAPI-3.0
subset) or the newer `responseJsonSchema` (fuller JSON Schema), plus
`responseMimeType:"text/x.enum"` for enums. Unlike OpenAI/Anthropic (which reject
unsupported keywords), Gemini **silently ignores** them, and Gemini 2.0 needs an
explicit `propertyOrdering` for deterministic field order
([Gemini — structured output](https://ai.google.dev/gemini-api/docs/structured-output)).

### Citations bifurcate into two unrelated primitives

The "citations" word covers two different problems:

- **Document-citation (Anthropic Citations)**: you supply documents with
  `citations:{enabled:true}`; the model's text blocks carry a `citations[]` array
  pointing at exact source spans (`char_location` / `page_location` /
  `content_block_location`) with verbatim `cited_text`. Crucially, **`cited_text`
  counts toward neither output nor input tokens** — *"The cited_text field…
  does not count towards output tokens. When passed back in subsequent
  conversation turns, cited_text is also not counted towards input tokens."* This
  makes Citations cheaper *and* more reliable than prompting the model to quote
  sources. All active models support it except Haiku 3
  ([Anthropic — citations](https://platform.claude.com/docs/en/build-with-claude/citations)).
- **Search-grounding (OpenAI / Gemini)**: artifacts of the *search tools*. OpenAI
  `file_search`/`web_search` emit `file_citation`/`url_citation` annotations on
  `output_text` (underlying sources require opt-in via `include`). Gemini's
  `google_search` tool returns `groundingMetadata` mapping text segments to
  `groundingChunks` via `groundingSupports`. **Gemini 3 bills per search query the
  model executes** (several per turn possible), whereas 2.5-and-older bill per
  grounded prompt — a material cost-model change
  ([OpenAI — web search](https://developers.openai.com/api/docs/guides/tools-web-search);
  [Gemini — grounding](https://ai.google.dev/gemini-api/docs/google-search)).

> **The confirmed Anthropic gotcha**: Citations and Structured Outputs are
> **mutually exclusive**. Enabling citations on a document while also setting
> `output_config.format` returns a **400** — citation blocks must interleave with
> text and break the strict-JSON envelope. Split the pipeline: one call extracts
> structured data, a separate call produces cited prose.

### The Vercel AI SDK is a validation layer, and it moved

In **AI SDK 6**, the dedicated `generateObject`/`streamObject` are **deprecated**
(*"They will be removed in a future version."*) in favor of
`generateText`/`streamText` with an `output:` spec
(`Output.object()`/`array()`/`choice()`/`json()`/`text()`). The SDK forwards your
schema to the provider's native strict mode where available, **then re-validates
the final result client-side** with Zod/Valibot, throwing
`AI_NoObjectGeneratedError` on mismatch. Note OpenAI `strictJsonSchema` now
**defaults to `true`** in v6. There is no built-in repair primitive — the
documented recipe is external (`jsonrepair` + `safeParseJSON`, then Zod parse)
([Vercel AI SDK 6 — migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0);
[Vercel AI SDK — generating structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)).

### Function-calling-as-extraction is the lowest common denominator

Any provider with tool calling can return a target object: define a single tool
whose schema *is* the target, force the call, and read the validated arguments. It
works on cheap models lacking a native `response_format`, costs tool-system-prompt
overhead (a simple 1-tool request ≈403 input tokens on Opus 4.8), and — without
strict mode — risks type drift (`"2"` vs `2`).

---

## At a glance

A combined cross-provider matrix. "OpenRouter" describes the normalized surface it
documents; underlying behavior is inherited from whichever model serves the route.
"Vercel AI SDK" describes the provider-agnostic orchestration layer, not a model.

| Dimension | Anthropic | OpenAI | Google Gemini | OpenRouter | MCP / Vercel AI SDK |
|---|---|---|---|---|---|
| **Tool wire format** | `tool_use`/`tool_result` content **blocks**; no tool role | `role:"tool"` (Chat) / `function_call_output` items (Responses) | `FunctionCall`/`FunctionResponse` parts; per-call `id` (G3) | Normalizes to OpenAI Chat Completions shape | MCP: JSON-RPC `tools/call`; SDK: `tool()` + auto-loop |
| **Force-a-tool** | `tool_choice` auto/any/tool/none (any/tool prefill, suppress preamble) | `tool_choice` auto/required/none/named/allowed_tools | `mode` AUTO/ANY/**VALIDATED**/NONE | auto/none/named (required, allowed_tools undocumented) | `toolChoice` auto/required/none/tool |
| **Parallel calls** | default on; one user msg per batch | `parallel_tool_calls=true` | default on, id-mapped | default on | SDK loops; default on |
| **Strict schema** | `strict:true` on tool; native `output_config.format` | `strict:true` (Responses auto-normalizes) | constrained gen; no `strict` flag | passthrough | client-side Zod re-validate |
| **Recursive schema** | **No** | **Yes** (`$ref:"#"`/`$defs`) | limited | model-dependent | passes schema through |
| **Citations** | Document Citations (`cited_text` free; ✗ with structured output) | search annotations (`url_citation`/`file_citation`) | search `groundingMetadata`; G3 billed per query | inherited | n/a |
| **Reasoning control** | `effort` + `thinking:{adaptive}`; legacy `budget_tokens` removed on 4.7/4.8 | `reasoning.effort` (none…xhigh) | `thinkingLevel` (G3) / `thinkingBudget` (2.5) | unified `reasoning:{effort\|max_tokens}` (mutually exclusive) | passes through |
| **Reasoning billing** | output rate, full chain | output rate, full chain | output rate (output + thinking) | underlying provider | underlying provider |
| **Prompt caching** | explicit `cache_control`, 0.1× read, ≤4 breakpoints, min 1,024–4,096 by model | auto ≥1,024 tok; 0.1× read on GPT-5.x (50/75% older); OpenRouter shows 0.25×/0.50× | implicit on 2.5+; explicit `cachedContent` | passthrough by route | passthrough |
| **Instruction channel** | `system` param | `system`/`developer` (Model Spec chain of command) | `system_instruction` | OpenAI-style `role:"system"` | passthrough |
| **Step cap** | harness-owned | harness-owned | harness-owned | harness-owned + Tool Call Error Rate signal | `stopWhen`+`stepCountIs(20)` |

---

## Macrotide implications

For a small-model, tool-using, OpenRouter-fronted advisor, these primitives line
up against Macrotide's existing constraints (the public-tier `openrouter/free`
chain, the 24h quote TTL, the demo-mode budget caps, and the empty-turn
reliability theme). The loop *implementation* already lives in
[architecture.md § The chat path](../architecture.md#the-chat-path) and
[advisor-context.md](../advisor-context.md); these are the prior-art-grounded
reasons behind its shape.

- **Route by tool reliability, then price.** Filter OpenRouter models on
  `supported_parameters=tools` and weight the per-provider **Tool Call Error
  Rate** alongside the cost constraints already in play. For an advisor where a
  dropped or garbled tool call puts a wrong number on screen, emission
  reliability is a first-class routing criterion — and complements the
  multi-model fallback that addresses provider flakiness.
- **Target the OpenAI Chat Completions shape.** It is exactly what OpenRouter
  normalizes to, so the loop is portable across the small models a route might
  pick. Treat `parallel_tool_calls=true` as default; disable it only if a cheap
  model misbehaves with batches.
- **Strict schemas on every market-data tool, validated again client-side.** A
  hallucinated ticker or malformed date is a correctness bug, not a UX wrinkle.
  Use `strict:true` + force a tool when the user clearly asks for a quote, but
  because the router is multi-model and strict mode is best-effort, keep the
  Vercel SDK's Zod re-validation plus a `jsonrepair` fallback as the resilience
  net.
- **Design schemas to the strictest intersection.** ≤5 nesting levels (OpenAI),
  ≤20 strict tools / ≤24 optional params (Anthropic), scalar-only enums, no
  `minLength`/`pattern`/`minimum`, and **avoid recursion** (OpenAI allows it,
  Anthropic does not). Design once; avoid per-model schema forks.
- **Shape tool results, don't pass raw JSON.** Return `{price, change, currency,
  asOf}`, not the provider envelope; a `concise|detailed` response-format enum
  lets the model ask for more only when needed (~66% token cut in Anthropic's own
  example). If/when on the Vercel SDK, implement `toModelOutput` per tool to do
  the decoupling.
- **Keep the tool surface small and namespaced.** A handful of consolidated tools
  (`get_quote`, `get_holdings`, `search_security`, `get_macro_series`) with
  service-prefixed names — well under the ~20-tool soft cap both Anthropic and
  OpenAI cite, so favor clarity over breadth.
- **Own the step cap and forced answer.** Set an explicit iteration limit (the
  SDK default is `stepCountIs(20)`), and after the final tool result force a
  natural-language answer (`tool_choice:none` / a "now answer the user" turn) so
  the model can't loop on tool calls and leave the user with nothing — directly
  the empty-turn failure mode.
- **Return instructive, model-legible tool errors.** `is_error:true` with "Rate
  limit exceeded, retry after 60 seconds" or "No quote for TICKER, suggest the
  user check the symbol" lets a small model recover or fail gracefully rather than
  emitting an empty turn — cheap resilience that complements the multi-model fix.
- **Default reasoning off/low; gate effort behind intent.** Quote lookups and
  portfolio display are the well-defined workhorse path where reasoning adds
  latency and output-token cost with little gain. **Macrotide sends no `reasoning`
  param today**, so a reasoning-capable zero-cost model the router picks reasons at its
  own default and bills it at the output rate — a silent cost leak on the public
  tier. Standardize on OpenRouter's `reasoning:{effort}` defaulting to
  `none`/`minimal`, and reserve higher effort for genuinely analytical asks
  (rebalancing rationale, feeder look-through, "should I tilt toward gold given THB
  weakness"). Use `exclude:true` to hide chain-of-thought in the UI — but budget
  for it anyway, because excluded reasoning is still billed. Avoid `max`/`high` on
  structured-output paths (Anthropic warns it overthinks and can corrupt
  strict-format output).
- **Lead the system prompt with a thin right-altitude contract.** Role (the
  "Advisor" — an educational index-investing companion), source-priority hierarchy
  (live market/DB data via tools > model knowledge), explicit scope (Macrotide
  *does* give concrete plan-anchored buy/sell/hold + rebalancing guidance — that's
  the product — but always educational, grounded in the user's real data, with the
  standing "not licensed advice" disclaimer), output format. Bake in a staleness
  clause so the model states quote age ("as of <timestamp>") rather than implying
  real-time — given the 24h quote TTL. Don't rely on frontier dial-back behavior;
  weak models under-trigger, so keep tool-use instructions explicit and plain.
- **Structure for cache hits.** Invariant block first (tool defs, stable contract,
  static disclaimers), volatile content last (user message, today's date,
  freshly-fetched rows). Never inject the current date/time or per-request market
  data *into* the cached prefix — it busts the cache every call.
- **Treat every tool result as untrusted No-Authority data.** Market JSON,
  SEC/EDGAR filings, scraped holdings, OCR'd statement images — wrap/label them as
  data and instruct the model that content inside tool results never changes its
  instructions. Apply the Rule-of-Two: the chat reads private holdings (sensitive)
  and ingests untrusted filing/web content (untrusted input), so keep the third
  leg — autonomous external/state-changing actions — gated behind explicit user
  confirmation.
- **Use Anthropic Citations only where it fits, and not with structured output.**
  For a "cite your source" UX on uploaded statements/prospectuses, `cited_text` is
  free on tokens and points at real spans — but it's mutually exclusive with
  structured JSON, so split extraction (json_schema) from cited explanatory prose.
  For market/news grounding, gate Gemini/OpenAI search behind explicit user intent
  (Gemini 3 bills per query).
- **If Macrotide exposes its data tools to external agents (or consumes external
  ones), MCP is the right transport.** Define `inputSchema` + `outputSchema`,
  return `structuredContent` for prices, use `isError` for execution failures, and
  keep a human-in-the-loop gate for any write/trade-like action per the spec's
  guidance.

## About this research

This document reconciles four fact-checked research passes carried out in May 2026,
each one verifying an earlier scout finding against primary provider documentation
and correcting it where the docs had moved. Sources are primary throughout: the
Anthropic Claude docs (tool use, prompt engineering, prompt caching, extended
thinking, effort, structured outputs, strict tool use, citations, migration
guide), the OpenAI developer docs and the 2025-12-18 Model Spec, the Google Gemini
API docs (function calling, thinking, caching, structured output, grounding), the
OpenRouter feature guides, the MCP 2025-06-18 specification, and the Vercel AI SDK
docs and v5/v6 migration guides. URLs are cited inline at each claim.

Verbatim quotation is used sparingly and only where the exact wording is
load-bearing; everything else is paraphrase. This is understanding-oriented prior
art — it does **not** restate Macrotide's own code, which it references rather than
reproduces (see [architecture.md](../architecture.md),
[advisor-context.md](../advisor-context.md), [memory.md](../memory.md), and the
peer survey [context-engineering.md](./context-engineering.md)).

**Flagged unverified / contested at time of writing:**

- **Model-version churn.** Anthropic's docs render unresolved template
  placeholders (`<NextOpus />` → Claude Opus 4.8, "Claude Mythos Preview") and the
  per-model tool-use overhead and cache-minimum tables update per release. Treat
  any single numeric row as a snapshot; prefer `count_tokens` for the model you
  actually call over hard-coded constants.
- **OpenRouter `tool_choice` passthrough.** `required` and `{type:"allowed_tools"}`
  are not documented on the tool-calling guide; they may pass through to
  OpenAI-family models but should be tested before being relied on.
- **OpenAI structured-output limit semantics.** The raised limits are confirmed
  OpenAI-direct, but Azure/Foundry docs (2026-05-13) still list the old
  100-property/5-level ceiling, and a community thread suggests "level"/"property"
  counting is under-specified — validate complex schemas empirically.
- **Gemini exact discount and explicit-cache floors.** The caching doc says only
  "lower cost" and defers exact rates to the pricing page; widely-cited 90%/75%
  figures and the explicit-cache minimum (2,048 vs 4,096 vs a 1,024/4,096 split)
  come from secondary sources — confirm per model.
- **Per-million-token prices** throughout are indicative (secondary aggregators);
  the only verified price *mechanic* is that reasoning is billed at the output
  rate.
- **OpenRouter "silently drops reasoning" behavior** is directionally consistent
  with the docs (reasoning returned "unless excluded," provider-dependent) but the
  specific wording traces to third-party testing — verify per model before
  building UI against a `reasoning`/`reasoning_details` field.
