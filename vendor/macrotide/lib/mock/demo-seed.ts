// Seed mock data into a fresh demo SQLite. Mirrors lib/mock/seed.ts but runs
// against an in-memory app.db passed in (no path resolution, no migrations).
//
// This seeds ONLY the precious, user-authored side: model portfolios, buckets,
// holdings, the plan, and journal entries — the tables that live in the demo's
// isolated in-memory app.db.
//
// Market data is NOT seeded here. After the database split, a demo session
// uses the SHARED real market.db (fund catalog/fees + the NAV/quote cache)
// read-write, like a real user — it reads from and warms the same cache (see
// lib/api/with-db.ts and lib/market/cache.ts). The persona's holdings point at
// REAL Thai-fund tickers (lib/mock/data.ts), so the live NAV path prices them
// against real SEC NAVs and write-throughs any cache misses into the shared file.

import type { drizzle } from "drizzle-orm/better-sqlite3";
import {
  buckets,
  earmarks,
  holdings,
  journalEntries,
  modelPortfolios,
  plans,
  transactions,
} from "../db/schema";
import type * as appSchema from "../db/schema/app";
import { inferHoldingCurrency } from "../market/currency";
import { MODEL_PORTFOLIOS, PORTFOLIOS, USER_GOALS, USER_JOURNAL, USER_PLAN } from "./data";
import { demoHoldingSeries } from "./demo-history-read";

type Db = ReturnType<typeof drizzle<typeof appSchema>>;
const REFERENCE_TODAY = new Date("2026-05-21T00:00:00Z");

// Most demo seed holdings are Thai mutual funds; a few are direct US positions.
const DEMO_QUOTE_SOURCE = "thai_mutual_fund" as const;
// The US positions were bought around 2022 — a representative USD→THB rate so their
// cost basis reads in native USD. The THB figures on the legs are unchanged; this
// only tags them as foreign so the entry editors show $ and the trade-date rate.
const DEMO_MARKET_FX = 35;

/** One ledger row of the persona's trade history. */
interface StoryLeg {
  kind: "buy" | "sell";
  tradeDate: string;
  units: number;
  /** Signed THB (buy negative, sell positive). */
  amount: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * The persona's DATED trade history for one holding — the value-over-time
 * chart REPLAYS the ledger (a position contributes nothing before its first
 * event), so a believable demo needs believable trades, not an opening anchor
 * stamped "today" (that would collapse the 5-year chart to a single point).
 *
 * Default story: one buy on the holding's first fixture date at the seeded
 * cost (terminal units and avg cost stay exactly data.ts's). The first
 * portfolio gets flavour that exercises the replay machinery end-to-end:
 *   • holding[0]: bought in two tranches (a DCA step on the contribution line),
 *   • holding[1]: bought 10% heavy, trimmed mid-history at the then-current
 *     fixture NAV (a realized gain),
 *   • holding[2]: the trim's proceeds re-deployed a week later (a fund switch —
 *     in-transit settlement cash, no external flow).
 * Every story still folds to data.ts's terminal unit count.
 */
function storyLegs(
  portfolioIndex: number,
  holdingIndex: number,
  h: { ticker: string; units: number; cost: number },
  siblings: { ticker: string; units: number; cost: number }[],
): StoryLeg[] {
  const nav = (ticker: string) => demoHoldingSeries(`${DEMO_QUOTE_SOURCE}:${ticker}`);
  const series = nav(h.ticker);
  // No fixture series → a plain dated buy; the chart prices it from the trade.
  const FALLBACK_START = "2022-06-01";
  const start = series?.[0]?.date ?? FALLBACK_START;
  const single: StoryLeg[] = [{ kind: "buy", tradeDate: start, units: h.units, amount: -h.cost }];
  if (portfolioIndex !== 0 || !series || series.length < 12) return single;

  if (holdingIndex === 0) {
    // DCA: 60% at inception, 40% a third of the way through the history.
    const mid = series[Math.floor(series.length / 3)];
    return [
      { kind: "buy", tradeDate: start, units: round4(h.units * 0.6), amount: -h.cost * 0.6 },
      { kind: "buy", tradeDate: mid.date, units: round4(h.units * 0.4), amount: -h.cost * 0.4 },
    ];
  }

  if (holdingIndex === 1 || holdingIndex === 2) {
    // The switch pair: trim holding[1] mid-history, redeploy into holding[2].
    const seller = siblings[1];
    const buyer = siblings[2];
    const sellerSeries = seller ? nav(seller.ticker) : null;
    const buyerSeries = buyer ? nav(buyer.ticker) : null;
    if (seller && buyer && sellerSeries && buyerSeries) {
      const m = Math.floor(sellerSeries.length / 2);
      const sellPoint = sellerSeries[m];
      const rebuyPoint = buyerSeries.find((p) => p.date > sellPoint.date) ?? null;
      const trimUnits = round4(seller.units * 0.1);
      const proceeds = round4(trimUnits * sellPoint.value);
      const rebuyUnits = rebuyPoint ? round4(proceeds / rebuyPoint.value) : 0;
      const safe =
        rebuyPoint !== null &&
        proceeds > 0 &&
        proceeds < buyer.cost * 0.4 &&
        rebuyUnits < buyer.units * 0.4;
      if (safe && holdingIndex === 1) {
        return [
          {
            kind: "buy",
            tradeDate: start,
            units: round4(h.units + trimUnits),
            amount: -(h.cost * (1 + trimUnits / h.units)),
          },
          { kind: "sell", tradeDate: sellPoint.date, units: trimUnits, amount: proceeds },
        ];
      }
      if (safe && holdingIndex === 2) {
        return [
          {
            kind: "buy",
            tradeDate: start,
            units: round4(h.units - rebuyUnits),
            amount: -(h.cost - proceeds),
          },
          {
            kind: "buy",
            tradeDate: (rebuyPoint as { date: string }).date,
            units: rebuyUnits,
            amount: -proceeds,
          },
        ];
      }
    }
  }
  return single;
}

function parseRelativeDate(text: string, today = REFERENCE_TODAY): string {
  const rel = text.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+ago$/i);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const days = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
  }
  const abs = text.match(/^(\d{1,2})\s+(\w{3,})\s+(\d{4})$/);
  if (abs) {
    const parsed = new Date(`${abs[1]} ${abs[2]} ${abs[3]} UTC`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return today.toISOString();
}

// Explicit cash accounts (#149) — real bank cash held alongside the funds so the
// demo shows cash in allocation/net worth + the value chart, a Reserved slice
// carved out of the return, and idle investable cash for the Include/Exclude-cash
// return toggle to move. All in the "main" bucket, THB, valued 1.0. The ticker is
// the account NAME (upper = ledger identity); `name` carries the display case.
type DemoCashEvent =
  | { kind: "cash_balance"; date: string; balance: number; reconcile?: boolean }
  | { kind: "deposit" | "withdraw"; date: string; amount: number };

interface DemoCashAccount {
  ticker: string;
  name: string;
  /** Set → a Reserved earmark with this purpose label; absent → investable. */
  reserved?: string;
  events: DemoCashEvent[];
}

const DEMO_CASH_BUCKET = "main";

export const DEMO_CASH: DemoCashAccount[] = [
  {
    // Cash tickers ARE the account name in its own case (#235); no upper-casing.
    ticker: "SCB Savings",
    name: "SCB Savings",
    events: [
      { kind: "cash_balance", date: "2024-06-17", balance: 100000 },
      { kind: "deposit", date: "2024-12-10", amount: 50000 },
      { kind: "withdraw", date: "2025-05-20", amount: 30000 },
      { kind: "deposit", date: "2025-11-05", amount: 40000 },
      // A reconcile (interest credited) — not new money, so no contribution.
      { kind: "cash_balance", date: "2026-03-01", balance: 162000, reconcile: true },
    ],
  },
  {
    ticker: "Emergency Savings",
    name: "Emergency Savings",
    reserved: "Emergency",
    events: [
      { kind: "cash_balance", date: "2024-06-17", balance: 200000 },
      { kind: "deposit", date: "2025-08-12", amount: 25000 },
    ],
  },
  {
    ticker: "Brokerage Cash",
    name: "Brokerage Cash",
    events: [{ kind: "cash_balance", date: "2025-12-01", balance: 45000 }],
  },
];

/** Seed the demo's explicit-cash accounts, their cash events, and the reserved
 *  earmark into the "main" bucket (created by the PORTFOLIOS loop). */
function seedDemoCash(db: Db, now: string): void {
  for (const acct of DEMO_CASH) {
    db.insert(holdings)
      .values({
        bucketId: DEMO_CASH_BUCKET,
        ticker: acct.ticker,
        thaiName: null,
        englishName: acct.name,
        category: "Cash",
        assetClass: "cash",
        region: "",
        ter: null,
        source: "Demo",
        quoteSource: "cash",
        currency: "THB",
        acquiredOn: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const ev of acct.events) {
      // cash_balance asserts the level (units = value = balance, amount 0, no flow);
      // a delta carries its magnitude as units, signed into `amount` for XIRR
      // (deposit = cash out → negative, withdraw = cash in → positive).
      let units: number;
      let amount: number;
      let value: number | null;
      let reconcile: boolean | null;
      if (ev.kind === "cash_balance") {
        units = ev.balance;
        amount = 0;
        value = ev.balance;
        reconcile = ev.reconcile ?? false;
      } else {
        units = ev.amount;
        amount = ev.kind === "deposit" ? -ev.amount : ev.amount;
        value = null;
        reconcile = null;
      }
      db.insert(transactions)
        .values({
          bucketId: DEMO_CASH_BUCKET,
          ticker: acct.ticker,
          englishName: acct.name,
          quoteSource: "cash",
          kind: ev.kind,
          tradeDate: ev.date,
          units,
          pricePerUnit: null,
          amount,
          value,
          reconcile,
          fee: null,
          tradeCurrency: "THB",
          fxToThb: 1,
          source: "Demo",
          importBatchId: "seed-cash",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    if (acct.reserved) {
      db.insert(earmarks)
        .values({
          bucketId: DEMO_CASH_BUCKET,
          ticker: acct.ticker,
          scope: "account",
          role: "reserved",
          amount: null,
          currency: null,
          purpose: acct.reserved,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }
}

// A pair of recent fund dividends so the "Recently recorded" peek reads as a
// believable cash/fund mix: the two newest ledger rows are fund income (April /
// May 2026, after the latest cash event), the third-newest is a cash Set balance.
// Dividends are paid out (no unit change), so the demo's book-value invariant and
// the series tests are unaffected.
function seedDemoRecentDividends(db: Db, now: string): void {
  const main = PORTFOLIOS[0];
  if (!main) return;
  const dividends = [
    { holding: main.holdings[0], date: "2026-04-15", amount: 1280 },
    { holding: main.holdings[1], date: "2026-05-12", amount: 2450 },
  ];
  for (const d of dividends) {
    if (!d.holding) continue;
    db.insert(transactions)
      .values({
        bucketId: main.id,
        ticker: d.holding.ticker,
        englishName: d.holding.name,
        quoteSource: DEMO_QUOTE_SOURCE,
        kind: "dividend",
        tradeDate: d.date,
        units: null,
        pricePerUnit: null,
        amount: d.amount,
        fee: null,
        tradeCurrency: "THB",
        fxToThb: 1,
        source: d.holding.source,
        importBatchId: "seed-history",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function seedDemoData(db: Db): void {
  const now = new Date().toISOString();

  for (const m of MODEL_PORTFOLIOS) {
    db.insert(modelPortfolios)
      .values({
        id: m.id,
        name: m.name,
        tagline: m.tagline,
        blurb: m.blurb,
        builtIn: !m.isCustom,
        allocation: m.mix,
        expectedReturn: m.expectedReturn,
        expectedVolatility: m.expectedVol,
        ter: m.ter,
        horizon: m.horizon,
        risk: m.risk,
        pros: m.pros,
        cons: m.cons,
        createdAt: now,
      })
      .run();
  }

  for (const [portfolioIndex, p] of PORTFOLIOS.entries()) {
    db.insert(buckets)
      .values({
        id: p.id,
        name: p.name,
        typeLabel: p.typeLabel,
        icon: p.icon,
        color: p.color,
        brokerage: p.brokerage,
        notes: p.notes,
        goalText: null,
        targetModelId: p.targetModelId,
        targetAllocation: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const [holdingIndex, h] of p.holdings.entries()) {
      // Most demo holdings are real Thai mutual funds (SEC Open API); a few are
      // direct US positions (quoteSource "market") priced in USD via the market
      // chain and converted to THB by the shared FX path.
      const holdingSource = h.quoteSource ?? DEMO_QUOTE_SOURCE;
      db.insert(holdings)
        .values({
          bucketId: p.id,
          ticker: h.ticker,
          thaiName: h.thai ?? null,
          englishName: h.name,
          category: h.category,
          assetClass: h.class,
          region: h.region,
          // Position (units/avgCost) is folded from the opening anchor below, not stored.
          ter: h.ter,
          source: h.source,
          quoteSource: holdingSource,
          acquiredOn: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      // Dated trade history — the ledger is the source of truth and the holding
      // above is its projection (ADR 0004). Real dates matter: the value chart
      // replays the ledger, so these legs ARE the persona's 5-year story.
      // A US (`market`) position's cost basis is native (USD); tag its legs so the entry
      // editors show $ + the trade-date rate. The stored THB figures are unchanged — the
      // ledger stays uniformly THB, this only records the native currency + rate.
      const legCurrency =
        holdingSource === "market" ? inferHoldingCurrency("market", h.ticker) : "THB";
      const legFx = legCurrency === "THB" ? 1 : DEMO_MARKET_FX;
      for (const leg of storyLegs(portfolioIndex, holdingIndex, h, p.holdings)) {
        // Store the native (USD) figures the persona "typed" so the demo round-trips
        // exactly — the editor shows $500, not the ฿ ÷ rate reconstruction.
        const legNativeAmount = legCurrency === "THB" ? null : Math.abs(leg.amount) / legFx;
        db.insert(transactions)
          .values({
            bucketId: p.id,
            ticker: h.ticker,
            englishName: h.name,
            quoteSource: holdingSource,
            kind: leg.kind,
            tradeDate: leg.tradeDate,
            units: leg.units,
            pricePerUnit: leg.units > 0 ? round4(Math.abs(leg.amount) / leg.units) : null,
            amount: leg.amount,
            fee: null,
            tradeCurrency: legCurrency,
            fxToThb: legFx,
            nativeInputs:
              legNativeAmount == null
                ? null
                : {
                    amount: round4(legNativeAmount),
                    ...(leg.units > 0 ? { price: round4(legNativeAmount / leg.units) } : {}),
                  },
            source: h.source,
            importBatchId: "seed-history",
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }
  }

  seedDemoCash(db, now);
  seedDemoRecentDividends(db, now);

  db.insert(plans)
    .values({
      id: 1,
      markdown: USER_PLAN.markdown,
      selectedModelId: USER_GOALS.selectedModelId ?? null,
      updatedAt: parseRelativeDate(USER_PLAN.lastUpdated),
    })
    .run();

  for (const n of USER_JOURNAL.notes) {
    db.insert(journalEntries)
      .values({
        kind: "note",
        title: n.title,
        body: n.body,
        url: null,
        source: n.source ?? null,
        tags: n.tags ?? null,
        pinned: false,
        createdAt: parseRelativeDate(n.date),
        archivedAt: null,
      })
      .run();
  }
  for (const r of USER_JOURNAL.reading) {
    db.insert(journalEntries)
      .values({
        kind: "reading",
        title: r.title,
        body: r.summary,
        url: r.url,
        source: r.source ?? null,
        tags: null,
        pinned: false,
        createdAt: parseRelativeDate(r.savedDate),
        archivedAt: null,
      })
      .run();
  }
}
