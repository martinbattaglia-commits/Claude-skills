// Context-aware starter prompts for the Advisor composer.
//
// This is a THIN, SWAPPABLE layer: it derives the chat composer's suggestion
// chips from context the UI already has — the user's combined portfolio
// (already computed into HealthSignals via lib/portfolio/health) and the screen
// they're looking at. It does NOT fetch, plumb, or invent a new context model;
// a sibling effort owns the formal "what the Advisor knows" model, and this
// function is written so its inputs can later be fed straight from that model
// without touching the suggestion copy. See NOTES-22.md for the context gaps
// this layer wanted but did not build.
//
// Pure + deterministic: no DB, no network, no React. Given the same inputs it
// returns the same ordered list of prompt strings. Empty/loading portfolios are
// handled gracefully — we fall back to evergreen learning prompts.

import type { HealthSignals } from "@/lib/portfolio/health";

/**
 * The screen the user is currently looking at, as the suggestion layer cares
 * about it. A deliberately small vocabulary — not the full App `Screen` union —
 * so this module stays decoupled from the app shell's routing. Callers map
 * their own screen id onto one of these (or omit it).
 */
export type AdvisorScreenContext =
  | "portfolio"
  | "markets"
  | "explore"
  | "journal"
  | "models"
  | "chat";

export interface ChatSuggestionContext {
  /** The screen the composer is being shown against, if known. */
  screen?: AdvisorScreenContext | null;
  /**
   * Objective signals over the user's COMBINED book, already computed by
   * computeHealth(). Null while loading, or when there are no holdings yet.
   */
  health?: HealthSignals | null;
  /** Name of the user's selected target model (e.g. "Bogle 3-fund"), if any. */
  targetName?: string | null;
  /** Whether the user has any holdings at all. Drives the empty-state fallback. */
  hasHoldings?: boolean;
}

// Evergreen learning prompts — the graceful fallback for an empty portfolio or
// a demo session with nothing entered yet. Mirrors the prior hard-coded list's
// educational intent.
const EVERGREEN: string[] = [
  "What's a 3-fund portfolio?",
  "Why index over active?",
  "Help me write my plan",
  "How much should I keep in cash?",
];

// Thresholds mirror summarizeHealth() so a suggestion never contradicts the
// Plan panel's headline. Kept local (not imported) so this layer can be retuned
// independently of the headline copy.
const CONCENTRATION_PCT = 30;
const CASH_PCT = 10;
const DRIFT_PP = 5;
const HIGH_FEE_PCT = 0.75;

/**
 * Portfolio-derived prompts, most important first. Each branch references a real
 * signal from the user's own book so the chip reads as "about me", not generic.
 * Returns [] when there's nothing notable (or no portfolio), letting the caller
 * fall back to screen/evergreen prompts.
 */
function portfolioPrompts(
  health: HealthSignals | null | undefined,
  targetName: string | null | undefined,
): string[] {
  if (!health) return [];
  const out: string[] = [];
  const { concentration: c, cashPct, trackingGapPp, blendedTer } = health;

  if (targetName && trackingGapPp >= DRIFT_PP) {
    out.push(
      `My mix is ${trackingGapPp.toFixed(1)}pp off my ${targetName} target — walk me through a rebalance`,
    );
  }
  if (c.top && c.top.pct >= CONCENTRATION_PCT) {
    out.push(`Is ${c.top.ticker} at ${c.top.pct.toFixed(0)}% of my book too concentrated?`);
  }
  if (cashPct >= CASH_PCT) {
    out.push(`I'm holding ${cashPct.toFixed(0)}% cash — should I put it to work?`);
  }
  if (blendedTer > HIGH_FEE_PCT) {
    out.push(`My blended fee is ${blendedTer.toFixed(2)}% — where could I cut costs?`);
  }
  // Always-useful book-level questions so an on-track portfolio still gets
  // portfolio-specific chips even when none of the signals above fired.
  out.push("How am I doing vs my target?");
  out.push("Give me a quick health check on my portfolio");
  return out;
}

/**
 * Screen-flavored prompts. The screen the user came from biases WHICH question
 * feels relevant — e.g. on Explore they're shopping for funds, on Markets they
 * care about today's moves. These complement (don't replace) portfolio prompts.
 */
function screenPrompts(screen: AdvisorScreenContext | null | undefined): string[] {
  switch (screen) {
    case "markets":
      return [
        "Should today's market moves change anything I do?",
        "How do I avoid reacting to short-term noise?",
      ];
    case "explore":
      return ["How do I compare two index funds?", "What should I look at before adding a fund?"];
    case "models":
      return [
        "Which target model fits a long-term investor?",
        "What's the difference between these model portfolios?",
      ];
    case "journal":
      return ["Summarize what's changed in my plan", "Help me write my next plan note"];
    case "portfolio":
      return ["Explain my asset allocation", "When should I rebalance?"];
    default:
      return [];
  }
}

/**
 * Build the ordered, de-duplicated list of composer suggestions for the current
 * context. Portfolio-specific prompts lead (most relevant), then screen-flavored
 * ones, then evergreen learning prompts fill any remaining slots. With no
 * holdings we lead with the screen + evergreen prompts so a fresh/demo user
 * still sees a sensible, non-empty set.
 *
 * @param limit Max chips to return (the composer shows a handful).
 */
export function buildChatSuggestions(ctx: ChatSuggestionContext, limit = 6): string[] {
  const { screen, health, targetName, hasHoldings = !!health } = ctx;

  const ordered = hasHoldings
    ? [...portfolioPrompts(health, targetName), ...screenPrompts(screen), ...EVERGREEN]
    : [...screenPrompts(screen), ...EVERGREEN];

  // De-dupe (a screen prompt may repeat a portfolio one) while preserving order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of ordered) {
    if (seen.has(s)) continue;
    seen.add(s);
    result.push(s);
    if (result.length >= limit) break;
  }
  return result;
}
