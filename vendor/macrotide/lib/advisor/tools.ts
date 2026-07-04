// AI SDK tool surface for advisor actions. These give the chat model
// READ access to the user's real portfolio / plan / journal, a WRITE for
// journal notes, and a single PROPOSE tool for plan edits that does NOT mutate
// — it emits a proposal the ChatScreen renders as a PlanProposalCard, applied
// only when the user clicks Accept (see lib/portfolio/apply-plan-edit.ts and
// POST /api/plan/edit). Mirrors the AI SDK `tool()` shape used by the memory
// tools (lib/memory/tools.ts).
//
// All reads/writes resolve through the request's DB context, so they're
// automatically per-user scoped (ownedBy/ownerId) — never bypass it.
import { tool } from "ai";
import { z } from "zod";
import { type Bucket, listBuckets } from "../db/queries/buckets";
import {
  canonicalTicker,
  findFunds,
  getCheaperAlternatives,
  getFundsByAbbr,
} from "../db/queries/funds";
import { listHeldQuoteKeys, listHoldings } from "../db/queries/holdings";
import { createJournalEntry, type JournalKind, listJournalEntries } from "../db/queries/journal";
import { getModelPortfolio } from "../db/queries/models";
import { getPlan } from "../db/queries/plan";
import { listFundQuotes } from "../db/queries/quotes";
import { getPortfolioSeries } from "../db/queries/series";
import { listTransactionsForBuckets, type Transaction } from "../db/queries/transactions";
import { findUsSecurities } from "../db/queries/us-securities";
import { BENCHMARK_TR_OPTIONS, getBenchmarkReturnPct } from "../market/benchmarks";
import { QUOTE_SOURCES } from "../market/sources";
import { cleanUsSecurityName } from "../market/us-security-name";
import { adaptModelPortfolio, adaptPortfolios } from "../portfolio/adapter";
import { deriveRowsWithNav } from "../portfolio/derive-rows";
import { assessConcentration, computeHealth, summarizeHealth } from "../portfolio/health";
import { computeLookThrough } from "../portfolio/look-through";
import type { ExtractedRow } from "../portfolio/ocr";
import { parsePlan } from "../portfolio/plan-parser";
import { computeTransactionAnalytics } from "../portfolio/transaction-analytics";
import type { Holding as AdapterHolding, ModelPortfolio } from "../static/types";
import {
  type BucketSummary,
  type CheaperOutput,
  type FundsOutput,
  type PerformanceOutput,
  type PortfolioOutput,
  shapeForModel,
} from "./shape";

const JOURNAL_KINDS = ["note", "decision", "question", "reading"] as const;
const PERF_RANGES = ["1mo", "3mo", "6mo", "1y", "5y", "max"] as const;

export interface AdvisorToolOptions {
  // Single owner: null. Multi-user threads the authenticated user id.
  // Carried for symmetry with createMemoryTools; the query layer reads the
  // owner from the DB context (ownedBy), so we don't pass it down explicitly.
  userId: string | null;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ─── per-portfolio scoping helpers (Wave 1) ─────────────────────────────────
//
// The Advisor's portfolios are `buckets`. read_portfolio used to flatten every
// bucket into one aggregate, so it could not answer "what about my Tax
// portfolio?" or "review each of my portfolios". These helpers let one readout
// be computed for the WHOLE book (aggregate) OR scoped to a single bucket —
// each scored against THAT bucket's own target model — and a compact per-bucket
// summary for the aggregate's `byBucket` list.

/**
 * Resolve a free-text portfolio reference (what the user said — "Tax", a bucket
 * id, a partial name) to a bucket. Tries id, then case-insensitive exact name,
 * then a contains-match, then the type label. Null when nothing matches.
 */
function resolveBucket(buckets: Bucket[], ref: string): Bucket | null {
  const q = ref.trim().toLowerCase();
  if (!q) return null;
  return (
    buckets.find((b) => b.id.toLowerCase() === q) ??
    buckets.find((b) => b.name.toLowerCase() === q) ??
    buckets.find((b) => b.name.toLowerCase().includes(q)) ??
    buckets.find((b) => (b.typeLabel ?? "").toLowerCase().includes(q)) ??
    null
  );
}

/** A bucket's OWN target model (per-bucket honesty — no fallback to a global). */
function bucketTarget(b: Bucket): ModelPortfolio | null {
  if (!b.targetModelId) return null;
  const m = getModelPortfolio(b.targetModelId);
  return m ? adaptModelPortfolio(m) : null;
}

interface ReadoutArgs {
  holdings: AdapterHolding[];
  target: ModelPortfolio | null;
  txns: Transaction[];
  asOf: string;
  /** Tail of the `message` (e.g. how many buckets); the count prefix is shared. */
  scopeLabel: string;
  /** Optional held symbol → also return that one fund's ledger analytics. */
  ticker?: string;
}

/**
 * Compute the full portfolio readout (allocation, drift vs `target`, blended
 * fee, concentration + look-through, lifetime ledger analytics, optional
 * single-fund position) for a given set of holdings + ledger events. Used for
 * the aggregate (all holdings, global target) and for a single scoped bucket
 * (its holdings, its own target). The returned shape is the model-facing
 * PortfolioOutput body minus `byBucket`/`scope`, which the tool adds.
 */
async function buildReadout(
  args: ReadoutArgs,
): Promise<Omit<PortfolioOutput, "byBucket" | "scope"> & { ok: true }> {
  const { holdings: allHoldings, target, txns: allTxns, asOf, scopeLabel, ticker } = args;
  const totalValue = allHoldings.reduce((s, h) => s + h.value, 0);

  const lookThrough = computeLookThrough(allHoldings);
  const health = computeHealth(
    allHoldings,
    totalValue,
    target?.mix ?? null,
    target?.ter ?? null,
    lookThrough,
  );
  const headline = summarizeHealth(health, target?.name ?? null);
  const concAssessment = assessConcentration(health.concentration);

  const toLedger = (a: Awaited<ReturnType<typeof computeTransactionAnalytics>>) => ({
    invested: round(a.costBasisTotal),
    realized: round(a.realizedTotal),
    income: round(a.incomeTotal),
    irrPct: a.irr == null ? null : round(a.irr * 100, 1),
    irrUnavailable: a.irrUnavailable,
  });

  const ledger =
    allHoldings.length > 0
      ? toLedger(await computeTransactionAnalytics(allTxns, { method: "average", asOf }))
      : null;

  const customHoldings =
    totalValue > 0
      ? allHoldings
          .filter((h) => h.quoteSource === "manual")
          .map((h) => ({
            ticker: h.ticker,
            label: h.name,
            pct: round((h.value / totalValue) * 100, 1),
          }))
      : [];

  let position: PortfolioOutput["position"] = null;
  let tickerNote = "";
  if (ticker) {
    const want = ticker.trim().toUpperCase();
    const fundTxns = allTxns.filter((t) => t.ticker.toUpperCase() === want);
    if (fundTxns.length > 0) {
      const a = await computeTransactionAnalytics(fundTxns, { method: "average", asOf });
      const units = a.positions.reduce((s, p) => s + (p.units > 0 ? p.units : 0), 0);
      position = {
        // Report the ticker in its STORED (official/typed) case, not upper (#235).
        ticker: fundTxns[0].ticker,
        ...toLedger(a),
        marketValue: a.marketValue == null ? null : round(a.marketValue),
        units: round(units, 4),
      };
    } else {
      tickerNote = ` No ledger events for "${want}" — the user may not hold it.`;
    }
  }

  return {
    ok: true as const,
    hasHoldings: allHoldings.length > 0,
    totalValue: round(totalValue),
    baseCurrency: "THB",
    targetModel: target?.name ?? null,
    byClass: health.byClass.map((s) => ({ label: s.label, pct: round(s.pct, 1) })),
    byRegion: health.byRegion.map((s) => ({ label: s.label, pct: round(s.pct, 1) })),
    drift: health.drift.map((d) => ({
      ticker: d.ticker,
      label: d.label,
      current: round(d.current, 1),
      target: round(d.target, 1),
      drift: round(d.drift, 1),
    })),
    trackingGapPp: health.trackingGapPp,
    blendedTer: round(health.blendedTer, 3),
    targetTer: health.targetTer,
    concentration: {
      top: health.concentration.top
        ? {
            ticker: health.concentration.top.ticker,
            label: health.concentration.top.label,
            pct: round(health.concentration.top.pct, 1),
          }
        : null,
      top3Pct: round(health.concentration.top3Pct, 1),
      hhi: round(health.concentration.hhi, 3),
      holdingCount: health.concentration.holdingCount,
      status: concAssessment.status,
      reason: concAssessment.reason,
      lookThrough: health.concentration.lookThrough
        ? {
            topName: health.concentration.lookThrough.maxName
              ? {
                  label: health.concentration.lookThrough.maxName.label,
                  atLeastPct: round(health.concentration.lookThrough.maxName.pct, 1),
                  fundCount: health.concentration.lookThrough.maxName.fundCount,
                }
              : null,
            redundantPairs: health.concentration.lookThrough.redundantPairs,
            equityCoverage: round(health.concentration.lookThrough.equityCoverage, 2),
          }
        : null,
    },
    cashPct: round(health.cashPct, 1),
    ledger,
    customHoldings,
    position,
    headline: { tone: headline.tone, title: headline.title, body: headline.body },
    message: allHoldings.length
      ? `Read ${allHoldings.length} holding(s) ${scopeLabel}; total ฿${round(totalValue).toLocaleString()}.${tickerNote}`
      : "The user has no holdings yet — suggest adding some before analysis.",
  };
}

/**
 * Compact per-bucket summary for the aggregate readout's `byBucket` list — the
 * few figures a "review all my portfolios" answer turns on, scored against each
 * bucket's OWN target. Lighter than a full readout (no look-through detail) so N
 * buckets stay cheap; the model drills into one with read_portfolio({portfolio}).
 */
async function buildBucketSummary(
  bucket: Bucket,
  holdings: AdapterHolding[],
  txns: Transaction[],
  grandTotal: number,
  asOf: string,
): Promise<BucketSummary> {
  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const target = bucketTarget(bucket);
  const health = computeHealth(
    holdings,
    totalValue,
    target?.mix ?? null,
    target?.ter ?? null,
    null,
  );
  const a =
    holdings.length > 0
      ? await computeTransactionAnalytics(txns, { method: "average", asOf })
      : null;
  return {
    bucketId: bucket.id,
    name: bucket.name,
    typeLabel: bucket.typeLabel ?? null,
    totalValue: round(totalValue),
    pctOfTotal: grandTotal > 0 ? round((totalValue / grandTotal) * 100, 1) : 0,
    targetModel: target?.name ?? null,
    topClass: health.byClass[0]
      ? { label: health.byClass[0].label, pct: round(health.byClass[0].pct, 1) }
      : null,
    trackingGapPp: health.trackingGapPp,
    blendedTer: round(health.blendedTer, 3),
    topHolding: health.concentration.top
      ? { ticker: health.concentration.top.ticker, pct: round(health.concentration.top.pct, 1) }
      : null,
    cashPct: round(health.cashPct, 1),
    realized: a ? round(a.realizedTotal) : null,
    irrPct: a?.irr == null ? null : round(a.irr * 100, 1),
    irrUnavailable: a?.irrUnavailable ?? null,
  };
}

export function createAdvisorTools({ userId }: AdvisorToolOptions) {
  void userId; // scoping is enforced by the DB context, not this argument.

  const read_portfolio = tool({
    description:
      "Read the user's REAL portfolio: total value, allocation by asset class " +
      "and region, per-sleeve drift from their target model, blended (value-" +
      "weighted) expense ratio, concentration (largest holding, top-3, HHI), " +
      "and cash drag. ALSO returns lifetime ledger analytics — money invested " +
      "(contributions), realized gains/losses, income (dividends), and the " +
      "money-weighted (annualized) return — plus a flag for any custom, " +
      "self-priced holdings. Use this before answering anything about how " +
      "they're doing, their mix, fees, concentration, realized/unrealized " +
      "gains, or rebalancing. Numbers are computed deterministically from the " +
      "ledger — never invent figures.\n" +
      "The user keeps SEPARATE portfolios (e.g. 'Tax', 'Retirement'). By default " +
      "this returns the WHOLE-BOOK aggregate PLUS a per-portfolio breakdown " +
      "(`byBucket`: each portfolio's value, mix, drift, fee, and money-weighted " +
      "return) — call it with NO arguments to review ALL portfolios at once. " +
      "To focus ONE portfolio (e.g. 'how is my Tax portfolio doing?'), pass " +
      "`portfolio` with its name or id; the readout is then scoped to just that " +
      "portfolio and scored against ITS OWN target model.",
    inputSchema: z.object({
      portfolio: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional: focus a SINGLE portfolio by its name (what the user calls " +
            "it, e.g. 'Tax', 'Retirement') or its bucket id. A partial name " +
            "matches. Omit to get the aggregate + the per-portfolio breakdown.",
        ),
      ticker: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional: a held fund/ETF/stock symbol (exactly as it appears in the " +
            "portfolio) to ALSO return that one fund's realized P/L, income, " +
            "invested, and money-weighted return.",
        ),
    }),
    // Model sees a compact text view (#60); the UI still gets the full object.
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: shapeForModel.portfolio(output as PortfolioOutput),
    }),
    execute: async ({ portfolio, ticker }) => {
      const buckets = listBuckets();
      const holdings = listHoldings();
      const quotes = listFundQuotes(listHeldQuoteKeys());
      const portfolios = adaptPortfolios(buckets, holdings, quotes);

      // Lifetime ledger analytics mirror the History/Position screens' KPI cards
      // so a spoken answer matches what the user sees (computeTransactionAnalytics
      // is the same orchestrator /api/transactions/analytics uses).
      const asOf = new Date().toISOString().slice(0, 10);
      const bucketIds = buckets.map((b) => b.id);
      const allTxns = bucketIds.length > 0 ? listTransactionsForBuckets(bucketIds) : [];

      // ── Single-portfolio scope ──────────────────────────────────────────
      if (portfolio) {
        const bucket = resolveBucket(buckets, portfolio);
        if (!bucket) {
          const known = buckets.map((b) => b.name).join(", ") || "none yet";
          const empty = await buildReadout({
            holdings: [],
            target: null,
            txns: [],
            asOf,
            scopeLabel: "",
          });
          return {
            ...empty,
            message: `No portfolio matching "${portfolio}". The user's portfolios are: ${known}.`,
          };
        }
        const scoped = portfolios.find((p) => p.id === bucket.id);
        const scopedHoldings = scoped?.holdings ?? [];
        const scopedTxns = allTxns.filter((t) => t.bucketId === bucket.id);
        const readout = await buildReadout({
          holdings: scopedHoldings,
          target: bucketTarget(bucket),
          txns: scopedTxns,
          asOf,
          ticker,
          scopeLabel: `in the "${bucket.name}" portfolio`,
        });
        return {
          ...readout,
          scope: { bucketId: bucket.id, name: bucket.name, typeLabel: bucket.typeLabel ?? null },
        };
      }

      // ── Aggregate + per-portfolio breakdown ─────────────────────────────
      const allHoldings = portfolios.flatMap((p) => p.holdings);
      const grandTotal = allHoldings.reduce((s, h) => s + h.value, 0);

      const plan = getPlan();
      const model = plan?.selectedModelId ? getModelPortfolio(plan.selectedModelId) : undefined;
      const target = model ? adaptModelPortfolio(model) : null;

      const readout = await buildReadout({
        holdings: allHoldings,
        target,
        txns: allTxns,
        asOf,
        ticker,
        scopeLabel: `across ${buckets.length} portfolio(s)`,
      });

      // Per-portfolio breakdown — only when there's more than one portfolio (a
      // single-portfolio user's aggregate already IS that portfolio).
      const byBucket =
        buckets.length > 1
          ? await Promise.all(
              portfolios.map((p) => {
                const b = buckets.find((x) => x.id === p.id) as Bucket;
                const txns = allTxns.filter((t) => t.bucketId === p.id);
                return buildBucketSummary(b, p.holdings, txns, grandTotal, asOf);
              }),
            )
          : undefined;

      return { ...readout, byBucket };
    },
  });

  const read_performance = tool({
    description:
      "Read how the user's portfolio has PERFORMED over a period: its value at " +
      "the start and end of the range, the total return %, AND the same-period " +
      "return of reference indices (SET, S&P 500) — so you can answer 'am I " +
      "matching / beating my index?' with real numbers. Call this for any " +
      "question about returns, performance, or keeping up with an index. " +
      "Computed from the user's real NAV history; never invent performance " +
      "figures. Benchmark returns are best-effort — if an index is temporarily " +
      "unavailable its return comes back null; say so rather than guessing.\n" +
      "Defaults to the WHOLE book. To check ONE portfolio's return (e.g. 'is my " +
      "Tax portfolio lagging?'), pass `portfolio` with its name or id — the " +
      "period return is then scoped to just that portfolio, still compared to " +
      "the same indices.",
    inputSchema: z.object({
      range: z.enum(PERF_RANGES).optional().describe("Look-back window; default 6mo."),
      portfolio: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional: scope the return to a SINGLE portfolio by name (e.g. 'Tax') " +
            "or bucket id. A partial name matches. Omit for the whole-book return.",
        ),
    }),
    // Model sees a compact text view (#60); the UI still gets the full object.
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: shapeForModel.performance(output as PerformanceOutput),
    }),
    execute: async ({ range, portfolio }) => {
      const r = range ?? "6mo";
      const { aggregate, perBucket, asOf } = await getPortfolioSeries(r);

      // Resolve scope: a named portfolio uses its own per-bucket series; absent,
      // the whole-book aggregate.
      let series = aggregate;
      let scope: { bucketId: string; name: string } | null = null;
      if (portfolio) {
        const bucket = resolveBucket(listBuckets(), portfolio);
        if (!bucket) {
          return {
            ok: true as const,
            hasData: false,
            range: r,
            message: `No portfolio matching "${portfolio}".`,
          };
        }
        series = perBucket[bucket.id] ?? [];
        scope = { bucketId: bucket.id, name: bucket.name };
      }

      if (series.length < 2) {
        return {
          ok: true as const,
          hasData: false,
          range: r,
          scope,
          message: scope
            ? `Not enough NAV history for the "${scope.name}" portfolio over ${r} yet — needs at least two priced dates.`
            : "Not enough NAV history to compute a return yet — needs at least two priced dates.",
        };
      }
      const first = series[0];
      const last = series[series.length - 1];
      const periodReturnPct = first.value
        ? round(((last.value - first.value) / first.value) * 100)
        : null;

      // Compare against the Thai market and US, total-return and ฿-converted,
      // over the SAME window (aligned to the portfolio's first date) — a
      // like-for-like comparison with the ฿ portfolio line.
      const benchmarks = await Promise.all(
        (["thai_tr", "us_tr"] as const).map(async (key) => {
          const ret = await getBenchmarkReturnPct(key, r, first.date);
          const opt = BENCHMARK_TR_OPTIONS.find((b) => b.key === key);
          return {
            key,
            label: opt?.label ?? key,
            returnPct: ret == null ? null : round(ret),
            beating: ret == null || periodReturnPct == null ? null : periodReturnPct >= ret,
          };
        }),
      );

      const fmt = (n: number | null) => (n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n}%`);
      return {
        ok: true as const,
        hasData: true,
        range: r,
        startDate: first.date,
        endDate: last.date,
        startValue: round(first.value),
        endValue: round(last.value),
        periodReturnPct,
        asOf,
        benchmarks,
        scope,
        message:
          `${scope ? `"${scope.name}" portfolio` : "Portfolio"} ${fmt(periodReturnPct)} over ${r} ` +
          `(${first.date}→${last.date}). ` +
          `Benchmarks: ${benchmarks.map((b) => `${b.label} ${fmt(b.returnPct)}`).join(", ")}.`,
      };
    },
  });

  const read_plan = tool({
    description:
      "Read the user's written investing plan (markdown) plus its parsed spine " +
      "sections (target, principles, risk, commitments) and any extra sections. " +
      "Use this before referencing or proposing changes to their plan, so you " +
      "don't duplicate something already there.",
    inputSchema: z.object({}),
    execute: async () => {
      const plan = getPlan();
      const markdown = plan?.markdown ?? "";
      const parsed = parsePlan(markdown);
      return {
        ok: true as const,
        hasPlan: markdown.trim().length > 0,
        markdown,
        spine: parsed.spine,
        extras: parsed.extras,
        selectedModelId: plan?.selectedModelId ?? null,
        message: markdown.trim()
          ? "Loaded the user's plan."
          : "The user hasn't written a plan yet — offer to help them start one.",
      };
    },
  });

  const read_journal = tool({
    description:
      "Read the user's investing journal entries. Optionally filter by kind " +
      "(note/decision/question/reading), a tag, and a since-date. Use this to " +
      "recall past decisions, open questions, or reading before answering.",
    inputSchema: z.object({
      kind: z.enum(JOURNAL_KINDS).optional().describe("Restrict to one entry kind."),
      tag: z.string().min(1).optional().describe("Only entries carrying this tag."),
      since: z
        .string()
        .optional()
        .describe("ISO date (e.g. '2026-01-01'); only entries created on/after it."),
      limit: z.number().int().positive().max(50).optional().describe("Max entries (default 20)."),
    }),
    execute: async ({ kind, tag, since, limit }) => {
      const rows = listJournalEntries({
        kind: kind as JournalKind | undefined,
        since,
        limit: tag ? undefined : (limit ?? 20),
      });
      const filtered = tag ? rows.filter((r) => (r.tags ?? []).includes(tag)) : rows;
      const sliced = tag ? filtered.slice(0, limit ?? 20) : filtered;
      return {
        ok: true as const,
        count: sliced.length,
        entries: sliced.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          body: r.body,
          url: r.url ?? null,
          tags: r.tags ?? [],
          createdAt: r.createdAt,
        })),
        message:
          sliced.length === 0
            ? "No matching journal entries."
            : `Found ${sliced.length} journal entr${sliced.length === 1 ? "y" : "ies"}.`,
      };
    },
  });

  const write_journal = tool({
    description:
      "Save a new entry to the user's investing journal. Use when the user " +
      "makes a decision, asks you to log something, or records an open question " +
      "or reading. Choose the most fitting kind. Confirm with the returned " +
      "message.",
    inputSchema: z.object({
      kind: z
        .enum(JOURNAL_KINDS)
        .describe(
          "note = general observation; decision = a choice they've made; " +
            "question = an open question to revisit; reading = an article/resource.",
        ),
      title: z.string().max(200).optional().describe("Optional short title."),
      body: z.string().min(1).max(4000).describe("The entry content."),
      url: z
        .string()
        .url()
        .optional()
        .describe("Optional source link (e.g. the article URL for a reading entry)."),
      tags: z.array(z.string().min(1)).max(10).optional().describe("Optional tags."),
    }),
    execute: async ({ kind, title, body, url, tags }) => {
      const row = createJournalEntry({
        kind,
        title: title ?? null,
        body,
        url: url ?? null,
        tags: tags ?? null,
        source: "advisor_tool",
        pinned: false,
      });
      return {
        ok: true as const,
        id: row.id,
        kind: row.kind,
        message: `Saved to your journal as a ${kind}${title ? `: "${title}"` : ""}.`,
      };
    },
  });

  const propose_plan_edit = tool({
    description:
      "Propose an addition to the user's written plan. This does NOT change the " +
      "plan — it shows the user a proposal card they can Accept or dismiss. Use " +
      "it whenever the user wants to add a rule, principle, risk note, target, " +
      "or commitment to their plan. Read the plan first (read_plan) so you put " +
      "the line in the right section and don't duplicate. After calling this, " +
      "tell the user you've drafted the change for them to confirm.",
    inputSchema: z.object({
      section: z
        .string()
        .min(1)
        .describe(
          "The plan section to add to (e.g. 'Principles', 'Risk', " +
            "'Commitments', 'Target'). Created if it doesn't exist.",
        ),
      add: z
        .string()
        .min(1)
        .describe("The line to add, WITHOUT a leading bullet — it's added as a list item."),
      rationale: z
        .string()
        .min(1)
        .max(500)
        .describe("One short sentence explaining why, shown on the proposal card."),
    }),
    execute: async ({ section, add, rationale }) => {
      // Normalize to a markdown bullet, matching the existing card/diff shape.
      const line = add.trim().replace(/^[-*]\s*/, "");
      // The `proposal` field carries the exact PlanProposal shape ChatScreen's
      // card expects ({ section, rationale, add, rm }). The client picks it off
      // the tool output in the stream and renders the card; accept flows
      // through POST /api/plan/edit (persistPlanEdit). No DB mutation here.
      const proposal = {
        section,
        rationale,
        add: `- ${line}`,
        rm: null as string | null,
      };
      return {
        ok: true as const,
        proposal,
        message: `Drafted a change to your ${section} section — confirm on the card to apply it.`,
      };
    },
  });

  const propose_holding = tool({
    description:
      "Propose adding ONE holding (a single fund/ETF/stock position) to the user's " +
      "portfolio. This does NOT write anything — when you can read a unit count it shows " +
      "a HoldingProposalCard the user Accepts (saved on Accept via POST /api/holdings/" +
      "propose, per-user scoped); when only a ฿ value is shown it shows a one-row review " +
      "table that opens the importer, where units are derived and the user verifies. Call " +
      "this ONCE for a SINGLE position the user describes or that you read from a " +
      "screenshot. For TWO OR MORE positions use propose_holdings_import instead. " +
      "Use the ticker exactly as shown; put the human-readable fund/stock name in " +
      "englishName. " +
      "If the position shows the DATE it was purchased (วันที่ทำรายการ — a LOT / detail " +
      "view, even when it also shows the current value and P/L), it is a BUY, not a " +
      "current snapshot — use propose_transactions_import instead so the cost is dated to " +
      "the real purchase, not today. Apply this SILENTLY — pick the right tool, don't " +
      "explain the reasoning to the user. " +
      "If you can read a UNIT COUNT, pass `units` (and `avgCost` if a per-unit cost is " +
      "shown). If the statement shows only a market VALUE and no unit count — the common " +
      "Thai-app case (มูลค่าปัจจุบัน + ยอดเงินลงทุน + กำไร/ขาดทุน) — pass `value` (the " +
      "current market value) and `pl` (the gain/loss), and LEAVE `units` AND `avgCost` " +
      "EMPTY. NEVER compute units = value / price yourself and NEVER put an invested total " +
      "into `avgCost` (that field is the price PER UNIT) — the importer derives units from " +
      "the NAV on the snapshot date. Don't invent numbers you can't read — omit a field " +
      "rather than guess. Choose bucketId from the user's existing buckets — call " +
      "read_portfolio to see them and pick the one that fits by context (e.g. an SSF " +
      "bucket for an SSF fund). If the user has more than one bucket and the right one " +
      "isn't clear, ASK which bucket before proposing rather than guessing. After " +
      "proposing, confirm in ONE brief sentence — do NOT restate the row or explain your " +
      "reasoning.",
    inputSchema: z
      .object({
        ticker: z
          .string()
          .min(1)
          .max(40)
          .describe("Fund/ETF/stock symbol exactly as shown (e.g. 'K-USA-A(A)', 'VOO')."),
        englishName: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Human-readable fund/stock name (e.g. 'S&P 500 ETF'). Falls back to the ticker.",
          ),
        thaiName: z.string().max(200).optional().describe("Thai name if the statement shows one."),
        units: z
          .number()
          .positive()
          .optional()
          .describe(
            "Number of units/shares held, when a unit count is shown. OMIT when only a ฿ " +
              "value is shown — never derive it from value/price.",
          ),
        value: z
          .number()
          .positive()
          .optional()
          .describe(
            "Current market value of the position in baht (the large ฿ figure), when no " +
              "unit count is shown. The importer derives units from NAV on the snapshot date.",
          ),
        pl: z
          .number()
          .optional()
          .describe(
            "Unrealised profit/loss in baht (negative for a loss), if shown — reconstructs " +
              "the invested cost basis when only a value is given.",
          ),
        nav: z
          .number()
          .positive()
          .optional()
          .describe("NAV / price per unit, if printed on the statement."),
        avgCost: z
          .number()
          .positive()
          .optional()
          .describe("Average cost per unit, ONLY if the statement shows that per-unit figure."),
        ter: z
          .number()
          .min(0)
          .optional()
          .describe("Total expense ratio as a fraction (e.g. 0.003)."),
        assetClass: z
          .enum(["equity", "bond", "mixed", "alternative", "cash"])
          .optional()
          .describe("Asset class if you can infer it from the fund name; otherwise omit."),
        region: z
          .string()
          .max(60)
          .optional()
          .describe("Region/geography if inferable (e.g. 'US')."),
        quoteSource: z
          .enum(QUOTE_SOURCES)
          .optional()
          .describe(
            "Price source: 'thai_mutual_fund' for SEC-registered Thai mutual funds, " +
              "'market' for stocks/ETFs/indices. Defaults to 'market'.",
          ),
        bucketId: z
          .string()
          .optional()
          .describe(
            "Target portfolio bucket id, chosen from the user's existing buckets " +
              "(see read_portfolio) by context. If you're unsure which of several " +
              "buckets fits, ask the user first rather than guessing. If omitted, " +
              "the accept path falls back to the user's first bucket.",
          ),
        source: z
          .string()
          .max(80)
          .optional()
          .describe("Provenance label shown in the UI (e.g. brokerage name)."),
        asOf: z
          .string()
          .optional()
          .describe(
            "The snapshot's as-of date in ISO YYYY-MM-DD. PREFER a date shown in the image; " +
              "otherwise the attached file's name/timestamp noted in the conversation. Omit if unknown.",
          ),
        rationale: z
          .string()
          .min(1)
          .max(300)
          .describe("One short line shown on the card (e.g. what statement line this came from)."),
      })
      .refine((v) => v.units != null || v.value != null, {
        message: "Provide either a unit count (units) or a ฿ value.",
        path: ["units"],
      }),
    execute: async (input) => {
      // Units known → the one-tap HoldingProposalCard, direct write on Accept. The
      // `holding` field carries the shape the card expects and POST /api/holdings/
      // propose accepts; the client picks it off the stream. No DB mutation here.
      if (input.units != null) {
        const holding = {
          // Official catalog case (#235); a custom symbol keeps the typed case.
          ticker: canonicalTicker(input.ticker),
          englishName: input.englishName.trim(),
          thaiName: input.thaiName?.trim() ?? null,
          units: input.units,
          avgCost: input.avgCost ?? null,
          ter: input.ter ?? null,
          assetClass: input.assetClass ?? null,
          region: input.region?.trim() ?? null,
          quoteSource: input.quoteSource ?? "market",
          bucketId: input.bucketId?.trim() ?? null,
          source: input.source?.trim() ?? null,
          rationale: input.rationale,
        };
        return {
          ok: true as const,
          holding,
          message: `Drafted ${holding.ticker}${
            Number.isFinite(holding.units) ? ` (${holding.units} units)` : ""
          } — confirm on the card to add it to your portfolio.`,
        };
      }

      // Value-only → route into the SAME reviewable importer the batch path uses
      // (#130 / ADR 0004): units derive from NAV(asOf) at the fold and the ฿ value
      // stays the stored fact — never a frozen value÷price conversion. We emit a
      // one-row holdingsImport payload (shared deriveRowsWithNav, mirroring
      // propose_holdings_import) so the user reviews the estimated unit count.
      const extracted: ExtractedRow[] = [
        {
          ticker: input.ticker.trim(),
          englishName: input.englishName.trim(),
          avgCost: input.avgCost,
          nav: input.nav,
          value: input.value,
          pl: input.pl,
        },
      ];
      const derived = deriveRowsWithNav(extracted, input.asOf);
      const out = derived.map((d) => {
        const row = input.quoteSource ? { ...d, quoteSource: input.quoteSource } : d;
        return input.asOf ? { ...row, asOf: input.asOf } : row;
      });
      const needs = out.filter((r) => r.needsUnits).length;
      return {
        ok: true as const,
        holdingsImport: {
          rows: out,
          source: input.source?.trim() ?? null,
          note: input.rationale.trim(),
        },
        message:
          `Drafted ${canonicalTicker(input.ticker)} — review and import it on the table ` +
          `below.${needs > 0 ? " You'll be asked to fill in a unit count." : ""}`,
      };
    },
  });

  const propose_holdings_import = tool({
    description:
      "Propose adding MANY current holdings at once by handing them to the portfolio " +
      "importer. Use this — NOT repeated propose_holding calls — when you've read TWO " +
      "OR MORE positions from an attached holdings/portfolio screenshot. It does NOT " +
      "write anything: it shows the user a compact table that opens the full import " +
      "page, pre-filled, where they review/edit and bulk-save. One entry per position. " +
      "FIRST classify the screenshot: if each position shows the DATE it was purchased " +
      "(วันที่ทำรายการ — a LOT / position-detail view, even when it ALSO shows the current " +
      "value and P/L), it is a BUY, NOT a current snapshot — use propose_transactions_import " +
      "instead, so the cost is dated to the real purchase. Recording it here as a Balance " +
      "would date the whole cost basis to today and distort the money-weighted return. Use " +
      "THIS tool only for a CURRENT positions snapshot with NO per-position purchase date. " +
      "Apply this classification SILENTLY — pick the right tool, don't explain the date / " +
      "cost-basis / money-weighted-return reasoning to the user. " +
      "Read each value EXACTLY as printed — never invent a number; omit ONLY a field you " +
      "genuinely can't read, but DO capture every figure that IS printed (a dropped fact " +
      "loses cost basis or accuracy). For each row pass whatever it shows: `units` (unit " +
      "count, จำนวนหน่วย/หน่วย), `avgCost` (cost per unit, NAV ต้นทุน — a small per-unit " +
      "number), `nav` (current price per unit), `value` (current market value, " +
      "มูลค่าปัจจุบัน — the large ฿ figure), `pl` (P/L, กำไร/ขาดทุน). " +
      "Two common shapes: (a) a SUMMARY view shows value + invested (ยอดเงินลงทุน) + P/L " +
      "but NO unit count → pass `value` and `pl`, leave `units` AND `avgCost` EMPTY (the " +
      "importer derives units from NAV). (b) a dateless DETAIL view shows BOTH a unit count " +
      "AND a per-unit cost (e.g. '18,657.4125 units @ 10.7196') → pass BOTH `units` AND " +
      "`avgCost`, plus `value`/`pl` if shown, so the cost basis is preserved. " +
      "NEVER invent a unit count (e.g. 1), and NEVER put the invested TOTAL into `avgCost` " +
      "(that field is the price PER UNIT, not a total). For a SINGLE position use " +
      "propose_holding instead. After calling this, confirm in ONE brief sentence (e.g. " +
      "'Drafted 2 holdings below — review and import when ready.') — do NOT restate the " +
      "rows, describe the table, or explain your reasoning.",
    inputSchema: z.object({
      rows: z
        .array(
          z.object({
            ticker: z
              .string()
              .min(1)
              .max(40)
              .describe("Fund/ETF/stock code exactly as printed (e.g. 'K-USA-A(A)', 'VOO')."),
            englishName: z
              .string()
              .max(200)
              .optional()
              .describe("Human-readable fund/stock name if shown."),
            units: z.number().positive().optional().describe("Units/shares held, if shown."),
            avgCost: z.number().positive().optional().describe("Average cost per unit, if shown."),
            nav: z.number().positive().optional().describe("NAV/price per unit, if shown."),
            value: z
              .number()
              .positive()
              .optional()
              .describe("Market value of the position (the large baht amount), if shown."),
            pl: z
              .number()
              .optional()
              .describe("Unrealised profit/loss in baht (negative for a loss), if shown."),
            quoteSource: z
              .enum(QUOTE_SOURCES)
              .optional()
              .describe(
                "Price source override: 'thai_mutual_fund' for SEC-registered Thai funds, " +
                  "'market' for stocks/ETFs. Omit to let the importer infer it from the ticker.",
              ),
          }),
        )
        .min(1)
        .max(40)
        .describe("One entry per extracted position."),
      source: z
        .string()
        .max(80)
        .optional()
        .describe("Provenance label shown in the UI (e.g. brokerage name)."),
      note: z
        .string()
        .max(300)
        .optional()
        .describe("One short line shown above the table (e.g. what was read from the image)."),
      asOf: z
        .string()
        .optional()
        .describe(
          "The snapshot's as-of date in ISO YYYY-MM-DD. PREFER a date shown in the image; " +
            "otherwise use the attached file's name/timestamp noted in the conversation. Omit if unknown.",
        ),
    }),
    execute: async ({ rows, source, note, asOf }) => {
      // Derive units/avgCost from the NAV on the snapshot's own date (#130),
      // falling back to the latest NAV (shared with POST /api/import/image via
      // lib/portfolio/derive-rows.ts), so the in-chat table and the importer agree
      // and a dated snapshot's units don't drift. The `holdingsImport` field carries the shape
      // ChatScreen's HoldingsImportCard expects; the client picks it off the
      // stream and renders the table. No DB mutation here — saving happens in the
      // importer the user opens.
      const extracted: ExtractedRow[] = rows.map((r) => ({
        ticker: r.ticker.trim(),
        englishName: r.englishName?.trim(),
        units: r.units,
        avgCost: r.avgCost,
        nav: r.nav,
        value: r.value,
        pl: r.pl,
      }));
      const derived = deriveRowsWithNav(extracted, asOf);
      // Honor an explicit per-row quoteSource override; otherwise keep the
      // ticker-inferred default deriveRow chose.
      const out = derived.map((d, i) => {
        const override = rows[i]?.quoteSource;
        const row = override ? { ...d, quoteSource: override } : d;
        // Stamp the snapshot's as-of date on every row so the importer dates the
        // Balances (the model determines it from the image / file context).
        return asOf ? { ...row, asOf } : row;
      });
      const needs = out.filter((r) => r.needsUnits).length;
      return {
        ok: true as const,
        holdingsImport: { rows: out, source: source?.trim() ?? null, note: note?.trim() ?? null },
        message:
          `Drafted ${out.length} holding${out.length === 1 ? "" : "s"} — review and import ` +
          `them on the table below.${
            needs > 0
              ? ` ${needs} need${needs === 1 ? "s" : ""} a unit count you'll be asked to fill in.`
              : ""
          }`,
      };
    },
  });

  const propose_transactions_import = tool({
    description:
      "Propose recording a batch of past TRANSACTIONS (a buy/sell/dividend log) to " +
      "the user's ledger. Use this — NOT propose_holdings_import — when an attached " +
      "image or the user's text is a TRANSACTION HISTORY: a DATED log of activity over " +
      "time (rows carry or inherit a date, the same fund repeats, labels like " +
      "buy/sell/subscribe/redeem/ซื้อ/ขาย/สับเปลี่ยน). It does NOT write anything: it " +
      "shows the user a compact table they review, edit and save — so PROPOSE directly " +
      "and let them correct it there. Do NOT interrogate the user about details you can " +
      "read; you already know how to read a Thai fund log: " +
      "(a) DATES are group headers — give every row under a date that date; Buddhist-era " +
      "years subtract 543 (มีนาคม 2569 = March 2026, 22 ธันวาคม 2568 = 2025-12-22). " +
      "(b) The TYPE is the action word — ซื้อ = buy, ขาย = sell, เงินปันผล = dividend; " +
      "'AMC' and other channel/agent badges are NOT the type, ignore them. " +
      "(c) A สับเปลี่ยน (switch) is TWO rows — the ออก (out) leg a 'sell', the เข้า (in) " +
      "leg a 'buy'. " +
      "(d) A LOT / purchase-detail view (e.g. 'LOT 1', a dated row with units + a cost " +
      "NAV + an invested total) IS a transaction: record the BUY from the PURCHASE facts " +
      "— `tradeDate` (the purchase date), `units`, `pricePerUnit` (the cost NAV ต้นทุน, a " +
      "small per-unit number), and `amount` (the invested total ยอดเงินลงทุน). Such a view " +
      "often ALSO shows the position's current value (มูลค่าปัจจุบัน) and unrealised P/L " +
      "(กำไร/ขาดทุน) — those are TODAY'S market state, NOT the trade: do NOT use them as " +
      "the transaction `amount` or `pricePerUnit`. " +
      "Read each value EXACTLY as printed and capture every TRADE figure that's shown " +
      "(date, units, price, amount, fee); omit ONLY a field you genuinely can't read (the " +
      "user fills it in) — never invent one, and never ask the user to confirm B.E. dates " +
      "or what สับเปลี่ยน/ซื้อ/ขาย mean. For a CURRENT positions snapshot (no per-row " +
      "dates) use propose_holdings_import instead. After calling this, confirm in ONE " +
      "brief sentence (e.g. 'Drafted 2 buy transactions below — review and import when " +
      "ready.') — do NOT restate the rows, describe the table, or explain your " +
      "classification reasoning.",
    inputSchema: z.object({
      rows: z
        .array(
          z.object({
            ticker: z.string().min(1).max(40).describe("Fund/ETF/stock code exactly as printed."),
            englishName: z.string().max(200).optional().describe("Human-readable name if shown."),
            kind: z
              .enum(["buy", "sell", "dividend", "fee", "split", "reinvest"])
              .optional()
              .describe("Transaction type read off the row; omit only if truly unreadable."),
            tradeDate: z
              .string()
              .optional()
              .describe("ISO date YYYY-MM-DD — inherit the nearest date header above the row."),
            units: z.number().positive().optional().describe("Units bought/sold, if shown."),
            pricePerUnit: z
              .number()
              .positive()
              .optional()
              .describe("NAV / price per unit, if shown."),
            amount: z
              .number()
              .positive()
              .optional()
              .describe("Baht amount of the transaction (unsigned magnitude)."),
            fee: z
              .number()
              .min(0)
              .optional()
              .describe("Fee / front-end charge on this row, if any."),
          }),
        )
        .min(1)
        .max(200)
        .describe("One entry per transaction row."),
      source: z
        .string()
        .max(80)
        .optional()
        .describe("Provenance label shown in the UI (e.g. brokerage name)."),
      note: z
        .string()
        .max(300)
        .optional()
        .describe("One short line shown above the table (e.g. what was read from the image)."),
    }),
    execute: async ({ rows, source, note }) => {
      // The `transactionsImport` field carries the shape ChatScreen's
      // TransactionsImportCard expects; the client picks it off the stream and
      // renders the table, which opens the importer (RecordSheet txnSeed →
      // trade rows). No DB mutation here — saving happens in the importer.
      const out = rows.map((r) => ({
        ticker: r.ticker.trim(),
        englishName: r.englishName?.trim(),
        kind: r.kind,
        tradeDate: r.tradeDate?.trim(),
        units: r.units,
        pricePerUnit: r.pricePerUnit,
        amount: r.amount,
        fee: r.fee,
      }));
      return {
        ok: true as const,
        transactionsImport: {
          rows: out,
          source: source?.trim() ?? null,
          note: note?.trim() ?? null,
        },
        message:
          `Drafted ${out.length} transaction${out.length === 1 ? "" : "s"} — review and import ` +
          "them on the table below.",
      };
    },
  });

  // ─── fee-aware fund finder ─────────────────────────────────────────────────
  //
  // STANCE: Macrotide is an index-investing companion, not a stock picker. These
  // tools help the advisor answer "which low-fee fund gives me exposure X?" —
  // always proposing funds over individual stocks, always leading with fee as the
  // controllable edge. See docs/explanation/product-direction.md "Index-purist
  // stance" for the full rationale. The descriptions below are deliberately
  // written to steer the model toward fee-first, index-first framing.

  const find_funds = tool({
    description:
      "Search the SEC-registered Thai mutual fund catalog and return funds that " +
      "match a TARGET EXPOSURE, sorted CHEAPEST FIRST by their all-in annual fee " +
      "(TER). Use this tool whenever the user asks 'which fund gives me [exposure]', " +
      "'what's the lowest-fee S&P 500 / global / bond fund', 'cheapest index fund', " +
      "'cheapest SSF equity fund', or needs a concrete fund recommendation. " +
      "The fee is THE controllable edge for an index investor — this tool names the " +
      "best-value option for any exposure. " +
      "Use indexOnly=true to restrict to passive/index-tracking funds (management " +
      "style PN or PM) — always prefer these when the user wants market-cap exposure. " +
      "For 'cheapest fund tracking X' questions, prefer trackingIndex over a free-text " +
      "query: it matches the normalized index family (catching feeder funds whose own " +
      "name never mentions the index), restricts to index-style funds, and returns " +
      "cheapest-first. " +
      "Use taxIncentive to find SSF/ThaiESG/RMF wrappers, which add tax deductibility " +
      "on top of the fee advantage. " +
      "Use regionFocus (e.g. 'us', 'china', 'emerging') or sectorFocus (e.g. 'gold', " +
      "'technology') to target a PRECISE exposure — preferred over a free-text query " +
      "when you know the region/theme. " +
      "IMPORTANT: Macrotide is an index-investing companion. When the user asks about " +
      "an individual stock or hot theme (e.g. 'should I buy NVIDIA'), do NOT use this " +
      "tool to find that stock — instead call find_funds for the closest low-fee " +
      "index or thematic fund that captures the same exposure, then explain why a " +
      "diversified fund beats picking a single name.",
    inputSchema: z.object({
      assetClass: z
        .enum(["equity", "bond", "alternative", "cash"])
        .optional()
        .describe(
          "Asset class filter. Use 'equity' for stock index funds, 'bond' for fixed-income, " +
            "'alternative' for REITs / gold / commodity funds, 'cash' for money-market.",
        ),
      indexOnly: z
        .boolean()
        .optional()
        .describe(
          "When true, restrict results to index / passive funds (management style PN or PM). " +
            "Always prefer this for market-cap exposure questions — index funds have lower fees " +
            "and no active management risk.",
        ),
      taxIncentive: z
        .enum(["SSF", "ThaiESG", "RMF"])
        .optional()
        .describe(
          "Filter by Thai tax-advantaged wrapper. SSF = Super Savings Fund (deduct up to 30% " +
            "of income, max 200,000 THB); ThaiESG = Thai ESG Fund (deduct up to 30%, max 300,000 THB); " +
            "RMF = Retirement Mutual Fund (deduct up to 30%, max 500,000 THB). " +
            "Tax efficiency is part of net return — mention the wrapper when recommending these.",
        ),
      region: z
        .enum(["foreign", "domestic", "mixed"])
        .optional()
        .describe(
          "Geographic mandate: 'foreign' for funds investing outside Thailand (feeder funds, " +
            "global index funds), 'domestic' for Thai-only exposure, 'mixed' for blended mandate.",
        ),
      trackingIndex: z
        .string()
        .optional()
        .describe(
          "Normalized index family the fund must TRACK (index-style funds only — actively " +
            "managed funds merely benchmarked against it are excluded). Use the canonical " +
            "name: 'S&P 500', 'NASDAQ-100', 'SET50', 'SET100', 'MSCI World', 'MSCI ACWI', " +
            "'MSCI EM', 'Nikkei 225', 'TOPIX', 'CSI 300', 'Hang Seng', 'Nifty 50', 'VN30', " +
            "'FTSE All-World', 'Bloomberg Global Aggregate'. Prefer this over query for " +
            "'cheapest fund tracking X' — results come back cheapest-first.",
        ),
      regionFocus: z
        .string()
        .optional()
        .describe(
          "Specific geographic focus, FINER than `region` — match a precise exposure. Common " +
            "values: 'us', 'global', 'emerging', 'asia', 'japan', 'china', 'india', 'europe', " +
            "'vietnam', 'korea', 'asean', 'thailand'. Use this for 'cheapest US fund', 'a China " +
            "fund', etc. (preferred over a free-text query when you know the region).",
        ),
      sectorFocus: z
        .string()
        .optional()
        .describe(
          "Specific sector/theme focus. Common values: 'technology', 'healthcare', 'financials', " +
            "'energy', 'property' (REIT), 'gold', 'commodities'. Use for 'a tech fund', 'a gold " +
            "fund', etc.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Free-text search against fund name and investment-policy text. Good for finding " +
            "funds by theme (e.g. 'gold', 'REIT') or when no normalized index family fits. " +
            "NOTE: with a query, results are ranked by match relevance, not fee — use " +
            "trackingIndex for cheapest-index questions, and regionFocus/sectorFocus when you " +
            "know the region/theme. Combine with assetClass for best results.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(30)
        .optional()
        .describe("Max funds to return (default 10). Keep this small — present the top options."),
    }),
    // Model sees a compact one-line-per-fund view (#60); the UI gets the full list.
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: shapeForModel.funds(output as FundsOutput),
    }),
    execute: async ({
      assetClass,
      indexOnly,
      taxIncentive,
      region,
      trackingIndex,
      regionFocus,
      sectorFocus,
      query,
      limit,
    }) => {
      const funds = findFunds({
        assetClass,
        indexOnly,
        taxIncentive,
        region,
        trackingIndex,
        regionFocus: regionFocus?.trim().toLowerCase(),
        sectorFocus: sectorFocus?.trim().toLowerCase(),
        query,
        activeOnly: true,
        excludeFixedTerm: true,
        limit: limit ?? 10,
      });

      if (funds.length === 0) {
        return {
          ok: true as const,
          count: 0,
          funds: [],
          message:
            "No funds found for that filter. Try a broader query, drop the asset-class filter, " +
            "or relax the indexOnly / taxIncentive / region constraints.",
        };
      }

      const items = funds.map((f) => ({
        projId: f.projId,
        abbr: f.abbrName ?? f.projId,
        englishName: f.englishName ?? null,
        amc: f.amcName ?? null,
        assetClass: f.assetClass ?? null,
        // TER is the headline fee — the all-in annual cost as a percent.
        // Null means the SEC hasn't published a Total Fee and Expense for this fund.
        terPct: f.ter,
        terLabel: f.ter == null ? "TER not published" : `${f.ter.toFixed(2)}% p.a.`,
        // Enrichment fields — the advisor uses these to describe the fund accurately.
        managementStyle: f.managementStyle ?? null,
        isIndex: f.managementStyle === "PN" || f.managementStyle === "PM",
        taxIncentiveType: f.taxIncentiveType ?? null,
        distributionPolicy: f.distributionPolicy ?? null,
        investRegion: f.investRegion ?? null,
        isFeederFund: f.isFeederFund,
        feederMasterFund: f.feederMasterFund ?? null,
      }));

      // With a text query results arrive in RELEVANCE order, so items[0] is the
      // best match, not the cheapest — name the true lowest-TER fund explicitly.
      // Zero TER means "fee not actualized", not free — treat like null.
      const effTer = (t: number | null) => (t != null && t > 0 ? t : null);
      const cheapest = items.reduce((best, i) => {
        const ti = effTer(i.terPct);
        const tb = effTer(best.terPct);
        return ti != null && (tb == null || ti < tb) ? i : best;
      }, items[0]);
      const hasTer = items.filter((i) => i.terPct != null).length;
      const indexCount = items.filter((i) => i.isIndex).length;

      const contextNote =
        indexOnly && indexCount > 0
          ? `All ${indexCount} result${indexCount === 1 ? "" : "s"} are index/passive funds. `
          : indexCount > 0
            ? `${indexCount} of ${items.length} are index/passive funds (marked isIndex=true). `
            : "";

      const orderNote = query?.trim()
        ? "sorted by match relevance (NOT by fee)"
        : "sorted cheapest first";

      return {
        ok: true as const,
        count: funds.length,
        funds: items,
        cheapestAbbr: cheapest.abbr,
        ordering: orderNote,
        message:
          `Found ${funds.length} fund${funds.length === 1 ? "" : "s"} — ${orderNote}. ` +
          contextNote +
          (hasTer > 0
            ? `Lowest TER: ${cheapest.terLabel} (${cheapest.abbr}). ` +
              "Fee is the single most controllable factor in long-run return — " +
              "lead with the cheapest option that matches the target exposure."
            : "No TER data available for these funds — suggest the user verify fees " +
              "on the fund factsheet before committing."),
      };
    },
  });

  const find_cheaper_alternatives = tool({
    description:
      "Given a fund the user already holds (by ticker/abbr or SEC project id), find " +
      "cheaper funds in the same asset class or category — strictly lower TER, " +
      "ranked lowest-fee first. Use this to surface the 'fee-creep' opportunity: " +
      "'you hold X at Y% TER; here are cheaper funds with the same exposure.' " +
      "Call read_portfolio first to see the user's holdings and identify candidates. " +
      "Always present the fee delta prominently — it compounds against the user every year.",
    inputSchema: z.object({
      fundAbbr: z
        .string()
        .optional()
        .describe(
          "The fund's abbreviated ticker/symbol (e.g. 'K-USA-A(A)'). " +
            "Provide this OR projId — not both.",
        ),
      projId: z
        .string()
        .optional()
        .describe("The SEC project id (e.g. 'M0017_2538'). Provide this OR fundAbbr — not both."),
      limit: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe("Max alternatives to return (default 5)."),
    }),
    // Model sees a compact one-line-per-fund view (#60); the UI gets the full list.
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value: shapeForModel.cheaper(output as CheaperOutput),
    }),
    execute: async ({ fundAbbr, projId, limit }) => {
      // Resolve projId from abbr if needed.
      let resolvedProjId = projId?.trim();
      let resolvedAbbr = fundAbbr?.trim();

      if (!resolvedProjId && resolvedAbbr) {
        const matches = getFundsByAbbr([resolvedAbbr]);
        if (matches.length === 0) {
          return {
            ok: true as const,
            count: 0,
            alternatives: [],
            message:
              `Could not find a fund with abbreviation "${resolvedAbbr}" in the catalog. ` +
              "The daily SEC refresh may not have run yet, or the abbreviation may differ from " +
              "what's in the catalog. Try the SEC project id instead.",
          };
        }
        resolvedProjId = matches[0].projId;
        resolvedAbbr = matches[0].abbrName ?? resolvedAbbr;
      }

      if (!resolvedProjId) {
        return {
          ok: false as const,
          count: 0,
          alternatives: [],
          message: "Provide either fundAbbr or projId.",
        };
      }

      const peers = getCheaperAlternatives(resolvedProjId, limit ?? 5);

      if (peers.length === 0) {
        // Distinguish between "ref fund not found / no TER" vs "already the cheapest".
        return {
          ok: true as const,
          count: 0,
          alternatives: [],
          referenceAbbr: resolvedAbbr ?? resolvedProjId,
          message:
            peers.length === 0
              ? `No cheaper alternatives found for ${resolvedAbbr ?? resolvedProjId}. ` +
                "Either it's already the lowest-fee option in its class, or the catalog " +
                "doesn't have TER data for this fund yet."
              : "",
        };
      }

      // We need the reference TER to compute deltas.
      // getCheaperAlternatives already filtered to strictly-cheaper; the ref TER
      // is peers[0].ter + delta, but we don't have it directly here. Re-resolve.
      const refFunds = getFundsByAbbr(resolvedAbbr ? [resolvedAbbr] : []);
      const refProjIdFinal = resolvedProjId;
      // Get ref TER from the first peer's ter vs the position — use the query result
      // shape: peers are sorted cheapest-first and all have ter < refTer.
      // We don't have refTer directly without calling getCurrentTer again, but
      // we can infer it from the result list's context. For the message we
      // compute an approximate delta from cheapest peer.
      const cheapestPeer = peers[0];

      const items = peers.map((f) => ({
        projId: f.projId,
        abbr: f.abbrName ?? f.projId,
        englishName: f.englishName ?? null,
        amc: f.amcName ?? null,
        assetClass: f.assetClass ?? null,
        terPct: f.ter,
        terLabel: f.ter == null ? "TER not published" : `${f.ter.toFixed(2)}% p.a.`,
        managementStyle: f.managementStyle ?? null,
        isIndex: f.managementStyle === "PN" || f.managementStyle === "PM",
        taxIncentiveType: f.taxIncentiveType ?? null,
        investRegion: f.investRegion ?? null,
        isFeederFund: f.isFeederFund,
        feederMasterFund: f.feederMasterFund ?? null,
      }));

      void refFunds; // used for projId resolution only
      void refProjIdFinal;

      return {
        ok: true as const,
        count: peers.length,
        alternatives: items,
        referenceAbbr: resolvedAbbr ?? resolvedProjId,
        cheapestAlternativeAbbr: cheapestPeer.abbrName ?? cheapestPeer.projId,
        message:
          `Found ${peers.length} cheaper alternative${peers.length === 1 ? "" : "s"} for ` +
          `${resolvedAbbr ?? resolvedProjId} — all with lower TER, sorted cheapest first. ` +
          `Best: ${cheapestPeer.abbrName ?? cheapestPeer.projId} at ` +
          `${cheapestPeer.ter?.toFixed(2) ?? "?"}% p.a. ` +
          "Even a 0.5% TER difference compounds materially over a 10-year horizon — " +
          "present this as the fee-creep opportunity and offer to propose a switch.",
      };
    },
  });

  const find_us_securities = tool({
    description:
      "Search the catalog of US-listed stocks & ETFs (the official Nasdaq directory) " +
      "by symbol or name, optionally filtered to ETFs or single stocks. Use this to " +
      "RESOLVE or DESCRIBE a US ticker the user mentions ('what is VOO', 'is QQQ a " +
      "stock or an ETF', 'find the Vanguard S&P 500 ETF', 'list US tech ETFs'), to " +
      "confirm a symbol before proposing a holding, or to browse US ETFs for a target " +
      "exposure. Returns symbol, name, type (stock/etf), and listing exchange. " +
      "IMPORTANT: Macrotide is an index-investing companion. Prefer a broad, low-cost " +
      "ETF over a single stock — when the user asks about an individual US stock, you " +
      "can identify it here, but steer toward a diversified ETF that captures the same " +
      "exposure and explain why concentration in one name carries idiosyncratic risk. " +
      "For Thai mutual funds use find_funds instead; this tool is US-listed only and " +
      "does not carry fees, tax wrappers, or NAV.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text search over symbol (prefix) and name (contains). E.g. 'VOO', " +
            "'Vanguard', 'semiconductor'. Exact symbol matches rank first.",
        ),
      type: z
        .enum(["stock", "etf"])
        .optional()
        .describe("Restrict to 'etf' (preferred for diversified exposure) or 'stock'."),
      sort: z
        .enum(["symbol", "name"])
        .optional()
        .describe("Sort order — 'symbol' (default) or 'name'."),
      limit: z
        .number()
        .int()
        .positive()
        .max(30)
        .optional()
        .describe("Max securities to return (default 10). Keep small — present the top matches."),
    }),
    execute: async ({ query, type, sort, limit }) => {
      const { items, total } = findUsSecurities({
        query,
        securityType: type,
        sort: sort ?? "symbol",
        limit: limit ?? 10,
      });

      if (items.length === 0) {
        return {
          ok: true as const,
          count: 0,
          securities: [],
          message:
            "No US securities found for that search. Check the symbol spelling, or drop the " +
            "stock/ETF type filter. Thai mutual funds aren't in this catalog — use find_funds.",
        };
      }

      const securities = items.map((s) => ({
        symbol: s.symbol,
        name: cleanUsSecurityName(s.name),
        type: s.securityType,
        exchange: s.exchange ?? null,
        currency: s.currency,
      }));
      const etfCount = securities.filter((s) => s.type === "etf").length;

      return {
        ok: true as const,
        count: total,
        securities,
        message:
          `Found ${total} US-listed match${total === 1 ? "" : "es"}` +
          (total > securities.length ? ` (showing the first ${securities.length})` : "") +
          `. ${etfCount} of ${securities.length} are ETFs. ` +
          "Prefer a diversified ETF over a single stock for the same exposure; these are " +
          "US-listed, priced in USD, and shown in THB when held.",
      };
    },
  });

  return {
    read_portfolio,
    read_performance,
    read_plan,
    read_journal,
    write_journal,
    propose_plan_edit,
    propose_holding,
    propose_holdings_import,
    propose_transactions_import,
    find_funds,
    find_cheaper_alternatives,
    find_us_securities,
  };
}

export type AdvisorTools = ReturnType<typeof createAdvisorTools>;
