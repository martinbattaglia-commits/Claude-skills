import { describe, expect, it } from "vitest";
import { BASE_CURRENCY, inferHoldingCurrency } from "./currency";

describe("inferHoldingCurrency", () => {
  it("treats every Thai mutual fund as THB regardless of ticker shape", () => {
    expect(inferHoldingCurrency("thai_mutual_fund", "EXAMPLE-FUND-A")).toBe("THB");
    expect(inferHoldingCurrency("thai_mutual_fund", "EXAMPLE-EQ-SSF")).toBe("THB");
  });

  it("maps Yahoo exchange suffixes to the listing currency", () => {
    expect(inferHoldingCurrency("market", "PTT.BK")).toBe("THB"); // Bangkok
    expect(inferHoldingCurrency("market", "^SET.BK")).toBe("THB"); // SET index
    expect(inferHoldingCurrency("market", "7203.T")).toBe("JPY"); // Tokyo
    expect(inferHoldingCurrency("market", "0700.HK")).toBe("HKD"); // Hong Kong
    expect(inferHoldingCurrency("market", "VWRL.L")).toBe("GBP"); // London
    expect(inferHoldingCurrency("market", "EXS1.DE")).toBe("EUR"); // Xetra
  });

  it("maps known non-suffixed index symbols", () => {
    expect(inferHoldingCurrency("market", "^N225")).toBe("JPY"); // Nikkei
    expect(inferHoldingCurrency("market", "^HSI")).toBe("HKD"); // Hang Seng
    expect(inferHoldingCurrency("market", "^FTSE")).toBe("GBP");
  });

  it("defaults bare US tickers and US-index carets to USD", () => {
    expect(inferHoldingCurrency("market", "VOO")).toBe("USD");
    expect(inferHoldingCurrency("market", "ACWI")).toBe("USD");
    expect(inferHoldingCurrency("market", "^GSPC")).toBe("USD");
    expect(inferHoldingCurrency("market", "^NDX")).toBe("USD");
    expect(inferHoldingCurrency("market", "GC=F")).toBe("USD"); // gold spot
  });

  it("degrades an unknown symbol to USD, not to THB", () => {
    // Falling back to USD is the honest default — the dominant foreign case —
    // rather than silently treating a foreign holding as already-baht.
    expect(inferHoldingCurrency("market", "MYSTERY")).toBe("USD");
  });

  it("is case-insensitive on the ticker", () => {
    expect(inferHoldingCurrency("market", "ptt.bk")).toBe("THB");
  });

  it("reads cash currency from the stored column, defaulting to THB", () => {
    // The ticker is the account name, not a symbol — currency is explicit.
    expect(inferHoldingCurrency("cash", "SCB-SAVINGS", "THB")).toBe("THB");
    expect(inferHoldingCurrency("cash", "WISE-USD", "usd")).toBe("USD");
    expect(inferHoldingCurrency("cash", "PIGGY-BANK")).toBe("THB");
  });

  it("exposes THB as the base currency", () => {
    expect(BASE_CURRENCY).toBe("THB");
  });
});
