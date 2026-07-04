import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMostActives } from "./screener";

// Synthetic shapes — no live API is hit.

function setCreds() {
  process.env.ALPACA_API_KEY_ID = "test-key";
  process.env.ALPACA_API_SECRET_KEY = "test-secret";
}
function clearCreds() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
}

describe("fetchMostActives", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    clearCreds();
    fetchSpy.mockRestore();
  });

  it("returns [] without hitting the network when creds are unset", async () => {
    clearCreds();
    const out = await fetchMostActives(50);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses most_actives and sends creds in headers (not the URL)", async () => {
    setCreds();
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          most_actives: [
            { symbol: "NVDA", volume: 151000454, trade_count: 2767385 },
            { symbol: "AAPL", volume: 107608198, trade_count: 1767761 },
          ],
          last_updated: "2026-06-25T23:59:00Z",
        }),
        { status: 200 },
      ),
    );

    const out = await fetchMostActives(15);
    expect(out).toEqual([
      { symbol: "NVDA", volume: 151000454, tradeCount: 2767385 },
      { symbol: "AAPL", volume: 107608198, tradeCount: 1767761 },
    ]);

    const url = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("by")).toBe("volume");
    expect(url.searchParams.get("top")).toBe("15");
    expect(url.searchParams.get("apikey")).toBeNull();
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("APCA-API-KEY-ID")).toBe("test-key");
    expect(headers.get("APCA-API-SECRET-KEY")).toBe("test-secret");
  });

  it("throws on a non-2xx response", async () => {
    setCreds();
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(fetchMostActives()).rejects.toThrow(/429/);
  });

  it("tolerates a missing most_actives array", async () => {
    setCreds();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    expect(await fetchMostActives()).toEqual([]);
  });
});
