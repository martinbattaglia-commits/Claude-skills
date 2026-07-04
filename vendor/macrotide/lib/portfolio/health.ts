// Portfolio health signals — pure, deterministic computations over REAL
// holdings + a target model mix. No mock data, no AI judgment. These are the
// objective metrics that genuinely matter to an index investor:
//   • drift from target allocation (per-sleeve + a single "tracking gap" pp)
//   • blended fee (weighted TER) vs the target model's fee
//   • concentration (largest holding, top-3, HHI)
//   • cash drag (% sitting in cash)
//   • allocation by asset class + by region (fund-level, not look-through)
//
// Subjective 0–100 "quality" scores (diversification/risk-fit) are deliberately
// NOT computed here — those need AI tool-calls.

import type { AssetClass, Holding, MixSlice } from "@/lib/static/types";

export interface SleeveDrift {
  ticker: string;
  label: string;
  color: string;
  /** Current weight as a % of the portfolio. */
  current: number;
  /** Target weight as a % from the model mix. */
  target: number;
  /** current − target, in percentage points (positive = overweight). */
  drift: number;
}

export interface AllocationSlice {
  key: string;
  label: string;
  value: number;
  pct: number;
  color: string;
}

/**
 * Look-through into what the user's funds hold *underneath*, aggregated across
 * funds. Computed server-side from the regenerable market.db (feeder
 * look-through + top-5 holdings) and injected as a precomputed argument so the
 * pure health/score layer stays DB- and network-free. `null` when no underlying
 * data is available for any holding.
 *
 * The design rule is asymmetric — look-through may ESCALATE concern but never
 * GRANT comfort: every figure here is a lower bound (most funds publish only
 * their top-5), so absence of a finding never certifies diversification. Full
 * rationale: docs/explanation/portfolio-health.md.
 */
export interface LookThrough {
  /**
   * Largest single underlying company as a % of the WHOLE book, summed across
   * every fund that holds it. A LOWER BOUND (top-5 captures a minority of NAV) —
   * present it as "at least". `null` when no underlying names resolved.
   */
  maxName: { label: string; pct: number; fundCount: number } | null;
  /**
   * Pairs of the user's funds whose published top holdings largely coincide —
   * effectively the same exposure bought twice. High-confidence even on thin
   * data, so it is not coverage-gated.
   */
  redundantPairs: { a: string; b: string }[];
  /** 0..1 — share of EQUITY book value with usable underlying-holdings data. */
  equityCoverage: number;
  /**
   * Equity region weight (pp) in excess of what the target plan implies, when
   * honestly derivable; `null` otherwise (region then surfaces as disclosure,
   * never a deduction). Coarse per-fund region data keeps this `null` today.
   */
  regionDivergencePp: number | null;
}

export interface ConcentrationSignal {
  top: { ticker: string; label: string; pct: number } | null;
  top3Pct: number;
  /** Herfindahl–Hirschman index over holding weights, 0..1 (1 = single fund). */
  hhi: number;
  holdingCount: number;
  /**
   * Largest single ALTERNATIVE holding as a % of the whole book (or `null`).
   * A large alternative position (one stock, one crypto, one REIT) is genuine
   * concentration; a large broad-index *equity* fund is not, so fund-level size
   * flags only this class. Underlying equity concentration comes from
   * `lookThrough`. See docs/explanation/portfolio-health.md § Diversification.
   */
  singleBet: { ticker: string; label: string; pct: number } | null;
  /** Underlying-exposure look-through, injected by the server; `null` if absent. */
  lookThrough: LookThrough | null;
}

export interface HealthSignals {
  totalValue: number;
  byClass: AllocationSlice[];
  byRegion: AllocationSlice[];
  drift: SleeveDrift[];
  /** Sum of overweights = half the total absolute deviation. "How far off target." */
  trackingGapPp: number;
  blendedTer: number;
  /** Number of holdings whose TER is unknown (null). Fee scoring ignores them. */
  unknownTerCount: number;
  targetTer: number | null;
  concentration: ConcentrationSignal;
  cashPct: number;
}

// Distinct, high-contrast donut/legend colors (the same readable palette family as
// the region chart) — one clearly separable hue per class. Mixed uses the region
// palette's rose so it stands apart from equity-green and bond-orange.
const ASSET_CLASS_META: Record<AssetClass, { label: string; color: string }> = {
  equity: { label: "Equity", color: "var(--accent)" },
  bond: { label: "Bonds", color: "#F4A434" },
  mixed: { label: "Mixed", color: "#C76A8F" },
  alternative: { label: "Alternatives", color: "#7C7CFF" },
  cash: { label: "Cash", color: "#9E9EA8" },
  unknown: { label: "Unclassified", color: "#A38A55" },
};

// Reserved cash (#149) — set-aside cash shown as its OWN slice, a darker shade of the
// cash grey so it reads as "cash, but earmarked".
const RESERVED_META = { label: "Reserved", color: "#6E6E7A" };

const REGION_COLORS = [
  "var(--accent)",
  "#F4A434",
  "#7C7CFF",
  "#C76A8F",
  "#5BA7B5",
  "#A38A55",
  "#9E9EA8",
];

function safePct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Allocation by asset class as ordered slices (only non-zero sleeves). Reserved cash
 * (#149 — accounts in `reservedTickers`) is pulled out of the Cash sleeve into its own
 * "Reserved" slice, so set-aside cash doesn't read as investable allocation.
 */
export function allocationByClass(
  holdings: Holding[],
  totalValue: number,
  reservedTickers?: ReadonlySet<string>,
): AllocationSlice[] {
  const groups = new Map<string, number>();
  for (const h of holdings) {
    const key =
      h.class === "cash" && reservedTickers?.has(h.ticker.trim().toUpperCase())
        ? "reserved"
        : h.class;
    groups.set(key, (groups.get(key) ?? 0) + h.value);
  }
  const order = ["equity", "bond", "mixed", "alternative", "cash", "reserved", "unknown"] as const;
  return order
    .map((key) => {
      const value = groups.get(key) ?? 0;
      const meta = key === "reserved" ? RESERVED_META : ASSET_CLASS_META[key];
      return { key, label: meta.label, value, pct: safePct(value, totalValue), color: meta.color };
    })
    .filter((s) => s.value > 0);
}

/** Allocation by region (fund-level — not fund look-through). */
export function allocationByRegion(holdings: Holding[], totalValue: number): AllocationSlice[] {
  const groups = new Map<string, number>();
  for (const h of holdings) {
    const region = h.region?.trim() || "Other";
    groups.set(region, (groups.get(region) ?? 0) + h.value);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      key: label,
      label,
      value,
      pct: safePct(value, totalValue),
      color: REGION_COLORS[i % REGION_COLORS.length],
    }));
}

/**
 * Per-sleeve drift between the actual portfolio (by ticker) and the target mix.
 * Mix slices that share a ticker (e.g. a bond fund split across maturities) are
 * summed. Tickers present in only one side are still surfaced (target 0 or
 * current 0). Sorted by magnitude of drift, largest first.
 */
export function computeDrift(
  holdings: Holding[],
  totalValue: number,
  targetMix: MixSlice[],
): SleeveDrift[] {
  const current = new Map<string, number>();
  for (const h of holdings) {
    current.set(h.ticker, (current.get(h.ticker) ?? 0) + h.value);
  }

  const target = new Map<string, { pct: number; label: string; color: string }>();
  for (const m of targetMix) {
    const key = m.ticker ?? m.label;
    const prev = target.get(key);
    target.set(key, {
      pct: (prev?.pct ?? 0) + m.pct,
      label: prev?.label ?? m.label,
      color: prev?.color ?? m.color,
    });
  }

  const tickers = new Set<string>([...current.keys(), ...target.keys()]);
  const rows: SleeveDrift[] = [];
  for (const ticker of tickers) {
    const currentPct = safePct(current.get(ticker) ?? 0, totalValue);
    const t = target.get(ticker);
    const targetPct = t?.pct ?? 0;
    rows.push({
      ticker,
      label: t?.label ?? ticker,
      color: t?.color ?? "var(--muted)",
      current: currentPct,
      target: targetPct,
      drift: currentPct - targetPct,
    });
  }
  return rows.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
}

/** Single-number "how far off target": sum of overweights = ½·Σ|drift|. */
export function trackingGap(drift: SleeveDrift[]): number {
  const overweight = drift.reduce((s, d) => s + Math.max(0, d.drift), 0);
  return Math.round(overweight * 10) / 10;
}

/**
 * Value-weighted total expense ratio (in %), computed over holdings with a
 * KNOWN ter only. Holdings with `ter == null` are excluded from both the
 * numerator and the denominator, so missing fee data neither inflates nor
 * deflates the blended rate (vs. the old `ter ?? 0`, which scored unknowns as
 * free). Returns 0 when no holding has a known ter.
 */
export function blendedTer(holdings: Holding[], _totalValue: number): number {
  const known = holdings.filter((h) => h.ter != null);
  const knownValue = known.reduce((s, h) => s + h.value, 0);
  if (knownValue <= 0) return 0;
  const weighted = known.reduce((s, h) => s + h.value * (h.ter as number), 0);
  return weighted / knownValue;
}

/** Count of holdings whose TER is unknown (null) — excluded from fee scoring. */
export function unknownTerCount(holdings: Holding[]): number {
  return holdings.filter((h) => h.ter == null).length;
}

export function concentration(
  holdings: Holding[],
  totalValue: number,
  lookThrough: LookThrough | null = null,
): ConcentrationSignal {
  const sorted = [...holdings].filter((h) => h.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted[0]
    ? {
        ticker: sorted[0].ticker,
        label: sorted[0].name || sorted[0].ticker,
        pct: safePct(sorted[0].value, totalValue),
      }
    : null;
  const top3Pct = sorted.slice(0, 3).reduce((s, h) => s + safePct(h.value, totalValue), 0);
  const hhi = sorted.reduce((s, h) => {
    const w = totalValue > 0 ? h.value / totalValue : 0;
    return s + w * w;
  }, 0);
  // Fund-level size only flags single ALTERNATIVE bets — a large broad-index
  // equity fund is not concentration risk (the underlying is diversified), so it
  // is excluded here and judged by look-through instead.
  const topAlt = sorted.find((h) => h.class === "alternative");
  const singleBet = topAlt
    ? {
        ticker: topAlt.ticker,
        label: topAlt.name || topAlt.ticker,
        pct: safePct(topAlt.value, totalValue),
      }
    : null;
  return { top, top3Pct, hhi, holdingCount: sorted.length, singleBet, lookThrough };
}

// ─── Concentration assessment ────────────────────────────────────────────────
// Coverage gates: look-through may ESCALATE concern but never GRANT comfort, and
// the louder a finding the more coverage it needs. See portfolio-health.md.
const COVERAGE_TRUSTED = 0.6; // ≥ this → a confirmed finding may reach "act"
const COVERAGE_PARTIAL = 0.4; // ≥ this (but < trusted) → "watch" at most, caveated
const NAME_ACT_PCT = 10; // book-level single-name weight that warrants "act"
const NAME_WATCH_PCT = 5; // …that warrants "watch"
const SINGLE_BET_ACT_PCT = 35; // a single alternative holding this large is concentration
const REGION_DIVERGENCE_WATCH_PP = 20; // equity region weight this far past plan → watch

export interface ConcentrationAssessment {
  status: HealthTone;
  /** One-line, plain-English reason for the status (the named-check detail). */
  reason: string;
  /** Concentration sub-score as a 0..1 fraction (score.ts scales it to points). */
  fraction: number;
}

const TONE_RANK: Record<HealthTone, number> = { good: 0, watch: 1, action: 2 };

/** Round a 0..1 coverage to a friendly "~NN%" phrase. */
function coveragePhrase(cov: number): string {
  return `~${Math.round(cov * 20) * 5}%`;
}

/**
 * Interpret the concentration signal into a single named-check status + reason,
 * worst-status-wins across the fund-level single-bet check and the coverage-gated
 * look-through checks. Pure — the look-through input is precomputed server-side.
 *
 * The fund-level value the UI shows (top fund %, top 3 %) is the certain fact;
 * this reason carries the look-through story, always hedged ("at least", "the
 * ~X% we can see") because underlying data is a lower bound.
 */
export function assessConcentration(c: ConcentrationSignal): ConcentrationAssessment {
  let status: HealthTone = "good";
  let reason = "";
  const promote = (s: HealthTone, r: string) => {
    if (TONE_RANK[s] > TONE_RANK[status] || (TONE_RANK[s] === TONE_RANK[status] && !reason)) {
      status = s;
      reason = r;
    }
  };

  // B2 — a single large ALTERNATIVE position (one stock, crypto, REIT…).
  const bet = c.singleBet;
  if (bet && bet.pct >= SINGLE_BET_ACT_PCT) {
    promote(
      "action",
      `${bet.ticker} is ${bet.pct.toFixed(0)}% of your book in a single alternative position — that concentrates risk in one bet.`,
    );
  }

  // B1 — look-through (coverage-gated). A finding may only fire where we can see.
  const lt = c.lookThrough;
  if (lt?.maxName) {
    const { label, pct, fundCount } = lt.maxName;
    const cov = lt.equityCoverage;
    const across = fundCount > 1 ? `, held across ${fundCount} funds` : "";
    if (cov >= COVERAGE_TRUSTED) {
      if (pct >= NAME_ACT_PCT) {
        promote(
          "action",
          `At least ${pct.toFixed(0)}% of your portfolio is ${label}${across} — more concentrated underneath than your fund list suggests.`,
        );
      } else if (pct >= NAME_WATCH_PCT) {
        promote(
          "watch",
          `At least ${pct.toFixed(0)}% of your portfolio is ${label}${across} — worth knowing your funds overlap here.`,
        );
      }
    } else if (cov >= COVERAGE_PARTIAL && pct >= NAME_WATCH_PCT) {
      // Partial sight: may reach "watch", never "act", and the copy says so.
      promote(
        "watch",
        `Based on the ${coveragePhrase(cov)} of your stocks we can see, at least ${pct.toFixed(0)}% is ${label}. Worth understanding.`,
      );
    }
    // cov < COVERAGE_PARTIAL → disclosure only; the pill stays on the fund-level fact.
  }

  // Redundant funds — high-confidence even on thin data, so not coverage-gated.
  if (lt && lt.redundantPairs.length > 0) {
    const p = lt.redundantPairs[0];
    const extra =
      lt.redundantPairs.length > 1 ? ` (and ${lt.redundantPairs.length - 1} more such pair)` : "";
    promote(
      "watch",
      `${p.a} and ${p.b} hold much the same thing${extra} — together they add less diversification than separate funds suggest.`,
    );
  }

  // Region — target-relative, capped at "watch". Dormant until region data deepens.
  if (lt && lt.regionDivergencePp != null && lt.regionDivergencePp > REGION_DIVERGENCE_WATCH_PP) {
    promote(
      "watch",
      `Your equity leans ${lt.regionDivergencePp.toFixed(0)}pp further into one region than your plan implies.`,
    );
  }

  if (status === "good") {
    reason = goodConcentrationReason(c);
  }

  const fraction = status === "good" ? 1 : status === "watch" ? 0.5 : 0.15;
  return { status, reason, fraction };
}

/** The calm, honest "nothing dominates" copy, scoped to what we could see. */
function goodConcentrationReason(c: ConcentrationSignal): string {
  const n = c.holdingCount;
  if (n === 0) return "No holdings yet.";
  const lt = c.lookThrough;
  const spread = n === 1 ? "Your book is a single fund" : `Spread across ${n} funds`;
  if (lt && lt.equityCoverage >= COVERAGE_TRUSTED && lt.maxName) {
    return `${spread}. Looking through the ${coveragePhrase(lt.equityCoverage)} we can see, no single company dominates.`;
  }
  if (lt?.maxName) {
    return `${spread}; the funds we can see into don't lean on any one company.`;
  }
  return `${spread}. Based on your fund mix — the funds underneath don't all publish their holdings.`;
}

export function cashWeight(holdings: Holding[], totalValue: number): number {
  const cash = holdings.filter((h) => h.class === "cash").reduce((s, h) => s + h.value, 0);
  return safePct(cash, totalValue);
}

export type HealthTone = "good" | "watch" | "action";

export interface HealthHeadline {
  tone: HealthTone;
  title: string;
  body: string;
  /** Seed text for the "Discuss" AI prompt. */
  prompt: string;
}

export interface RebalanceHint {
  /** Most overweight sleeve to trim, if any meaningfully exceeds target. */
  trim: SleeveDrift | null;
  /** Most underweight sleeve to add, if any meaningfully trails target. */
  add: SleeveDrift | null;
}

/** Largest overweight + underweight sleeve, ignoring drift within tolerance. */
export function rebalanceHint(drift: SleeveDrift[], tolerancePp = 1.5): RebalanceHint {
  const bySign = [...drift].sort((a, b) => b.drift - a.drift);
  const top = bySign[0];
  const bottom = bySign[bySign.length - 1];
  return {
    trim: top && top.drift > tolerancePp ? top : null,
    add: bottom && bottom.drift < -tolerancePp ? bottom : null,
  };
}

/**
 * Pick the single most important thing to surface, from objective signals only.
 * Priority: large drift → concentration → cash drag → fees → on-track.
 */
export function summarizeHealth(health: HealthSignals, targetName: string | null): HealthHeadline {
  const { trackingGapPp, concentration: c, cashPct, blendedTer: ter, drift } = health;

  if (targetName && trackingGapPp >= 5) {
    const { trim, add } = rebalanceHint(drift);
    const moves: string[] = [];
    if (trim) moves.push(`trim ${trim.ticker} (+${trim.drift.toFixed(1)}pp)`);
    if (add) moves.push(`add to ${add.ticker} (${add.drift.toFixed(1)}pp under)`);
    return {
      tone: "watch",
      title: `Your mix is ${trackingGapPp.toFixed(1)}pp off your ${targetName} target`,
      body: moves.length
        ? `Biggest gaps: ${moves.join(", ")}. A small rebalance brings you back in line.`
        : "A small rebalance would bring you back in line with your target weights.",
      prompt: `My portfolio has drifted ${trackingGapPp.toFixed(1)}pp from my ${targetName} target. Walk me through a rebalance.`,
    };
  }

  if (c.top && c.top.pct >= 35) {
    return {
      tone: "action",
      title: `${c.top.ticker} is ${c.top.pct.toFixed(0)}% of your book`,
      body: `A single fund driving this much of your portfolio concentrates risk. Your top 3 holdings are ${c.top3Pct.toFixed(0)}% combined.`,
      prompt: `${c.top.ticker} is ${c.top.pct.toFixed(0)}% of my portfolio. Is that too concentrated, and what would diversifying look like?`,
    };
  }

  if (cashPct >= 10) {
    return {
      tone: "watch",
      title: `${cashPct.toFixed(0)}% of your portfolio is in cash`,
      body: "Cash is a drag on long-term returns. If this isn't an earmarked reserve, putting it to work compounds over time.",
      prompt: `${cashPct.toFixed(0)}% of my portfolio is sitting in cash. Should I deploy it, and how?`,
    };
  }

  if (ter > 0) {
    const good = ter <= 0.75;
    return {
      tone: good ? "good" : "watch",
      title: `Blended fee of ${ter.toFixed(2)}% per year`,
      body: good
        ? "Your index-heavy mix keeps costs low — fees compound against you, so this is a real edge."
        : "On the higher side for an index investor. Cheaper index funds covering the same exposure could lift net returns.",
      prompt: `My blended expense ratio is ${ter.toFixed(2)}%. Is that reasonable, and where could I cut fees?`,
    };
  }

  return {
    tone: "good",
    title: targetName
      ? `Closely tracking your ${targetName} target`
      : "Your allocation looks balanced",
    body: "Nothing needs attention right now. Keep contributing and revisit on your rebalance cadence.",
    prompt: "Give me a quick health check on my portfolio.",
  };
}

/** Roll all signals up in one pass. `targetMix`/`targetTer` may be absent. */
export function computeHealth(
  holdings: Holding[],
  totalValue: number,
  targetMix: MixSlice[] | null,
  targetTer: number | null = null,
  lookThrough: LookThrough | null = null,
  reservedTickers?: ReadonlySet<string>,
): HealthSignals {
  const drift = targetMix ? computeDrift(holdings, totalValue, targetMix) : [];
  return {
    totalValue,
    byClass: allocationByClass(holdings, totalValue, reservedTickers),
    byRegion: allocationByRegion(holdings, totalValue),
    drift,
    trackingGapPp: trackingGap(drift),
    blendedTer: blendedTer(holdings, totalValue),
    unknownTerCount: unknownTerCount(holdings),
    targetTer,
    concentration: concentration(holdings, totalValue, lookThrough),
    cashPct: cashWeight(holdings, totalValue),
  };
}
