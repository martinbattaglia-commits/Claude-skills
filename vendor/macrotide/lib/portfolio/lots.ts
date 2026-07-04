// Cost-basis lot engine — pure, deterministic, DB- and network-free.
//
// Folds a transaction ledger into per-position state (running units + remaining
// cost basis + derived average cost), a realized-CAPITAL-gain log, and the
// separate income (cash dividends) / expense (standalone fees) lines. It is the
// math behind the Activity ledger's realized gains, the cost-basis-vs-value
// timeline, AND the derived `holdings` projection (positions are computed from
// the ledger, never typed directly — see ADR 0004).
//
// Design rules baked in (see
// docs/explanation/decisions/0004-unified-ledger-positions-derived.md):
//
//   • Everything is in THB. The SIGNED `amount` on each txn is the authoritative
//     money field — it already folds in fees and trade-date FX. This engine uses
//     its MAGNITUDE for basis/proceeds and never re-applies any FX rate, so the
//     mixed-currency double-count cannot creep back in. (XIRR consumes the signed
//     value directly; see xirr.ts.)
//   • Basis on a sell is removed PROPORTIONALLY (avgCost × unitsSold for average,
//     oldest-lot cost for FIFO) — NEVER by sale proceeds. This is the single most
//     important invariant; getting it wrong corrupts every later realized gain.
//   • Rows are ALWAYS folded in (tradeDate, createdAt, id) order, never import
//     order — moving-average basis at a sell depends on the running average at
//     that moment, so a backfilled/out-of-order buy must still land before a
//     later sell.
//   • A full exit resets the position (next buy starts a fresh average, never a
//     stale blend). An oversell is flagged, never allowed to go negative.
//
// Two event categories (ADR 0004): DELTAS (buy/sell/dividend/fee/split/reinvest)
// move the position relatively; ANCHORS (opening/snapshot) assert an absolute
// position at a date and DISCARD accumulated drift before them:
//   • `opening`  — opening balance: absolute units at an optional avg cost. The
//     "start from where I am, then track forward" flow. Counts toward
//     net-invested when costed.
//   • `snapshot` — point-in-time restatement: absolute units (+ optional avg
//     cost). Resets the position; never a realized event, never a cash flow. If
//     no avg cost is given, the prior per-unit cost is CARRIED FORWARD (units
//     snap to the anchor, cost basis is preserved) — a value-only restatement
//     never destroys cost basis.
//
// Cost and market value are kept ORTHOGONAL: a position can be held with cost
// UNKNOWN (an uncosted opening/snapshot, or a buy onto an already-unknown
// position). Unknown cost surfaces as `costBasis: null` / `avgCost: null` while
// `units > 0`; gain-based analytics then return null rather than fabricate a
// basis. A ticker is cost-known only while ALL its contributing units are
// costed.

export type TxnKind =
  | "buy"
  | "sell"
  | "dividend"
  | "fee"
  | "split"
  | "reinvest"
  | "opening"
  | "snapshot"
  // Explicit cash events (issue #149), scoped to a named cash account (the ticker).
  // They fold into a held-cash POSITION at face value (1 ฿ = 1 unit, avg cost 1) so
  // bank balances show up alongside funds, but never touch fund net-invested /
  // realized gains. The bucket-level contribution + in-transit override lives in the
  // settlement-cash fold; here they only move the cash position.
  | "deposit"
  | "withdraw"
  | "cash_balance";

export type CostBasisMethod = "average" | "fifo";

/** The pure subset of a transaction row the lot engine needs. */
export interface LedgerTxn {
  /** Stable tie-breaker for same-date ordering (the DB row id). */
  id?: number;
  /** Owning portfolio — read ONLY by the settlement-cash fold to scope in-transit
   * lots and absorption per bucket when a caller folds several buckets' rows
   * together (the analytics path). Position math never crosses buckets anyway. */
  bucketId?: string;
  ticker: string;
  kind: TxnKind;
  /** ISO-8601 economic event date — the ordering + discounting key. */
  tradeDate: string;
  /**
   * Units moved. For `buy`/`sell`/`reinvest` the share count. For `split` this is
   * the RATIO (2 = 2-for-1, 0.5 = 1-for-2 reverse). For an `opening`/`snapshot`
   * anchor it is the ABSOLUTE units held as of the date. `null`/absent for a cash
   * `dividend` or standalone `fee`.
   */
  units?: number | null;
  /**
   * Per-unit cost in THB. Only read for `opening`/`snapshot` anchors, where it is
   * the avg cost being asserted (null/absent → cost unknown). Deltas derive their
   * cost from `amount`; this is ignored for them.
   */
  pricePerUnit?: number | null;
  /** Signed THB cash flow; magnitude is the basis (buy) or proceeds (sell). */
  amount: number;
  /**
   * Trade-date FX rate (native → THB). Read by the settlement-cash fold to value a
   * `cash_balance` assertion in THB (`units × fxToThb`); 1 for THB. Ignored elsewhere.
   */
  fxToThb?: number | null;
  /**
   * `cash_balance` only: the "no money moved" override (#149). When true, the Set
   * balance is a pure reconciliation — no contribution flow, and it clears the bucket's
   * in-transit settlement lots. When false/absent, the change vs the prior asserted
   * balance is a contribution/withdrawal. See lib/portfolio/settlement-cash.ts.
   */
  reconcile?: boolean | null;
  /** Secondary tie-breaker when ids are absent. */
  createdAt?: string;
}

/** Per-position state after folding the whole ledger. */
export interface PositionState {
  ticker: string;
  /** Units still held. */
  units: number;
  /** Remaining cost basis in THB, or null when the cost is unknown. */
  costBasis: number | null;
  /** Derived average cost per unit in THB; null when nothing is held OR cost is unknown. */
  avgCost: number | null;
}

/** One realized CAPITAL gain — produced only by `sell` rows on cost-known positions. */
export interface RealizedEvent {
  /** The originating sell txn's id (when present) — lets callers map a sell to its cost basis. */
  id?: number;
  ticker: string;
  tradeDate: string;
  unitsSold: number;
  /** THB received (the sell `amount` magnitude, already net of fee). */
  proceeds: number;
  /** THB cost basis removed for the sold units. */
  costRemoved: number;
  /** proceeds − costRemoved (negative = a realized loss). */
  realizedGain: number;
}

/** A cash dividend received (income) or a standalone fee paid (expense). */
export interface CashEvent {
  ticker: string;
  tradeDate: string;
  /** THB magnitude. */
  amount: number;
}

export type LotWarningCode = "oversell" | "missing_units" | "missing_ratio" | "cost_unknown";

export interface LotWarning {
  code: LotWarningCode;
  ticker: string;
  tradeDate: string;
  detail: string;
}

/** A snapshot of aggregate cost basis after an event — drives the timeline chart. */
export interface BasisPoint {
  date: string;
  /** Total remaining KNOWN cost basis across all positions, THB (unknown-cost positions contribute 0). */
  costBasis: number;
  /** Cumulative net invested (Σ buys + costed openings − Σ sells) to date, THB. */
  netInvested: number;
}

/**
 * One per-ticker position checkpoint, pushed after EVERY folded event (even a
 * no-op dividend/fee) — the point-in-time replay the value-over-time chart walks.
 * Same-date checkpoints are valid; the last one for a date is the end-of-day state.
 */
export interface PositionCheckpoint {
  date: string;
  /** Units held after the event. */
  units: number;
  /** Remaining cost basis in THB after the event, or null while cost is unknown. */
  costBasis: number | null;
}

export interface LotEngineResult {
  method: CostBasisMethod;
  positions: PositionState[];
  realized: RealizedEvent[];
  realizedTotal: number;
  income: CashEvent[];
  incomeTotal: number;
  expenses: CashEvent[];
  expenseTotal: number;
  warnings: LotWarning[];
  /** Aggregate cost-basis timeline, one point per event in date order. */
  basisTimeline: BasisPoint[];
  /** Per-ticker point-in-time replay, one checkpoint per event in date order. */
  positionTimeline: Map<string, PositionCheckpoint[]>;
}

// Units below this are treated as zero (float dust after a full exit).
const UNIT_EPSILON = 1e-9;

/**
 * Collapse case-variant tickers to ONE display case before folding (#235). Two
 * ledger rows that differ only in case (a custom symbol free-typed as "voo" then
 * "VOO") are the SAME holding, so they must fold to one position — not silently
 * fork. The most-recent (by trade date, then input order) non-empty case wins as
 * the display case — the explicit input-index tiebreak keeps the winner
 * deterministic on a same-date tie without relying on sort stability. For a
 * cataloged fund the ledger already carries one canonical (catalog) case, so this
 * is a no-op there; it only changes the very mixed-case rows it fixes.
 */
export function foldTickerCase<T extends { ticker: string; tradeDate: string }>(
  rows: readonly T[],
): T[] {
  const display = new Map<string, string>();
  for (const { r } of rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      a.r.tradeDate < b.r.tradeDate ? -1 : a.r.tradeDate > b.r.tradeDate ? 1 : a.i - b.i,
    ))
    if (r.ticker) display.set(r.ticker.trim().toUpperCase(), r.ticker);
  return rows.map((r) => {
    const d = display.get(r.ticker.trim().toUpperCase());
    return d && d !== r.ticker ? { ...r, ticker: d } : r;
  });
}

interface AverageState {
  units: number;
  basis: number;
}

interface Lot {
  units: number;
  costPerUnit: number;
}

/**
 * Fold a transaction ledger into realized gains + position state.
 *
 * @param txns  the ledger rows (any order — sorted internally by trade date)
 * @param method "average" (default) or "fifo"
 */
export function reduceLots(
  txns: readonly LedgerTxn[],
  method: CostBasisMethod = "average",
): LotEngineResult {
  const sorted = [...foldTickerCase(txns)].sort(compareTxns);

  // Per-ticker state. Average tracks {units, basis}; FIFO tracks a lot queue.
  const avg = new Map<string, AverageState>();
  const fifo = new Map<string, Lot[]>();
  // A ticker is cost-known until an uncosted anchor (or a buy onto an already-
  // unknown position) makes its basis unblendable. Default true; absence = true.
  const costKnown = new Map<string, boolean>();
  const isKnown = (ticker: string): boolean => costKnown.get(ticker) ?? true;

  const realized: RealizedEvent[] = [];
  const income: CashEvent[] = [];
  const expenses: CashEvent[] = [];
  const warnings: LotWarning[] = [];
  const basisTimeline: BasisPoint[] = [];
  const positionTimeline = new Map<string, PositionCheckpoint[]>();

  let netInvested = 0;

  const aggregateBasis = (): number => {
    let total = 0;
    if (method === "fifo") {
      for (const [ticker, lots] of fifo) {
        if (!isKnown(ticker)) continue;
        for (const lot of lots) total += lot.units * lot.costPerUnit;
      }
      return total;
    }
    for (const [ticker, s] of avg) {
      if (!isKnown(ticker)) continue;
      total += s.basis;
    }
    return total;
  };

  // One ticker's current cost basis (units × avg cost). Uncosted → 0 (it has
  // contributed nothing to net-invested). Drives the anchor basis-delta below.
  const tickerBasis = (ticker: string): number => {
    if (!isKnown(ticker)) return 0;
    if (method === "fifo") {
      let total = 0;
      for (const lot of fifo.get(ticker) ?? []) total += lot.units * lot.costPerUnit;
      return total;
    }
    return avg.get(ticker)?.basis ?? 0;
  };

  for (const txn of sorted) {
    const { ticker, kind, tradeDate } = txn;
    const magnitude = Math.abs(txn.amount);

    switch (kind) {
      case "buy":
      case "reinvest": {
        const units = txn.units ?? 0;
        if (units <= 0) {
          warnings.push({
            code: "missing_units",
            ticker,
            tradeDate,
            detail: `${kind} has no positive units`,
          });
          break;
        }
        applyBuy(method, avg, fifo, ticker, units, magnitude, isKnown(ticker));
        // A reinvested (accumulating) dividend adds basis but is NOT external
        // cash — XIRR excludes it. A cash buy IS external. Either way it adds to
        // net-invested for the cost-basis timeline.
        netInvested += magnitude;
        break;
      }
      case "sell": {
        const units = txn.units ?? 0;
        if (units <= 0) {
          warnings.push({
            code: "missing_units",
            ticker,
            tradeDate,
            detail: "sell has no positive units",
          });
          break;
        }
        const ev = applySell(
          method,
          avg,
          fifo,
          ticker,
          units,
          magnitude,
          tradeDate,
          isKnown(ticker),
          warnings,
        );
        // A full exit resets the position to a fresh, cost-known slate.
        if (positionUnits(method, avg, fifo, ticker) <= UNIT_EPSILON) costKnown.set(ticker, true);
        if (ev) {
          ev.id = txn.id;
          realized.push(ev);
        }
        netInvested -= magnitude;
        break;
      }
      case "split": {
        const ratio = txn.units ?? 0;
        if (ratio <= 0) {
          warnings.push({
            code: "missing_ratio",
            ticker,
            tradeDate,
            detail: "split has no positive ratio (set units = post:pre ratio)",
          });
          break;
        }
        applySplit(method, avg, fifo, ticker, ratio);
        break;
      }
      case "opening":
      case "snapshot": {
        const units = txn.units ?? 0;
        // Cost basis (units × avg cost) already counted into net-invested for this
        // fund — 0 if uncosted. Its CHANGE across this anchor is the money added or
        // removed this period: market-immune, because avg cost only moves when you
        // buy or sell, never when the price changes.
        const priorBasis = tickerBasis(ticker);
        if (units <= 0) {
          // A zero-unit anchor clears the position; its basis leaves net-invested.
          applyAnchor(method, avg, fifo, ticker, 0, null, false);
          costKnown.set(ticker, true);
          netInvested -= priorBasis;
          break;
        }
        // Avg cost: explicit pricePerUnit, else carry the prior per-unit cost
        // forward (a value-only restatement keeps its basis). A fresh anchor with
        // no price is a genuinely uncosted balance.
        const hasPriorPosition = positionUnits(method, avg, fifo, ticker) > UNIT_EPSILON;
        const explicit = txn.pricePerUnit ?? null;
        const prior =
          hasPriorPosition && isKnown(ticker) ? priorAvgCost(method, avg, fifo, ticker) : null;
        const perUnit = explicit !== null && explicit > 0 ? explicit : prior;
        const known = perUnit !== null;
        applyAnchor(method, avg, fifo, ticker, units, known ? perUnit : null, known);
        costKnown.set(ticker, known);
        if (!known) {
          warnings.push({
            code: "cost_unknown",
            ticker,
            tradeDate,
            detail: `${kind} has no average cost — gains and return are unavailable until you add one`,
          });
        }
        // Contribution = the INCREASE in cost basis. A fresh opening counts its full
        // basis (prior 0); a re-statement counts only what changed — zero on a pure
        // market move, positive when money was added (more units and/or a higher avg
        // cost), negative if the basis fell. A snapshot can't see sale proceeds, so a
        // basis drop reads as an at-cost withdrawal (realized gain isn't recoverable).
        const newBasis = known ? units * (perUnit as number) : 0;
        netInvested += newBasis - priorBasis;
        break;
      }
      case "dividend": {
        // Cash dividend paid out — income, not a capital gain. No basis effect.
        income.push({ ticker, tradeDate, amount: magnitude });
        break;
      }
      case "fee": {
        // Standalone account fee — expense, no basis effect, no realized gain.
        expenses.push({ ticker, tradeDate, amount: magnitude });
        break;
      }
      case "deposit": {
        // Cash into a bank account — a position add at face: `units` is the amount
        // in the account's NATIVE currency (e.g. 100 for $100), avg cost 1, so the
        // value series prices it units × 1 × FX. NOT added to net-invested: cash
        // contribution rides the settlement-cash external-flow fold (in THB), not
        // the fund cost-basis timeline.
        const units = txn.units ?? 0;
        if (units > 0) applyBuy(method, avg, fifo, ticker, units, units, true);
        break;
      }
      case "withdraw": {
        // Cash out of a bank account — removes position at face (native units). No
        // realized event (cash gains nothing); over-withdraw is flagged like an oversell.
        const units = txn.units ?? 0;
        if (units > 0) {
          applySell(method, avg, fifo, ticker, units, units, tradeDate, true, warnings);
        }
        break;
      }
      case "cash_balance": {
        // Absolute restatement of a cash balance (the cash analogue of a fund
        // Balance): units = the asserted NATIVE balance (resolved upstream for a
        // value-only row), priced at 1. Resets the position; never touches net-invested.
        const units = txn.units ?? 0;
        applyAnchor(method, avg, fifo, ticker, units, units > 0 ? 1 : null, units > 0);
        costKnown.set(ticker, true);
        break;
      }
    }

    basisTimeline.push({ date: tradeDate, costBasis: aggregateBasis(), netInvested });

    // Point-in-time checkpoint from the same state the terminal fold reports —
    // the replay can never disagree with `positions`.
    let checkpoints = positionTimeline.get(ticker);
    if (!checkpoints) {
      checkpoints = [];
      positionTimeline.set(ticker, checkpoints);
    }
    checkpoints.push({
      date: tradeDate,
      units: positionUnits(method, avg, fifo, ticker),
      costBasis: isKnown(ticker) ? tickerBasis(ticker) : null,
    });
  }

  const positions = collectPositions(method, avg, fifo, isKnown);
  const realizedTotal = realized.reduce((s, e) => s + e.realizedGain, 0);
  const incomeTotal = income.reduce((s, e) => s + e.amount, 0);
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);

  return {
    method,
    positions,
    realized,
    realizedTotal,
    income,
    incomeTotal,
    expenses,
    expenseTotal,
    warnings,
    basisTimeline,
    positionTimeline,
  };
}

/** Stable chronological order: trade date, then createdAt, then id. */
export function compareTxns(a: LedgerTxn, b: LedgerTxn): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
  const ac = a.createdAt ?? "";
  const bc = b.createdAt ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
}

/** Current held units for a ticker (method-aware). */
function positionUnits(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
): number {
  if (method === "fifo") return (fifo.get(ticker) ?? []).reduce((s, l) => s + l.units, 0);
  return avg.get(ticker)?.units ?? 0;
}

/** Per-unit cost of the current position (for carrying forward across a snapshot). */
function priorAvgCost(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
): number | null {
  if (method === "fifo") {
    const lots = fifo.get(ticker) ?? [];
    const units = lots.reduce((s, l) => s + l.units, 0);
    if (units <= UNIT_EPSILON) return null;
    const basis = lots.reduce((s, l) => s + l.units * l.costPerUnit, 0);
    return basis / units;
  }
  const s = avg.get(ticker);
  if (!s || s.units <= UNIT_EPSILON) return null;
  return s.basis / s.units;
}

function applyBuy(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
  units: number,
  costThb: number,
  known: boolean,
): void {
  if (method === "fifo") {
    const lots = fifo.get(ticker) ?? [];
    // Onto an already-unknown position the per-unit cost can't be blended; carry a
    // zero-cost lot so the unit count stays right (basis is reported as unknown).
    lots.push({ units, costPerUnit: known ? costThb / units : 0 });
    fifo.set(ticker, lots);
    return;
  }
  const s = avg.get(ticker) ?? { units: 0, basis: 0 };
  s.units += units;
  if (known) s.basis += costThb;
  avg.set(ticker, s);
}

function applySell(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
  unitsSold: number,
  proceeds: number,
  tradeDate: string,
  known: boolean,
  warnings: LotWarning[],
): RealizedEvent | null {
  if (method === "fifo") {
    const lots = fifo.get(ticker) ?? [];
    const held = lots.reduce((s, l) => s + l.units, 0);
    let remaining = unitsSold;
    let costRemoved = 0;
    while (remaining > UNIT_EPSILON && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.units, remaining);
      costRemoved += take * lot.costPerUnit;
      lot.units -= take;
      remaining -= take;
      if (lot.units <= UNIT_EPSILON) lots.shift();
    }
    if (remaining > UNIT_EPSILON) {
      warnings.push({
        code: "oversell",
        ticker,
        tradeDate,
        detail: `sold ${unitsSold} units but only ${held} held`,
      });
    }
    fifo.set(ticker, lots);
    // Cost unknown → no computable capital gain; units still leave the position.
    if (!known) return null;
    return {
      ticker,
      tradeDate,
      unitsSold,
      proceeds,
      costRemoved,
      realizedGain: proceeds - costRemoved,
    };
  }

  const s = avg.get(ticker) ?? { units: 0, basis: 0 };
  const avgCost = s.units > UNIT_EPSILON ? s.basis / s.units : 0;
  const sellable = Math.min(unitsSold, s.units);
  if (unitsSold > s.units + UNIT_EPSILON) {
    warnings.push({
      code: "oversell",
      ticker,
      tradeDate,
      detail: `sold ${unitsSold} units but only ${s.units} held`,
    });
  }
  const costRemoved = avgCost * sellable;
  s.units -= sellable;
  if (known) s.basis -= costRemoved;
  // Full exit: snap to zero so the next buy starts a fresh average (no dust).
  if (s.units <= UNIT_EPSILON) {
    s.units = 0;
    s.basis = 0;
  }
  avg.set(ticker, s);
  if (!known) return null;
  return {
    ticker,
    tradeDate,
    unitsSold,
    proceeds,
    costRemoved,
    realizedGain: proceeds - costRemoved,
  };
}

function applySplit(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
  ratio: number,
): void {
  // Total dollar basis is unchanged; units scale by the ratio, so per-unit cost
  // scales by 1/ratio. With average cost we derive avgCost = basis/units on
  // demand, so only `units` needs scaling. With FIFO each lot's per-unit cost
  // must be rescaled explicitly.
  if (method === "fifo") {
    const lots = fifo.get(ticker);
    if (!lots) return;
    for (const lot of lots) {
      lot.units *= ratio;
      lot.costPerUnit /= ratio;
    }
    return;
  }
  const s = avg.get(ticker);
  if (!s) return;
  s.units *= ratio;
}

/**
 * Apply an anchor: discard any prior drift and SET the position to `units` (at
 * `perUnit` cost when known). `units <= 0` clears the position entirely.
 */
function applyAnchor(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  ticker: string,
  units: number,
  perUnit: number | null,
  known: boolean,
): void {
  if (units <= UNIT_EPSILON) {
    if (method === "fifo") fifo.set(ticker, []);
    else avg.set(ticker, { units: 0, basis: 0 });
    return;
  }
  if (method === "fifo") {
    fifo.set(ticker, [{ units, costPerUnit: known ? (perUnit as number) : 0 }]);
    return;
  }
  avg.set(ticker, { units, basis: known ? units * (perUnit as number) : 0 });
}

function collectPositions(
  method: CostBasisMethod,
  avg: Map<string, AverageState>,
  fifo: Map<string, Lot[]>,
  isKnown: (ticker: string) => boolean,
): PositionState[] {
  const out: PositionState[] = [];
  if (method === "fifo") {
    for (const [ticker, lots] of fifo) {
      const units = lots.reduce((s, l) => s + l.units, 0);
      if (units <= UNIT_EPSILON) continue;
      if (!isKnown(ticker)) {
        out.push({ ticker, units, costBasis: null, avgCost: null });
        continue;
      }
      const basis = lots.reduce((s, l) => s + l.units * l.costPerUnit, 0);
      out.push({ ticker, units, costBasis: basis, avgCost: basis / units });
    }
  } else {
    for (const [ticker, s] of avg) {
      if (s.units <= UNIT_EPSILON) continue;
      if (!isKnown(ticker)) {
        out.push({ ticker, units: s.units, costBasis: null, avgCost: null });
        continue;
      }
      out.push({
        ticker,
        units: s.units,
        costBasis: s.basis,
        avgCost: s.basis / s.units,
      });
    }
  }
  out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return out;
}
