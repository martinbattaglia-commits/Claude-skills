// Settlement-cash fold — pure, deterministic, DB- and network-free.
//
// The ledger records fund trades, not the cash between them. During a fund
// switch (sell A → buy B days later) the proceeds exist as cash the basket
// math can't see, so a naive Σ units × NAV chart craters for the transit days
// and recovers — a fake drawdown on every rebalance. This fold makes that cash
// explicit, per bucket, from the trades alone:
//
//   • A `sell` opens a CASH LOT (its proceeds, dated at the sell).
//   • A `buy` consumes live lots FIFO; whatever the lots can't cover is, by
//     definition, new money from outside — an EXTERNAL INFLOW at the buy date.
//   • A lot is consumable only within SETTLEMENT_WINDOW_DAYS of its sell.
//     Proceeds still unconsumed past the window are treated as WITHDRAWN —
//     retroactively at the SELL date, so the chart steps only on real event
//     dates, never on a windowless anniversary. Expired cash therefore never
//     appears on the chart at all.
//   • Lots younger than the window as of `today` haven't had their chance to
//     be reinvested yet — they stay as in-transit cash (no fabricated
//     withdrawal for a switch that is happening right now).
//
// The window is a foolproof-default heuristic: it keeps a sell-and-walk-away
// user's chart honest (no phantom wealth forever) at the cost of drawing a
// deliberately-parked stash as out-of-market. Recorded truth OVERRIDES it
// (issue #149) — explicit cash events the user enters:
//
//   • A `deposit` is an external inflow; a `withdraw` is an external outflow. They
//     move money across the portfolio boundary; the held-cash position's standing
//     value is folded separately (reduceLots), so withdraw is just the boundary flow.
//   • A `cash_balance` (Set balance) ASSERTS an account's balance. A RAISE vs that
//     account's prior asserted balance first ABSORBS live in-transit sale proceeds
//     FIFO (#232) — redemptions pay out to the bank, so proceeds routinely land
//     inside routine balance updates, and the absorbed part is the same money
//     changing rooms, not a contribution. Only the remainder is money in. A DROP is
//     money out at face. There is deliberately NO user classification to get wrong:
//     the split is arithmetic over the ledger, self-correcting like the rest of the
//     fold (a mis-absorbed raise is offset by the phantom flow the untouched lot
//     would otherwise have produced — see the tests). The legacy `reconcile` flag
//     (rows saved before #232 retired its UI) still means "pure restatement": no
//     flow at all, and it clears the bucket's in-transit lots.
//
// A fund `buy` consumes only in-transit sell proceeds (the heuristic), NOT explicit
// cash — the app never silently debits a tracked account (which one, of several?).
// Funding a buy from tracked cash is recorded by the user (a withdraw, via the
// "funded from cash?" nudge) or reconciled at the next Set balance; either way the
// buy(+) and the cash-down(−) net to zero. See tmp/cash-prd.md §2c.
//
// Explicit cash's standing VALUE is a held-cash position folded by reduceLots (a
// `cash`-quote-source ticker priced at 1), not in-transit settlement cash — so it
// never enters `terminalCash` and is never double-counted on the value line. An
// ABSORBED lot's proceeds migrate from in-transit cash to that held-cash position
// on the assert date (its span closes there), so the value line stays continuous.
//
// `dividend` (paid out), `fee`, `reinvest` (internal income), and fund anchors
// (position restatements, no cash flow) do not touch cash.
//
// The external-flow series is the chart's CONTRIBUTION line. It is NOT
// `reduceLots().netInvested`: that subtracts sale PROCEEDS (the right sign
// convention for XIRR) and so phantom-swings on every switch; this fold moves
// only when money actually enters or leaves the bucket.
//
// The fold ALSO emits a parallel `returnFlows` for the time-weighted return. It
// agrees with the contribution line everywhere EXCEPT a walked-away (expired) sell
// lot, where it removes the full proceeds rather than just the cost basis — so a
// realized gain that leaves the book doesn't read as a market loss in TWR. Unlike
// `reduceLots().netInvested` it still only moves on a genuine exit, never on a
// reinvested switch (a consumed lot pushes no flow in either series).
//
// ONE fold produces the lot flows AND the explicit-cash contribution flows —
// absorption entangles them (an assert's flow depends on the live lot state), so
// they cannot be computed separately without risking divergence. The public
// `cashContributionFlows` (XIRR / summary path) and `foldSettlementCash` (chart
// path) are views over the same pass; they cannot disagree by construction.

import { compareTxns, type LedgerTxn } from "./lots";

/** Days a sell's proceeds stay consumable by later buys before they count as withdrawn. */
export const SETTLEMENT_WINDOW_DAYS = 30;

// Cash below this is dust (float residue after a fully-consumed lot).
const CASH_EPSILON = 1e-6;

export interface CashPoint {
  date: string;
  /** In-transit cash in the bucket from this date (until the next point). */
  cash: number;
}

export interface ExternalFlow {
  date: string;
  /**
   * Signed THB capital: > 0 money entered the bucket (a buy funded from outside, a
   * deposit, or a Set-balance raise beyond absorbed proceeds), < 0 capital left (a
   * withdraw or a Set-balance drop). An UNCONSUMED sell lot that expires past the
   * window removes only its **cost basis**, not the realized gain riding in the
   * proceeds — so walking away from a profitable sale returns net contribution
   * toward 0, never past it. Explicit deposit/withdraw/Set-balance flows move at
   * FACE (cash carries no gain to split).
   */
  amount: number;
}

export interface SettlementCashResult {
  /** Step series of the in-transit cash level; one point per change, date-ascending. */
  cashTimeline: CashPoint[];
  /** External flows in/out of the bucket, date-ascending (the contribution line's deltas). */
  externalFlows: ExternalFlow[];
  /**
   * Flows for the TIME-WEIGHTED return, date-ascending. Identical to `externalFlows`
   * except an unconsumed sell lot that EXPIRES (proceeds walked away) leaves at its
   * **full proceeds**, not just its cost basis. TWR strips external flows to measure
   * the return earned while invested — so a profitable exit must remove the whole
   * market value that left; counting only cost basis (as `externalFlows` does, to keep
   * the money-weighted contribution line from going negative) makes the realized gain
   * read as a phantom loss. The two series therefore differ ONLY at a walk-away sale.
   */
  returnFlows: ExternalFlow[];
  /** Cash still in transit as of `today` (sells younger than the window). */
  terminalCash: number;
  /**
   * Per-buy UNCOVERED shortfall, keyed by txn id — the part of each buy the live
   * in-transit lots could not fund (exactly the external inflow it pushed). This is
   * the "funded from cash?" nudge's trigger (#232): a buy that reinvested
   * recently-settled proceeds is already netted by the lots and never appears here.
   */
  buyShortfallById: Map<number, number>;
  /**
   * Per-Set-balance ABSORBED proceeds, keyed by txn id (#232) — the part of each
   * raise that live in-transit lots covered (an internal transfer, no flow). The
   * remainder (`delta − absorbed`) is what flowed as a contribution.
   */
  absorbedByTxnId: Map<number, number>;
  /**
   * Explicit-cash boundary flows only (deposit / withdraw / Set-balance remainder) —
   * the slice `cashContributionFlows` exposes for XIRR and the contribution summary.
   * Already included in `externalFlows`/`returnFlows`.
   */
  cashEventFlows: ExternalFlow[];
  /** Per-account running balance (THB) after the last folded event. */
  balancesByTicker: Map<string, number>;
}

interface CashLot {
  date: string;
  /** Cash still in the lot (proceeds), drives the value line. */
  remaining: number;
  /** Cost basis (return-of-capital) still in the lot, drives the contribution line. */
  costRemaining: number;
}

/** A span during which some cash amount was live: [from, to), to=null → still live. */
interface CashSpan {
  from: string;
  to: string | null;
  amount: number;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fold ONE bucket's ledger into its in-transit-cash series and external flows.
 *
 * @param txns  the bucket's ledger rows (any order — sorted internally)
 * @param today ISO date used to keep recent, still-pending proceeds as cash
 * @param windowDays settlement window before unconsumed proceeds count as withdrawn
 * @param costBySellId per-sell cost basis (by txn id) — the capital portion of its
 *   proceeds. When an unconsumed sell lot EXPIRES past the window, only this capital
 *   is removed (not the realized gain), so walking away from a profitable sale doesn't
 *   drive net contribution negative. Falls back to proceeds when absent (an uncosted
 *   sell can't split capital from gain).
 * @param excludeCashTickers cash accounts whose EXPLICIT events are ignored entirely —
 *   a `reserved` account (#149) is set aside, so its deposits / balance changes
 *   neither flow nor absorb (its lots-eligible proceeds expire normally, which reads
 *   as the withdrawal that parking into a reserved account really is).
 */
export function foldSettlementCash(
  txns: readonly LedgerTxn[],
  today: string,
  windowDays: number = SETTLEMENT_WINDOW_DAYS,
  costBySellId?: ReadonlyMap<number, number>,
  excludeCashTickers?: ReadonlySet<string>,
): SettlementCashResult {
  // Within a single date cash is fungible, so the fold order is fixed by kind, not
  // row insertion: SELL (0) opens proceeds first so a same-day switch nets to zero;
  // DEPOSIT (1) / WITHDRAW (2) move explicit cash; CASH_BALANCE (3) asserts the level
  // AFTER those moves (so a same-day deposit+Set-balance double-counts nothing) and
  // absorbs live proceeds BEFORE a same-day BUY (4) draws — if both claim the same
  // proceeds, the balance holds them and the buy correctly reads as bank-funded (the
  // nudge offers the matching withdraw).
  const rankKind = (t: LedgerTxn): number => {
    switch (t.kind) {
      case "sell":
        return 0;
      case "deposit":
        return 1;
      case "withdraw":
        return 2;
      case "cash_balance":
        return 3;
      case "buy":
        return 4;
      default:
        return 5;
    }
  };
  const sorted = [...txns].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
    if (rankKind(a) !== rankKind(b)) return rankKind(a) - rankKind(b);
    return compareTxns(a, b);
  });

  const lots: CashLot[] = []; // FIFO queue, oldest first
  const spans: CashSpan[] = [];
  const flows: ExternalFlow[] = [];
  // The TWR variant — same as `flows` except an expired (walked-away) lot leaves
  // at its full PROCEEDS, not just its cost basis (see SettlementCashResult).
  const returnFlows: ExternalFlow[] = [];
  // Explicit-cash boundary flows (also pushed into flows/returnFlows — cash moves at
  // face, no gain to split, so the two series always agree on them).
  const cashEventFlows: ExternalFlow[] = [];
  const buyShortfallById = new Map<number, number>();
  const absorbedByTxnId = new Map<number, number>();
  const balancesByTicker = new Map<string, number>();

  const pushCashFlow = (date: string, amount: number): void => {
    const f = { date, amount };
    cashEventFlows.push(f);
    flows.push(f);
    returnFlows.push(f);
  };

  // Drop every lot no longer consumable at `onDate`: its remainder was never
  // reinvested in time, so it left the bucket — recorded at the LOT's date. The
  // contribution withdrawal removes the lot's COST basis (return of capital); the
  // TWR withdrawal removes the lot's full proceeds (the realized gain also left).
  const expireBefore = (onDate: string): void => {
    while (lots.length > 0 && addDays(lots[0].date, windowDays) < onDate) {
      const lot = lots.shift() as CashLot;
      if (lot.costRemaining > CASH_EPSILON) {
        flows.push({ date: lot.date, amount: -lot.costRemaining });
      }
      if (lot.remaining > CASH_EPSILON) {
        returnFlows.push({ date: lot.date, amount: -lot.remaining });
      }
    }
  };

  // Draw up to `need` cash from live heuristic lots FIFO, closing each consumed
  // lot's in-transit span at `onDate`. Returns the cash drawn and its capital
  // (cost) share — the caller decides whether that capital is an external outflow
  // (a withdraw) or an internal reinvestment (a buy or an absorbing Set balance —
  // no contribution change).
  const drawCash = (need: number, onDate: string): { drawn: number; costDrawn: number } => {
    let drawn = 0;
    let costDrawn = 0;
    while (need > CASH_EPSILON && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.remaining, need);
      const costTake = lot.costRemaining * (take / lot.remaining);
      lot.costRemaining -= costTake;
      spans.push({ from: lot.date, to: onDate, amount: take });
      lot.remaining -= take;
      drawn += take;
      costDrawn += costTake;
      need -= take;
      if (lot.remaining <= CASH_EPSILON) lots.shift();
    }
    return { drawn, costDrawn };
  };

  for (const txn of sorted) {
    const magnitude = Math.abs(txn.amount);
    const excluded =
      (txn.kind === "deposit" || txn.kind === "withdraw" || txn.kind === "cash_balance") &&
      excludeCashTickers?.has(txn.ticker);
    if (excluded) continue;
    switch (txn.kind) {
      case "sell": {
        if (magnitude > CASH_EPSILON) {
          // Cost basis of the proceeds (capital); the rest is realized gain. Unknown
          // → treat the whole proceeds as capital (can't split without a basis).
          const cost = txn.id != null ? (costBySellId?.get(txn.id) ?? magnitude) : magnitude;
          lots.push({
            date: txn.tradeDate,
            remaining: magnitude,
            costRemaining: Math.min(cost, magnitude),
          });
        }
        break;
      }
      case "deposit": {
        if (magnitude > CASH_EPSILON) pushCashFlow(txn.tradeDate, magnitude);
        balancesByTicker.set(txn.ticker, (balancesByTicker.get(txn.ticker) ?? 0) + magnitude);
        break;
      }
      case "withdraw": {
        if (magnitude > CASH_EPSILON) pushCashFlow(txn.tradeDate, -magnitude);
        balancesByTicker.set(
          txn.ticker,
          Math.max(0, (balancesByTicker.get(txn.ticker) ?? 0) - magnitude),
        );
        break;
      }
      case "cash_balance": {
        const assertedThb = (txn.units ?? 0) * (txn.fxToThb ?? 1);
        const prior = balancesByTicker.get(txn.ticker) ?? 0;
        const delta = assertedThb - prior;
        balancesByTicker.set(txn.ticker, assertedThb);
        if (txn.reconcile) {
          // LEGACY "no money moved" (#149, entry UI retired in #232): a pure
          // restatement — no flow — that asserts any in-transit proceeds are now held
          // cash: close their spans and drop the lots, so the window heuristic can't
          // retroactively withdraw deliberately-parked proceeds.
          for (const lot of lots) {
            if (lot.remaining > CASH_EPSILON) {
              spans.push({ from: lot.date, to: txn.tradeDate, amount: lot.remaining });
            }
          }
          lots.length = 0;
          break;
        }
        if (delta > CASH_EPSILON) {
          // AUTO-ABSORB (#232): the raise soaks up live in-transit sale proceeds
          // FIFO first — that part is the sale landing in the bank (an internal
          // transfer; the lot's span migrates into the held-cash position here).
          // Only the remainder crossed the boundary. No user classification: the
          // split is ledger arithmetic, and mistakes self-correct — an over-absorbed
          // raise skips exactly the phantom expiry the untouched lot would have
          // pushed, so lifetime contribution converges either way.
          expireBefore(txn.tradeDate);
          const { drawn } = drawCash(delta, txn.tradeDate);
          if (drawn > CASH_EPSILON && txn.id != null) absorbedByTxnId.set(txn.id, drawn);
          const remainder = delta - drawn;
          if (remainder > CASH_EPSILON) pushCashFlow(txn.tradeDate, remainder);
        } else if (delta < -CASH_EPSILON) {
          // A drop is money out at face. (A typo is fixed by editing the wrong row,
          // not by classifying a corrective assert.)
          pushCashFlow(txn.tradeDate, delta);
        }
        break;
      }
      case "buy": {
        expireBefore(txn.tradeDate);
        const { drawn } = drawCash(magnitude, txn.tradeDate);
        // Whatever live cash couldn't cover came from outside the bucket (new capital).
        const shortfall = magnitude - drawn;
        if (shortfall > CASH_EPSILON) {
          flows.push({ date: txn.tradeDate, amount: shortfall });
          returnFlows.push({ date: txn.tradeDate, amount: shortfall });
          if (txn.id != null) buyShortfallById.set(txn.id, shortfall);
        }
        break;
      }
      default:
        break; // reinvest/dividend/fee/fund anchors: no cash effect
    }
  }

  // Terminal sweep: lots past the window expired (capital withdrawn at their sell
  // date); younger lots are genuinely in transit and stay on the chart.
  let terminalCash = 0;
  for (const lot of lots) {
    if (lot.remaining <= CASH_EPSILON) continue;
    if (addDays(lot.date, windowDays) < today) {
      if (lot.costRemaining > CASH_EPSILON) {
        flows.push({ date: lot.date, amount: -lot.costRemaining });
      }
      returnFlows.push({ date: lot.date, amount: -lot.remaining });
    } else {
      spans.push({ from: lot.date, to: null, amount: lot.remaining });
      terminalCash += lot.remaining;
    }
  }

  // Spans → step series: +amount at `from`, −amount at `to`, accumulated.
  const deltas = new Map<string, number>();
  for (const s of spans) {
    deltas.set(s.from, (deltas.get(s.from) ?? 0) + s.amount);
    if (s.to !== null) deltas.set(s.to, (deltas.get(s.to) ?? 0) - s.amount);
  }
  const cashTimeline: CashPoint[] = [];
  let level = 0;
  for (const date of Array.from(deltas.keys()).sort()) {
    level += deltas.get(date) ?? 0;
    cashTimeline.push({ date, cash: level > CASH_EPSILON ? level : 0 });
  }

  // Retroactive expiries land out of date order — restore it.
  const byDate = (a: ExternalFlow, b: ExternalFlow) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  flows.sort(byDate);
  returnFlows.sort(byDate);
  cashEventFlows.sort(byDate);

  return {
    cashTimeline,
    externalFlows: flows,
    returnFlows,
    terminalCash,
    buyShortfallById,
    absorbedByTxnId,
    cashEventFlows,
    balancesByTicker,
  };
}

// `today` only shapes the terminal sweep (lot flows we discard in the views below);
// the explicit-cash flows and balances are today-independent, so any date works.
const ANY_TODAY = "9999-12-31";

/**
 * The boundary CONTRIBUTION flows from explicit cash events (#149/#232) — the SINGLE
 * definition shared by the settlement-cash chart line, the XIRR cash flows, and the
 * contribution summary, so the three never silently diverge (PRD §6 review trap #3).
 * A view over `foldSettlementCash` — absorption (#232) makes an assert's flow depend
 * on the live lot state, so this can no longer be computed from cash events alone.
 *
 * Sign (chart convention): > 0 money ENTERED the portfolio (a deposit, or a Set-balance
 * raise beyond absorbed proceeds), < 0 it LEFT (a withdraw, or a Set-balance drop). A
 * legacy `reconcile` Set balance moves no money → no flow. XIRR negates these (money
 * in = a negative, out-of-pocket flow).
 *
 * Per-account running balance: a Set balance's delta is measured against THAT account's
 * prior level (THB = native units × `fxToThb`), not a bucket-wide total — several cash
 * accounts can share a bucket.
 */
export function cashContributionFlows(
  txns: readonly LedgerTxn[],
  /**
   * Cash account tickers whose contributions are EXCLUDED — a `reserved` account (#149)
   * is set aside, so its deposits / Set-balance changes are not portfolio contributions
   * and its rows produce no flows (nor absorb proceeds). (Its value still counts in net
   * worth, just not in the return — the terminal-side exclusion is the caller's job.)
   */
  excludeTickers?: ReadonlySet<string>,
): ExternalFlow[] {
  // PARTITION BY BUCKET before folding. The analytics path passes every owned
  // bucket's rows in one call; in-transit lots are a per-portfolio concept, so a
  // raise in one bucket must never absorb another bucket's sale proceeds (and two
  // buckets' same-named accounts must not share a running balance). The chart path
  // already folds per bucket — partitioning here keeps the two views identical.
  // Rows without a bucketId (pure callers, tests) fold as one group, unchanged.
  const groups = new Map<string, LedgerTxn[]>();
  for (const t of txns) {
    const key = t.bucketId ?? "";
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const flows: ExternalFlow[] = [];
  for (const group of groups.values()) {
    flows.push(
      ...foldSettlementCash(group, ANY_TODAY, SETTLEMENT_WINDOW_DAYS, undefined, excludeTickers)
        .cashEventFlows,
    );
  }
  if (groups.size > 1) {
    flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return flows;
}

/**
 * Per-account explicit-cash balance (THB) as of `asOf` (inclusive) — the same
 * running-balance rule the contribution classifier applies, minus the flows. Feeds the
 * funded-from-cash nudge's "could this account have covered the buy?" check (#232).
 */
export function cashBalancesAsOf(
  txns: readonly LedgerTxn[],
  asOf: string,
): ReadonlyMap<string, number> {
  return foldSettlementCash(
    txns.filter((t) => t.tradeDate <= asOf),
    asOf,
  ).balancesByTicker;
}

/**
 * A funded-from-cash nudge (#232), returned by `POST /api/transactions` for a
 * just-inserted buy whose post-heuristic shortfall a tracked, non-reserved cash
 * account could cover. The client offers a one-tap matching withdraw so buy(+) and
 * cash(−) net to an internal transfer instead of double-counting as new money.
 */
export interface CashNudge {
  buyTicker: string;
  /** The buy's trade date — the offered withdraw is dated here. */
  tradeDate: string;
  /** THB the in-transit heuristic did NOT cover — the offered withdraw amount. */
  shortfall: number;
  /**
   * Candidate accounts (balance ≥ shortfall at the buy date), largest first.
   * `balance` is THB (the sufficiency check is THB-vs-THB); `currency` is the
   * account's native currency, so a non-THB account records its withdraw in native
   * units at the buy-date FX rate rather than storing THB as its units.
   */
  accounts: Array<{ ticker: string; balance: number; currency: string }>;
}

/** `previewBalanceChange`'s verdict — what saving a draft Set balance will conclude. */
export interface BalanceChangePreview {
  /** The account's balance before this assert (THB) — the delta's baseline. */
  prior: number;
  /**
   * True when the account has no explicit-cash history before this assert — a FIRST
   * Set balance. Its whole amount defaulting to a contribution is correct and needs
   * no narration (a "+฿500,000 added" consequence line on an opening assertion of a
   * long-held account reads as alarming, not honest).
   */
  first: boolean;
  /** The raise (+) or drop (−) vs `prior`, THB. */
  delta: number;
  /** The part of a raise live in-transit sale proceeds will absorb — not new money. */
  absorbed: number;
}

/**
 * Preview how a DRAFT Set balance will classify (#232), for the entry form's
 * consequence line — the same arithmetic the fold will run at save: raise = absorb
 * live proceeds first, remainder is new money; drop = money out.
 */
export function previewBalanceChange(
  txns: readonly LedgerTxn[],
  draft: { ticker: string; tradeDate: string; assertedThb: number },
): BalanceChangePreview {
  // The fold state at the assert moment: everything before the date, plus same-date
  // rows the fold ranks AHEAD of a Set balance (sell/deposit/withdraw + earlier
  // asserts — never a buy, which draws only after the balance asserts).
  const upTo = txns.filter(
    (t) => t.tradeDate < draft.tradeDate || (t.tradeDate === draft.tradeDate && t.kind !== "buy"),
  );
  const r = foldSettlementCash(upTo, draft.tradeDate);
  // Account names match case-insensitively everywhere else (tickerKey); mirror that.
  const key = draft.ticker.trim().toUpperCase();
  let prior = 0;
  let first = true;
  for (const [ticker, balance] of r.balancesByTicker) {
    if (ticker.trim().toUpperCase() === key) {
      prior += balance;
      first = false;
    }
  }
  const delta = draft.assertedThb - prior;
  // Live lots at the assert (terminalCash with today = the assert date matches what
  // drawCash will find: both drop lots older than the window as of that date).
  const absorbed = delta > CASH_EPSILON ? Math.min(delta, r.terminalCash) : 0;
  return { prior, first, delta, absorbed };
}
