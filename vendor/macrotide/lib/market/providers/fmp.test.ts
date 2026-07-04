import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmpProvider, toFmpSymbol } from "./fmp";
import { ProviderError } from "./types";

// All symbols/data here are synthetic shapes — no live API is hit.

describe("toFmpSymbol", () => {
  it("maps the US indices FMP's free tier serves (caret passthrough)", () => {
    expect(toFmpSymbol("^GSPC")).toBe("^GSPC");
    expect(toFmpSymbol("^DJI")).toBe("^DJI");
  });

  it("does not map ^NDX (premium on FMP — left to EODHD) or non-US / ETF / FX", () => {
    expect(toFmpSymbol("^NDX")).toBeUndefined();
    expect(toFmpSymbol("^N225")).toBeUndefined();
    expect(toFmpSymbol("^SET.BK")).toBeUndefined();
    expect(toFmpSymbol("ACWI")).toBeUndefined();
    expect(toFmpSymbol("THB=X")).toBeUndefined();
  });
});

describe("fmpProvider.matches", () => {
  const KEY = "test-key";
  afterEach(() => {
    delete process.env.FMP_API_KEY;
  });

  it("matches only when the key is set AND the symbol is a covered US index", () => {
    process.env.FMP_API_KEY = KEY;
    expect(fmpProvider.matches("market", "^GSPC")).toBe(true);
    expect(fmpProvider.matches("market", "^DJI")).toBe(true);
    expect(fmpProvider.matches("thai_mutual_fund", "^GSPC")).toBe(false);
    expect(fmpProvider.matches("market", "^SET.BK")).toBe(false);
    expect(fmpProvider.matches("market", "ACWI")).toBe(false);
  });

  it("drops out of the chain when no key is configured", () => {
    delete process.env.FMP_API_KEY;
    expect(fmpProvider.matches("market", "^GSPC")).toBe(false);
    process.env.FMP_API_KEY = "  ";
    expect(fmpProvider.matches("market", "^GSPC")).toBe(false);
  });
});

describe("fmpProvider.fetchSeries", () => {
  const KEY = "test-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.FMP_API_KEY = KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    delete process.env.FMP_API_KEY;
    fetchSpy.mockRestore();
  });

  it("parses the newest-first stable-API array into an oldest-first series + quote", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          // stable /historical-price-eod/full returns a flat array, newest-first
          { symbol: "^GSPC", date: "2026-05-23", close: 5300.0 },
          { symbol: "^GSPC", date: "2026-05-22", close: 5200.0 },
        ]),
        { status: 200 },
      ),
    );

    const { quote, series } = await fmpProvider.fetchSeries("^GSPC", "6mo", "1d");

    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(5200);
    expect(series[1].close).toBe(5300);
    expect(series[0].t).toBeLessThan(series[1].t); // oldest-first
    expect(quote.price).toBe(5300);
    expect(quote.previousClose).toBe(5200);
    expect(quote.currency).toBe("USD");

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.pathname).toContain("historical-price-eod/full");
    expect(url.searchParams.get("symbol")).toBe("^GSPC");
    expect(url.searchParams.get("apikey")).toBe(KEY);
  });

  it("throws on a non-2xx HTTP response (so the chain can fall back)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(fmpProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on an FMP error-message payload (non-array body)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ "Error Message": "Invalid API KEY" }), { status: 200 }),
    );
    await expect(fmpProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on an empty array", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await expect(fmpProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
