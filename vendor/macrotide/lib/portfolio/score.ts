// Transparent 0-100 composite portfolio-health score.
//
// Composed of four objective components derived from the health.ts signals —
// no AI calls, no black-box weights. Every deduction is explained by a short
// rule so the UI can show WHY the score is what it is.
//
// Component weights (must sum to 100):
//   drift         30 pts  — how closely the portfolio tracks its target mix
//   fees          25 pts  — blended expense ratio vs. index-grade benchmarks
//   concentration 25 pts  — underlying-exposure concentration (see assessConcentration)
//   cash drag     20 pts  — uninvested cash as a % of portfolio
//
// Each component is scored independently and can be read in isolation.
//
// With a target: total is the simple sum of all four — nothing more.
// Without a target: drift is undefined, so it is EXCLUDED rather than awarded
// full marks (which would inflate the headline by rewarding the absence of a
// plan). The remaining 70 points (fees 25 + concentration 25 + cash 20) are
// renormalised onto a 0–100 scale so the headline stays comparable.
//
// NOTE: this composite is no longer the user's headline (the Portfolio screen
// leads with a plain-language headline + named checks). It is kept for the
// Advisor's internal reasoning and /api/analysis. See portfolio-health.md.

import { assessConcentration, type HealthSignals } from "./health";

export interface ScoreComponent {
  key: "drift" | "fees" | "concentration" | "cash";
  /** Short human-readable component name. */
  label: string;
  /** Points earned (0..max). Integer. */
  score: number;
  /** Maximum possible points for this component. */
  max: number;
  /** One-sentence explanation of why this component scored what it did. */
  detail: string;
}

export interface PortfolioScore {
  /** Sum of component scores, 0–100. Integer. */
  total: number;
  /** Individual component breakdown — ordered drift, fees, concentration, cash. */
  components: ScoreComponent[];
  /**
   * Whether a target mix was present. When false, the drift component is
   * excluded from `total` and the remaining components are renormalised onto
   * 0–100 (the drift component is still listed, scored 0, as a CTA).
   */
  hasTarget: boolean;
}

// ─── Component max-point allocations (must sum to 100) ─────────────────────
const DRIFT_MAX = 30;
const FEE_MAX = 25;
const CONC_MAX = 25;
const CASH_MAX = 20;

// ─── Scoring rules ──────────────────────────────────────────────────────────

/**
 * Drift sub-score (0–30 pts).
 *
 * Rule: −2 pts per percentage-point of tracking gap; full penalty at ≥ 15 pp.
 * No target → not scored: returns 0 with a CTA detail and is excluded from the
 * composite by scorePortfolio (drift is undefined without a benchmark).
 *
 *   trackingGapPp = 0   → 30 pts
 *   trackingGapPp = 5   → 20 pts
 *   trackingGapPp = 10  → 10 pts
 *   trackingGapPp ≥ 15  →  0 pts
 */
function driftScore(trackingGapPp: number, hasTarget: boolean): ScoreComponent {
  if (!hasTarget) {
    // Not scored at all — excluded from the composite (see scorePortfolio) so
    // the absence of a plan neither helps nor hurts the headline. The UI shows
    // this row as a call to action rather than a fake full mark.
    return {
      key: "drift",
      label: "Drift from target",
      score: 0,
      max: DRIFT_MAX,
      detail: "Not scored — set a target model to track how closely you follow your plan.",
    };
  }
  const score = Math.max(0, Math.round(DRIFT_MAX - trackingGapPp * 2));
  const detail =
    trackingGapPp < 1
      ? `Within 1 pp of target — excellent tracking.`
      : trackingGapPp < 5
        ? `${trackingGapPp.toFixed(1)} pp off target — acceptable, review at next rebalance.`
        : trackingGapPp < 10
          ? `${trackingGapPp.toFixed(1)} pp off target — consider rebalancing soon.`
          : `${trackingGapPp.toFixed(1)} pp off target — significant drift, rebalance recommended.`;
  return { key: "drift", label: "Drift from target", score, max: DRIFT_MAX, detail };
}

/**
 * Fee sub-score (0–25 pts).
 *
 * Rule: TER ≤ 0.20% → 25 pts; TER ≥ 2.0% → 0 pts; linear in between.
 * The band [0.20, 2.0] covers the realistic range from cheapest tracker to
 * expensive active fund. Each +0.072% TER above 0.20% costs ~1 point.
 *
 *   TER ≤ 0.20% → 25 pts   (index-grade)
 *   TER = 0.50% → ~21 pts
 *   TER = 1.00% → ~18 pts
 *   TER ≥ 2.00% →  0 pts
 */
function feeScore(ter: number, unknownCount: number): ScoreComponent {
  const score = ter <= 0.2 ? FEE_MAX : Math.max(0, Math.round(FEE_MAX * (1 - (ter - 0.2) / 1.8)));
  const base =
    ter <= 0.2
      ? `${ter.toFixed(2)}% TER — index-grade efficiency.`
      : ter <= 0.75
        ? `${ter.toFixed(2)}% TER — reasonable for an index investor.`
        : ter <= 1.5
          ? `${ter.toFixed(2)}% TER — moderately high; consider cheaper alternatives.`
          : `${ter.toFixed(2)}% TER — high cost drag on long-term returns.`;
  // Holdings with no published fee are excluded from the blended rate so missing
  // data neither rewards nor punishes the score. Flag it so the number is honest.
  const note =
    unknownCount > 0
      ? ` Fee data incomplete for ${unknownCount} holding${unknownCount !== 1 ? "s" : ""}.`
      : "";
  return { key: "fees", label: "Blended fees", score, max: FEE_MAX, detail: base + note };
}

/**
 * Concentration sub-score (0–25 pts).
 *
 * Derived from the shared `assessConcentration` interpretation (the same one the
 * named-check UI reads), so the composite can never disagree with what the user
 * sees. Fund-count HHI is no longer the basis — it punished clean broad-index
 * books (few funds) and was fooled by redundant funds (many funds, one
 * exposure). Instead: a single-alternative-bet check plus coverage-gated
 * look-through, where look-through can only SUBTRACT on a confident finding and
 * missing data is neutral. Full rationale: docs/explanation/portfolio-health.md.
 *
 *   good  → 25 pts    watch → ~13 pts    act → ~4 pts
 */
function concentrationScore(health: HealthSignals): ScoreComponent {
  const { status, reason, fraction } = assessConcentration(health.concentration);
  void status; // status drives the UI pill; the composite needs only the points
  // An empty book assesses as "good" (nothing to penalise) → full marks, keeping
  // the composite at 100 when there is nothing to score, like fees and cash.
  const score = Math.round(CONC_MAX * fraction);
  return { key: "concentration", label: "Diversification", score, max: CONC_MAX, detail: reason };
}

/**
 * Cash-drag sub-score (0–20 pts).
 *
 * Rule: cash ≤ 2% → 20 pts; cash ≥ 20% → 0 pts; linear in between.
 * 2% is a reasonable emergency-buffer threshold; ≥ 20% is serious uninvested drag.
 *
 *   cash ≤ 2%   → 20 pts
 *   cash = 10%  → ~11 pts
 *   cash ≥ 20%  →  0 pts
 */
function cashScore(cashPct: number): ScoreComponent {
  const score =
    cashPct <= 2 ? CASH_MAX : Math.max(0, Math.round(CASH_MAX * (1 - (cashPct - 2) / 18)));
  const detail =
    cashPct <= 2
      ? `${cashPct.toFixed(1)}% cash — minimal drag.`
      : cashPct <= 10
        ? `${cashPct.toFixed(1)}% cash — small drag on returns.`
        : `${cashPct.toFixed(1)}% cash — notable drag; consider deploying.`;
  return { key: "cash", label: "Cash drag", score, max: CASH_MAX, detail };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a transparent 0-100 composite portfolio-health score.
 *
 * The four components (drift, fees, concentration, cash) each contribute a
 * clearly-documented sub-score. Pass `hasTarget = false` when no model-portfolio
 * target has been selected.
 *
 * With a target: `total` is the simple sum of all four components (0–100).
 * Without a target: drift is undefined, so it is EXCLUDED from the composite
 * and the remaining three components (fees + concentration + cash, max 70) are
 * renormalised onto a 0–100 scale: `total = round(rawSum / 70 × 100)`. The drift
 * component is still returned (score 0, with a "set a target" CTA detail) so the
 * UI can render the full breakdown, but it does not contribute to the total.
 *
 * @example
 * const health = computeHealth(holdings, totalValue, targetMix, targetTer);
 * const score  = scorePortfolio(health, targetMix !== null);
 * // score.total → e.g. 74
 * // score.components[0] → { key: "drift", score: 20, max: 30, detail: "…" }
 */
export function scorePortfolio(health: HealthSignals, hasTarget: boolean): PortfolioScore {
  const components: ScoreComponent[] = [
    driftScore(health.trackingGapPp, hasTarget),
    feeScore(health.blendedTer, health.unknownTerCount),
    concentrationScore(health),
    cashScore(health.cashPct),
  ];

  let total: number;
  if (hasTarget) {
    total = components.reduce((s, c) => s + c.score, 0);
  } else {
    // Exclude drift; renormalise the remaining 70 points onto 0–100 so the
    // headline stays comparable and isn't inflated by an auto-awarded drift.
    const scored = components.filter((c) => c.key !== "drift");
    const rawSum = scored.reduce((s, c) => s + c.score, 0);
    const rawMax = scored.reduce((s, c) => s + c.max, 0);
    total = rawMax > 0 ? Math.round((rawSum / rawMax) * 100) : 0;
  }
  return { total, components, hasTarget };
}
