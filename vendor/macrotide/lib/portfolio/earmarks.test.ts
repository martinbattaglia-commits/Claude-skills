import { describe, expect, it } from "vitest";
import { type CashHoldingInput, resolveEarmarks } from "./earmarks";

// Synthetic data only — generic account names, never real fund codes.
const bank = (over: Partial<CashHoldingInput> = {}): CashHoldingInput => ({
  bucketId: "b1",
  ticker: "SAVINGS",
  balance: 500_000,
  currency: "THB",
  ...over,
});

describe("resolveEarmarks", () => {
  it("reserves a fixed amount; the remainder is investable", () => {
    const r = resolveEarmarks(
      [bank()],
      [
        {
          scope: "account",
          bucketId: "b1",
          ticker: "SAVINGS",
          amount: 200_000,
          purpose: "Emergency",
        },
      ],
    );
    expect(r).toHaveLength(1);
    expect(r[0].effective).toBe(200_000);
    expect(r[0].shortfall).toBe(0);
    expect(r[0].purpose).toBe("Emergency");
    // investable = balance − effective = 300k (the caller derives it).
    expect(r[0].balance - r[0].effective).toBe(300_000);
  });

  it('"All" (null amount) reserves the whole balance and auto-tracks', () => {
    const r = resolveEarmarks(
      [bank({ balance: 300_000 })],
      [{ scope: "account", bucketId: "b1", ticker: "SAVINGS", amount: null }],
    );
    expect(r[0].requested).toBe(300_000);
    expect(r[0].effective).toBe(300_000);
  });

  it("caps a fixed earmark at the balance and reports the shortfall (no silent cap)", () => {
    const r = resolveEarmarks(
      [bank({ balance: 100_000 })],
      [{ scope: "account", bucketId: "b1", ticker: "SAVINGS", amount: 200_000 }],
    );
    expect(r[0].requested).toBe(200_000);
    expect(r[0].effective).toBe(100_000); // capped at balance
    expect(r[0].shortfall).toBe(100_000); // surfaced, not swallowed
  });

  it("most-specific scope wins: an account earmark overrides a portfolio default", () => {
    const r = resolveEarmarks(
      [bank()],
      [
        { scope: "portfolio", bucketId: "b1", ticker: null, amount: null }, // whole bucket
        { scope: "account", bucketId: "b1", ticker: "SAVINGS", amount: 50_000 }, // override
      ],
    );
    expect(r[0].effective).toBe(50_000);
  });

  it("falls back to the portfolio default when no account earmark exists", () => {
    const r = resolveEarmarks(
      [bank({ balance: 120_000 })],
      [{ scope: "portfolio", bucketId: "b1", ticker: null, amount: null }],
    );
    expect(r[0].effective).toBe(120_000);
  });

  it("omits holdings with no earmark and ignores other buckets / goal scope", () => {
    const r = resolveEarmarks(
      [bank(), bank({ ticker: "BROKERAGE-CASH", balance: 100_000 })],
      [
        { scope: "account", bucketId: "b2", ticker: "SAVINGS", amount: 10 }, // other bucket
        { scope: "goal", bucketId: "b1", ticker: "SAVINGS", amount: 10 }, // #36, ignored here
      ],
    );
    expect(r).toEqual([]);
  });

  it("matches tickers case-insensitively", () => {
    const r = resolveEarmarks(
      [bank({ ticker: "savings" })],
      [{ scope: "account", bucketId: "b1", ticker: "SAVINGS", amount: 100_000 }],
    );
    expect(r[0].effective).toBe(100_000);
  });

  it("ignores an `investable`-role row (it only carries a label, reserves nothing)", () => {
    const r = resolveEarmarks(
      [bank()],
      [
        {
          scope: "account",
          bucketId: "b1",
          ticker: "SAVINGS",
          role: "investable",
          amount: null,
          purpose: "Retirement",
        },
      ],
    );
    expect(r).toEqual([]); // investable cash is never reserved
  });

  it("treats a row with no role as reserved (legacy back-compat)", () => {
    const r = resolveEarmarks(
      [bank()],
      [{ scope: "account", bucketId: "b1", ticker: "SAVINGS", amount: 200_000 }],
    );
    expect(r[0].effective).toBe(200_000);
  });
});
