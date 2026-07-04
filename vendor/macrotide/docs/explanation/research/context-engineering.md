# Context engineering for tool-using agents — a prior-art survey

*Researched May 2026*

## Summary

How production and open-source systems make a **tool-using LLM agent reliable** —
the discipline of designing everything that enters the model's context window
(system prompt, tool definitions, tool results, history, retrieved data) and of
making the agentic tool-use loop robust against its characteristic failures: a
model that reads a tool result and then stalls without answering, a model that
loops tools forever, malformed tool calls, and provider errors. The recurring
lessons: keep the tool surface small and unambiguous; shape tool results to the
*smallest set of high-signal tokens*; control the loop explicitly (step limits,
`toolChoice`, forced-answer follow-ups, repair, fallbacks) rather than trusting
the model to terminate cleanly; and treat the system prompt as a steering
instrument for tool-first behavior.

This survey is oriented toward Macrotide's specific problem: a **small / cheap
model** (the public-tier OpenRouter chain) acting as **Advisor** over a tool
surface that reads the user's portfolio, plan, and journal and can save notes.
Small models fail the loop more often than frontier models, so the engineering
here matters more, not less.

## Decision

Macrotide's Advisor runs on the Vercel AI SDK (`ai` v6) `streamText` loop with a
frozen memory snapshot in the system prompt and a deliberately small tool
surface. The *implementation* of that loop — model resolution by tier, memory
injection, the tool set, and the DB-context re-entry on `onFinish` — lives in
[architecture.md § The chat path](../architecture.md#the-chat-path) and the
[memory feature guide](../memory.md). This document is the evidence behind the
shape of that loop, not the verdict.

## What context engineering is (vs. prompt engineering)

Anthropic frames context engineering as **the natural progression of prompt
engineering**. Where prompt engineering is about "finding the right words and
phrases for your prompts," context engineering is the broader question of *"what
configuration of context is most likely to generate our model's desired
behavior?"* — curating and maintaining "the optimal set of tokens (information)
during LLM inference," spanning system instructions, tools, examples, message
history, and retrieved data, not just the prompt
([Anthropic, *Effective context engineering for AI agents*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

The single load-bearing principle is the **finite attention budget**: *"LLMs,
like humans, lose focus or experience confusion at a certain point."* As the
token count rises, **context rot** sets in — *"the model's ability to accurately
recall information from that context decreases."* The engineer's job is therefore
to find *"the smallest possible set of high-signal tokens that maximize the
likelihood of some desired outcome"* (ibid.). Everything downstream in this
document is a tactic in service of that one constraint.

For a small model the budget is smaller and the rot is faster, so the same
discipline that is a nicety on a frontier model is a correctness requirement on
the public tier.

Sources:
[Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## The agentic tool-use loop and where it fails

### The loop

Anthropic's *Building effective agents* reduces the pattern to one sentence:
*"Agents are typically just LLMs using tools based on environmental feedback in a
loop"* — the model picks a tool, the environment returns ground truth (a tool
result, a code-execution output), and the model reassesses
([Anthropic, *Building effective agents*](https://www.anthropic.com/research/building-effective-agents)).
The same post draws the boundary worth keeping in mind: **workflows** are
"systems where LLMs and tools are orchestrated through predefined code paths,"
while **agents** are "systems where LLMs dynamically direct their own processes
and tool usage." Macrotide's Advisor is the agent end of that spectrum within a
single turn — it chooses whether and which tools to call — but the *app* keeps
the surrounding control flow (loop bounds, retries, persistence) as a workflow.

At the API level the loop is a `while` keyed on the stop reason: the model
returns `stop_reason: "tool_use"` with one or more `tool_use` blocks, the
application executes them and returns `tool_result` blocks, and the model
continues until it stops asking for tools
([Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview)).
The Vercel AI SDK wraps this for the app: with `stopWhen` set, *"when the model
generates a tool call, the AI SDK will trigger a new generation passing in the
tool result until there are no further tool calls or the stopping condition is
met"*
([AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).

### Where it fails

Four characteristic failure modes, each with a production countermeasure:

1. **Reads a tool, then stalls** — the model emits a tool call, gets the result,
   and *ends the turn without producing an answer for the user*. This is more
   common on smaller models. The fix is a **forced-answer follow-up**: after the
   loop terminates with a tool result but no assistant text, re-invoke the model
   with tools disabled so its only legal move is to write prose. In the AI SDK
   that is `toolChoice: 'none'` (the AI SDK lists `"none"` — "tools disabled" —
   alongside `"auto"`, `"required"`, and a specific-tool form) on a follow-up
   generation, or a `prepareStep` that flips `toolChoice` to `'none'` once the
   needed tool has run
   ([AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control),
   [AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
   The Anthropic equivalent is steering with the system prompt (see below) plus
   `tool_choice` to constrain the follow-up.

2. **Loops tools forever** — the model keeps calling tools and never converges.
   The countermeasure is a **hard step limit**, and the verified, cross-vendor
   fact is that the cap lives in the harness, not the model API: the AI SDK
   defaults `stopWhen` to `stepCountIs(20)` *"as a safety mechanism against
   runaway loops"*
   ([AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control)). The
   specific community numbers (2–3 for simple Q&A, 15–20 for a read-edit-test
   coding agent — [Inngest](https://www.inngest.com/docs/ai-patterns/agent-tool-loops))
   are secondary and a tuning choice, not an authority. For a chat advisor a low
   cap is right — most turns are one tool read then an answer; **Macrotide uses
   `stepCountIs(5)`**.

3. **Malformed / invalid tool calls** — *"Language models sometimes fail to
   generate valid tool calls, especially when the input schema is complex or the
   model is smaller"*
   ([AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
   The AI SDK distinguishes `NoSuchToolError` (undefined tool) and
   `InvalidToolInputError` (inputs fail schema validation)
   ([AI SDK errors — NoSuchToolError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-such-tool-error),
   [InvalidToolInputError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-invalid-tool-input-error)).
   Two recovery layers: in a multi-step loop the failed call is *"sent back to
   the LLM in the next step to give it an opportunity to fix it"*; or you supply
   `experimental_repairToolCall` to fix it out-of-band (re-ask a stronger model,
   re-validate against the schema) without polluting the message history with the
   failed attempt
   ([AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
   Anthropic's `strict: true` tool option is the upstream prevention — it
   "ensure[s] Claude's tool calls always match your schema exactly"
   ([Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview)).

4. **A tool throws / the provider errors** — the consensus is *do not throw out
   of the loop*. As one walkthrough puts it, throwing on a failed tool execution
   "prevents Claude from learning what went wrong and recovering"
   ([Inngest — Agent tool loops](https://www.inngest.com/docs/ai-patterns/agent-tool-loops)).
   The AI SDK surfaces execution errors as **`tool-error` content parts** rather
   than throwing, explicitly so they can feed *"automated LLM roundtrips in
   multi-step scenarios"* — the model sees the error text and can retry or route
   around it
   ([AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
   (LangGraph's `ToolNode.handle_tool_errors` is described as doing the same, and
   chaining models with `.with_fallbacks()` — illustrative only; not re-verified
   against LangGraph's primary docs and not in Macrotide's stack.) For *provider*
   failure (a 429, a dead endpoint), the verified pattern is a **fallback model**:
   the AI SDK's `prepareStep` can "switch models dynamically based on execution
   history"
   ([AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control)).
   Macrotide already has a provider *chain* for market data and a tiered model
   resolver; the same fallback instinct applies to the chat model.

Sources:
[Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents),
[Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview),
[AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control),
[AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[Inngest — Agent tool loops](https://www.inngest.com/docs/ai-patterns/agent-tool-loops),
[LangGraph error handling](https://machinelearningplus.com/gen-ai/langgraph-error-handling-retries-fallback-strategies/).

## Tool design for reliability

### Keep the surface small and unambiguous

Anthropic's single most-quoted tool-design rule is about **ambiguity, not
count**: *"If a human engineer can't definitively say which tool should be used
in a given situation, an AI agent can't be expected to do better."* The named
failure mode is "bloated tool sets that cover too much functionality or lead to
ambiguous decision points"
([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
Tools should be *self-contained, robust to error, and clear about their intended
use*. For a small model this is decisive: overlapping tools (`get_portfolio`
vs. `get_holdings` vs. `get_positions`) multiply the wrong-tool error rate.

### Treat the tool interface like a UI — the ACI

*Building effective agents* coins the **agent-computer interface (ACI)** and
argues you should "put as much effort into [it] as into the human-computer
interfaces (HCI)." Concrete guidance:

- **Give the model room to think.** "Give the model enough tokens to 'think'
  before it writes itself into a corner."
- **Use familiar formats.** "Keep the format close to what the model has seen
  naturally occurring in text on the internet" and remove formatting "overhead."
- **Document like a junior dev.** Tool descriptions should include "example
  usage, edge cases, input format requirements, and clear boundaries from other
  tools."
- **Poka-yoke the arguments.** Make mistakes impossible by construction — the
  cited example changed a tool to "always require absolute filepaths" after the
  model kept getting relative ones wrong.
- **Test against real inputs.** "Run many example inputs… to see what mistakes
  the model makes, and iterate"
  ([Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents)).

Anthropic's later *advanced tool use* work adds that **tool-use examples** (a few
realistic invocations, not just a JSON schema) lifted accuracy on complex
parameter handling "from 72% to 90%" — schemas describe structure, examples
describe behavior
([Anthropic — Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).

### Shape tool results — the part that matters most for small models

Results are context, so they obey the high-signal-tokens rule. The guidance is
to return *"information that is token efficient"* and to encourage *"efficient
agent behaviors"*
([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
The strongest demonstration is **Programmatic Tool Calling**: instead of letting
2,000+ expense line items enter context, the model writes code that filters them
and *"Claude's context receives only the final result: the two to three people
who exceeded their budget."* The reported effect was a **37% token reduction**
(43,588 → 27,297 tokens) on complex research tasks *and* an accuracy bump —
less noise, better answers
([Anthropic — Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).

For an app without code-execution, the same principle is applied **server-side
before the result is handed back**: don't dump a raw 50-field holdings JSON blob
into the result, return a compact, labeled, model-legible summary (the few fields
the answer needs). The AI SDK gives a hook for this — a tool's optional
`toModelOutput` function "convert[s] tool outputs into content parts for model
consumption," letting the model-facing view diverge from the rich object the app
keeps
([AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)).
Small models are disproportionately hurt by a big JSON dump: it eats their
limited budget, accelerates context rot, and buries the relevant number — so
result shaping is the single highest-leverage reliability lever for the public
tier.

For very large tool *surfaces*, Anthropic's **tool-search** approach loads tool
definitions on demand and reports an "85%" reduction in tool-definition token
overhead — relevant only if the surface grows large, which Macrotide's
deliberately doesn't
([Anthropic — Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).

### Error semantics

Tool results should carry **legible errors**, not exceptions — a tool that hits a
rate limit should return `{ error: "rate_limited, retry later" }` as its result
so the model can react, rather than throwing and breaking the loop (see failure
mode 4 above). This is the AI SDK's `tool-error` content-part model and
LangGraph's `handle_tool_errors`, restated as a tool-authoring rule.

Sources:
[Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents),
[Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Anthropic — Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
[AI SDK — Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).

## System prompt design for grounded, tool-first behavior

### The "right altitude"

Anthropic's framing for system prompts is **altitude**: too low and you "hardcode
brittle logic"; too high and you "fail to guide behavior." Aim for prompts
"specific enough to guide behavior effectively, yet flexible enough to provide
the model with strong heuristics." Start from "the minimal set of information that
fully outlines your expected behavior" — *minimal, but not necessarily short* —
and organize it into distinct sections
([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### Steering tool-first behavior (the read-before-answering nudge)

Anthropic documents that the read-before-answering behavior is **steerable
through the system prompt**, and gives the actual gradient of phrasings:

> If Claude isn't calling tools when you expect, a light instruction like *"Use
> the tools to investigate before responding."* measurably increases tool use; a
> stronger form like *"Always call a tool first before responding."* pushes
> further. Conversely, *"Use your judgment about whether to call a tool or respond
> directly."* keeps triggering behavior conservative
> ([Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview)).

For a grounded finance advisor — which should read the user's actual portfolio
before opining — the stronger end of that gradient (paired with the
forced-answer follow-up so it doesn't stall) is the right default. For a *hard*
guarantee rather than a nudge, `tool_choice` / `toolChoice: 'required'` forces a
tool call
([Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview),
[AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control)).

### Honesty constraints and missing-parameter behavior

Anthropic notes a model-capability gradient worth designing around: with a
required parameter missing, **Opus** is "much more likely to recognize that a
parameter is missing and ask for it," whereas **Sonnet** (and, by extension,
smaller models) "may also do its best to infer a reasonable value" — sometimes
guessing `"New York, NY"` for an unspecified location
([Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview)).
For a small-model advisor this is a correctness hazard: the system prompt should
explicitly instruct it to **ask rather than invent** when a required input (a
fund code, a date, an amount) is missing, and never to fabricate numbers a tool
didn't return. This dovetails with Macrotide's product rule that *"Advisor is AI
and can make mistakes"* and the no-real-data discipline.

### Persona

The persona is part of the system prompt's context budget. Macrotide's is fixed:
the assistant is always **Advisor** — never "agent", "bot", "assistant", or "AI"
in any user-facing string, including the system prompt itself
([design-principles.md § The AI is "Advisor"](../design-principles.md),
[AGENTS.md § Product copy](../../AGENTS.md#product-copy--vocabulary)). Persona
text should stay lean — it competes with tools and data for the same finite
budget.

Sources:
[Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Anthropic — Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview),
[AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control).

## Context-window management

### Relevance and recency over volume

The whole field's answer to "what goes in the window?" is the high-signal-tokens
rule restated per component. Anthropic's just-in-time strategy: rather than
"pre-loading all data," let the agent "dynamically retrieve data at runtime via
tools," holding only "lightweight identifiers (file paths, stored queries, web
links, etc.)" and doing progressive disclosure
([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
For Macrotide that means: don't stuff the entire portfolio + all market data +
full chat history into every turn — give Advisor *tools* to fetch the slice it
needs.

### Summarization / compaction

For long conversations the standard move is **compaction**: "summarize and
reinitialize" the window, "preserving critical decisions while discarding
redundant tool outputs"
([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
The AI SDK's `prepareStep` supports the mechanical side — it can "manage
conversation context by filtering older messages" before each step
([AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control)).
Macrotide already adopts a summarize-and-replace compaction for chat sessions,
modeled on the `<summary>`-block pattern, run by a cheap model over the same key
— see the [memory feature guide](../memory.md) and the
[memory-systems survey](./memory-systems.md), which is the companion to this
document on the *memory* axis.

### The cost of stuffing

The reason to bother: **context rot** (recall degrades as tokens grow) plus the
literal token bill. On a metered public tier the second cost is concrete — every
redundant tool-result field and every un-compacted old turn is paid for on every
subsequent turn of the conversation. Macrotide's frozen-snapshot memory injection
(built once per session, held identical across turns) is partly a **prefix-cache
discipline**: a stable prompt prefix is cacheable, so re-stuffing the window each
turn is both a quality and a cost regression. (See the memory survey for the
frozen-snapshot rationale.)

Sources:
[Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[AI SDK — Loop control](https://ai-sdk.dev/docs/agents/loop-control).

## Passing entry-point context (what the assistant knows about the user's screen)

A recurring practical problem: when a user opens the chat from a specific screen
(say, viewing one holding), how does the app hand the assistant **structured
situational context** — "the user is looking at fund X, here is their current
allocation" — without either dumping everything or making the model fish for it?

The surveyed material gives two complementary patterns:

1. **Inject a small, structured context block** — the entry-point analog of
   memory injection. Keep it to the high-signal subset (which screen, which
   entity, the few numbers relevant to it), not the whole dataset. This is the
   "smallest set of high-signal tokens" rule applied to situational context, and
   it pairs with the just-in-time principle: inject the *pointer* and the
   headline facts, give tools for the depth
   ([Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

2. **Out-of-band, cache-safe injection.** Dynamic, per-turn context belongs in a
   **message**, not baked into the system prompt. Attaching it as its own block —
   for example a `<system-reminder>`-style note carried in the messages array —
   keeps the cached system-prompt prefix stable across turns while still
   delivering fresh situational context. The transferable rule: freeze the system
   prompt so it stays cacheable, and carry anything that changes per turn in the
   message stream rather than re-templating the prefix.

For Macrotide, the clean shape is: the screen hands the chat route a small typed
context object (current screen + focused entity + a few headline figures), the
route renders it as a compact labeled block in the request, and Advisor uses its
existing portfolio/plan/journal tools to go deeper on demand. This keeps the
frozen system prompt cacheable while still answering "what does the assistant
know about what I'm looking at?"

Sources:
[Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## Two named inspirations

### Hermes (Nous Research) — first-party, two distinct artifacts

"Hermes Agent" points at two genuinely first-party Nous Research artifacts, both
worth mining:

**(a) The `hermes-agent` harness** ([github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)).
The README bills it as a *"self-improving AI agent"* with *"a built-in learning
loop — it creates skills from experience, improves them during use,"* a surface
of *40+ tools*, MCP integration, and six terminal backends. The concrete
model→tool→result→answer iteration, the tool-call JSON schema, the system-prompt
structure, and explicit step limits are **not spelled out in the README** (they
live in the full docs at `hermes-agent.nousresearch.com/docs/` and the source).
What *is* documented, and directly relevant to loop robustness, is its
**human-in-the-loop recovery surface**: an *"interrupt-and-redirect"* affordance
(`/stop` or a new message halts a running loop), `/retry` and `/undo` to reverse
a turn, and `/compress` to manage token usage / context. The transferable lesson
for Advisor: the recovery story isn't only automatic (step caps, repair) — giving
the *user* a cheap interrupt/retry/redo is a first-class reliability lever for a
chat agent. (Memory specifics of this harness are surveyed separately in
[memory-systems.md § Hermes Agent](./memory-systems.md#hermes-agent-nous-research).)

**(b) The `Hermes-Function-Calling` format/datamix** (the function-calling format
and training datamix behind Hermes 2 Pro / Hermes 3). What's genuinely
documented:

The format is **XML-tag-delimited inside a ChatML transcript**. The system prompt
declares the agent as "a function calling AI model" and provides function
signatures inside `<tools></tools>`. The model emits a call as:

```text
<tool_call>
{"name": <function-name>, "arguments": <args-dict>}
</tool_call>
```

and the application returns the result inside a `tool` message as:

```text
<tool_response>
{"name": <function-name>, "content": {...}}
</tool_response>
```

Tools are described with a standard JSON-schema-ish object
(`{"type": "function", "function": {"name", "description", "parameters": {...}}}`),
and a separate **JSON-mode** path constrains output to a supplied schema (*"You
are a helpful assistant that answers in JSON. Here's the json schema you must
adhere to…"*). The loop itself lives in `functioncall.py`, which "handles the
recursive loop for generating function calls and executing them"
([NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling),
[hermes-function-calling-v1 dataset](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1)).

The transferable lessons for a small-model advisor: (a) the function-calling
contract is *just a documented text format* the model was trained to emit and the
app must parse — robustness comes from strict parsing + a recursive execute loop,
exactly the failure-mode-3 territory above; and (b) a separate, schema-pinned
JSON mode is the structured-output discipline.

### Claude Code

Anthropic's engineering writing uses Claude Code as a worked example, and two of
its patterns carry over directly: the orchestrator–workers / sub-agent
decomposition in *Building effective agents*, and the compaction and structured
note-taking techniques in *Effective context engineering*. The underlying shape —
a streaming tool loop with retries and token accounting, a small set of
self-contained tools, and a permission model around tool execution — matches the
failure-mode toolkit above.

Sources:
[NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent),
[NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling),
[hermes-function-calling-v1 dataset](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1),
[Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents).

## At a glance: the reliability toolkit

The levers, mapped to the failure they address and the Macrotide-relevant
mechanism:

| Failure mode | Lever | Mechanism (AI SDK v6 / Anthropic) |
|---|---|---|
| Reads tool, then stalls | Forced-answer follow-up | `toolChoice: 'none'` on a follow-up step; `prepareStep` flip; system-prompt steering |
| Loops tools forever | Hard step limit | `stopWhen: stepCountIs(n)` (default 20); cap to task |
| Invalid tool call | Repair / re-ask | next-step feedback; `experimental_repairToolCall`; Anthropic `strict: true` |
| Tool throws / provider errors | Don't break the loop; fall back | `tool-error` content parts; fallback model via `prepareStep` / `.with_fallbacks()` |
| Wrong tool chosen | Small, unambiguous surface | few self-contained tools; clear boundaries; ACI docs + examples |
| Big JSON dump in context | Result shaping | `toModelOutput`; return high-signal subset; programmatic filtering |
| Window bloat / context rot | Just-in-time + compaction | tools for depth; summarize-and-replace; `prepareStep` message filtering |
| Stale/over-stuffed prefix | Frozen, cacheable prefix | inject once per session; dynamic context in a message, not the system prompt |

## About this research

This survey was gathered in May 2026 via web search and direct fetches of primary
sources, oriented toward Macrotide's public-tier, small-model Advisor.

- The **Anthropic** material is from the company's own published engineering
  posts and docs, fetched directly:
  [*Effective context engineering for AI agents*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  [*Building effective agents*](https://www.anthropic.com/research/building-effective-agents),
  [*Advanced tool use*](https://www.anthropic.com/engineering/advanced-tool-use),
  and the [Tool use overview](https://platform.claude.com/docs/en/build-with-claude/tool-use/overview).
  Quoted phrasings are verbatim from those pages.
- The **Vercel AI SDK** material (`stopWhen`/`stepCountIs`, `toolChoice`,
  `prepareStep`, `tool-error` parts, `experimental_repairToolCall`,
  `toModelOutput`, the error types) is from
  [the loop-control](https://ai-sdk.dev/docs/agents/loop-control) and
  [tool-calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) docs
  plus the [error reference](https://ai-sdk.dev/docs/reference/ai-sdk-errors).
  The repo pins `ai` `^6.0.191`; API names are quoted as the v6 docs present
  them, but exact signatures should be checked against the installed version
  before use in code.
- **Hermes** material is first-party Nous Research: the
  [hermes-agent](https://github.com/nousresearch/hermes-agent) harness README
  (the learning loop, the `/stop` `/retry` `/undo` `/compress` recovery surface —
  the README is sparse on the exact loop/schema/prompt internals, which is noted
  in-line), and the function-calling specifics (the `<tools>` / `<tool_call>` /
  `<tool_response>` tags, the recursive `functioncall.py` loop, JSON mode) from
  the [Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling)
  README and the HF dataset card, read via fetch.
- **Claude Code** material comes from Anthropic's published engineering posts,
  which use it as a worked example.

**Flagged as unverified / secondary:**

- The Hermes loop internals (exact tool-call schema, system-prompt structure,
  step limits) are **not in the `hermes-agent` README** — only the higher-level
  description and the user-facing recovery commands (`/stop` `/retry` `/undo`
  `/compress`) are confirmed there. The harness's documented internals are a
  **"system_and_3" four-breakpoint cache scheme** (stable system prompt + 3
  most-recent messages) with a **5-minute default TTL** (1h opt-in), and
  compression firing at a 50% threshold (85% safety net) with a summary budget of
  `content_tokens × 0.20` (max 12,000). Note: `stepCountIs(20)` and
  `experimental_repairToolCall` are **Vercel AI SDK** primitives, not Hermes
  features — don't conflate them.
- Anthropic's reported metrics (the 37% token reduction; the 72%→90% and
  25.6%→28.5% accuracy figures; the "85%" tool-search overhead reduction) are
  Anthropic's own published numbers for *their* models on *their* benchmarks;
  they are not independently reproduced and may not transfer to a public-tier
  OpenRouter model. A separately-verified Anthropic example shows the
  **direction** holds: a concise vs. detailed tool-result `ResponseFormat` cut a
  Slack tool's output from ~206 to ~72 tokens (~66%)
  ([Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).
  Treat the magnitudes as directional and the **pattern** (shape results; small
  unambiguous tool surface; defer only past ~20 tools) as the load-bearing,
  cross-vendor-confirmed claim.
- The exact iteration-cap *numbers* (2–3 for Q&A, 15–20 for coding) and the
  "don't throw out of the loop" framing are community/secondary
  ([Inngest](https://www.inngest.com/docs/ai-patterns/agent-tool-loops)), not
  vendor docs. **What is primary-verified:** no provider auto-stops the agentic
  loop — you own the cap in the harness; the AI SDK default is `stepCountIs(20)`
  (Macrotide uses `stepCountIs(5)`); and returning execution errors as legible
  tool results (`is_error`/`tool-error`) rather than throwing is the documented
  Anthropic + MCP + AI SDK convention. The numeric caps are directional; the
  "own-the-cap, feed-errors-back" pattern is authoritative.
- LangGraph specifics (`recursion_limit` default 25, `handle_tool_errors`,
  `.with_fallbacks()`) are from a single secondary tutorial
  ([machinelearningplus](https://machinelearningplus.com/gen-ai/langgraph-error-handling-retries-fallback-strategies/)),
  **were not re-confirmed against LangGraph's primary docs** in the verification
  pass, and are not part of Macrotide's stack (Vercel AI SDK). Treat as
  illustrative only. The portable, verified equivalents are the AI SDK's
  `stopWhen`/`stepCountIs`, `tool-error` content parts, and `prepareStep`
  model-switching.
