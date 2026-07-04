import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alpacaProvider } from "./alpaca";
import { ProviderError } from "./types";

// All symbols/data here are synthetic shapes — no live API is hit.

function setCreds() {
  process.env.ALPACA_API_KEY_ID = "test-key";
  process.env.ALPACA_API_SECRET_KEY = "test-secret";
}
function clearCreds() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
}

describe("alpacaProvider.matches", () => {
  afterEach(clearCreds);

  it("matches equity-shaped tickers only when BOTH credentials are set", () => {
    setCreds();
    expect(alpacaProvider.matches("market", "AAPL")).toBe(true);
    expect(alpacaProvider.matches("market", "VOO")).toBe(true);
    expect(alpacaProvider.matches("market", "BRK.B")).toBe(true);
    expect(alpacaProvider.matches("thai_mutual_fund", "AAPL")).toBe(false);
  });

  it("skips caret indices and FX pairs", () => {
    setCreds();
    expect(alpacaProvider.matches("market", "^GSPC")).toBe(false);
    expect(alpacaProvider.matches("market", "THB=X")).toBe(false);
  });

  it("drops out of the chain unless BOTH credentials are present", () => {
    clearCreds();
    expect(alpacaProvider.matches("market", "AAPL")).toBe(false);
    process.env.ALPACA_API_KEY_ID = "only-id";
    expect(alpacaProvider.matches("market", "AAPL")).toBe(false);
    clearCreds();
    process.env.ALPACA_API_SECRET_KEY = "only-secret";
    expect(alpacaProvider.matches("market", "AAPL")).toBe(false);
  });
});

describe("alpacaProvider.fetchSeries", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCreds();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    clearCreds();
    fetchSpy.mockRestore();
  });

  it("parses bars into an oldest-first series + quote and sends the IEX feed + raw adjustment", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          symbol: "AAPL",
          bars: [
            // intentionally out of order to prove we sort by date
            { t: "2026-05-23T04:00:00Z", c: 213.0 },
            { t: "2026-05-22T04:00:00Z", c: 211.0 },
          ],
          next_page_token: null,
        }),
        { status: 200 },
      ),
    );

    const { quote, series } = await alpacaProvider.fetchSeries("AAPL", "6mo", "1d");

    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(211);
    expect(series[1].close).toBe(213);
    expect(series[0].t).toBeLessThan(series[1].t);
    expect(quote.price).toBe(213);
    expect(quote.previousClose).toBe(211);
    expect(quote.ticker).toBe("AAPL");

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.pathname).toContain("/AAPL/bars");
    expect(url.searchParams.get("timeframe")).toBe("1Day");
    expect(url.searchParams.get("feed")).toBe("iex");
    expect(url.searchParams.get("adjustment")).toBe("raw");
    // Credentials ride headers, never the URL.
    expect(url.searchParams.get("apikey")).toBeNull();
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("APCA-API-KEY-ID")).toBe("test-key");
    expect(headers.get("APCA-API-SECRET-KEY")).toBe("test-secret");
  });

  it("maps weekly/monthly intervals to Alpaca timeframes", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ symbol: "VOO", bars: [{ t: "2026-05-23T04:00:00Z", c: 1 }] }), {
        status: 200,
      }),
    );
    await alpacaProvider.fetchSeries("VOO", "1y", "1wk");
    expect(
      new URL((fetchSpy.mock.calls[0][0] as URL).toString()).searchParams.get("timeframe"),
    ).toBe("1Week");
  });

  it("throws on a non-2xx HTTP response (so the chain can fall back)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(alpacaProvider.fetchSeries("NOPE", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws when bars is missing / not an array", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid symbol" }), { status: 200 }),
    );
    await expect(alpacaProvider.fetchSeries("NOPE", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on an empty bars array", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ symbol: "AAPL", bars: [] }), { status: 200 }),
    );
    await expect(alpacaProvider.fetchSeries("AAPL", "6mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
