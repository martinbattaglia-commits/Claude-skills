import { describe, expect, it } from "vitest";
import { qtyDefaultMode } from "@/components/ui/QtyInput";
import type { RowInvalidReason, RowValidityInput } from "@/lib/portfolio/txn-import";
import { rowValidity } from "@/lib/portfolio/txn-import";

// #135 — every balance/trade input combination through the shared entry gate.
// Both inline editors (the Add modal `RecordSheet.valid()` and the History editor
// `TxnEditor.save()`) route accept/reject through ONE predicate, `rowValidity`. A
// single assertion per row therefore proves the editors agree (assertion #4,
// validation parity). `qtyDefaultMode` proves the round-trip mode (assertion #1).
//
// Persistence (only the typed side stored) and fold correctness (assertions #2/#3)
// are locked at the route layer in transactions-route.test.ts / -patch-route.test.ts.

const FEED = "thai_mutual_fund" as const;
const CUSTOM = "manual" as const;
const DATE = "2026-03-01";

type Case = {
  name: string;
  input: RowValidityInput;
  expect: true | RowInvalidReason;
};

// ── Balances (opening / snapshot) ───────────────────────────────────────────
const BALANCE_CASES: Case[] = [
  {
    name: "units only",
    input: { kind: "opening", ticker: "F", tradeDate: DATE, units: 100, quoteSource: FEED },
    expect: true,
  },
  {
    name: "units + avg cost",
    input: {
      kind: "opening",
      ticker: "F",
      tradeDate: DATE,
      units: 100,
      pricePerUnit: 11.25,
      quoteSource: FEED,
    },
    expect: true,
  },
  {
    name: "฿ value only (feed-priced fund)",
    input: { kind: "opening", ticker: "F", tradeDate: DATE, value: 200000, quoteSource: FEED },
    expect: true,
  },
  {
    name: "฿ value only (custom, no price → rejected)",
    input: { kind: "opening", ticker: "F", tradeDate: DATE, value: 50000, quoteSource: CUSTOM },
    expect: "custom-needs-price",
  },
  {
    name: "฿ value only (custom, with current price)",
    input: {
      kind: "opening",
      ticker: "F",
      tradeDate: DATE,
      value: 50000,
      currentPrice: 25,
      quoteSource: CUSTOM,
    },
    expect: true,
  },
  {
    name: "฿ value + avg cost (cost reaches XIRR)",
    input: {
      kind: "opening",
      ticker: "F",
      tradeDate: DATE,
      value: 200000,
      amount: 180000,
      quoteSource: FEED,
    },
    expect: true,
  },
  {
    name: "restatement (snapshot) by value",
    input: { kind: "snapshot", ticker: "F", tradeDate: DATE, value: 200000, quoteSource: FEED },
    expect: true,
  },
  {
    name: "neither units nor value → rejected",
    input: { kind: "opening", ticker: "F", tradeDate: DATE, quoteSource: FEED },
    expect: "balance-needs-figure",
  },
  {
    name: "missing date → rejected",
    input: { kind: "opening", ticker: "F", tradeDate: "", value: 200000, quoteSource: FEED },
    expect: "missing-date",
  },
  {
    name: "missing ticker → rejected",
    input: { kind: "opening", ticker: "", tradeDate: DATE, value: 200000, quoteSource: FEED },
    expect: "missing-ticker",
  },
];

// ── Trades (buy / sell / reinvest / dividend / fee / split) ──────────────────
const TRADE_CASES: Case[] = [
  {
    name: "units only, feed-priced (amount derives from NAV)",
    input: { kind: "buy", ticker: "F", tradeDate: DATE, units: 50, quoteSource: FEED },
    expect: true,
  },
  // A custom units-only trade has units but no NAV/price to value them — it needs a
  // price (the same guidance as a custom amount-only trade). Blocked either way.
  {
    name: "units only, custom (no price → rejected)",
    input: { kind: "buy", ticker: "F", tradeDate: DATE, units: 50, quoteSource: CUSTOM },
    expect: "needs-price",
  },
  {
    name: "฿ amount only, feed-priced (units derive from NAV)",
    input: { kind: "buy", ticker: "F", tradeDate: DATE, amount: 1000, quoteSource: FEED },
    expect: true,
  },
  {
    name: "฿ amount only, custom (no price → rejected)",
    input: { kind: "buy", ticker: "F", tradeDate: DATE, amount: 1000, quoteSource: CUSTOM },
    expect: "needs-price",
  },
  {
    name: "฿ amount + price (units = amount ÷ price)",
    input: {
      kind: "buy",
      ticker: "F",
      tradeDate: DATE,
      amount: 1000,
      pricePerUnit: 25,
      quoteSource: CUSTOM,
    },
    expect: true,
  },
  {
    name: "units + price",
    input: {
      kind: "buy",
      ticker: "F",
      tradeDate: DATE,
      units: 10,
      pricePerUnit: 5,
      quoteSource: CUSTOM,
    },
    expect: true,
  },
  {
    name: "sell, ฿ amount only feed-priced",
    input: { kind: "sell", ticker: "F", tradeDate: DATE, amount: 1000, quoteSource: FEED },
    expect: true,
  },
  {
    name: "reinvest, units only feed-priced",
    input: { kind: "reinvest", ticker: "F", tradeDate: DATE, units: 5, quoteSource: FEED },
    expect: true,
  },
  {
    name: "dividend (฿ amount only, no units)",
    input: { kind: "dividend", ticker: "F", tradeDate: DATE, amount: 500, quoteSource: CUSTOM },
    expect: true,
  },
  {
    name: "fee (฿ amount only, no units)",
    input: { kind: "fee", ticker: "F", tradeDate: DATE, amount: 50, quoteSource: CUSTOM },
    expect: true,
  },
  {
    name: "split (ratio only, no cash)",
    input: { kind: "split", ticker: "F", tradeDate: DATE, units: 2, quoteSource: FEED },
    expect: true,
  },
  {
    name: "split without a ratio → rejected",
    input: { kind: "split", ticker: "F", tradeDate: DATE, quoteSource: FEED },
    expect: "missing-ratio",
  },
  {
    name: "trade missing amount (custom, no figures) → rejected",
    input: { kind: "buy", ticker: "F", tradeDate: DATE, quoteSource: CUSTOM },
    expect: "missing-amount",
  },
  {
    name: "trade missing date → rejected",
    input: { kind: "buy", ticker: "F", tradeDate: "", amount: 1000, quoteSource: FEED },
    expect: "missing-date",
  },
  {
    name: "trade missing ticker → rejected",
    input: { kind: "buy", ticker: "", tradeDate: DATE, amount: 1000, quoteSource: FEED },
    expect: "missing-ticker",
  },
];

describe("rowValidity — shared entry gate (Add modal ⇄ History parity, #135)", () => {
  for (const c of [...BALANCE_CASES, ...TRADE_CASES]) {
    it(c.name, () => {
      const result = rowValidity(c.input);
      if (c.expect === true) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(c.expect);
      }
    });
  }
});

describe("qtyDefaultMode — a saved row reopens in the mode it was entered (#135)", () => {
  // A row persists only the side the user typed: units-typed → `units` set; total-typed
  // (value-only Balance / amount-only trade) → `units` empty. Mode is recovered from
  // `units` presence alone, the SAME rule both editors wire into QtyInput.
  it("reopens a units-typed row in Units mode", () => {
    expect(qtyDefaultMode("50")).toBe("units");
    expect(qtyDefaultMode("  100  ")).toBe("units");
  });
  it("reopens a ฿-total-typed row (empty units) in Total mode", () => {
    expect(qtyDefaultMode("")).toBe("total");
    expect(qtyDefaultMode("   ")).toBe("total");
  });
  it("matches each valid matrix row's stored shape", () => {
    // Mirror what the editors store: units-bearing inputs keep `units`; value/amount-only
    // inputs leave it empty. The reopened mode must follow.
    const rows: { units: string; mode: "units" | "total" }[] = [
      { units: "100", mode: "units" }, // balance units only
      { units: "", mode: "total" }, // balance ฿ value only
      { units: "50", mode: "units" }, // trade units only
      { units: "", mode: "total" }, // trade ฿ amount only
    ];
    for (const r of rows) expect(qtyDefaultMode(r.units)).toBe(r.mode);
  });
});
