# In-chat vision

The Advisor can read images a user attaches in chat. Two jobs, one capability:

1. **Holdings from screenshots.** A user drops a portfolio summary, a transaction
   history, and/or per-holding detail screens; the Advisor reads and reconciles
   them into one set of positions, derives missing units / average cost where the
   data supports it, and asks for anything it can't read.
2. **Visual Q&A.** A user attaches a chart, graph, or factsheet and asks about it;
   the Advisor answers in prose with nothing to extract.

This is distinct from the **Add-holdings image importer** (the *Image* tab of the
Add-holdings sheet), which sends one screenshot to a pinned, tier-agnostic
extractor. In-chat vision keeps the *chat model in the loop* so it can reason
across several images and hold a conversation about the gaps — which a
single-shot extractor can't.

## Vision is a TOOL, not a whole-turn model swap

The chat driver (the text model, e.g. grok) stays on **every** turn, including an
image turn — but it cannot see pixels. The only way it reads an attachment is by
calling the `examine_image` tool ([lib/advisor/vision-tool.ts](../../lib/advisor/vision-tool.ts)),
whose executor runs a vision model on the image bytes and returns text. The
driver asks a focused question, reasons over the answer, and replies.

Why a tool and not the old whole-turn swap (where an image turn ran entirely on
the vision model):

- **Prompt cache stays warm.** No foreign-model turn ever lands in the driver's
  history, so its cached prefix is never invalidated. The swap re-rolled it once
  per image turn. Validated empirically (cached-token counts rise across the
  follow-up); see [inference-strategy.md](./inference-strategy.md).
- **The driver keeps reasoning** on the image turn instead of ceding it to the
  vision model.
- **Numbers stay on a vision model, reasoning on the driver** — the tool quotes
  exact tickers/figures; the driver never guesses digits from pixels (VLMs are
  weak exactly there). Mirrors the structured-extraction posture of the importer.

## How an image turn flows

The image rides the message, not a side channel. The route captures the bytes for
the tool and strips them from the driver's view:

```
composer (downscaled image → UIMessage file part, data URL)
  → POST /api/chat
  → extractTurnImages   (decode the data URL → bytes, captured in the tool closure)
  → stripDriverImages   (remove the file parts → the driver sees text + a note only)
  → driver (chat model) calls examine_image(question)
      → @ai-sdk/openai-compatible → OpenRouter → vision model → text
  → driver answers (or calls propose_holdings_import / propose_transactions_import)
```

The client sends the **whole conversation as UIMessage `parts`** only when the
current turn has images; text-only turns keep the compact `{role, content}` string
shape byte-for-byte, so the prefix cache stays warm. The route detects an image
turn on the raw body (`countTurnImages`, [lib/advisor/image-turn.ts](../../lib/advisor/image-turn.ts))
before model-message conversion. The model-facing note (filename + EXIF/saved
capture time + a directive that the only way to read an attachment is the tool) is
folded in per-turn — never into the cached system prompt.

The image bytes live only in the request and the tool closure — **no
server-side persistence**, so the tool can re-read the current turn's image but
not a *prior* turn's (the bytes are gone). See cross-turn context below.

## Model routing — a dedicated vision model, with optional escalation

The tool runs its own `VISION_CHAT_MODELS` (default
`google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` — the family the OCR
importer also proves out, primary + an EOL-proof fallback) via
`resolveVisionProvider` ([lib/ai/provider.ts](../../lib/ai/provider.ts)). This is
the same shape as the `PUBLIC_TIER_MODELS` invariant, and for the same reason:
**public-tier vision derives from its own var, never from `TRUSTED_TIER_MODELS`** —
so enabling vision can't widen the text model chains.

A chart/factsheet the user is reasoning *about* can escalate to a stronger
`VISION_CHAT_ESCALATE_MODELS` chain (`resolveVisionEscalateProvider`), chosen
*inside* the tool. Escalation is **owner/trusted only** (public/demo never
escalate — cost invariant) and **unset by default** — the cheap chain serves
charts too until the chart-Q&A eval proves a pro tier earns its cost.

The per-turn decision (`visionDecisionFor`) governs whether the tool is offered:

| Path | Image turn |
| --- | --- |
| owner / trusted | driver + `examine_image` (escalation available; trusted keeps the intent-gated reasoning effort) |
| public | driver + `examine_image` on the cheap chain, **bounded by the daily token + optional cents caps** (no escalation); the vision sub-model's tokens are metered into the turn |
| demo | **stub unless `DEMO_VISION` is set**; when on, the tool uses the demo key, bounded by the 10-turn cap |
| any, `VISION_CHAT_MODELS=off` | stub pointing at the Add-holdings importer |

The chat route is the source of truth (it stubs unavailable image turns);
`GET /api/chat/capabilities` exposes the same decision so the composer can hide
the attach button when image upload isn't available for the session.

## Output: table for many, card for one

When the Advisor extracts **two or more** holdings it calls
`propose_holdings_import` ([lib/advisor/tools.ts](../../lib/advisor/tools.ts)) with
the rows it read via `examine_image`, which derives rows via the shared
`deriveRowsWithNav` ([lib/portfolio/derive-rows.ts](../../lib/portfolio/derive-rows.ts),
also used by the import route) and emits a compact in-chat table. "Review &
import" opens the full importer pre-seeded (through
[lib/stores/import-seed.ts](../../lib/stores/import-seed.ts)) for bulk edit and
save. A **single** position uses the existing one-tap `propose_holding` card. Both
only propose — nothing is written until the user accepts.

## Persistence: ephemeral on the server, browser-only for the session

Attached images are **never stored server-side.** The user message persists as
its text plus a `[N image(s) attached]` marker (`withImageMarker`). The durable
artifacts of an image turn are the *accepted holdings* and the *Advisor's reply* —
not the raw screenshots, which are sensitive broker data.

For continuity within a session, the client caches downscaled copies in
localStorage ([lib/stores/chat-images.ts](../../lib/stores/chat-images.ts)),
keyed by `threadId:seq` (the user message's index in the thread — deterministic on
both the send and reload paths, so they re-attach without a server image id),
size-bounded with oldest-first eviction. A muted disclaimer states images stay in
the browser and are sent to the Advisor to answer, not stored on the server. See
[SECURITY.md](../../SECURITY.md).

## Cross-turn context: carry the reading as text, not the bytes

An image's pixels are only readable on the turn it's attached (bytes aren't
persisted server-side, and a later turn sends only text). To answer follow-ups
about it — "what was my *other* fund's value?" three turns later — the Advisor
carries the image's **reading**, not the image:

- `examine_image`'s guardrail makes the vision model return a **complete reading**
  of the image (every fund/ticker, number, date), not just the narrow answer — so
  the observation is a reusable transcript. **No separate transcription pass**:
  it's the same call the Advisor already makes to read the image, so there's no
  double-spend (the reason the old eager `/transcribe`-on-attach was removed).
- The client captures that observation from the streamed tool result, stores it on
  the turn's image(s) in localStorage, and on later turns folds it back into that
  turn's text (`imageText` → an `[Earlier image, as the Advisor read it:]` block).
  Follow-ups read it as cheap, cache-stable text; the vision call happened once.
- The system prompt tells the Advisor to read that block and keep going, and that
  it can't re-examine the pixels (they aren't resent) — so it only asks the user to
  re-share for a genuine **visual** detail the reading didn't capture (a chart's
  exact shape). That's the rare case; a number/ticker is already in the reading.

Re-uploading bytes every follow-up would gain little — the dominant cross-turn
question is a number the reading already holds. Grounded in
[context-engineering](./research/context-engineering.md) /
[inference-strategy](./inference-strategy.md) (high-signal tokens, run the flaky
path once, keep the prefix warm).

## Related

- [Advisor context model](./advisor-context.md) — what the Advisor knows per turn.
- [Inference strategy](./inference-strategy.md) — model routing, tiers, cost, the
  vision-as-a-tool verdict + provider-agnostic cache affinity.
- [auth-and-providers.md § In-chat vision](../reference/auth-and-providers.md) —
  the env vars and spend bounds.
