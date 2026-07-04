# Advisor context model

*Last updated: 2026-05-31*

> **Living doc.** It describes the Advisor's current per-turn context design: the
> three channels, the structured entry-context envelope the high-value entry
> points carry, the per-turn injection rule, and the empty-turn recovery. Trust
> the code over the doc and fix the doc when they disagree. The external
> best-practice survey behind these choices is
> [research/context-engineering.md](./research/context-engineering.md).

How does the Advisor know what you're looking at when you tap **Ask advisor**?
This page is the single answer to that question: one coherent notion of *what
the Advisor knows about your current screen and portfolio*, and the contract
each entry point honours when it hands off. It's the foundation the
context-aware chatbar suggestions build on, so the model is written to be
explicit and reusable rather than implicit in each button.

For the voice rules behind the persona, see
[design-principles.md § The AI is "Advisor"](./design-principles.md#the-ai-is-advisor).
For what the Advisor remembers *across* chats (durable preferences, notes), see
[memory.md](./memory.md) — this page is about the *current turn's* context, not
long-term memory.

## The three context channels

Everything the Advisor knows on a given turn arrives through exactly three
channels. Keeping them distinct is what stops "context" from becoming a vague
catch-all.

| Channel | What it carries | Where it lives | Lifetime |
|---|---|---|---|
| **Memory block** | Durable user facts — goals, risk tolerance, response preferences | Prepended to the system prompt (`composeSystemPrompt`, `app/api/chat/route.ts`) | Frozen for the session |
| **Tool reads** | The user's *real* live data — holdings, drift, fees, performance, plan, journal, fund catalog | Pulled on demand by the model via `lib/advisor/tools.ts` | Fetched per call |
| **Entry-point context** | *Why this chat started* — the screen, the intent, the subject in focus, the figures already on screen | A structured `EntryContext` envelope on the request, injected as a per-turn message (`lib/advisor/entry-context.ts`) | This turn only |

The first two are well-modelled. The memory block is bounded and visible
([memory.md](./memory.md)); the tool reads return deterministic structured data
(`read_portfolio` returns allocation, drift, blended TER, concentration, cash
drag, the lifetime ledger figures — money invested, realized gains, income,
money-weighted return — and a flag for self-priced custom holdings; pass a
`ticker` for one fund's own realized P/L and return. It is **per-portfolio
aware**: by default it adds a compact breakdown of each portfolio (bucket),
scored against that portfolio's own target model, and a `portfolio` name/id
scopes the whole readout to one; `read_performance` takes the same `portfolio`
to scope a period return — see `lib/advisor/tools.ts`).
**The third channel used to be the weak one**
— entry-point facts travelled as prose — which is what the
[context envelope](#the-context-envelope) below now fixes.

## How entry-point context flows today

Every "Ask advisor" surface in the UI funnels through a single seam: a
`window` `CustomEvent("ai-prompt", { detail })` (dispatched from the screens),
caught in `components/App.tsx`, which sets `pendingPrompt` and routes to the
chat. `ChatScreen` consumes it as a **`SeedPrompt`**:

```ts
// components/screens/ChatScreen.tsx
export type SeedPrompt = string | { display: string; send: string; context?: EntryContext };
```

A bare string is shown verbatim as the user's bubble and sent as-is. The
`{ display, send }` split lets a short visible bubble ride alongside a larger
hidden payload (the image-OCR handoff uses it to keep the raw transcription out
of the visible body). The optional `context` is the structured
[envelope](#the-context-envelope) an Ask-Advisor button attaches — never shown in
the bubble.

The seed is sent to `POST /api/chat` whose body is now `{ messages, threadId,
entryContext? }` (`ChatScreen.tsx`, the `askLive` fetch). A plain typed turn or a
string seed omits `entryContext`, so its body is byte-identical to before — the
structured side-channel is purely additive.

### What "thin" means

A thin entry point hands the Advisor a sentence that *names* a subject but
withholds the structured facts the screen already had in hand. The Advisor then
has to (1) parse the subject back out of the prose, (2) decide to call the right
tool to re-fetch what the screen already knew, and (3) write a final answer.
Each of those is a step that can fail — see the [turn-reliability](#turn-reliability-the-empty-turn)
section. Rich-but-prose entry points avoid step 2 for the headline figure but
still pay for steps 1 and 3.

## The per-entry-point contract

The contract is the same for every surface: **pass the structured subject and
the figures already on screen, not just a sentence that mentions them.** That
side-channel now exists — the [context envelope](#the-context-envelope) — so the
contract is concrete: an Ask-Advisor button attaches an `entryContext` object
(screen, intent, subject, the figures as `signals`) alongside the visible prose,
and the server hands those to the model as facts. The richer entries
(rebalance, fee-switch) carry their figures; the open-ended ones (custom-allocation
kickoff, journal chips) legitimately stay prose-only.

### Audit of current entry points

| Entry point | File | Trigger | Envelope it now passes | State |
|---|---|---|---|---|
| Suggested rebalance | `components/screens/PortfolioScreen.tsx` (rebalance card) | Tap **Plan the rebalance** | `intent: rebalance`, `subject: <target name>`, `signals: { trackingGapPp }` | **Rich** — the gap + target arrive as facts |
| Fee-creep finding | `components/screens/PortfolioScreen.tsx` (fee-creep card) | Tap **Ask advisor** on a fee finding | `intent: fee_switch`, `subject: <held ticker>`, `signals: { heldTer, alternative, altTer, assetClass }` | **Rich** — the whole fee comparison the screen showed |
| Fund-row shortcut | `components/FundSelect.tsx` (`handleAskAdvisor`) | Tap the chat icon on a fund row | `screen: funds`, `intent: fund_lookup`, `subject: <abbr>` | **Tagged** — the fund in focus; the catalog tools recover the rest |
| Model-portfolio explainer | `components/screens/ModelPortfoliosScreen.tsx` | "Ask the advisor about this" on a model | `screen: models`, `intent: strategy_explain`, `subject: <model name>` | **Tagged** |
| Portfolio headline ("Discuss") | `components/screens/PortfolioScreen.tsx`; mirrored in `components/AppPanels.tsx` | Tap **Discuss** on the "Top thing to know" card | `screen: portfolio`, `intent: score_review` / `health_review` | **Tagged** — screen + intent; the headline prose carries the figure |
| Journal suggested question | `components/screens/JournalScreen.tsx` | Tap a parsed question chip | none (bare string) | **Prose-only by design** — generic editorial question |
| Custom-allocation kickoff | `components/screens/ModelPortfoliosScreen.tsx` (`startChat`) | "Help me design an allocation" | none (bare string) | **Prose-only by design** — opens a Q&A; no subject to pass |
| Free-typed chat | `components/screens/ChatScreen.tsx` (chat input) | User types directly | none | N/A — the user *is* the context |
| OCR / image handoff | image-import flow → `SeedPrompt.send` | Hand off a transcribed statement | `{ display, send }` split (no `context` yet) | **Modelled** — the split payload; `EntryContext.image` is the reserved slot for wiring this through the envelope later |

The two high-value dashboard findings (rebalance, fee-switch) now hand over the
exact figures the screen computed, so the Advisor can reason about the action
without a `read_portfolio` / `find_cheaper_alternatives` round-trip. The catalog
entries pass the subject as a tag; the Advisor still recovers full fund data via
the catalog tools when it needs it (see note below). The open-ended entries
legitimately stay prose-only — exercising the additive, backward-compatible path.

> **Note — the catalog tools still back the tagged entries.** `find_funds`,
> `find_cheaper_alternatives`, and `getFundsByAbbr` (`lib/advisor/tools.ts`) let
> the Advisor recover a fund from the `subject` abbreviation. The envelope removes
> the gamble of parsing the subject back out of prose, but the tools remain the
> path to the *live* per-user-scoped data the envelope deliberately doesn't carry.

## The context envelope

A structured field on the chat request carries entry-point context so it stops
travelling as prose (`lib/advisor/entry-context.ts`):

```ts
export interface EntryContext {
  screen?: string;   // "portfolio" | "funds" | "models" | "journal" | …
  intent?: string;   // "rebalance" | "fee_switch" | "fund_lookup" | "strategy_explain" | …
  subject?: string;  // the thing in focus — a ticker, a target-model name, a fund abbr
  signals?: Record<string, string | number>; // the figures the screen already had
  image?: { ref: string; mime?: string };     // RESERVED for a future in-chat vision handoff
}
```

The shape is deliberately **flat and open** — a `signals` bag rather than a
discriminated `subject` union. Each Ask-Advisor button only has a handful of
facts to pass, and a flat record absorbs new ones (or a new `intent`) without a
schema change per finding-type. The `image` field is declared but not yet wired,
so the envelope is the single forward-compatible home for the vision handoff.

The seed `display` string stays for the visible bubble (the user sees a natural
sentence); the `EntryContext` rides alongside it on `SeedPrompt`, is sent to
`/api/chat` as a typed `entryContext` field, and the server renders it with
`entryContextMessage()`.

**Where it lands matters — and it is NOT the system prompt.** The memory block
is *prepended* to the system prompt precisely because it's frozen for the
session, which keeps the prompt prefix stable and prefix-cache-friendly (see
[memory.md § Why "frozen for the session"](./memory.md)).
Entry-point context is the opposite: it's different every turn. Folding a
per-turn value into the cached prefix would invalidate the cache on every turn.
So `injectEntryContext()` splices the rendered block in as a **`user` message
immediately before the latest user turn** — after the cached system+memory
prefix — so the model reads `context → question` while the cacheable prefix stays
byte-stable. The block is model-facing only; it is never persisted as a chat row.

Two properties keep it safe and reusable:

1. **It reduces tool hops, it doesn't replace tools.** With the fee comparison or
   the tracking gap already in hand, the model can answer without a
   `read_portfolio` / `find_cheaper_alternatives` round-trip — but the tools stay
   available for anything the envelope didn't carry. The block is additive
   context, not a contract.
2. **No personal data leaks into the seam.** The envelope carries on-screen
   handles and figures (a ticker, a TER, a gap) — never cost basis or account
   identifiers beyond what the screen already shows. The Advisor still reads
   *live* private data through the per-user-scoped tool layer, and the server
   defensively re-parses the client-supplied envelope (`parseEntryContext`),
   capping field count and length.

## Turn reliability: the empty turn

The context model and the "I didn't have a reply" dead-end are the same problem
from two directions — what reaches the model isn't enough to *finish* a turn — so
the diagnosis and the fix live here.

An **empty turn** is when the model runs a read tool (e.g. `read_portfolio`) and
then *stops without emitting a final prose step*. The client
(`components/screens/ChatScreen.tsx`) sees no accumulated text; before the fix it
surfaced as *"I didn't have a reply for that."*

### What actually causes it (investigated 2026-05)

The cause is **public-tier model/provider reliability**, confirmed by local
reproduction with per-turn logging. `logEmptyTurn` (`app/api/chat/route.ts`)
records, on any empty turn, the model OpenRouter actually routed to, the
`finishReason`, each step's reason, and which tools ran. It shows three flavours:

- **Read-then-stall** — the model calls a read tool and ends with no prose
  (`finishReason=stop`/`tool-calls`, empty text). The dominant flavour.
- **Tool looping** — the model keeps calling tools without answering.
- **Provider error** — the free router errors mid-generation (`finishReason=error`,
  or a hard error where the turn produces nothing).

Three tempting explanations were **tested and ruled out**:

- *Not a DB-context bug.* The advisor tools run with the correct request context
  (a demo turn's tools see the session's in-memory DB, `isDemo=true`) —
  AsyncLocalStorage propagates into tool execution; only `onFinish` runs outside
  it, which is why it re-enters via `runWithDbContext`. The tools return cleanly;
  they don't throw.
- *Not one weak model.* The dead-end hits several distinct `…:free` models and
  the `openrouter/free` router, so pinning a single "stronger" free model does
  **not** fix it.
- *Not the tool surface.* A faithful standalone harness — same model, system
  prompt, and full 14-tool surface — answers reliably when the tools' results
  come back cleanly. The trigger is real public-tier generation/routing flakiness,
  not tool count.

The trusted/owner chain (`openrouter/free → openrouter/auto`) barely sees this
because it has the paid `auto` fallback the public tier deliberately lacks.

### The fix: recover, don't depend on the model

Because no single free model is reliable, the fix is **model-agnostic
resilience** rather than model selection. `streamAdvisorResponse()`
(`app/api/chat/route.ts`) wraps every tier (demo/tiered/owner) with two safety
nets, composed into one response stream via `createUIMessageStream`:

1. **Recover-on-empty.** When a turn produces no prose but a tool ran, issue one
   follow-up generation seeded with the gathered tool results and **no tools** —
   so the model can only write the answer. This is the documented production fix
   for read-then-stall (see
   [research § the agentic tool-use loop](./research/context-engineering.md)); it
   works regardless of which free model stalled.
2. **Retry-on-error.** A provider error gathers nothing to recover from, so the
   turn is re-rolled once (the router picks a fresh model).

Local demo-path testing took the dead-end rate from roughly a fifth-to-half of
tool-using turns down to ~4%. The residual is a *double* provider failure (the
retry also failed), which only a more reliable model removes. The custom
`ChatScreen` reader concatenates all text-deltas into a single bubble and ignores
stream-envelope chunks, so the recovered/retried generation renders as one
coherent message.

### Complementary reliability levers

Beyond the recovery net, three levers reduce dead-ends further:

- **The context envelope already cuts tool hops** for the high-value flows
  (rebalance, fee-switch): the figures arrive as facts (see
  [the context envelope](#the-context-envelope)), so the model can skip a
  `read_portfolio` hop and has fewer chances to stall.
- **A cheaper, more reliable public-tier model** removes most dead-ends at the
  source. The public tier's model is operator-configurable and bounded by usage
  limits, so pointing it at a cheap paid model (Gemini-Flash class) is a config
  choice, not a code change; the recovery stays as belt-and-suspenders either way.
- **Tool-result shaping** — returning a compact, model-legible subset instead of
  the full rich object lifts small-model reliability further
  ([research § tool design for reliability](./research/context-engineering.md)).
  `read_portfolio` returns a large structured object, so a trimmed model-facing
  view is the natural refinement.

## Related

- [Memory](./memory.md) — what the Advisor knows *across* chats (the memory
  channel above).
- [Architecture § request lifecycle](./architecture.md) — how a chat request
  flows server-side, demo/owner DB routing, the `onFinish` re-entry pattern.
- [Design principles](./design-principles.md) — the "Advisor" voice and
  secure-by-default posture.
- `lib/advisor/tools.ts` — the tool-read channel (the second context channel).
