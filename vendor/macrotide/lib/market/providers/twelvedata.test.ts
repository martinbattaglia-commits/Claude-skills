import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_TR_SOURCE } from "../sources";
import { toTwelveDataSymbol, twelveDataAdjustedProvider, twelveDataProvider } from "./twelvedata";
import { ProviderError } from "./types";

// All symbols/data here are synthetic shapes — no live API is hit.

describe("toTwelveDataSymbol", () => {
  it("maps real-index Yahoo symbols to free-tier ETF proxies", () => {
    // Twelve Data's free tier carries the tracking ETF, not the raw index, so
    // these resolve to ETF proxies (the real-index level comes from FMP/EODHD).
    expect(toTwelveDataSymbol("^GSPC")).toBe("SPY");
    expect(toTwelveDataSymbol("^NDX")).toBe("QQQ");
    expect(toTwelveDataSymbol("^N225")).toBe("EWJ");
    expect(toTwelveDataSymbol("^SET.BK")).toBe("THD");
  });

  it("converts Yahoo FX pairs (XXX=X) to USD/XXX slash notation", () => {
    expect(toTwelveDataSymbol("THB=X")).toBe("USD/THB");
    expect(toTwelveDataSymbol("JPY=X")).toBe("USD/JPY");
  });

  it("maps commodity futures to Twelve Data metal/energy pairs", () => {
    expect(toTwelveDataSymbol("GC=F")).toBe("XAU/USD");
    expect(toTwelveDataSymbol("SI=F")).toBe("XAG/USD");
    expect(toTwelveDataSymbol("CL=F")).toBe("WTI");
  });

  it("converts Yahoo crypto pairs (X-USD) to slash notation", () => {
    expect(toTwelveDataSymbol("BTC-USD")).toBe("BTC/USD");
    expect(toTwelveDataSymbol("ETH-USD")).toBe("ETH/USD");
  });

  it("passes ETF proxies through and strips a leading caret otherwise", () => {
    expect(toTwelveDataSymbol("ACWI")).toBe("ACWI");
    expect(toTwelveDataSymbol("AAPL")).toBe("AAPL");
    expect(toTwelveDataSymbol("^FOO")).toBe("FOO");
  });
});

describe("twelveDataProvider", () => {
  const KEY = "test-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    process.env.TWELVE_DATA_API_KEY = undefined;
    fetchSpy.mockRestore();
  });

  it("joins the chain only when a key is configured", () => {
    expect(twelveDataProvider.matches("market", "^GSPC")).toBe(true);
    process.env.TWELVE_DATA_API_KEY = "  ";
    expect(twelveDataProvider.matches("market", "^GSPC")).toBe(false);
    process.env.TWELVE_DATA_API_KEY = KEY;
    expect(twelveDataProvider.matches("thai_mutual_fund", "X")).toBe(false);
  });

  it("parses an ascending series and derives the quote from the last point", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          meta: { symbol: "GSPC", currency: "USD" },
          status: "ok",
          values: [
            { datetime: "2026-05-22", close: "100.0" },
            { datetime: "2026-05-23", close: "110.0" },
          ],
        }),
        { status: 200 },
      ),
    );

    const { quote, series } = await twelveDataProvider.fetchSeries("^GSPC", "6mo", "1d");

    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(100);
    expect(series[1].close).toBe(110);
    expect(series[0].t).toBeLessThan(series[1].t); // oldest-first
    expect(quote.price).toBe(110);
    expect(quote.previousClose).toBe(100);
    expect(quote.currency).toBe("USD");

    // request carried symbol (ETF proxy) + key + ascending order
    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("symbol")).toBe("SPY");
    expect(url.searchParams.get("apikey")).toBe(KEY);
    expect(url.searchParams.get("order")).toBe("asc");
  });

  it("throws on a Twelve Data error status (so the chain can fall back)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "error", code: 404, message: "symbol not found" }), {
        status: 200,
      }),
    );
    await expect(twelveDataProvider.fetchSeries("^SET.BK", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on a non-2xx HTTP response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(twelveDataProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("does NOT match the benchmark_tr source (that is the adjusted provider's)", () => {
    expect(twelveDataProvider.matches(BENCHMARK_TR_SOURCE, "ACWI")).toBe(false);
  });

  it("requests raw close — no adjust param on the market chain", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          meta: { symbol: "SPY", currency: "USD" },
          status: "ok",
          values: [{ datetime: "2026-05-23", close: "110.0" }],
        }),
        { status: 200 },
      ),
    );
    await twelveDataProvider.fetchSeries("^GSPC", "6mo", "1d");
    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("adjust")).toBeNull();
  });
});

describe("twelveDataAdjustedProvider", () => {
  const KEY = "test-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    process.env.TWELVE_DATA_API_KEY = undefined;
    fetchSpy.mockRestore();
  });

  it("matches only benchmark_tr, and only with a key configured", () => {
    expect(twelveDataAdjustedProvider.matches(BENCHMARK_TR_SOURCE, "ACWI")).toBe(true);
    expect(twelveDataAdjustedProvider.matches("market", "ACWI")).toBe(false);
    process.env.TWELVE_DATA_API_KEY = "  ";
    expect(twelveDataAdjustedProvider.matches(BENCHMARK_TR_SOURCE, "ACWI")).toBe(false);
  });

  it("requests dividend-reinvested close via adjust=all", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          meta: { symbol: "ACWI", currency: "USD" },
          status: "ok",
          values: [
            { datetime: "2026-05-22", close: "88.5" },
            { datetime: "2026-05-23", close: "90.0" },
          ],
        }),
        { status: 200 },
      ),
    );

    const { quote, series } = await twelveDataAdjustedProvider.fetchSeries("ACWI", "max", "1d");

    expect(series).toHaveLength(2);
    expect(quote.price).toBe(90);
    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("symbol")).toBe("ACWI"); // bare ETF passthrough
    expect(url.searchParams.get("adjust")).toBe("all");
    expect(url.searchParams.get("outputsize")).toBe("5000"); // max depth
  });
});
