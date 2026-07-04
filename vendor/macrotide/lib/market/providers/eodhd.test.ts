import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eodhdProvider, toEodhdSymbol } from "./eodhd";
import { ProviderError } from "./types";

// All symbols/data here are synthetic shapes — no live API is hit.

describe("toEodhdSymbol", () => {
  it("maps the real index symbols EODHD's free tier serves to .INDX codes", () => {
    expect(toEodhdSymbol("^GSPC")).toBe("GSPC.INDX");
    expect(toEodhdSymbol("^NDX")).toBe("NDX.INDX");
    expect(toEodhdSymbol("^IXIC")).toBe("IXIC.INDX");
    expect(toEodhdSymbol("^DJI")).toBe("DJI.INDX");
    expect(toEodhdSymbol("^N225")).toBe("N225.INDX");
    expect(toEodhdSymbol("^SET.BK")).toBe("SET.INDX"); // Stock Exchange of Thailand
  });

  it("returns undefined for symbols EODHD does not cover (ETF proxies, FX)", () => {
    expect(toEodhdSymbol("ACWI")).toBeUndefined();
    expect(toEodhdSymbol("THB=X")).toBeUndefined();
    expect(toEodhdSymbol("GC=F")).toBeUndefined();
  });
});

describe("eodhdProvider.matches", () => {
  const KEY = "test-key";
  afterEach(() => {
    delete process.env.EODHD_API_KEY;
  });

  it("matches only when the key is set AND the symbol is mapped", () => {
    process.env.EODHD_API_KEY = KEY;
    expect(eodhdProvider.matches("market", "^GSPC")).toBe(true);
    expect(eodhdProvider.matches("market", "^SET.BK")).toBe(true);
    // mapped symbol, but other logical source → no match
    expect(eodhdProvider.matches("thai_mutual_fund", "^GSPC")).toBe(false);
    // unmapped symbol → no match even with a key
    expect(eodhdProvider.matches("market", "ACWI")).toBe(false);
    expect(eodhdProvider.matches("market", "THB=X")).toBe(false);
  });

  it("drops out of the chain when no key is configured", () => {
    delete process.env.EODHD_API_KEY;
    expect(eodhdProvider.matches("market", "^GSPC")).toBe(false);
    process.env.EODHD_API_KEY = "  ";
    expect(eodhdProvider.matches("market", "^GSPC")).toBe(false);
  });
});

describe("eodhdProvider.fetchSeries", () => {
  const KEY = "test-key";
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.EODHD_API_KEY = KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    delete process.env.EODHD_API_KEY;
    fetchSpy.mockRestore();
  });

  it("parses the EOD array into an oldest-first series + quote and maps the symbol", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          // intentionally out of order to prove we sort by date
          { date: "2026-05-23", close: 5300.0 },
          { date: "2026-05-22", close: 5200.0 },
        ]),
        { status: 200 },
      ),
    );

    const { quote, series } = await eodhdProvider.fetchSeries("^GSPC", "6mo", "1d");

    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(5200);
    expect(series[1].close).toBe(5300);
    expect(series[0].t).toBeLessThan(series[1].t); // oldest-first
    expect(quote.price).toBe(5300);
    expect(quote.previousClose).toBe(5200);

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.pathname).toContain("GSPC.INDX");
    expect(url.searchParams.get("api_token")).toBe(KEY);
    expect(url.searchParams.get("order")).toBe("a");
  });

  it("throws on a non-2xx HTTP response (so the chain can fall back)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(eodhdProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws when the response is an error object, not an array", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Symbol not found" }), { status: 200 }),
    );
    await expect(eodhdProvider.fetchSeries("^SET.BK", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on an empty array", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await expect(eodhdProvider.fetchSeries("^GSPC", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
