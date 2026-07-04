// Per-user token accounting + tier gating.
//
// Two tables back this module (migration 0007):
//   - `account_tier`  one row per user; `tier` ∈ {'public','trusted'}. A user
//                     with NO row defaults to 'public' (the safe, zero-cost
//                     posture). Owner promotes via SQL.
//   - `usage`         one row per (user, UTC date) holding the running
//                     input/output token totals AND an estimated cost in
//                     micro-dollars for that day. Resets naturally at UTC
//                     midnight because the date key rolls over.
//
// Two caps gate a tiered user, checked BEFORE forwarding to OpenRouter:
//   - the TOKEN cap (always on) — a coarse floor on volume; and
//   - the optional COST cap (cents/day) — only active when a cents budget is
//     configured AND the served model is priced. The cost cap exists because a
//     paid public-tier model (PUBLIC_TIER_MODELS) has asymmetric in/out pricing that
//     a flat token count can't bound. Either cap tripping blocks the request.
//
// All functions take an explicit `userId` (like the memory queries) so they're
// trivially testable with the :memory: freshDb pattern. Callers in
// single-owner / demo mode (`getUserId()` === null) must NOT call these — the
// owner is never metered and demo is already isolated. See app/api/chat.
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../context";
import { accountTier, usage } from "../schema";

export type Tier = "public" | "trusted";

/** Default daily token budgets (input+output) — overridable via env. */
const DEFAULT_BUDGET_PUBLIC = 20_000;
const DEFAULT_BUDGET_TRUSTED = 200_000;

/** Cost is stored in micro-dollars (1e-6 USD). 1 cent = 10_000 micro-dollars. */
const MICROS_PER_CENT = 10_000;

/**
 * Per-model price expressed as **US dollars per million tokens** — which, by a
 * happy unit coincidence, equals **micro-dollars per token** (so a turn's cost
 * in micro-dollars is just `tokens × price`). Prices are quoted this way by
 * every provider, so the numbers here read like the published rate card.
 */
export interface ModelPrice {
  /** input/prompt tokens, USD per 1M tokens */
  in: number;
  /** output/completion tokens, USD per 1M tokens */
  out: number;
}

// Built-in price table for the paid models we may serve (public candidates + the
// owner/trusted chain), keyed by the model id OpenRouter reports back in the
// response (`response.modelId`). These
// are list prices and may drift — operators override/extend via the MODEL_PRICES
// env (JSON) rather than a code change. Free / zero-cost models are deliberately
// ABSENT: an unpriced model contributes 0 cost, so `openrouter/free` routing
// never accrues a charge and the cost cap simply doesn't apply to it.
const BUILTIN_PRICES: Record<string, ModelPrice> = {
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "openai/gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "openai/gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "x-ai/grok-4.3": { in: 1.25, out: 2.5 },
  "z-ai/glm-5.1": { in: 0.98, out: 3.08 },
};

let cachedPriceEnv: string | undefined;
let cachedPriceTable: Record<string, ModelPrice> = BUILTIN_PRICES;

/**
 * The effective price table: MODEL_PRICES env (JSON `{"model-id":{"in","out"}}`)
 * merged OVER the built-in defaults. Parsed lazily and memoized per distinct env
 * value so a malformed override degrades to the built-ins rather than throwing.
 */
function priceTable(): Record<string, ModelPrice> {
  const raw = process.env.MODEL_PRICES;
  if (raw === cachedPriceEnv) return cachedPriceTable;
  cachedPriceEnv = raw;
  if (!raw) {
    cachedPriceTable = BUILTIN_PRICES;
    return cachedPriceTable;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const merged: Record<string, ModelPrice> = { ...BUILTIN_PRICES };
    for (const [id, p] of Object.entries(parsed)) {
      const inN = Number(p?.in);
      const outN = Number(p?.out);
      if (Number.isFinite(inN) && inN >= 0 && Number.isFinite(outN) && outN >= 0) {
        merged[id] = { in: inN, out: outN };
      }
    }
    cachedPriceTable = merged;
  } catch {
    cachedPriceTable = BUILTIN_PRICES;
  }
  return cachedPriceTable;
}

/**
 * Price for a served model id, or null when it isn't priced (→ no cost cap).
 * OpenRouter reports some providers' models with a dated snapshot suffix
 * (`openai/gpt-4.1-mini` → `openai/gpt-4.1-mini-2025-04-14`), so an exact miss
 * retries against the id with a trailing `-YYYY-MM-DD` stripped. We do NOT
 * prefix-match (that would wrongly map `…flash-lite` onto `…flash`).
 */
export function modelPrice(modelId: string | null | undefined): ModelPrice | null {
  if (!modelId) return null;
  const table = priceTable();
  if (table[modelId]) return table[modelId];
  const undated = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return (undated !== modelId && table[undated]) || null;
}

/**
 * Estimated cost of a turn in micro-dollars from the served model's price.
 * Returns 0 for an unpriced (free/zero-cost) model, so cost accounting is
 * additive and a free turn never accrues a charge.
 */
export function estimateCostMicros(
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = modelPrice(modelId);
  if (!price) return 0;
  const input = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return Math.round(input * price.in + output * price.out);
}

/**
 * Optional daily cost ceiling in **cents** for a tier, from
 * `DAILY_CENTS_BUDGET_PUBLIC` / `_TRUSTED`. Returns `null` when unset or
 * malformed — i.e. cost gating is OFF by default and a typo can't silently
 * invent a money cap (the always-on token cap still bounds spend). There is
 * deliberately no built-in cents default: a dollar limit must be a conscious
 * operator choice.
 */
export function dailyCentsBudget(tier: Tier): number | null {
  const raw =
    tier === "trusted"
      ? process.env.DAILY_CENTS_BUDGET_TRUSTED
      : process.env.DAILY_CENTS_BUDGET_PUBLIC;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Today's date as 'YYYY-MM-DD' in UTC — the partition key for `usage`. */
export function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Daily token budget (input+output) for a tier. Reads
 * `DAILY_TOKEN_BUDGET_PUBLIC` / `DAILY_TOKEN_BUDGET_TRUSTED` with documented
 * defaults (20k / 200k). A malformed/negative env value falls back to the
 * default rather than disabling the cap.
 */
export function dailyTokenBudget(tier: Tier): number {
  const raw =
    tier === "trusted"
      ? process.env.DAILY_TOKEN_BUDGET_TRUSTED
      : process.env.DAILY_TOKEN_BUDGET_PUBLIC;
  const fallback = tier === "trusted" ? DEFAULT_BUDGET_TRUSTED : DEFAULT_BUDGET_PUBLIC;
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve a user's tier. No row → 'public' (zero-cost default; new accounts
 * start here until the owner promotes them via SQL).
 */
export function getTier(userId: string): Tier {
  const row = getDb()
    .select({ tier: accountTier.tier })
    .from(accountTier)
    .where(eq(accountTier.userId, userId))
    .get();
  return (row?.tier as Tier | undefined) ?? "public";
}

export interface TodayUsage {
  inputTokens: number;
  outputTokens: number;
  total: number;
  /** Accumulated estimated cost today in micro-dollars (1e-6 USD). */
  costMicros: number;
}

/** Today's (UTC) token + cost totals for a user. Zeroes when there's no row yet. */
export function getTodayUsage(userId: string, date: string = utcDate()): TodayUsage {
  const row = getDb()
    .select({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros: usage.costMicros,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.date, date)))
    .get();
  const inputTokens = row?.inputTokens ?? 0;
  const outputTokens = row?.outputTokens ?? 0;
  const costMicros = row?.costMicros ?? 0;
  return { inputTokens, outputTokens, total: inputTokens + outputTokens, costMicros };
}

/**
 * Whether the user has already met-or-exceeded today's TOKEN cap for their tier.
 * Checked BEFORE forwarding to OpenRouter so we never start a paid request
 * for someone over budget. `>=` is intentional: at exactly the cap, stop.
 */
export function isOverDailyCap(userId: string, tier: Tier, date: string = utcDate()): boolean {
  return getTodayUsage(userId, date).total >= dailyTokenBudget(tier);
}

/**
 * Whether the user has met-or-exceeded today's optional COST cap (cents/day).
 * Always `false` when no cents budget is configured for the tier, so this is a
 * no-op until an operator opts in. Same `>=` boundary semantics as the token cap.
 */
export function isOverDailyCostCap(userId: string, tier: Tier, date: string = utcDate()): boolean {
  const cents = dailyCentsBudget(tier);
  if (cents === null) return false;
  return getTodayUsage(userId, date).costMicros >= cents * MICROS_PER_CENT;
}

/**
 * Add tokens (and optional estimated cost) to today's usage row (upsert +
 * atomic increment). Called after a stream finishes (the AI SDK `onFinish`
 * usage callback). Negative/NaN inputs are clamped to 0 so a missing provider
 * usage field can never corrupt the row. `costMicros` is the 5th arg (after the
 * optional `date`) so existing 3- and 4-arg callers stay source-compatible.
 */
export function recordUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
  date: string = utcDate(),
  costMicros = 0,
): void {
  const inc = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const input = inc(inputTokens);
  const output = inc(outputTokens);
  const cost = inc(costMicros);
  if (input === 0 && output === 0 && cost === 0) return;
  getDb()
    .insert(usage)
    .values({ userId, date, inputTokens: input, outputTokens: output, costMicros: cost })
    .onConflictDoUpdate({
      target: [usage.userId, usage.date],
      set: {
        inputTokens: sql`${usage.inputTokens} + ${input}`,
        outputTokens: sql`${usage.outputTokens} + ${output}`,
        costMicros: sql`${usage.costMicros} + ${cost}`,
      },
    })
    .run();
}
