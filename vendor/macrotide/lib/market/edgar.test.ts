import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCikMapCache,
  computeRatios,
  fetchProfile,
  fundamentalsFromFacts,
  padCik,
  tickerToCik,
} from "./edgar";

// Fixture shapes mirror the LIVE SEC payloads (company_tickers_exchange.json,
// data.sec.gov/submissions, api/xbrl/companyfacts).

const TICKERS = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
  ],
};

const SUBMISSIONS_AAPL = {
  name: "Apple Inc.",
  exchanges: ["Nasdaq"],
  sic: "3571",
  sicDescription: "Electronic Computers",
  stateOfIncorporation: "CA",
  fiscalYearEnd: "0926",
  tickers: ["AAPL"],
};

const FACTS_AAPL = {
  facts: {
    "us-gaap": {
      EarningsPerShareDiluted: {
        units: {
          "USD/shares": [
            { start: "2023-10-01", end: "2024-09-28", val: 6.08, form: "10-K" }, // FY2024 annual
            { start: "2024-06-30", end: "2024-09-28", val: 1.64, form: "10-Q" }, // quarterly → ignored
            { start: "2022-09-25", end: "2023-09-30", val: 5.9, form: "10-K" }, // older annual
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [{ start: "2023-10-01", end: "2024-09-28", val: 93_736_000_000, form: "10-K" }],
        },
      },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [{ start: "2023-10-01", end: "2024-09-28", val: 391_035_000_000, form: "10-K" }],
        },
      },
      StockholdersEquity: {
        units: {
          USD: [
            { end: "2024-09-28", val: 56_950_000_000 },
            { end: "2023-09-30", val: 62_146_000_000 }, // older instant → ignored
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            { end: "2024-10-18", val: 15_115_823_000 },
            { end: "2023-10-20", val: 15_634_232_000 },
          ],
        },
      },
    },
  },
};

function routedFetch(routes: Array<[string, unknown]>): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    for (const [frag, payload] of routes) {
      if (u.includes(frag)) return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => __resetCikMapCache());

describe("padCik", () => {
  it("zero-pads to 10 digits, stripping non-digits", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("CIK0000320193")).toBe("0000320193");
  });
});

describe("tickerToCik", () => {
  const f = routedFetch([["company_tickers_exchange.json", TICKERS]]);

  it("resolves a ticker case-insensitively to its padded CIK + exchange", async () => {
    expect(await tickerToCik("aapl", f)).toEqual({
      cik: "0000320193",
      name: "Apple Inc.",
      exchange: "Nasdaq",
    });
  });

  it("returns null for an unknown ticker (e.g. an ETF, not in this directory)", async () => {
    expect(await tickerToCik("VOO", f)).toBeNull();
  });
});

describe("fetchProfile", () => {
  it("maps submissions → profile (exchange, SIC industry, fiscal year)", async () => {
    const f = routedFetch([["submissions/CIK0000320193.json", SUBMISSIONS_AAPL]]);
    expect(await fetchProfile("320193", f)).toEqual({
      cik: "0000320193",
      name: "Apple Inc.",
      exchange: "Nasdaq",
      sic: "3571",
      sicDescription: "Electronic Computers",
      stateOfIncorporation: "CA",
      fiscalYearEnd: "0926",
      tickers: ["AAPL"],
    });
  });

  it("returns null when SEC 404s the CIK", async () => {
    expect(await fetchProfile("999", routedFetch([]))).toBeNull();
  });
});

describe("fundamentalsFromFacts", () => {
  it("picks the latest ANNUAL flow (not a quarter) and the latest INSTANT", () => {
    const f = fundamentalsFromFacts(FACTS_AAPL);
    expect(f.epsDiluted).toBe(6.08); // FY2024 annual, not the 1.64 quarter or 5.90 prior year
    expect(f.netIncome).toBe(93_736_000_000);
    expect(f.revenue).toBe(391_035_000_000); // contract-with-customer concept
    expect(f.equity).toBe(56_950_000_000); // latest instant, not the older 62.1B
    expect(f.sharesOutstanding).toBe(15_115_823_000);
    expect(f.asOf).toBe("2024-10-18");
  });

  it("falls back to the legacy Revenues tag when the contract concept is absent", () => {
    const facts = {
      facts: {
        "us-gaap": {
          Revenues: {
            units: { USD: [{ start: "2023-01-01", end: "2023-12-31", val: 1000, form: "10-K" }] },
          },
        },
      },
    };
    expect(fundamentalsFromFacts(facts).revenue).toBe(1000);
  });

  it("aligns revenue to net income's year when a filer switched revenue tags (NVDA case)", () => {
    const facts = {
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  start: "2025-01-27",
                  end: "2026-01-25",
                  val: 120_067_000_000,
                  fp: "FY",
                  form: "10-K",
                },
              ],
            },
          },
          // Stale: the filer stopped tagging revenue here after FY2022.
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                {
                  start: "2021-02-01",
                  end: "2022-01-30",
                  val: 26_914_000_000,
                  fp: "FY",
                  form: "10-K",
                },
              ],
            },
          },
          // Current revenue now lives under the legacy tag, same year-end as income.
          Revenues: {
            units: {
              USD: [
                {
                  start: "2025-01-27",
                  end: "2026-01-25",
                  val: 200_000_000_000,
                  fp: "FY",
                  form: "10-K",
                },
              ],
            },
          },
        },
      },
    };
    const f = fundamentalsFromFacts(facts);
    expect(f.revenue).toBe(200_000_000_000); // current year, NOT the stale 26.9B
    // Margin is now sane (≤ 1), not the 446% the stale tag produced.
    expect((f.netIncome ?? 0) / (f.revenue ?? 1)).toBeCloseTo(0.6, 2);
  });
});

describe("computeRatios", () => {
  const fundamentals = fundamentalsFromFacts(FACTS_AAPL);

  it("computes market cap, P/E, P/B, net margin against our price", () => {
    const r = computeRatios(fundamentals, 230);
    expect(r.marketCap).toBeCloseTo(230 * 15_115_823_000, 0);
    expect(r.peRatio).toBeCloseTo(230 / 6.08, 2);
    expect(r.pbRatio).toBeCloseTo((230 * 15_115_823_000) / 56_950_000_000, 2);
    expect(r.netMargin).toBeCloseTo(93_736_000_000 / 391_035_000_000, 4);
  });

  it("nulls price-dependent ratios when price is missing", () => {
    const r = computeRatios(fundamentals, null);
    expect(r.marketCap).toBeNull();
    expect(r.peRatio).toBeNull();
    expect(r.pbRatio).toBeNull();
    expect(r.netMargin).toBeCloseTo(93_736_000_000 / 391_035_000_000, 4); // margin is price-free
  });

  it("nulls P/E on non-positive EPS and P/B on non-positive equity", () => {
    const loss = { ...fundamentals, epsDiluted: -1.2, equity: -500 };
    const r = computeRatios(loss, 230);
    expect(r.peRatio).toBeNull();
    expect(r.pbRatio).toBeNull();
  });
});
