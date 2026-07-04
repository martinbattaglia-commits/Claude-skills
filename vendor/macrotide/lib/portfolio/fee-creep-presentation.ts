// Pure presentation logic for the Portfolio fee-check list (#74 §5). With ~10
// findings a flat amber wall is its own alert-fatigue surface, so we lead with a
// calm summary, show the top few in priority order, and tuck the rest behind a
// "N more" expander. No clock, no DB, no React — just ordering + slicing, so the
// screen and the tests share one source of truth.

export interface FeeCheckLike {
  /** The held fund's ticker — the stable identity for ordering ties. */
  heldTicker: string;
  /** Annual saving of the cheapest comparable alternative (pp/yr). Higher = worse. */
  savingsPp: number;
}

/** How many findings render as full cards before the "N more" expander. */
export const FEE_CHECK_TOP_N = 3;

/**
 * Order findings by severity — biggest annual saving (most wasted fee) first.
 * Ties break on ticker so the order is stable across renders. Pure; returns a
 * new array.
 */
export function orderFeeChecks<T extends FeeCheckLike>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => {
    if (b.savingsPp !== a.savingsPp) return b.savingsPp - a.savingsPp;
    return a.heldTicker.localeCompare(b.heldTicker);
  });
}

export interface FeeCheckPresentation<T extends FeeCheckLike> {
  /** Severity-ordered findings shown as full cards (up to `topN`). */
  top: T[];
  /** The lower-severity tail, default-collapsed behind a "N more" expander. */
  rest: T[];
  /** Count of the collapsed tail (`rest.length`) — the "N more" number. */
  moreCount: number;
  /**
   * A calm, no-deadline one-line summary. Empty string when there are no
   * findings (the caller renders nothing). Singular/plural aware.
   */
  summary: string;
}

/**
 * Split severity-ordered findings into a top-N head + collapsed tail and build
 * the calm summary line. The tone is deliberately no-nag — a passive investor
 * has no deadline on a fee flag, so the copy says "review when you have time",
 * never "N to-dos".
 */
export function presentFeeChecks<T extends FeeCheckLike>(
  findings: readonly T[],
  topN: number = FEE_CHECK_TOP_N,
): FeeCheckPresentation<T> {
  const ordered = orderFeeChecks(findings);
  const top = ordered.slice(0, Math.max(0, topN));
  const rest = ordered.slice(Math.max(0, topN));
  return {
    top,
    rest,
    moreCount: rest.length,
    summary: feeCheckSummary(ordered.length),
  };
}

/**
 * The honest intro line for the inline fee-check section: it always reflects the
 * TRUE total (`total`), never the capped count shown. Singular/plural aware.
 * Empty when there are none.
 */
export function feeCheckInlineIntro(total: number): string {
  if (total <= 0) return "";
  if (total === 1) {
    return "One of your funds has a cheaper alternative offering comparable exposure.";
  }
  return `${total} of your funds have cheaper alternatives offering comparable exposure.`;
}

/**
 * The "See details" button label for the inline fee-check section. When the
 * section is capped — more findings exist than the `shown` cards — the label
 * carries the true total so the count lives on the one action that reveals them
 * (e.g. "See all 11"). When nothing is hidden (`total <= shown`) it is the plain
 * "See details". Pure; the screen and its tests share this one source of truth.
 */
export function feeChecksButtonLabel(total: number, shown: number): string {
  if (total > shown) return `See all ${total}`;
  return "See details";
}

/** The calm one-line summary for `n` fee checks. Empty when there are none. */
export function feeCheckSummary(n: number): string {
  if (n <= 0) return "";
  if (n === 1) {
    return "One fund has a cheaper equivalent — review when you have time.";
  }
  return `${n} funds have cheaper equivalents — review when you have time.`;
}

// ─── Per-card helpers (slim summary list + detail overlay) ──────────────────────
// The list card shows only the held fund + a one-line saving summary and two
// buttons (Ask advisor / See details). The fee comparison and the
// Archive / "Not for me" controls live in the detail overlay. These pure helpers
// build the card's summary string and the per-fund Advisor prompt so the screen
// and its tests share one source of truth.

/** Minimal shape the card summary + Advisor prompt read off a fee-creep finding. */
export interface FeeCheckCardLike {
  heldTicker: string;
  heldName: string;
  heldTer: number;
  assetClass: string | null;
  savingsPp: number;
  alternatives: { abbrName: string; englishName: string | null; ter: number }[];
}

/**
 * The card's one-line saving summary, e.g. "≈0.45pp/yr cheaper available". The
 * magnitude is the `savingsPp` already on the finding (annual saving in
 * percentage points). We do not quote a baht figure — a fee-creep finding
 * carries no holding value, so a "฿N/yr" number would be invented; the pp/yr
 * figure is the honest, available one. Empty when there is no cheaper peer.
 */
export function feeCheckCardSummary(finding: Pick<FeeCheckCardLike, "savingsPp">): string {
  if (finding.savingsPp <= 0) return "";
  return `≈${finding.savingsPp.toFixed(2)}pp/yr cheaper available`;
}

/** A per-fund Advisor prompt: the display text, the send text, and the carried context. */
export interface FeeSwitchPrompt {
  display: string;
  send: string;
  context: {
    screen: "portfolio";
    intent: "fee_switch";
    subject: string;
    signals: {
      heldTer: number;
      alternative: string;
      altTer: number;
      assetClass: string;
    };
  };
}

/**
 * Build the per-fund "Ask advisor" prompt for one fee check, scoped to the held
 * fund and its cheapest comparable alternative. The fee comparison is already on
 * screen, so the carried `context.signals` lets the Advisor reason about the
 * switch without re-reading holdings. Returns null when the finding has no
 * alternative to switch into.
 */
export function feeSwitchPrompt(finding: FeeCheckCardLike): FeeSwitchPrompt | null {
  const alt = finding.alternatives[0];
  if (!alt) return null;
  const altTer = alt.ter ?? 0;
  const assetClass = finding.assetClass ?? "same-class";
  const prompt = `I hold ${finding.heldTicker} at a ${finding.heldTer.toFixed(2)}% TER. ${alt.abbrName} offers comparable ${assetClass} exposure at ${altTer.toFixed(2)}%. Walk me through what it would take to switch, and whether the saving justifies the move.`;
  return {
    display: prompt,
    send: prompt,
    context: {
      screen: "portfolio",
      intent: "fee_switch",
      subject: finding.heldTicker,
      signals: {
        heldTer: Number(finding.heldTer.toFixed(2)),
        alternative: alt.abbrName,
        altTer: Number(altTer.toFixed(2)),
        assetClass,
      },
    },
  };
}
