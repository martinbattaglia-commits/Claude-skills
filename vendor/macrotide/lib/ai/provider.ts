import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * AI provider routing. Three configurations, all via OpenRouter:
 *
 * - **owner**  — authenticated traffic. Default model chain
 *                `openrouter/free → openrouter/auto`: try free models first,
 *                fall back to paid `auto` router only if every free model is
 *                unavailable. Keeps cost near zero in the happy path while
 *                preserving reliability when free tier is saturated.
 * - **demo**   — anonymous demo sessions. Default `openrouter/free` with **no
 *                fallback** — cost predictability matters more than uptime for
 *                demo traffic. If free is unavailable, demo errors cleanly
 *                rather than silently billing.
 * - **title**  — auto-titling a chat after its first turn pair. Default
 *                `openrouter/free`. Explicitly *not* Claude / GPT — a 3–5-word
 *                title doesn't justify mainstream-model spend.
 *
 * - **extract** — archive-time fact extraction. Default
 *                `openrouter/free`; same cheap-model posture as titling.
 *
 * Configure via env (comma-separated, first is primary, rest are fallbacks):
 *   TRUSTED_TIER_MODELS=openrouter/free,openrouter/auto
 *   DEMO_TIER_MODELS=openrouter/free
 *   TITLE_MODELS=openrouter/free
 *   EXTRACT_MODELS=openrouter/free   # optional; falls back to TITLE_MODELS
 */

export interface ResolvedProvider {
  model: LanguageModel | null;
  /** True when AI is wired up; false means /api/chat should return a fallback. */
  ready: boolean;
  /** Display name for telemetry / UI banners. */
  label: string;
}

const TRUSTED_TIER_DEFAULT = ["openrouter/free", "openrouter/auto"];
const DEMO_TIER_DEFAULT = ["openrouter/free"];
// Auto-titling a chat is a 3–5-word task. We deliberately don't burn
// Claude/GPT capacity on it — `openrouter/free` is the meta-router that
// fans out across cheap free models (DeepSeek, Qwen, etc.). Override with
// the `TITLE_MODELS` env var; pinning anything in the Claude or GPT family
// would be an escalation per AGENTS.md § AI / model selection.
const TITLE_MODELS_DEFAULT = ["openrouter/free"];
// Archive-time fact extraction. Same posture as titling — a
// background summarize-and-extract pass over an idle chat is an ancillary task
// that doesn't justify Claude/GPT spend. Override with `EXTRACT_MODELS`; falls
// back to `TITLE_MODELS` then `openrouter/free` so an operator who already
// pinned a cheap title model gets the same model for extraction for free.
const EXTRACT_MODELS_DEFAULT = ["openrouter/free"];
// Memory consolidation sweep. UNLIKE extraction, this is offline + infrequent, so
// it can afford a true REASONING model — it judges which saved memories are
// duplicates and proposes merges, where chain-of-thought meaningfully improves
// precision. Two quality-verified free reasoners on DIFFERENT providers come first
// (so one provider's free-tier throttle can't take out both), then `openrouter/free`
// as a last-resort availability fallback. All probed on the real prompt 2026-06-24:
// gpt-oss-20b:free and cohere/north-mini-code:free emitted clean ops-JSON with correct
// merge/supersede every run; `openrouter/free` is a model-quality lottery that
// occasionally mis-merged a contradiction, so it sits LAST (a wrong merge is reversible
// and the proposer retries on bad JSON). Bigger free models (gpt-oss-120b, nemotron)
// are blocked by the account's strict data policy — which we KEEP, as it keeps personal
// memory data off training-logging providers. For guaranteed completion swap the trailing
// `openrouter/free` for a cheap paid model via `CONSOLIDATE_MODELS` (google/gemini-3.1-flash-lite
// — bounded reasoning, also verified; NOT a thinking-only model like qwen3-235b-thinking, whose
// reasoning eats the output budget and truncates the JSON). Keep the chain ≤ 3 (OpenRouter's
// models[] cap — see OPENROUTER_MAX_MODELS). The `:free` tiers churn — re-verify
// against /api/v1/models before changing.
const CONSOLIDATE_MODELS_DEFAULT = [
  "openai/gpt-oss-20b:free",
  "cohere/north-mini-code:free",
  "openrouter/free",
];

function parseModels(value: string | undefined): string[] | null {
  if (!value) return null;
  const list = value
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** OpenRouter `reasoning.effort` levels (highest → lowest cost/latency). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

const EFFORT_VALUES: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

/** Parse an operator-set reasoning-effort env var, falling back when unset or
 * invalid. Lets the reasoning policy track the chosen MODEL (e.g. pointing the
 * public tier at grok → set PUBLIC_REASONING_EFFORT=low). */
function parseEffort(raw: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  const v = raw?.trim().toLowerCase();
  return v && (EFFORT_VALUES as string[]).includes(v) ? (v as ReasoningEffort) : fallback;
}

interface OpenRouterOpts {
  /**
   * OpenRouter `reasoning.effort`. `"none"` disables a reasoning model's hidden
   * chain-of-thought — which is billed at the output rate and adds large latency.
   * Set it on cost-sensitive paths (free/demo/title/extract) so a reasoning model
   * the router lands on doesn't silently reason on a trivial turn (measured 8–29s
   * vs ~2s). Omit it to inherit each model's default. Owner/trusted now pass a
   * per-turn effort gated by analytical intent (see lib/advisor/intent.ts):
   * `"none"` on retrieve-then-explain turns, `"medium"` on multi-step asks.
   * Non-reasoning models ignore it.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * A stable per-conversation id (the chat thread id) used to pin provider
   * cache affinity, so a multi-turn chat keeps hitting the same backend and
   * reusing its prompt cache. The *signal* differs by model family — see
   * {@link cacheAffinity} — so this is provider-agnostic at the call site: pass
   * the thread id and the right header/body lands for whichever model the env
   * names. Omit for one-shot/stateless calls (titling, extraction, the vision
   * sub-model) where there's no conversation to keep warm.
   */
  conversationId?: string;
}

/**
 * Map a model id + conversation id to the provider-specific cache-affinity
 * signal, so swapping the chat model via env keeps prompt caching working
 * without touching call sites. Every family on OpenRouter uses sticky routing
 * and reports reads uniformly as `usage.cachedInputTokens`; only the *explicit*
 * affinity lever differs:
 *   - xAI/Grok  → `x-grok-conv-id` header (xAI's documented affinity signal;
 *                 without it OpenRouter may scatter requests across backends and
 *                 miss the cache).
 *   - Anthropic → `session_id` body field (OpenRouter's Anthropic sticky pin).
 *   - OpenAI / Google / DeepSeek / openrouter meta-routers → nothing to inject;
 *     sticky routing + a stable prompt prefix (our frozen system prompt + memory
 *     block) is automatic.
 * Adding explicit caching for a new family later is a one-line entry here.
 */
function cacheAffinity(
  modelId: string,
  conversationId: string,
): { headers?: Record<string, string>; body?: Record<string, unknown> } {
  if (modelId.startsWith("x-ai/")) return { headers: { "x-grok-conv-id": conversationId } };
  if (modelId.startsWith("anthropic/")) return { body: { session_id: conversationId } };
  return {};
}

// OpenRouter's `models` fallback array (primary + alternates) is capped at 3 items —
// a longer array 400s ("'models' array must have 3 items or fewer"), which dead-fails
// EVERY request on that chain. Cap defensively so an over-long *_MODELS env degrades to
// the first 3 (best-by-order) instead of breaking the path entirely.
const OPENROUTER_MAX_MODELS = 3;

function openrouter(apiKey: string, models: string[], opts: OpenRouterOpts = {}): LanguageModel {
  const [primary, ...rest] = models;
  const injectModels = rest.length > 0;
  const injectReasoning = opts.reasoningEffort !== undefined;
  const affinity = opts.conversationId ? cacheAffinity(primary, opts.conversationId) : {};
  const injectAffinityBody = affinity.body !== undefined;
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    headers: {
      "HTTP-Referer": process.env.PUBLIC_APP_URL ?? "https://macrotide.local",
      "X-Title": "Macrotide",
      // Header-based cache affinity (e.g. grok's x-grok-conv-id). The provider is
      // built fresh per request with the thread id known, so a static header is
      // correct and per-conversation.
      ...affinity.headers,
    },
    // OpenRouter takes `models: [primary, ...fallbacks]`, a `reasoning: { effort }`
    // control, and (for some families) a body-level cache-affinity field as body
    // fields. Only override fetch when we actually need to inject one of them — a
    // single-model, default-reasoning, no-body-affinity request stays clean.
    fetch:
      !injectModels && !injectReasoning && !injectAffinityBody
        ? undefined
        : async (input, init) => {
            if (init && typeof init.body === "string") {
              try {
                const body = JSON.parse(init.body);
                if (injectModels) body.models = models.slice(0, OPENROUTER_MAX_MODELS);
                if (injectReasoning) body.reasoning = { effort: opts.reasoningEffort };
                if (injectAffinityBody) Object.assign(body, affinity.body);
                init = { ...init, body: JSON.stringify(body) };
              } catch {
                // Body wasn't JSON — forward untouched rather than crashing.
              }
            }
            const res = await fetch(input as RequestInfo, init);
            // Some free models MANDATE reasoning and 400 when we send a disable
            // (`reasoning:{effort:'none'}`). The model-fallback `models[]` chain
            // doesn't absorb this (it's a request-shape rejection, not a provider
            // outage), so retry ONCE without the reasoning control — letting that
            // model use its default — instead of dead-ending the turn. Covers
            // every disable path (public/demo/title/extract/vision); trusted never
            // disables, so it can't hit this. Reading a 400's small JSON error is
            // safe — it's not the streamed success body.
            if (res.status === 400 && injectReasoning && typeof init?.body === "string") {
              const text = await res
                .clone()
                .text()
                .catch(() => "");
              if (/reasoning is mandatory|cannot be disabled/i.test(text)) {
                try {
                  const retryBody = JSON.parse(init.body);
                  delete retryBody.reasoning;
                  return fetch(input as RequestInfo, { ...init, body: JSON.stringify(retryBody) });
                } catch {
                  // fall through to the original response
                }
              }
            }
            return res;
          },
  });
  return provider(primary);
}

function chainLabel(prefix: string, models: string[]): string {
  return models.length === 1 ? `${prefix} · ${models[0]}` : `${prefix} · ${models.join(" → ")}`;
}

// Owner/trusted reasoning FLOOR. The eval (docs/explanation/inference-strategy.md)
// found the trusted primary (grok-4.3) saves explicit memory requests only ~41%
// of the time at effort `none` but ~100% at `low`, with no over-firing — and that
// the cheap public model REGRESSES with reasoning (more dead-ends), so the floor
// is trusted-only. So trusted runs at `low` minimum: the per-turn intent gate can
// still raise it (analytical → medium), but never below the floor. The floor is
// `TRUSTED_REASONING_FLOOR`-overridable (default `low`); public/demo set their own
// fixed effort below. `undefined` (gate off) also floors.
const EFFORT_RANK: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
};
function atLeastTrustedFloor(effort: ReasoningEffort | undefined): ReasoningEffort {
  const floor = parseEffort(process.env.TRUSTED_REASONING_FLOOR, "low");
  if (effort === undefined) return floor;
  return EFFORT_RANK[effort] >= EFFORT_RANK[floor] ? effort : floor;
}

export function resolveOwnerProvider(
  opts: { reasoningEffort?: ReasoningEffort; conversationId?: string } = {},
): ResolvedProvider {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "OpenRouter (no key)" };
  const models = parseModels(process.env.TRUSTED_TIER_MODELS) ?? TRUSTED_TIER_DEFAULT;
  // Per-turn intent gate raises effort (analytical → medium), floored at `low`.
  return {
    model: openrouter(key, models, {
      reasoningEffort: atLeastTrustedFloor(opts.reasoningEffort),
      conversationId: opts.conversationId,
    }),
    ready: true,
    label: chainLabel("OpenRouter", models),
  };
}

// The public tier chain derives ONLY from `PUBLIC_TIER_MODELS`, never from
// `TRUSTED_TIER_MODELS`, defaulting to OpenRouter's zero-cost meta-router. This
// preserves the cost/security invariant by construction: a slip in the trusted
// chain (`TRUSTED_TIER_MODELS`) can't widen public-tier access, because the
// public branch doesn't read it. Pointing the public tier at a cheap PAID model
// is a separate, conscious operator act (set `PUBLIC_TIER_MODELS`), and it's
// bounded by the daily token + optional cents cap — see lib/db/queries/usage.ts.
const PUBLIC_TIER_DEFAULT = ["openrouter/free"];

/**
 * Resolve the chat provider for a tier:
 *   - 'trusted' → the owner model chain (`TRUSTED_TIER_MODELS`, default
 *                 `openrouter/free → openrouter/auto`); identical to the owner
 *                 path.
 *   - 'public'  → `PUBLIC_TIER_MODELS` (default `openrouter/free`) ONLY. Reads
 *                 its own var, NEVER `TRUSTED_TIER_MODELS`, so the trusted chain
 *                 can't leak in.
 *
 * Both read the shared `OPENROUTER_API_KEY`; per-user keys are out of scope —
 * tier gating + the daily caps are what bound public-tier spend.
 */
export function resolveTierProvider(
  tier: "public" | "trusted",
  opts: { reasoningEffort?: ReasoningEffort; conversationId?: string } = {},
): ResolvedProvider {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "OpenRouter (no key)" };
  if (tier === "trusted") {
    const models = parseModels(process.env.TRUSTED_TIER_MODELS) ?? TRUSTED_TIER_DEFAULT;
    // Trusted shares the owner chain AND the per-turn intent-gated effort, floored
    // at `low` (the eval-backed memory-save floor; see atLeastTrustedFloor).
    return {
      model: openrouter(key, models, {
        reasoningEffort: atLeastTrustedFloor(opts.reasoningEffort),
        conversationId: opts.conversationId,
      }),
      ready: true,
      label: chainLabel("Trusted", models),
    };
  }
  const models = parseModels(process.env.PUBLIC_TIER_MODELS) ?? PUBLIC_TIER_DEFAULT;
  // Public tier: a FIXED reasoning effort (default `none`), ignoring the gated
  // effort. Public is the cost-protected path — a cheap model the router lands on
  // must not reason (slow + billed at the output rate) even on an analytical turn.
  // `PUBLIC_REASONING_EFFORT` lets an operator who points the public tier at a
  // reasoning model (e.g. grok) lift it to `low` so its tool-calling lands.
  return {
    model: openrouter(key, models, {
      reasoningEffort: parseEffort(process.env.PUBLIC_REASONING_EFFORT, "none"),
      conversationId: opts.conversationId,
    }),
    ready: true,
    label: chainLabel("Public", models),
  };
}

export function resolveDemoProvider(opts: { conversationId?: string } = {}): ResolvedProvider {
  const key = process.env.DEMO_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Demo (no key configured)" };
  const models = parseModels(process.env.DEMO_TIER_MODELS) ?? DEMO_TIER_DEFAULT;
  // Demo: fixed reasoning effort (default `none`) — public, abuse-exposed, on the
  // free chain; it shouldn't burn reasoning latency/cost on a throwaway turn.
  // `DEMO_REASONING_EFFORT` overrides for parity with the public knob.
  return {
    model: openrouter(key, models, {
      reasoningEffort: parseEffort(process.env.DEMO_REASONING_EFFORT, "none"),
      conversationId: opts.conversationId,
    }),
    ready: true,
    label: chainLabel("Demo", models),
  };
}

// Inline chat vision — the model the Advisor's `examine_image` tool runs under
// the hood to read an attached image (the chat driver, e.g. grok, stays on the
// turn; it cannot see pixels and calls this as a tool). Named by its OWN
// dedicated `VISION_CHAT_MODELS` var (default a gemini-flash-lite chain — primary
// + an EOL-proof current-gen fallback, the same family the pinned OCR extractor
// uses). Two deliberate consequences:
//   - The public-tier cost invariant is preserved by construction: public-tier
//     vision derives from `VISION_CHAT_MODELS`, NEVER from `TRUSTED_TIER_MODELS`,
//     exactly like `PUBLIC_TIER_MODELS`. Public image turns are bounded by the daily
//     token + optional cents caps enforced in the route before this is reached.
//   - Setting `VISION_CHAT_MODELS=off` (or empty) disables inline chat vision
//     entirely — the resolver returns not-ready and the route serves a stub that
//     points the user at the Add-to-portfolio image importer.
const VISION_DEFAULT = ["google/gemini-2.5-flash-lite", "google/gemini-3.1-flash-lite"];

/** True when a vision var explicitly disables that vision path. */
function visionDisabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "off" || v === "false" || v === "none" || v === "0";
}

/**
 * Resolve the provider for the Advisor's `examine_image` tool (the cheap,
 * common-case vision read).
 *
 * - `demo: true` reads `DEMO_OPENROUTER_API_KEY` (falling back to the owner key)
 *   so demo vision never silently bills the owner key — mirrors
 *   {@link resolveDemoProvider}.
 * - `VISION_CHAT_MODELS` set to `off`/empty → not-ready (vision disabled).
 * - `reasoningEffort` is passed through; the route pins `"none"` for the free
 *   and demo paths (cost) and forwards the intent-gated effort for owner/trusted.
 *
 * No `conversationId`: the vision read is a single-shot, stateless call (image +
 * one question), so there's no conversation cache to keep warm here — affinity
 * lives on the chat driver, not the sub-model.
 */
export function resolveVisionProvider(
  opts: { reasoningEffort?: ReasoningEffort; demo?: boolean } = {},
): ResolvedProvider {
  const key = opts.demo
    ? (process.env.DEMO_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY)
    : process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Vision (no key)" };
  const raw = process.env.VISION_CHAT_MODELS;
  if (visionDisabled(raw)) return { model: null, ready: false, label: "Vision (disabled)" };
  const models = parseModels(raw) ?? VISION_DEFAULT;
  return {
    model: openrouter(key, models, { reasoningEffort: opts.reasoningEffort }),
    ready: true,
    label: chainLabel(opts.demo ? "Vision (demo)" : "Vision", models),
  };
}

/**
 * Resolve the STRONGER vision chain for the escalation hook — a chart/factsheet
 * the user is reasoning *about*, where a cheap flash read may be too weak. Named
 * by `VISION_CHAT_ESCALATE_MODELS`; **default unset → not-ready**, so escalation
 * is dormant and the tool falls back to the cheap {@link resolveVisionProvider}
 * until the chart-Q&A eval (G2) proves a pro tier earns its cost. Gated to
 * owner/trusted at the call site — public/demo never escalate (cost invariant).
 */
export function resolveVisionEscalateProvider(
  opts: { reasoningEffort?: ReasoningEffort; demo?: boolean } = {},
): ResolvedProvider {
  const raw = process.env.VISION_CHAT_ESCALATE_MODELS;
  if (!raw || visionDisabled(raw)) {
    return { model: null, ready: false, label: "Vision escalate (unset)" };
  }
  const key = opts.demo
    ? (process.env.DEMO_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY)
    : process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Vision escalate (no key)" };
  const models = parseModels(raw);
  if (!models) return { model: null, ready: false, label: "Vision escalate (unset)" };
  return {
    model: openrouter(key, models, { reasoningEffort: opts.reasoningEffort }),
    ready: true,
    label: chainLabel("Vision escalate", models),
  };
}

/**
 * Tiny model used for ancillary tasks where Claude/GPT capacity is overkill
 * — currently just auto-titling a chat after the first turn pair. Reads the
 * same `OPENROUTER_API_KEY` as the chat path but uses a separate model var
 * (`TITLE_MODELS`, default `openrouter/free`) so the operator can pin a
 * cost-efficient small model without affecting chat quality.
 */
export function resolveTitleProvider(): ResolvedProvider {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Title (no key)" };
  const models = parseModels(process.env.TITLE_MODELS) ?? TITLE_MODELS_DEFAULT;
  // Reasoning off — a 3–5-word title never needs chain-of-thought.
  return {
    model: openrouter(key, models, { reasoningEffort: "none" }),
    ready: true,
    label: chainLabel("Title", models),
  };
}

/**
 * Cheap model for archive-time extraction. Reads the shared
 * `OPENROUTER_API_KEY`. Model resolution order: `EXTRACT_MODELS` →
 * `TITLE_MODELS` → `openrouter/free`. Pinning a Claude/GPT-family model here
 * would be an escalation per AGENTS.md § AI / model selection — extraction is
 * a background, best-effort pass and should stay on cheap free models.
 */
export function resolveExtractorProvider(): ResolvedProvider {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Extract (no key)" };
  const models =
    parseModels(process.env.EXTRACT_MODELS) ??
    parseModels(process.env.TITLE_MODELS) ??
    EXTRACT_MODELS_DEFAULT;
  // Reasoning off — a background summarize-and-extract pass doesn't need it.
  return {
    model: openrouter(key, models, { reasoningEffort: "none" }),
    ready: true,
    label: chainLabel("Extract", models),
  };
}

/**
 * Reasoning model for the offline memory-consolidation sweep. Reads the shared
 * `OPENROUTER_API_KEY`. Model resolution: `CONSOLIDATE_MODELS` →
 * `CONSOLIDATE_MODELS_DEFAULT` (a FREE reasoning chain) — note it does NOT fall
 * back to the extractor/title chains, because the whole point is to use a
 * reasoning model the latency-insensitive offline sweep can afford (extraction
 * runs every session close and stays cheap/non-reasoning).
 *
 * Reasoning is ON (effort `low` by default, `CONSOLIDATE_REASONING_EFFORT`
 * override). Unlike extraction — where the free meta-router is a JSON lottery so
 * reasoning is pinned `none` — here the chain pins DEDICATED reasoning models, so
 * OpenRouter returns the chain-of-thought in its own channel and `result.text`
 * stays clean JSON for the proposer to parse.
 */
export function resolveConsolidateProvider(): ResolvedProvider {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { model: null, ready: false, label: "Consolidate (no key)" };
  const models = parseModels(process.env.CONSOLIDATE_MODELS) ?? CONSOLIDATE_MODELS_DEFAULT;
  return {
    model: openrouter(key, models, {
      reasoningEffort: parseEffort(process.env.CONSOLIDATE_REASONING_EFFORT, "low"),
    }),
    ready: true,
    label: chainLabel("Consolidate", models),
  };
}
