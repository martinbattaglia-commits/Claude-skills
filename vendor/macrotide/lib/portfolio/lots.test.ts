import { describe, expect, it } from "vitest";
import { type LedgerTxn, reduceLots } from "./lots";

// Synthetic data only (EXAMPLE-FUND-*), never real fund codes.
const A = "EXAMPLE-FUND-A";

function tx(p: Partial<LedgerTxn> & Pick<LedgerTxn, "kind" | "amount">): LedgerTxn {
  return { ticker: A, tradeDate: "2024-01-01", ...p };
}

describe("reduceLots — average cost", () => {
  it("removes basis PROPORTIONALLY on a partial sell (avgCost × unitsSold)", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }), // avg 10
      tx({ kind: "buy", units: 100, amount: -2000, tradeDate: "2024-02-01" }), // avg 15
      tx({ kind: "sell", units: 100, amount: 1800, tradeDate: "2024-03-01" }),
    ]);
    expect(r.realized).toHaveLength(1);
    // costRemoved = 15 × 100 = 1500, NOT proceeds (1800) and NOT units×currentNAV.
    expect(r.realized[0].costRemoved).toBeCloseTo(1500, 6);
    expect(r.realized[0].realizedGain).toBeCloseTo(300, 6);
    expect(r.realizedTotal).toBeCloseTo(300, 6);
    const pos = r.positions[0];
    expect(pos.units).toBeCloseTo(100, 6);
    expect(pos.costBasis).toBeCloseTo(1500, 6);
    expect(pos.avgCost).toBeCloseTo(15, 6);
  });

  it("resets the average after a full exit (no stale blend on re-buy)", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "sell", units: 100, amount: 1200, tradeDate: "2024-02-01" }),
      tx({ kind: "buy", units: 50, amount: -2000, tradeDate: "2024-03-01" }),
    ]);
    expect(r.realizedTotal).toBeCloseTo(200, 6);
    // Fresh basis 2000/50 = 40, not blended with the old 10.
    expect(r.positions[0].avgCost).toBeCloseTo(40, 6);
  });

  it("flags an oversell and never goes to negative basis", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "sell", units: 150, amount: 1500, tradeDate: "2024-02-01" }),
    ]);
    expect(r.warnings.some((w) => w.code === "oversell")).toBe(true);
    // Only the 100 held units are costed out: 1500 − 1000 = 500.
    expect(r.realized[0].realizedGain).toBeCloseTo(500, 6);
    expect(r.positions).toHaveLength(0); // fully exited
  });

  it("scales units (and halves per-unit cost) on a split, basis unchanged", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }), // avg 10
      tx({ kind: "split", units: 2, amount: 0, tradeDate: "2024-02-01" }), // 2-for-1
      tx({ kind: "sell", units: 100, amount: 600, tradeDate: "2024-03-01" }),
    ]);
    // After split: 200 units, basis 1000, avg 5. Sell 100 → cost 500, gain 100.
    expect(r.realized[0].costRemoved).toBeCloseTo(500, 6);
    expect(r.realized[0].realizedGain).toBeCloseTo(100, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(5, 6);
  });

  it("treats a reinvested dividend as a basis-adding buy (no income line)", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "reinvest", units: 10, amount: -100, tradeDate: "2024-02-01" }),
    ]);
    expect(r.income).toHaveLength(0);
    expect(r.positions[0].units).toBeCloseTo(110, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(1100, 6);
  });

  it("books a cash dividend as income, not a capital gain", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "dividend", amount: 50, tradeDate: "2024-02-01" }),
    ]);
    expect(r.realized).toHaveLength(0);
    expect(r.incomeTotal).toBeCloseTo(50, 6);
    expect(r.positions[0].units).toBeCloseTo(100, 6); // unchanged
  });

  it("books a standalone fee as an expense, not a basis change", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "fee", amount: -20, tradeDate: "2024-02-01" }),
    ]);
    expect(r.realized).toHaveLength(0);
    expect(r.expenseTotal).toBeCloseTo(20, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(1000, 6); // unchanged
  });

  it("is order-independent — shuffled input yields identical realized output", () => {
    const txns: LedgerTxn[] = [
      tx({ id: 1, kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ id: 3, kind: "sell", units: 50, amount: 700, tradeDate: "2024-03-01" }),
      tx({ id: 2, kind: "buy", units: 100, amount: -2000, tradeDate: "2024-02-01" }), // backfilled
    ];
    const inOrder = reduceLots(txns);
    const shuffled = reduceLots([txns[2], txns[0], txns[1]]);
    // At the (date-sorted) sell, avg = (1000+2000)/200 = 15 → cost 750, gain −50.
    expect(inOrder.realized[0].realizedGain).toBeCloseTo(-50, 6);
    expect(shuffled.realized[0].realizedGain).toBeCloseTo(-50, 6);
    expect(shuffled.realizedTotal).toBeCloseTo(inOrder.realizedTotal, 9);
  });
});

describe("reduceLots — FIFO vs average divergence", () => {
  const txns: LedgerTxn[] = [
    tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }), // lot @ 10
    tx({ kind: "buy", units: 100, amount: -2000, tradeDate: "2024-02-01" }), // lot @ 20
    tx({ kind: "sell", units: 100, amount: 1800, tradeDate: "2024-03-01" }),
  ];

  it("FIFO consumes the oldest lot first", () => {
    const r = reduceLots(txns, "fifo");
    // Oldest lot cost 10 × 100 = 1000 → gain 800; remaining lot @ 20.
    expect(r.realized[0].costRemoved).toBeCloseTo(1000, 6);
    expect(r.realized[0].realizedGain).toBeCloseTo(800, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(20, 6);
  });

  it("average differs from FIFO on the same ledger", () => {
    const avg = reduceLots(txns, "average");
    const fifo = reduceLots(txns, "fifo");
    expect(avg.realizedTotal).toBeCloseTo(300, 6);
    expect(fifo.realizedTotal).toBeCloseTo(800, 6);
    expect(avg.realizedTotal).not.toBeCloseTo(fifo.realizedTotal, 1);
  });

  it("FIFO rescales each lot on a split", () => {
    const r = reduceLots(
      [
        tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
        tx({ kind: "split", units: 2, amount: 0, tradeDate: "2024-02-01" }),
        tx({ kind: "sell", units: 100, amount: 600, tradeDate: "2024-03-01" }),
      ],
      "fifo",
    );
    expect(r.realized[0].costRemoved).toBeCloseTo(500, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(5, 6);
  });
});

describe("reduceLots — anchors (opening / snapshot)", () => {
  it("a costed opening sets the position and counts toward net-invested", () => {
    const r = reduceLots([
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: -1000, tradeDate: "2024-01-01" }),
    ]);
    expect(r.positions[0].units).toBeCloseTo(100, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(10, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(1000, 6);
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(1000, 6);
  });

  it("an opening discards drift before it (anchor semantics)", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 999, amount: -9999, tradeDate: "2024-01-01" }),
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: -1000, tradeDate: "2024-02-01" }),
    ]);
    // The pre-anchor buy is discarded; the opening is the truth.
    expect(r.positions[0].units).toBeCloseTo(100, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(10, 6);
  });

  it("an uncosted opening is held but cost-unknown (graceful degradation)", () => {
    const r = reduceLots([tx({ kind: "opening", units: 100, amount: 0, tradeDate: "2024-01-01" })]);
    expect(r.positions[0].units).toBeCloseTo(100, 6);
    expect(r.positions[0].avgCost).toBeNull();
    expect(r.positions[0].costBasis).toBeNull();
    expect(r.warnings.some((w) => w.code === "cost_unknown")).toBe(true);
    // Unknown cost contributes 0 to the aggregate basis, and no contribution.
    expect(r.basisTimeline.at(-1)?.costBasis).toBeCloseTo(0, 6);
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(0, 6);
  });

  it("a value-only snapshot carries the prior per-unit cost forward", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }), // avg 10
      tx({ kind: "snapshot", units: 120, amount: 0, tradeDate: "2024-06-01" }), // value-only restatement
    ]);
    // Units snap to 120; per-unit cost (10) carried → basis 1200, NOT destroyed.
    expect(r.positions[0].units).toBeCloseTo(120, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(10, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(1200, 6);
  });

  it("a snapshot with an avg cost resets the basis", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }), // avg 10
      tx({ kind: "snapshot", units: 100, pricePerUnit: 25, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    expect(r.positions[0].avgCost).toBeCloseTo(25, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(2500, 6);
  });

  it("a snapshot is never a realized event even when it lowers units", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "snapshot", units: 60, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    expect(r.realized).toHaveLength(0); // restatement, not a sale
    expect(r.positions[0].units).toBeCloseTo(60, 6);
  });

  it("a value-only snapshot on an unknown-cost position stays unknown", () => {
    const r = reduceLots([
      tx({ kind: "opening", units: 100, amount: 0, tradeDate: "2024-01-01" }), // uncosted
      tx({ kind: "snapshot", units: 80, amount: 0, tradeDate: "2024-06-01" }), // no cost to carry
    ]);
    expect(r.positions[0].units).toBeCloseTo(80, 6);
    expect(r.positions[0].avgCost).toBeNull();
  });

  // Opening vs restatement is decided by prior STATE, not the stored kind — so the
  // ledger self-heals if the original opening is deleted, and a ledger of pure
  // balances still gets a real opening.
  it("a balance on a fresh position is the opening even if stored as a snapshot", () => {
    // e.g. the user deleted the first balance, leaving only this later one.
    const r = reduceLots([
      tx({ kind: "snapshot", units: 130, pricePerUnit: 10, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    expect(r.positions[0].units).toBeCloseTo(130, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(10, 6);
    expect(r.positions[0].costBasis).toBeCloseTo(1300, 6);
    // Counts as the opening contribution (not skipped as a restatement).
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(1300, 6);
  });

  it("a re-stated balance counts the INCREASE in cost basis as money added", () => {
    // Finnomena-style: units 100→130 and avg cost 10→10.5 ⇒ basis 1000→1365.
    const r = reduceLots([
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: 0, tradeDate: "2024-01-01" }),
      tx({ kind: "snapshot", units: 130, pricePerUnit: 10.5, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    expect(r.positions[0].units).toBeCloseTo(130, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(10.5, 6);
    // +365 of basis ⇒ +365 invested (the rest of any value change is market).
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(1365, 6);
  });

  it("a re-stated balance at the SAME cost basis adds nothing (pure market move)", () => {
    const r = reduceLots([
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: 0, tradeDate: "2024-01-01" }),
      tx({ kind: "snapshot", units: 100, pricePerUnit: 10, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(1000, 6); // unchanged
  });

  it("a value-only re-state to MORE units counts the added units at the carried cost", () => {
    const r = reduceLots([
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: 0, tradeDate: "2024-01-01" }),
      tx({ kind: "snapshot", units: 130, amount: 0, tradeDate: "2024-06-01" }), // value-only, cost carried = 10
    ]);
    expect(r.positions[0].units).toBeCloseTo(130, 6); // latest balance wins
    expect(r.positions[0].avgCost).toBeCloseTo(10, 6); // carried forward
    // 30 extra units × carried cost 10 = +300 added.
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(1300, 6);
  });

  it("flow #2 — opening balance then track forward (realized gain off the opening basis)", () => {
    const r = reduceLots([
      tx({ kind: "opening", units: 100, pricePerUnit: 10, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "buy", units: 100, amount: -2000, tradeDate: "2024-02-01" }), // avg now 15
      tx({ kind: "sell", units: 100, amount: 1800, tradeDate: "2024-03-01" }),
    ]);
    // Blended avg 15 → cost out 1500, gain 300; 100 units left at avg 15.
    expect(r.realized[0].realizedGain).toBeCloseTo(300, 6);
    expect(r.positions[0].units).toBeCloseTo(100, 6);
    expect(r.positions[0].avgCost).toBeCloseTo(15, 6);
  });
});

describe("reduceLots — multi-ticker", () => {
  it("keeps positions independent and aggregates the basis timeline", () => {
    const B = "EXAMPLE-FUND-B";
    const r = reduceLots([
      { ticker: A, kind: "buy", units: 10, amount: -100, tradeDate: "2024-01-01" },
      { ticker: B, kind: "buy", units: 5, amount: -250, tradeDate: "2024-01-02" },
    ]);
    expect(r.positions).toHaveLength(2);
    // Last timeline point = sum of both bases.
    expect(r.basisTimeline.at(-1)?.costBasis).toBeCloseTo(350, 6);
    expect(r.basisTimeline.at(-1)?.netInvested).toBeCloseTo(350, 6);
  });
});

describe("reduceLots — positionTimeline (point-in-time replay)", () => {
  it("checkpoints units and basis after each event, per ticker", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "buy", units: 100, amount: -2000, tradeDate: "2024-02-01" }),
      tx({ kind: "sell", units: 50, amount: 900, tradeDate: "2024-03-01" }),
    ]);
    const cps = r.positionTimeline.get(A);
    expect(cps).toHaveLength(3);
    expect(cps?.[0]).toEqual({ date: "2024-01-01", units: 100, costBasis: 1000 });
    expect(cps?.[1]).toEqual({ date: "2024-02-01", units: 200, costBasis: 3000 });
    // Sell removes 50 × avg 15 = 750 basis.
    expect(cps?.[2].units).toBeCloseTo(150, 6);
    expect(cps?.[2].costBasis).toBeCloseTo(2250, 6);
  });

  it("anchors RESET the running position at their date", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "snapshot", units: 80, amount: 0, tradeDate: "2024-06-01" }),
    ]);
    const cps = r.positionTimeline.get(A);
    expect(cps?.[1].units).toBe(80);
    // Value-only snapshot carries the prior per-unit cost: 80 × 10.
    expect(cps?.[1].costBasis).toBeCloseTo(800, 6);
  });

  it("records the zero-unit checkpoint on a full exit", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "sell", units: 100, amount: 1500, tradeDate: "2024-02-01" }),
    ]);
    const cps = r.positionTimeline.get(A);
    expect(cps?.[1]).toEqual({ date: "2024-02-01", units: 0, costBasis: 0 });
  });

  it("reports null basis while cost is unknown (uncosted opening)", () => {
    const r = reduceLots([tx({ kind: "opening", units: 100, amount: 0, tradeDate: "2024-01-01" })]);
    const cps = r.positionTimeline.get(A);
    expect(cps?.[0].units).toBe(100);
    expect(cps?.[0].costBasis).toBeNull();
  });

  it("checkpoints agree with the terminal fold (last checkpoint == positions)", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 100, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ kind: "split", units: 2, amount: 0, tradeDate: "2024-02-01" }),
      tx({ kind: "sell", units: 60, amount: 500, tradeDate: "2024-03-01" }),
      tx({ kind: "dividend", amount: 12, tradeDate: "2024-04-01" }),
    ]);
    const last = r.positionTimeline.get(A)?.at(-1);
    const pos = r.positions[0];
    expect(last?.units).toBeCloseTo(pos.units, 9);
    expect(last?.costBasis).toBeCloseTo(pos.costBasis ?? Number.NaN, 9);
    // The no-op dividend still checkpoints (same state, later date).
    expect(last?.date).toBe("2024-04-01");
  });
});

describe("reduceLots — cash holdings (issue #149)", () => {
  const CASH = "SAVINGS";
  // A cash event's `units` is the NATIVE amount; the THB `amount` carries the
  // contribution (signed elsewhere). reduceLots reads units for the position.
  it("a deposit folds to a cash position at face (units = native, avg cost 1)", () => {
    const r = reduceLots([tx({ ticker: CASH, kind: "deposit", units: 500, amount: -500 })]);
    const pos = r.positions.find((p) => p.ticker === CASH);
    expect(pos?.units).toBeCloseTo(500, 9);
    expect(pos?.avgCost).toBeCloseTo(1, 9);
    expect(pos?.costBasis).toBeCloseTo(500, 9);
    // Cash never produces realized gains, income, or expenses.
    expect(r.realized).toEqual([]);
    expect(r.income).toEqual([]);
    expect(r.expenses).toEqual([]);
  });

  it("a withdraw reduces the cash position at face", () => {
    const r = reduceLots([
      tx({ ticker: CASH, kind: "deposit", units: 500, amount: -500, tradeDate: "2024-01-01" }),
      tx({ ticker: CASH, kind: "withdraw", units: 200, amount: 200, tradeDate: "2024-02-01" }),
    ]);
    const pos = r.positions.find((p) => p.ticker === CASH);
    expect(pos?.units).toBeCloseTo(300, 9);
    expect(pos?.avgCost).toBeCloseTo(1, 9);
  });

  it("a cash_balance restates the position to the asserted native balance", () => {
    const r = reduceLots([
      tx({ ticker: CASH, kind: "deposit", units: 500, amount: -500, tradeDate: "2024-01-01" }),
      // The asserted balance arrives as units (resolved upstream from value ÷ 1).
      tx({ ticker: CASH, kind: "cash_balance", units: 1200, amount: 0, tradeDate: "2024-03-01" }),
    ]);
    const pos = r.positions.find((p) => p.ticker === CASH);
    expect(pos?.units).toBeCloseTo(1200, 9);
    expect(pos?.avgCost).toBeCloseTo(1, 9);
  });

  it("does not let cash contribute to a fund position in the same ledger", () => {
    const r = reduceLots([
      tx({ kind: "buy", units: 10, amount: -1000, tradeDate: "2024-01-01" }),
      tx({ ticker: CASH, kind: "deposit", units: 500, amount: -500, tradeDate: "2024-01-02" }),
    ]);
    const fund = r.positions.find((p) => p.ticker === A);
    const cash = r.positions.find((p) => p.ticker === CASH);
    expect(fund?.units).toBeCloseTo(10, 9);
    expect(cash?.units).toBeCloseTo(500, 9);
  });
});
