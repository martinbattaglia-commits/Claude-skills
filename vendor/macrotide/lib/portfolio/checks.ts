// Named health checks — the user-facing model that leads the Portfolio screen.
//
// Pure presentation layer over the health signals: each check is a label + the
// certain VALUE (a fact we're sure of) + a STATUS pill + a one-line REASON. This
// replaces the single 0-100 grade — a chase-able number harms passive investors;
// independent, individually-actionable checks do not. See portfolio-health.md.
//
// Pure and DB-free. The diversification check reuses assessConcentration so the
// pill matches the look-through story exactly.

import { assessConcentration, type HealthSignals, type HealthTone } from "./health";

/** "none" = not applicable yet (e.g. drift with no target) → rendered as a CTA. */
export type CheckStatus = HealthTone | "none";

export interface NamedCheck {
  key: "drift" | "fees" | "diversification" | "cash";
  label: string;
  /** The certain headline fact (no coverage caveat — look-through lives in `reason`). */
  value: string;
  status: CheckStatus;
  reason: string;
}

function driftCheck(health: HealthSignals, targetName: string | null): NamedCheck {
  if (!targetName) {
    return {
      key: "drift",
      label: "Drift",
      value: "No target set",
      status: "none",
      reason: "Set a target model to track how closely you follow your plan.",
    };
  }
  const gap = health.trackingGapPp;
  const status: HealthTone = gap < 5 ? "good" : gap < 10 ? "watch" : "action";
  const reason =
    gap < 1
      ? `Within 1pp of your ${targetName} target — excellent tracking.`
      : gap < 5
        ? `${gap.toFixed(1)}pp off your ${targetName} target — review at your next rebalance.`
        : gap < 10
          ? `${gap.toFixed(1)}pp off your ${targetName} target — a small rebalance brings you back in line.`
          : `${gap.toFixed(1)}pp off your ${targetName} target — significant drift; rebalancing is worth it.`;
  return { key: "drift", label: "Drift", value: `${gap.toFixed(1)}pp off target`, status, reason };
}

function feesCheck(health: HealthSignals): NamedCheck {
  const { blendedTer: ter, unknownTerCount, concentration } = health;
  const allUnknown =
    concentration.holdingCount > 0 && unknownTerCount >= concentration.holdingCount;
  if (allUnknown) {
    // Unknown fee data must not read as "0% — index-grade". Say it's unknown.
    return {
      key: "fees",
      label: "Fees",
      value: "Not published",
      status: "none",
      reason: "None of your holdings publish a fee, so a blended rate can't be shown.",
    };
  }
  const status: HealthTone = ter <= 0.75 ? "good" : ter <= 1.5 ? "watch" : "action";
  const note =
    unknownTerCount > 0
      ? ` Fee data is missing for ${unknownTerCount} holding${unknownTerCount !== 1 ? "s" : ""}.`
      : "";
  const base =
    ter <= 0.2
      ? "Index-grade efficiency — fees compound against you, so this is a real edge."
      : ter <= 0.75
        ? "Reasonable for an index investor."
        : ter <= 1.5
          ? "On the higher side; cheaper index exposure could lift net returns."
          : "A high cost drag on long-term returns — cheaper exposure is likely available.";
  return {
    key: "fees",
    label: "Fees",
    value: `${ter.toFixed(2)}% blended`,
    status,
    reason: base + note,
  };
}

function diversificationCheck(health: HealthSignals): NamedCheck {
  const c = health.concentration;
  const { status, reason } = assessConcentration(c);
  // Lead each clause with its percentage (like the other rows) so no two numbers
  // sit adjacent — "26% in top fund · 55% in top 3", not "top 3 55%". The top-3
  // clause only adds information once there are more than three holdings.
  const value = !c.top
    ? "—"
    : c.holdingCount >= 4
      ? `${c.top.pct.toFixed(0)}% in top fund · ${c.top3Pct.toFixed(0)}% in top 3`
      : `${c.top.pct.toFixed(0)}% in top fund`;
  return { key: "diversification", label: "Diversification", value, status, reason };
}

function cashCheck(health: HealthSignals): NamedCheck {
  const cash = health.cashPct;
  const status: HealthTone = cash <= 2 ? "good" : cash <= 10 ? "watch" : "action";
  const reason =
    cash <= 2
      ? `${cash.toFixed(1)}% in cash — minimal drag.`
      : cash <= 10
        ? `${cash.toFixed(1)}% in cash — a small drag on returns.`
        : `${cash.toFixed(1)}% in cash — a notable drag; if it isn't earmarked, putting it to work compounds.`;
  // One decimal under 10% so the value matches its reason ("3.6% cash", not "4%").
  const value = `${cash.toFixed(cash < 10 ? 1 : 0)}% cash`;
  return { key: "cash", label: "Cash", value, status, reason };
}

/**
 * The four named checks in display order. Drift leads (the plan), then fees,
 * diversification, cash. Each is independently actionable; the worst-status one
 * is what the screen's headline already surfaces via summarizeHealth.
 */
export function buildNamedChecks(health: HealthSignals, targetName: string | null): NamedCheck[] {
  return [
    driftCheck(health, targetName),
    feesCheck(health),
    diversificationCheck(health),
    cashCheck(health),
  ];
}
