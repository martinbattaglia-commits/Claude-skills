// Tool-result shaping (#60) — compact, model-legible views of the heavy advisor
// reads. The AI SDK streams a tool's full `execute` return to the UI, but lets a
// tool expose a SEPARATE model-facing view via `toModelOutput`. read_portfolio /
// read_performance / find_funds / find_cheaper_alternatives return large
// structured objects (allocation + drift + concentration + headline, or a
// many-field fund list); the model only needs the few figures the answer turns
// on. These pure functions produce that lean view — keeping the headline facts
// (largest holding, drift direction, blended fee, the benchmark gap, each fund's
// TER) and dropping JSON scaffolding, redundant labels, and fields no answer
// uses (HHI, tone, project ids).
//
// Why it matters: for a small free-tier model fewer tool tokens means less
// context rot and a lower empty-turn dead-end rate (#21) — the
// highest-leverage token move per docs/explanation/inference-strategy.md §5.
// Anthropic's own concise-vs-detailed example cut a tool result ~66%.
//
// These are PURE (no server-only, no DB) so both lib/advisor/tools.ts and the
// committed eval (scripts/eval) attach the exact same shapers — one source of
// truth for what the model sees.

const num = (
  n: number | null | undefined,
  opts: { pct?: boolean; sign?: boolean } = {},
): string => {
  if (n == null) return "n/a";
  const s = opts.sign && n >= 0 ? "+" : "";
  return `${s}${n}${opts.pct ? "%" : ""}`;
};

// ─── read_portfolio ─────────────────────────────────────────────────────────

/**
 * Compact per-portfolio (per-bucket) summary in the aggregate readout's
 * `byBucket` list — the few figures a "review all my portfolios" answer turns
 * on, each scored against that portfolio's OWN target model. `irrPct` is the
 * money-weighted (annualized) return; null with `irrUnavailable` saying why.
 */
export interface BucketSummary {
  bucketId: string;
  name: string;
  typeLabel: string | null;
  totalValue: number;
  pctOfTotal: number;
  targetModel: string | null;
  topClass: { label: string; pct: number } | null;
  trackingGapPp: number | null;
  blendedTer: number;
  topHolding: { ticker: string; pct: number } | null;
  cashPct: number;
  realized: number | null;
  irrPct: number | null;
  irrUnavailable: string | null;
}

export interface PortfolioOutput {
  hasHoldings: boolean;
  totalValue: number;
  baseCurrency: string;
  targetModel: string | null;
  byClass: { label: string; pct: number }[];
  byRegion: { label: string; pct: number }[];
  drift: { ticker: string | null; label: string; current: number; target: number; drift: number }[];
  trackingGapPp: number | null;
  blendedTer: number;
  targetTer: number | null;
  concentration: {
    top: { ticker: string; label: string; pct: number } | null;
    top3Pct: number;
    hhi: number;
    holdingCount: number;
    status?: string;
    reason?: string;
    lookThrough?: {
      topName: { label: string; atLeastPct: number; fundCount: number } | null;
      redundantPairs: { a: string; b: string }[];
      equityCoverage: number;
    } | null;
  };
  cashPct: number;
  // Lifetime ledger analytics — mirrors the History screen's KPI cards so a
  // spoken answer matches what the user sees. null only when there are no
  // holdings. `irrPct` is the money-weighted (annualized) return in percent;
  // when it can't be computed `irrUnavailable` says why (and irrPct is null).
  ledger: {
    invested: number;
    realized: number;
    income: number;
    irrPct: number | null;
    irrUnavailable: string | null;
  } | null;
  // Holdings priced from the user's own last-entered price (quote_source
  // "manual"), not a live feed — the model must flag these as user-supplied.
  customHoldings: { ticker: string; label: string; pct: number }[];
  // Present only when read_portfolio was called with a `ticker` — that one
  // fund's ledger analytics (same figures, scoped to its events).
  position: {
    ticker: string;
    invested: number;
    realized: number;
    income: number;
    irrPct: number | null;
    irrUnavailable: string | null;
    marketValue: number | null;
    units: number;
  } | null;
  headline: { tone: string; title: string; body: string };
  // Per-portfolio breakdown — present on the aggregate readout when the user has
  // more than one portfolio. Each entry is scored against its own target.
  byBucket?: BucketSummary[];
  // Present when read_portfolio was scoped to a single portfolio by name/id —
  // the readout above is just that one portfolio.
  scope?: { bucketId: string; name: string; typeLabel: string | null };
  message: string;
}

export function portfolioModelText(o: PortfolioOutput): string {
  if (!o.hasHoldings) return o.message;
  const drift =
    o.drift
      .filter((d) => Math.abs(d.drift) >= 0.1)
      .map((d) => `${d.ticker ?? d.label} ${num(d.drift, { sign: true })}pp`)
      .join(", ") || "all sleeves on target";
  const top = o.concentration.top;
  // A scoped readout names the one portfolio; the aggregate stays "Portfolio".
  const head = o.scope ? `"${o.scope.name}" portfolio` : "Portfolio";
  return [
    `${head} ฿${o.totalValue.toLocaleString()} (${o.baseCurrency}); target model: ${o.targetModel ?? "none set"}.`,
    `By class: ${o.byClass.map((c) => `${c.label} ${c.pct}%`).join(", ")}.`,
    `By region: ${o.byRegion.map((c) => `${c.label} ${c.pct}%`).join(", ")}.`,
    `Drift vs target: ${drift}.`,
    `Blended fee ${o.blendedTer}%${o.targetTer != null ? ` (target ${o.targetTer}%)` : ""}${
      o.trackingGapPp != null ? `; tracking gap ${o.trackingGapPp}pp` : ""
    }.`,
    `Concentration: ${top ? `largest ${top.ticker} ${top.pct}%` : "n/a"}, top-3 ${o.concentration.top3Pct}%, ${o.concentration.holdingCount} holdings; cash ${o.cashPct}%.`,
    concentrationLine(o.concentration),
    ledgerLine(o.ledger),
    customLine(o.customHoldings),
    positionLine(o.position),
    byBucketLines(o.byBucket),
    `${o.headline.title} — ${o.headline.body}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The per-portfolio breakdown for a "review all my portfolios" turn — one tight
 * line per portfolio so the model can compare them and spot the laggard without
 * a separate tool call each. Money-weighted return leads (it's what "low return"
 * questions turn on); drift/fee follow. Omitted when there's a single portfolio.
 */
function byBucketLines(rows: BucketSummary[] | undefined): string | null {
  if (!rows || rows.length === 0) return null;
  const lines = rows.map((b) => {
    const ret =
      b.irrPct != null
        ? `${num(b.irrPct, { pct: true, sign: true })} money-weighted`
        : "return n/a";
    const cls = b.topClass ? `${b.topClass.label} ${b.topClass.pct}%` : "no allocation";
    const gap = b.trackingGapPp != null ? `, gap ${b.trackingGapPp}pp` : "";
    return `- ${b.name}${b.typeLabel ? ` (${b.typeLabel})` : ""}: ฿${b.totalValue.toLocaleString()} (${b.pctOfTotal}% of total), ${ret}; ${cls}${gap}, fee ${b.blendedTer}%, cash ${b.cashPct}%.`;
  });
  return `Per-portfolio breakdown:\n${lines.join("\n")}`;
}

const baht = (n: number) => `฿${n.toLocaleString()}`;
const bahtSigned = (n: number) => `${n < 0 ? "−" : "+"}฿${Math.abs(n).toLocaleString()}`;
const mwReturn = (irrPct: number | null, why: string | null) =>
  irrPct != null
    ? `money-weighted return ${num(irrPct, { pct: true, sign: true })}`
    : `money-weighted return n/a (${why ?? "unavailable"})`;

/** Lifetime ledger figures (invested / realized / income / money-weighted return). */
function ledgerLine(l: PortfolioOutput["ledger"]): string | null {
  if (!l) return null;
  return `Lifetime ledger: invested ${baht(l.invested)} (cost basis), realized ${bahtSigned(l.realized)}, income ${baht(l.income)}, ${mwReturn(l.irrPct, l.irrUnavailable)}.`;
}

/**
 * Self-priced (custom) holdings — valued from the user's last-entered price, not
 * a live feed. Stated tersely; the system prompt carries the full caveat.
 */
function customLine(custom: PortfolioOutput["customHoldings"]): string | null {
  if (!custom.length) return null;
  const list = custom.map((c) => `${c.ticker} ${c.pct}%`).join(", ");
  return `Self-priced (custom) holdings (user-set price, not a live feed): ${list}.`;
}

/** Per-fund ledger analytics, present only when a `ticker` was requested. */
function positionLine(p: PortfolioOutput["position"]): string | null {
  if (!p) return null;
  const value = p.marketValue == null ? "value unpriced" : `value ${baht(p.marketValue)}`;
  return `Fund ${p.ticker}: invested ${baht(p.invested)}, realized ${bahtSigned(p.realized)}, income ${baht(p.income)}, ${mwReturn(p.irrPct, p.irrUnavailable)}; ${value} (${p.units} units).`;
}

/** Underlying-exposure look-through line for the model — omitted when absent. */
function concentrationLine(c: PortfolioOutput["concentration"]): string | null {
  const lt = c.lookThrough;
  if (!c.reason && !lt) return null;
  const parts: string[] = [];
  if (c.status && c.reason) parts.push(`Diversification (${c.status}): ${c.reason}`);
  if (lt) {
    if (lt.topName) {
      parts.push(
        `look-through: ≥${lt.topName.atLeastPct}% in ${lt.topName.label} across ${lt.topName.fundCount} fund(s)`,
      );
    }
    if (lt.redundantPairs.length) {
      parts.push(`redundant: ${lt.redundantPairs.map((p) => `${p.a}≈${p.b}`).join(", ")}`);
    }
    parts.push(`equity look-through coverage ~${Math.round(lt.equityCoverage * 100)}%`);
  }
  return parts.join("; ") || null;
}

// ─── read_performance ───────────────────────────────────────────────────────
export type PerformanceOutput =
  | { hasData: false; range: string; message: string; scope?: { name: string } | null }
  | {
      hasData: true;
      range: string;
      startDate: string;
      endDate: string;
      periodReturnPct: number | null;
      benchmarks: { label: string; returnPct: number | null; beating: boolean | null }[];
      // Present when the return was scoped to a single portfolio by name/id.
      scope?: { bucketId: string; name: string } | null;
      message: string;
    };

export function performanceModelText(o: PerformanceOutput): string {
  if (!o.hasData) return o.message;
  const benches = o.benchmarks
    .map((b) => {
      const dir = b.beating == null ? "" : b.beating ? " (beating)" : " (trailing)";
      return `${b.label} ${num(b.returnPct, { pct: true, sign: true })}${dir}`;
    })
    .join(", ");
  const head = o.scope ? `"${o.scope.name}" portfolio` : "Portfolio";
  return `${head} ${num(o.periodReturnPct, { pct: true, sign: true })} over ${o.range} (${o.startDate}→${o.endDate}). Benchmarks: ${benches}.`;
}

// ─── find_funds ─────────────────────────────────────────────────────────────
export interface FundsOutput {
  count: number;
  funds: {
    abbr: string;
    terLabel: string;
    isIndex: boolean;
    taxIncentiveType: string | null;
    investRegion: string | null;
    isFeederFund: boolean;
  }[];
  cheapestAbbr?: string | null;
  /** How the list is ordered — relevance when a text query was used. */
  ordering?: string;
  message: string;
}

function fundLine(f: FundsOutput["funds"][number]): string {
  const tags = [
    f.isIndex ? "index" : null,
    f.taxIncentiveType,
    f.investRegion,
    f.isFeederFund ? "feeder" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${f.abbr}: ${f.terLabel}${tags ? ` (${tags})` : ""}`;
}

export function fundsModelText(o: FundsOutput): string {
  if (!o.count) return o.message;
  const head = `${o.count} fund(s), ${o.ordering ?? "cheapest first"}${o.cheapestAbbr ? ` (lowest TER: ${o.cheapestAbbr})` : ""}:`;
  return `${head}\n${o.funds.map(fundLine).join("\n")}`;
}

// ─── find_cheaper_alternatives ──────────────────────────────────────────────
export interface CheaperOutput {
  count: number;
  alternatives: {
    abbr: string;
    terLabel: string;
    isIndex: boolean;
    investRegion: string | null;
  }[];
  referenceAbbr?: string;
  message: string;
}

export function cheaperModelText(o: CheaperOutput): string {
  if (!o.count) return o.message;
  const lines = o.alternatives.map((f) => {
    const tags = [f.isIndex ? "index" : null, f.investRegion].filter(Boolean).join(", ");
    return `- ${f.abbr}: ${f.terLabel}${tags ? ` (${tags})` : ""}`;
  });
  return `Cheaper than ${o.referenceAbbr ?? "the held fund"} (${o.count}, cheapest first):\n${lines.join("\n")}`;
}

/**
 * Keyed shapers so callers (the real tools, the eval) attach the same view by
 * name. Each takes a tool's `execute` output and returns the compact model text.
 */
export const shapeForModel = {
  portfolio: portfolioModelText,
  performance: performanceModelText,
  funds: fundsModelText,
  cheaper: cheaperModelText,
} as const;
