import { describe, expect, it } from "vitest";
import type { LedgerTxn } from "./lots";
import {
  cashBalancesAsOf,
  cashContributionFlows,
  foldSettlementCash,
  previewBalanceChange,
} from "./settlement-cash";

// Synthetic data only (EXAMPLE-FUND-*), never real fund codes.
const A = "EXAMPLE-FUND-A";
const B = "EXAMPLE-FUND-B";

const TODAY = "2025-06-01";

function tx(p: Partial<LedgerTxn> & Pick<LedgerTxn, "kind" | "amount">): LedgerTxn {
  return { ticker: A, tradeDate: "2024-01-01", ...p };
}

function cashOn(r: ReturnType<typeof foldSettlementCash>, date: string): number {
  let level = 0;
  for (const p of r.cashTimeline) {
    if (p.date > date) break;
    level = p.cash;
  }
  return level;
}

describe("foldSettlementCash", () => {
  it("keeps switch proceeds as in-transit cash until the rebuy consumes them", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
        tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-03-01" }),
        tx({ ticker: B, kind: "buy", units: 10, amount: -1500, tradeDate: "2024-03-08" }),
      ],
      TODAY,
    );
    // External money: only the original 1000. The switch is internal.
    expect(r.externalFlows).toEqual([{ date: "2024-01-01", amount: 1000 }]);
    // Cash exists exactly for the transit days [sell, rebuy).
    expect(cashOn(r, "2024-03-01")).toBeCloseTo(1500, 6);
    expect(cashOn(r, "2024-03-07")).toBeCloseTo(1500, 6);
    expect(cashOn(r, "2024-03-08")).toBe(0);
    expect(r.terminalCash).toBe(0);
  });

  it("nets a same-day switch to zero regardless of row order (sells fold first)", () => {
    const r = foldSettlementCash(
      [
        // Buy row inserted BEFORE the sell row, same trade date.
        tx({ ticker: B, kind: "buy", units: 10, amount: -500, tradeDate: "2024-03-01", id: 1 }),
        tx({ kind: "sell", units: 50, amount: 500, tradeDate: "2024-03-01", id: 2 }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([]);
    expect(r.terminalCash).toBe(0);
  });

  it("treats a partial rebuy's leftover as withdrawn AT THE SELL DATE after the window", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01" }),
        tx({ ticker: B, kind: "buy", units: 10, amount: -800, tradeDate: "2024-03-10" }),
      ],
      TODAY,
    );
    // 800 consumed; the 200 remainder expired retroactively at the sell date.
    expect(r.externalFlows).toEqual([{ date: "2024-03-01", amount: -200 }]);
    // The expired 200 never shows as cash — only the consumed 800 was live.
    expect(cashOn(r, "2024-03-05")).toBeCloseTo(800, 6);
    expect(cashOn(r, "2024-03-10")).toBe(0);
  });

  it("a buy outside the window cannot consume stale proceeds (reads as new money)", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01" }),
        tx({ ticker: B, kind: "buy", units: 10, amount: -1000, tradeDate: "2024-05-01" }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([
      { date: "2024-03-01", amount: -1000 }, // proceeds expired (withdrawn)
      { date: "2024-05-01", amount: 1000 }, // the late buy is fresh external money
    ]);
  });

  it("consumes overlapping sells FIFO across multiple buys", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", amount: 600, units: 1, tradeDate: "2024-03-01" }),
        tx({ ticker: B, kind: "sell", amount: 400, units: 1, tradeDate: "2024-03-03" }),
        tx({ kind: "buy", amount: -500, units: 1, tradeDate: "2024-03-05" }),
        tx({ ticker: B, kind: "buy", amount: -500, units: 1, tradeDate: "2024-03-09" }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([]);
    expect(cashOn(r, "2024-03-04")).toBeCloseTo(1000, 6);
    expect(cashOn(r, "2024-03-05")).toBeCloseTo(500, 6);
    expect(cashOn(r, "2024-03-09")).toBe(0);
  });

  it("keeps proceeds younger than the window as pending in-transit cash", () => {
    const r = foldSettlementCash(
      [tx({ kind: "sell", amount: 1000, units: 1, tradeDate: "2025-05-20" })],
      TODAY, // 12 days later — the rebuy may still be coming
    );
    expect(r.externalFlows).toEqual([]);
    expect(r.terminalCash).toBeCloseTo(1000, 6);
    expect(cashOn(r, TODAY)).toBeCloseTo(1000, 6);
  });

  it("ignores dividends, fees, reinvests, and anchors", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "opening", units: 100, amount: 0, tradeDate: "2024-01-01" }),
        tx({ kind: "dividend", amount: 50, tradeDate: "2024-02-01" }),
        tx({ kind: "fee", amount: 10, tradeDate: "2024-02-02" }),
        tx({ kind: "reinvest", units: 2, amount: -50, tradeDate: "2024-02-03" }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([]);
    expect(r.cashTimeline).toEqual([]);
    expect(r.terminalCash).toBe(0);
  });

  it("contribution stays flat across a grown switch (no proceeds-based phantom swing)", () => {
    // buy 1000 → grows → sell 1500 → rebuy 1500: external money is 1000 throughout.
    const r = foldSettlementCash(
      [
        tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
        tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-06-01" }),
        tx({ ticker: B, kind: "buy", units: 5, amount: -1500, tradeDate: "2024-06-05" }),
      ],
      TODAY,
    );
    const total = r.externalFlows.reduce((s, f) => s + f.amount, 0);
    expect(total).toBeCloseTo(1000, 6);
    expect(r.externalFlows.every((f) => f.amount > 0)).toBe(true);
    // A reinvested switch has no walk-away, so the TWR flows match exactly.
    expect(r.returnFlows).toEqual(r.externalFlows);
  });

  it("a profitable cash-out removes only COST BASIS — contribution floors at 0, never negative", () => {
    // Buy 1000 (cost 1000), grows, sell 1500 at a 500 gain, never rebuy → withdrawn.
    // Without the cost map the −1500 proceeds would push net contribution to −500.
    const r = foldSettlementCash(
      [
        tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01", id: 1 }),
        tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-03-01", id: 2 }),
      ],
      TODAY,
      undefined,
      new Map([[2, 1000]]), // sell #2 returned 1000 of capital (the other 500 is gain)
    );
    // +1000 in (the buy), −1000 out (capital withdrawn), gain left out of contribution.
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: 1000 },
      { date: "2024-03-01", amount: -1000 },
    ]);
    expect(r.externalFlows.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(0, 6);
    // The TWR flows strip the FULL proceeds (1500) at the walk-away — the realized
    // gain left the book, so it isn't read as a market loss in the time-weighted return.
    expect(r.returnFlows).toEqual([
      { date: "2024-01-01", amount: 1000 },
      { date: "2024-03-01", amount: -1500 },
    ]);
  });

  it("splits a partly-reinvested profitable sale's capital proportionally", () => {
    // Sell 1500 (cost 1000) → rebuy 900 within window (internal), 600 leftover expires.
    // Leftover is 600/1500 of the proceeds → 0.4 × 1000 = 400 of capital withdrawn.
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-03-01", id: 1 }),
        tx({ ticker: B, kind: "buy", units: 9, amount: -900, tradeDate: "2024-03-10", id: 2 }),
      ],
      TODAY,
      undefined,
      new Map([[1, 1000]]),
    );
    expect(r.externalFlows).toEqual([{ date: "2024-03-01", amount: -400 }]);
    // TWR strips the full leftover proceeds (600 = 1500 − 900 reinvested), not the
    // 400 cost portion.
    expect(r.returnFlows).toEqual([{ date: "2024-03-01", amount: -600 }]);
  });

  // ── Explicit cash events (issue #149) ──────────────────────────────────────

  it("a deposit is an external inflow and never becomes in-transit cash", () => {
    // Stored amount is signed (signFor deposit = -1); the fold uses its magnitude.
    const r = foldSettlementCash(
      [tx({ ticker: "THB", kind: "deposit", amount: -500, tradeDate: "2024-01-01" })],
      TODAY,
    );
    expect(r.externalFlows).toEqual([{ date: "2024-01-01", amount: 500 }]);
    expect(r.terminalCash).toBe(0);
    expect(r.cashTimeline).toEqual([]);
  });

  it("a withdraw is a boundary outflow at face and leaves in-transit sell proceeds alone", () => {
    // A withdraw moves money out of a TRACKED account; the sale proceeds are the
    // untracked-path heuristic — a separate pool the withdraw must not drain.
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2025-05-20", id: 1 }),
        tx({ ticker: "THB", kind: "withdraw", amount: 500, tradeDate: "2025-05-25" }),
      ],
      TODAY, // sell is 12d old → still in transit, never expires
      undefined,
      new Map([[1, 1000]]),
    );
    expect(r.externalFlows).toEqual([{ date: "2025-05-25", amount: -500 }]);
    expect(r.terminalCash).toBeCloseTo(1000, 6); // proceeds untouched
  });

  it("a withdraw beyond available cash still records the full external outflow", () => {
    const r = foldSettlementCash(
      [tx({ ticker: "THB", kind: "withdraw", amount: 700, tradeDate: "2024-02-01" })],
      TODAY,
    );
    expect(r.externalFlows).toEqual([{ date: "2024-02-01", amount: -700 }]);
  });

  it("a Set balance classifies the change vs the prior balance as money in/out by default", () => {
    const r = foldSettlementCash(
      [
        tx({
          ticker: "THB",
          kind: "cash_balance",
          units: 1000,
          amount: 0,
          tradeDate: "2024-01-01",
        }),
        tx({
          ticker: "THB",
          kind: "cash_balance",
          units: 1500,
          amount: 0,
          tradeDate: "2024-02-01",
        }),
        tx({
          ticker: "THB",
          kind: "cash_balance",
          units: 1200,
          amount: 0,
          tradeDate: "2024-03-01",
        }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: 1000 }, // first balance: delta from 0
      { date: "2024-02-01", amount: 500 }, // +500 added
      { date: "2024-03-01", amount: -300 }, // −300 spent/withdrawn
    ]);
  });

  it("a Set balance after a deposit counts only the un-deposited change (no double count)", () => {
    const r = foldSettlementCash(
      [
        tx({ ticker: "THB", kind: "deposit", amount: -500, tradeDate: "2024-01-01" }),
        tx({ ticker: "THB", kind: "cash_balance", units: 800, amount: 0, tradeDate: "2024-01-15" }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: 500 }, // the deposit
      { date: "2024-01-15", amount: 300 }, // balance 800 vs deposited 500 → +300 only
    ]);
  });

  it("values a non-THB Set balance in THB via fxToThb", () => {
    const r = foldSettlementCash(
      [
        tx({
          ticker: "USD-CASH",
          kind: "cash_balance",
          units: 100,
          fxToThb: 35,
          amount: 0,
          tradeDate: "2024-01-01",
        }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([{ date: "2024-01-01", amount: 3500 }]);
  });

  it("tracks each cash account's balance independently (per-ticker delta)", () => {
    const r = foldSettlementCash(
      [
        tx({
          ticker: "ACCT-1",
          kind: "cash_balance",
          units: 1000,
          amount: 0,
          tradeDate: "2024-01-01",
        }),
        tx({
          ticker: "ACCT-2",
          kind: "cash_balance",
          units: 500,
          amount: 0,
          tradeDate: "2024-01-02",
        }),
        tx({
          ticker: "ACCT-1",
          kind: "cash_balance",
          units: 1200,
          amount: 0,
          tradeDate: "2024-02-01",
        }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: 1000 }, // ACCT-1 first
      { date: "2024-01-02", amount: 500 }, // ACCT-2 first — NOT compared to ACCT-1
      { date: "2024-02-01", amount: 200 }, // ACCT-1 1200 vs its own prior 1000 → +200
    ]);
  });

  it("a reconcile Set balance asserts parked proceeds with no flow and clears in-transit lots", () => {
    // Sell, never rebuy: the heuristic ALONE would withdraw the proceeds at the sell
    // date (see "a buy outside the window…"). The "no money moved" override asserts the
    // cash accounts for them instead — they become a held-cash position, off this
    // in-transit timeline — and emits no contribution flow (issue #149 parked proceeds).
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01", id: 1 }),
        tx({
          ticker: "THB",
          kind: "cash_balance",
          units: 1000,
          amount: 0,
          reconcile: true,
          tradeDate: "2024-04-01",
        }),
      ],
      TODAY,
      undefined,
      new Map([[1, 1000]]),
    );
    expect(r.externalFlows).toEqual([]); // reconcile = no flow; no phantom withdrawal
    expect(r.terminalCash).toBe(0);
    expect(cashOn(r, "2024-03-15")).toBeCloseTo(1000, 6); // in transit until the assertion
    expect(cashOn(r, "2024-04-01")).toBe(0);
  });

  it("a buy draws from in-transit proceeds only — explicit cash is never auto-deducted", () => {
    // No-deduct model: the buy does NOT consume the deposited cash, so both the
    // contribution line (+deposit +buy) and net worth (cash + fund) move together —
    // consistent (the user records a withdraw via the nudge, or reconciles at Set balance).
    const r = foldSettlementCash(
      [
        tx({ ticker: "THB", kind: "deposit", amount: -500, tradeDate: "2024-01-01" }),
        tx({ kind: "buy", units: 5, amount: -500, tradeDate: "2024-02-01" }),
      ],
      TODAY,
    );
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: 500 },
      { date: "2024-02-01", amount: 500 },
    ]);
  });
});

describe("cashContributionFlows (the shared cash-contribution definition)", () => {
  it("deposit +, withdraw −, Set-balance delta; reconcile = no flow; FX in THB; per-account", () => {
    const flows = cashContributionFlows([
      { ticker: "ACCT", kind: "deposit", amount: -500, tradeDate: "2024-01-01" },
      {
        ticker: "ACCT",
        kind: "cash_balance",
        units: 800,
        fxToThb: 1,
        amount: 0,
        tradeDate: "2024-01-02",
      },
      { ticker: "ACCT", kind: "withdraw", amount: 100, tradeDate: "2024-01-03" },
      {
        ticker: "ACCT",
        kind: "cash_balance",
        units: 700,
        fxToThb: 1,
        amount: 0,
        reconcile: true,
        tradeDate: "2024-01-04",
      },
      {
        ticker: "USD",
        kind: "cash_balance",
        units: 100,
        fxToThb: 35,
        amount: 0,
        tradeDate: "2024-01-05",
      },
    ]);
    expect(flows).toEqual([
      { date: "2024-01-01", amount: 500 }, // deposit
      { date: "2024-01-02", amount: 300 }, // balance 800 vs deposited 500 → +300
      { date: "2024-01-03", amount: -100 }, // withdraw
      // 2024-01-04 reconcile → no flow
      { date: "2024-01-05", amount: 3500 }, // USD 100 × 35, its own account's first balance
    ]);
  });

  it("excludes a RESERVED account's rows entirely (#149 — its cash is out of the return)", () => {
    const flows = cashContributionFlows(
      [
        { ticker: "INVEST", kind: "deposit", amount: -1000, tradeDate: "2024-01-01" },
        {
          ticker: "EMERGENCY",
          kind: "cash_balance",
          units: 5000,
          fxToThb: 1,
          amount: 0,
          tradeDate: "2024-01-02",
        },
      ],
      new Set(["EMERGENCY"]), // reserved → skipped
    );
    expect(flows).toEqual([{ date: "2024-01-01", amount: 1000 }]); // only the investable account
  });
});

describe("buyShortfallById (#232 — the funded-from-cash nudge's trigger)", () => {
  it("reports only the part in-transit proceeds did not cover, keyed by txn id", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01", id: 1 }),
        // 1000 covered by the sell; 500 came from outside.
        tx({ ticker: B, kind: "buy", units: 10, amount: -1500, tradeDate: "2024-03-05", id: 2 }),
      ],
      TODAY,
    );
    expect(r.buyShortfallById.get(2)).toBeCloseTo(500, 6);
    expect(r.buyShortfallById.has(1)).toBe(false);
  });

  it("a fully covered rebuy never appears (a reinvested switch cannot double-fire)", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01", id: 1 }),
        tx({ ticker: B, kind: "buy", units: 10, amount: -1000, tradeDate: "2024-03-05", id: 2 }),
      ],
      TODAY,
    );
    expect(r.buyShortfallById.size).toBe(0);
  });

  it("a buy with no live lots is fully uncovered", () => {
    const r = foldSettlementCash(
      [tx({ kind: "buy", units: 10, amount: -800, tradeDate: "2024-03-01", id: 7 })],
      TODAY,
    );
    expect(r.buyShortfallById.get(7)).toBeCloseTo(800, 6);
  });
});

describe("cashBalancesAsOf", () => {
  it("folds deposit/withdraw/Set-balance into a per-account THB balance at a date", () => {
    const txns: LedgerTxn[] = [
      { ticker: "SAVINGS", kind: "deposit", amount: -1000, tradeDate: "2024-01-01" },
      { ticker: "SAVINGS", kind: "withdraw", amount: 200, tradeDate: "2024-01-05" },
      {
        ticker: "USD ACCT",
        kind: "cash_balance",
        units: 100,
        fxToThb: 35,
        amount: 0,
        tradeDate: "2024-01-03",
      },
      // After the as-of date — must not count.
      { ticker: "SAVINGS", kind: "deposit", amount: -9000, tradeDate: "2024-02-01" },
    ];
    const balances = cashBalancesAsOf(txns, "2024-01-31");
    expect(balances.get("SAVINGS")).toBeCloseTo(800, 6);
    expect(balances.get("USD ACCT")).toBeCloseTo(3500, 6);
  });
});

describe("Set-balance auto-absorb (#232 — a raise soaks up in-transit proceeds first)", () => {
  const assertBal = (units: number, tradeDate: string, p: Partial<LedgerTxn> = {}): LedgerTxn => ({
    ticker: "SAVINGS",
    kind: "cash_balance",
    units,
    fxToThb: 1,
    amount: 0,
    tradeDate,
    ...p,
  });

  it("a raise fully covered by proceeds produces NO flow and consumes the lot", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
        tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-03-01", id: 1 }),
        assertBal(1500, "2024-03-05", { id: 2 }),
      ],
      TODAY,
      undefined,
      new Map([[1, 1000]]), // sell cost basis 1000 → 500 realized gain rides in the lot
    );
    // Contribution: only the original buy. The landing is internal — and crucially
    // the 500 gain SURVIVES (value 1500 held cash vs 1000 contributed), where the
    // old raise-is-contribution default erased it (+1500 assert − 1000 expiry).
    expect(r.externalFlows).toEqual([{ date: "2024-01-01", amount: 1000 }]);
    expect(r.absorbedByTxnId.get(2)).toBeCloseTo(1500, 6);
    expect(r.terminalCash).toBe(0);
    // In-transit cash lives exactly [sell, assert) — then it's the held position's.
    expect(cashOn(r, "2024-03-03")).toBeCloseTo(1500, 6);
    expect(cashOn(r, "2024-03-05")).toBe(0);
  });

  it("a mixed raise (salary + proceeds) flows only the remainder", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-03-01" }),
        assertBal(80000, "2024-02-01", { id: 5 }), // prior balance 80k
        assertBal(130000, "2024-03-05", { id: 6 }), // +50k = 20k proceeds + 30k salary
      ],
      TODAY,
    );
    expect(r.absorbedByTxnId.get(6)).toBeCloseTo(20000, 6);
    expect(r.cashEventFlows).toEqual([
      { date: "2024-02-01", amount: 80000 }, // first assert = its full amount
      { date: "2024-03-05", amount: 30000 }, // the salary remainder only
    ]);
  });

  it("absorption respects the window — stale proceeds cannot be absorbed", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-01-01" }),
        assertBal(20000, "2024-03-05", { id: 3 }), // > 30 days later
      ],
      TODAY,
    );
    // Lot expired (capital withdrawn at the sell date); the raise is all new money.
    expect(r.absorbedByTxnId.size).toBe(0);
    expect(r.cashEventFlows).toEqual([{ date: "2024-03-05", amount: 20000 }]);
    expect(r.externalFlows).toEqual([
      { date: "2024-01-01", amount: -20000 },
      { date: "2024-03-05", amount: 20000 },
    ]);
  });

  it("an absorbing assert beats a same-day buy to the lots; the buy reads bank-funded", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-03-01" }),
        tx({ ticker: B, kind: "buy", units: 10, amount: -20000, tradeDate: "2024-03-05", id: 9 }),
        assertBal(20000, "2024-03-05", { id: 8 }),
      ],
      TODAY,
    );
    // The balance holds the proceeds (physically: they landed in the bank), so the
    // same-day buy was paid some other way — it shows the full shortfall and the
    // funded-from-cash nudge offers the matching withdraw.
    expect(r.absorbedByTxnId.get(8)).toBeCloseTo(20000, 6);
    expect(r.buyShortfallById.get(9)).toBeCloseTo(20000, 6);
  });

  it("EVENTUAL CORRECTNESS: parked-and-asserted vs walked-away converge on the same lifetime contribution", () => {
    const trades = [
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "sell", units: 100, amount: 1000, tradeDate: "2024-03-01" }),
    ];
    const sum = (flows: readonly { amount: number }[]) => flows.reduce((s, f) => s + f.amount, 0);
    const walked = foldSettlementCash(trades, TODAY);
    const asserted = foldSettlementCash([...trades, assertBal(1000, "2024-03-05")], TODAY);
    // Walk away: +1000 buy − 1000 expiry = 0. Assert: +1000 buy, raise absorbed = …
    // 1000 still inside as held cash — the CONTRIBUTION differs by exactly the money
    // still in the book, i.e. both agree the user put in 1000 and took nothing out.
    expect(sum(walked.externalFlows)).toBeCloseTo(0, 6);
    expect(sum(asserted.externalFlows)).toBeCloseTo(1000, 6);
    expect(asserted.cashEventFlows).toEqual([]); // the raise itself moved no money
  });

  it("a reserved account's assert neither flows nor absorbs (lots expire normally)", () => {
    const txns = [
      tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-03-01" }),
      assertBal(20000, "2024-03-05", { ticker: "EMERGENCY", id: 4 }),
    ];
    const excluded = foldSettlementCash(txns, TODAY, undefined, undefined, new Set(["EMERGENCY"]));
    // Parking proceeds into a set-aside account IS a withdrawal from the return's
    // perspective — the untouched lot expires and records exactly that.
    expect(excluded.absorbedByTxnId.size).toBe(0);
    expect(excluded.cashEventFlows).toEqual([]);
    expect(excluded.externalFlows).toEqual([{ date: "2024-03-01", amount: -20000 }]);
    // Without the exclusion the same assert absorbs.
    expect(foldSettlementCash(txns, TODAY).absorbedByTxnId.get(4)).toBeCloseTo(20000, 6);
  });

  it("legacy reconcile rows still restate with no flow and clear the lots", () => {
    const r = foldSettlementCash(
      [
        tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-03-01" }),
        assertBal(50000, "2024-03-05", { reconcile: true, id: 7 }),
      ],
      TODAY,
    );
    expect(r.cashEventFlows).toEqual([]);
    expect(r.absorbedByTxnId.size).toBe(0);
    expect(r.terminalCash).toBe(0); // lots cleared, not expired
    expect(r.externalFlows).toEqual([]);
  });
});

describe("previewBalanceChange (#232 — the entry form's consequence line)", () => {
  const sellThenAssert: LedgerTxn[] = [
    tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
    tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-03-01" }),
  ];

  it("a covered raise previews as fully absorbed", () => {
    const p = previewBalanceChange(sellThenAssert, {
      ticker: "SAVINGS",
      tradeDate: "2024-03-05",
      assertedThb: 1500,
    });
    expect(p).toEqual({ prior: 0, first: true, delta: 1500, absorbed: 1500 });
  });

  it("a raise beyond the proceeds previews the split", () => {
    const p = previewBalanceChange(sellThenAssert, {
      ticker: "SAVINGS",
      tradeDate: "2024-03-05",
      assertedThb: 2000,
    });
    expect(p.delta).toBe(2000);
    expect(p.absorbed).toBeCloseTo(1500, 6);
  });

  it("measures the raise against the account's PRIOR balance, case-insensitively", () => {
    const p = previewBalanceChange(
      [
        ...sellThenAssert,
        {
          ticker: "Savings",
          kind: "cash_balance",
          units: 400,
          fxToThb: 1,
          amount: 0,
          tradeDate: "2024-02-01",
        },
      ],
      { ticker: "SAVINGS", tradeDate: "2024-03-05", assertedThb: 1900 },
    );
    expect(p.prior).toBe(400);
    expect(p.first).toBe(false);
    expect(p.delta).toBe(1500);
    expect(p.absorbed).toBeCloseTo(1500, 6);
  });

  it("a same-day buy does not pre-consume the lots (the fold ranks it after the assert)", () => {
    const p = previewBalanceChange(
      [
        ...sellThenAssert,
        tx({ ticker: B, kind: "buy", units: 10, amount: -1500, tradeDate: "2024-03-05", id: 9 }),
      ],
      { ticker: "SAVINGS", tradeDate: "2024-03-05", assertedThb: 1500 },
    );
    expect(p.absorbed).toBeCloseTo(1500, 6);
  });

  it("expired proceeds absorb nothing", () => {
    const p = previewBalanceChange(sellThenAssert, {
      ticker: "SAVINGS",
      tradeDate: "2024-05-15", // > 30 days after the sell
      assertedThb: 1500,
    });
    expect(p.absorbed).toBe(0);
  });

  it("a drop absorbs nothing", () => {
    const p = previewBalanceChange(
      [
        ...sellThenAssert,
        {
          ticker: "SAVINGS",
          kind: "cash_balance",
          units: 5000,
          fxToThb: 1,
          amount: 0,
          tradeDate: "2024-02-01",
        },
      ],
      { ticker: "SAVINGS", tradeDate: "2024-03-05", assertedThb: 4000 },
    );
    expect(p.delta).toBe(-1000);
    expect(p.absorbed).toBe(0);
  });
});

describe("cashContributionFlows partitions by bucket (#232 — absorption never crosses portfolios)", () => {
  const crossBucket: LedgerTxn[] = [
    // A sell in portfolio X…
    tx({ kind: "sell", units: 100, amount: 20000, tradeDate: "2024-03-01", bucketId: "X" }),
    // …and a first Set balance in portfolio Y, 4 days later, matching the proceeds.
    {
      ticker: "SAVINGS",
      kind: "cash_balance",
      units: 20000,
      fxToThb: 1,
      amount: 0,
      tradeDate: "2024-03-05",
      bucketId: "Y",
      id: 1,
    },
  ];

  it("a raise in one bucket never absorbs another bucket's sale proceeds", () => {
    // The multi-bucket analytics path must agree with the per-bucket chart path:
    // bucket Y's raise is all new money; bucket X's lot expires on its own.
    expect(cashContributionFlows(crossBucket)).toEqual([{ date: "2024-03-05", amount: 20000 }]);
  });

  it("the same shape WITHIN one bucket absorbs (the control case)", () => {
    const sameBucket = crossBucket.map((t) => ({ ...t, bucketId: "X" }));
    expect(cashContributionFlows(sameBucket)).toEqual([]);
  });

  it("same-named accounts in different buckets keep separate running balances", () => {
    const flows = cashContributionFlows([
      {
        ticker: "SAVINGS",
        kind: "cash_balance",
        units: 1000,
        fxToThb: 1,
        amount: 0,
        tradeDate: "2024-01-01",
        bucketId: "X",
      },
      // Same account NAME in bucket Y — its first assert, not a +2000 raise on X's.
      {
        ticker: "SAVINGS",
        kind: "cash_balance",
        units: 3000,
        fxToThb: 1,
        amount: 0,
        tradeDate: "2024-01-02",
        bucketId: "Y",
      },
    ]);
    expect(flows).toEqual([
      { date: "2024-01-01", amount: 1000 },
      { date: "2024-01-02", amount: 3000 },
    ]);
  });
});
