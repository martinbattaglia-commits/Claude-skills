import { describe, expect, it } from "vitest";
import {
  coerceKind,
  isAnchorKind,
  isCashKind,
  looksLikeTransactionHistory,
  normalizeDate,
  normalizeTxnDraft,
  parseTxnPaste,
  promoteAnchorKinds,
  rowValidity,
  signedAmount,
} from "./txn-import";

describe("signedAmount", () => {
  it("makes cash-out kinds negative and cash-in kinds positive", () => {
    expect(signedAmount("buy", 1000)).toBe(-1000);
    expect(signedAmount("fee", 20)).toBe(-20);
    expect(signedAmount("reinvest", 50)).toBe(-50);
    expect(signedAmount("sell", 1200)).toBe(1200);
    expect(signedAmount("dividend", 30)).toBe(30);
    expect(signedAmount("split", 0)).toBe(0);
  });
  it("normalizes an already-signed magnitude to the canonical sign", () => {
    expect(signedAmount("buy", -1000)).toBe(-1000); // |−1000| then negated
    expect(signedAmount("sell", -1200)).toBe(1200);
  });
  it("signs cash kinds: deposit out (−), withdraw in (+), cash_balance no-move (0)", () => {
    expect(signedAmount("deposit", 500)).toBe(-500);
    expect(signedAmount("withdraw", 200)).toBe(200);
    expect(signedAmount("cash_balance", 1000)).toBe(0);
  });
});

describe("cash kinds (issue #149)", () => {
  it("classifies the cash kinds", () => {
    expect(isCashKind("deposit")).toBe(true);
    expect(isCashKind("withdraw")).toBe(true);
    expect(isCashKind("cash_balance")).toBe(true);
    expect(isCashKind("buy")).toBe(false);
    // cash_balance is also an anchor (an absolute restatement); deltas are not.
    expect(isAnchorKind("cash_balance")).toBe(true);
    expect(isAnchorKind("deposit")).toBe(false);
  });

  it("rowValidity accepts a cash delta with a date + amount, rejects a figure-less one", () => {
    const base = { kind: "deposit" as const, ticker: "SAVINGS", quoteSource: "cash" as const };
    expect(rowValidity({ ...base, tradeDate: "2024-01-01", amount: 500 }).ok).toBe(true);
    const bad = rowValidity({ ...base, tradeDate: "2024-01-01", amount: 0 });
    expect(bad.ok).toBe(false);
  });

  it("rowValidity accepts a cash_balance with an asserted ฿ value", () => {
    const ok = rowValidity({
      kind: "cash_balance",
      ticker: "SAVINGS",
      tradeDate: "2024-01-01",
      value: 1200,
      quoteSource: "cash",
    });
    expect(ok.ok).toBe(true);
  });
});

describe("normalizeTxnDraft", () => {
  it("derives amount = units × price + fee for a buy", () => {
    const d = normalizeTxnDraft({
      kind: "buy",
      ticker: "EXAMPLE-FUND-A",
      units: 100,
      pricePerUnit: 10,
      fee: 5,
      tradeDate: "2024-01-01",
    });
    expect(d.amount).toBeCloseTo(1005, 6);
    expect(d.needsAmount).toBe(false);
  });
  it("nets the fee from proceeds for a sell", () => {
    const d = normalizeTxnDraft({
      kind: "sell",
      ticker: "EXAMPLE-FUND-A",
      units: 100,
      pricePerUnit: 12,
      fee: 5,
      tradeDate: "2024-01-01",
    });
    expect(d.amount).toBeCloseTo(1195, 6);
  });
  it("flags a row with no derivable amount", () => {
    const d = normalizeTxnDraft({ kind: "buy", ticker: "EXAMPLE-FUND-A", tradeDate: "2024-01-01" });
    expect(d.needsAmount).toBe(true);
  });
  it("flags a missing date", () => {
    const d = normalizeTxnDraft({ kind: "buy", ticker: "EXAMPLE-FUND-A", amount: 100 });
    expect(d.needsDate).toBe(true);
  });
});

describe("normalizeDate", () => {
  it("passes ISO through and zero-pads", () => {
    expect(normalizeDate("2024-3-5")).toBe("2024-03-05");
    expect(normalizeDate("2024/03/05")).toBe("2024-03-05");
  });
  it("reads day-first D/M/Y", () => {
    expect(normalizeDate("05/03/2024")).toBe("2024-03-05");
    expect(normalizeDate("5/3/24")).toBe("2024-03-05");
  });
  it("returns empty for junk", () => {
    expect(normalizeDate("not a date")).toBe("");
  });
  it("parses Thai month names with Buddhist-era years", () => {
    expect(normalizeDate("16 มีนาคม 2569")).toBe("2026-03-16");
    expect(normalizeDate("22 ธันวาคม 2568")).toBe("2025-12-22");
    expect(normalizeDate("5 กันยายน 2568")).toBe("2025-09-05");
  });
  it("folds a Buddhist-era year in an ISO-shaped date", () => {
    expect(normalizeDate("2569-03-16")).toBe("2026-03-16");
  });
});

describe("coerceKind (Thai labels)", () => {
  it("maps Thai transaction words, including switch legs", () => {
    expect(coerceKind("ซื้อ")).toBe("buy");
    expect(coerceKind("ขาย")).toBe("sell");
    expect(coerceKind("เงินปันผล")).toBe("dividend");
    expect(coerceKind("เข้า")).toBe("buy"); // switch in-leg
    expect(coerceKind("ออก")).toBe("sell"); // switch out-leg
  });
  it("defaults unknown text to buy", () => {
    expect(coerceKind("???")).toBe("buy");
    expect(coerceKind(undefined)).toBe("buy");
  });
});

describe("parseTxnPaste", () => {
  it("parses a CSV with a header row by column name", () => {
    const rows = parseTxnPaste(
      [
        "date,type,ticker,units,price,amount",
        "2024-01-05,Buy,EXAMPLE-FUND-A,100,10,1000",
        "2024-02-10,Sell,EXAMPLE-FUND-A,40,12,480",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "buy",
      ticker: "EXAMPLE-FUND-A",
      units: 100,
      amount: 1000,
      tradeDate: "2024-01-05",
    });
    expect(rows[1]).toMatchObject({ kind: "sell", amount: 480, tradeDate: "2024-02-10" });
  });
  it("parses positional whitespace rows without a header", () => {
    const rows = parseTxnPaste("2024-01-05 buy EXAMPLE-FUND-A 100 10 1000");
    expect(rows[0]).toMatchObject({
      kind: "buy",
      ticker: "EXAMPLE-FUND-A",
      tradeDate: "2024-01-05",
    });
  });
});

describe("looksLikeTransactionHistory", () => {
  it("flags a repeated ticker as transaction-shaped", () => {
    expect(
      looksLikeTransactionHistory([
        { ticker: "EXAMPLE-FUND-A" },
        { ticker: "EXAMPLE-FUND-A" },
        { ticker: "EXAMPLE-FUND-A" },
      ]),
    ).toBe(true);
  });
  it("flags rows carrying trade dates", () => {
    expect(
      looksLikeTransactionHistory([
        { ticker: "EXAMPLE-FUND-A", tradeDate: "2024-01-01" },
        { ticker: "EXAMPLE-FUND-B", tradeDate: "2024-02-01" },
        { ticker: "EXAMPLE-FUND-C", tradeDate: "2024-03-01" },
      ]),
    ).toBe(true);
  });
  it("treats a normal one-row-per-fund snapshot as holdings", () => {
    expect(
      looksLikeTransactionHistory([
        { ticker: "EXAMPLE-FUND-A" },
        { ticker: "EXAMPLE-FUND-B" },
        { ticker: "EXAMPLE-FUND-C" },
      ]),
    ).toBe(false);
  });
});

describe("promoteAnchorKinds (auto-promote repeat anchors, ADR 0004)", () => {
  it("keeps the first opening per fund and promotes later ones to snapshot", () => {
    // No prior anchors in the DB; a batch with the same fund opened twice.
    expect(
      promoteAnchorKinds(
        [],
        [
          { kind: "opening", ticker: "K-EQUITY" },
          { kind: "opening", ticker: "K-EQUITY" },
        ],
      ),
    ).toEqual(["opening", "snapshot"]);
  });

  it("promotes an opening for a fund that already has an anchor in the DB", () => {
    // The quarterly re-paste: the fund already opened in a prior save.
    expect(promoteAnchorKinds(["K-EQUITY"], [{ kind: "opening", ticker: "K-EQUITY" }])).toEqual([
      "snapshot",
    ]);
  });

  it("leaves a first-ever opening as opening, and never touches trade deltas", () => {
    expect(
      promoteAnchorKinds(
        ["OTHER-FUND"],
        [
          { kind: "opening", ticker: "NEW-FUND" },
          { kind: "buy", ticker: "NEW-FUND" },
          { kind: "sell", ticker: "K-EQUITY" },
        ],
      ),
    ).toEqual(["opening", "buy", "sell"]);
  });

  it("matches tickers case-insensitively", () => {
    expect(promoteAnchorKinds(["k-equity"], [{ kind: "opening", ticker: "K-EQUITY" }])).toEqual([
      "snapshot",
    ]);
  });

  it("treats an existing snapshot as already-anchored", () => {
    expect(
      promoteAnchorKinds(
        [],
        [
          { kind: "snapshot", ticker: "K-EQUITY" },
          { kind: "opening", ticker: "K-EQUITY" },
        ],
      ),
    ).toEqual(["snapshot", "snapshot"]);
  });
});
