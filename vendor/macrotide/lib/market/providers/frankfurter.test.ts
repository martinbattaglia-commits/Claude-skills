import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frankfurterProvider } from "./frankfurter";
import { ProviderError } from "./types";

// Synthetic shapes only — no live API is hit (except the explicit smoke test).

describe("frankfurterProvider.matches", () => {
  it("owns Yahoo-style FX pairs and nothing else", () => {
    expect(frankfurterProvider.matches("market", "THB=X")).toBe(true);
    expect(frankfurterProvider.matches("market", "JPY=X")).toBe(true);
    expect(frankfurterProvider.matches("market", "^GSPC")).toBe(false);
    expect(frankfurterProvider.matches("market", "AAPL")).toBe(false);
    expect(frankfurterProvider.matches("thai_mutual_fund", "THB=X")).toBe(false);
  });
});

describe("frankfurterProvider.fetchSeries", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("parses the ECB rates map into an oldest-first series + quote", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          base: "USD",
          rates: {
            // intentionally out of order to prove we sort by date
            "2026-05-02": { THB: 33.0 },
            "2026-05-01": { THB: 32.0 },
          },
        }),
        { status: 200 },
      ),
    );

    const { quote, series } = await frankfurterProvider.fetchSeries("THB=X", "1mo", "1d");

    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(32);
    expect(series[1].close).toBe(33);
    expect(series[0].t).toBeLessThan(series[1].t);
    expect(quote.price).toBe(33);
    expect(quote.previousClose).toBe(32);
    expect(quote.currency).toBe("THB");

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("from")).toBe("USD");
    expect(url.searchParams.get("to")).toBe("THB");
  });

  it("throws on a non-2xx response (so the chain can fall back)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(frankfurterProvider.fetchSeries("THB=X", "1mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws on an empty rates map", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ base: "USD", rates: {} }), { status: 200 }),
    );
    await expect(frankfurterProvider.fetchSeries("THB=X", "1mo", "1d")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
