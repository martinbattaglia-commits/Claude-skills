import { afterEach, describe, expect, it, vi } from "vitest";
import { figiForTicker, mapIdsToTickers, mapTickersToFigi } from "./figi";

// Response shapes mirror the LIVE OpenFIGI v3 /mapping output — note the field is
// `compositeFIGI` (capital FIGI), the casing that bit us once.

afterEach(() => {
  delete process.env.OPENFIGI_API_KEY;
  vi.restoreAllMocks();
});

function mockOnce(payload: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
}

describe("mapTickersToFigi", () => {
  it("extracts compositeFIGI (real field casing) per symbol, in order", async () => {
    const spy = mockOnce([
      { data: [{ figi: "BBG000MM2P62", compositeFIGI: "BBG000MM2P62", ticker: "META" }] },
      { data: [{ figi: "BBG0015VYNT4", compositeFIGI: "BBG0015VYNT4", ticker: "VOO" }] },
    ]);
    const m = await mapTickersToFigi(["META", "VOO"]);
    expect(m.get("META")).toBe("BBG000MM2P62");
    expect(m.get("VOO")).toBe("BBG0015VYNT4");
    // exchCode=US → composite; ticker jobs sent.
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual([
      { idType: "TICKER", idValue: "META", exchCode: "US" },
      { idType: "TICKER", idValue: "VOO", exchCode: "US" },
    ]);
  });

  it("falls back to exchange-level figi when compositeFIGI is absent", async () => {
    mockOnce([{ data: [{ figi: "BBG000B9XRY4", ticker: "AAPL" }] }]);
    expect((await mapTickersToFigi(["AAPL"])).get("AAPL")).toBe("BBG000B9XRY4");
  });

  it("skips warning rows (unmatched symbols) and dedups input", async () => {
    const spy = mockOnce([
      { data: [{ compositeFIGI: "BBG000MM2P62" }] },
      { warning: "No identifier found." },
    ]);
    const m = await mapTickersToFigi(["META", "meta", "NOPE"]);
    expect(m.size).toBe(1);
    expect(m.get("META")).toBe("BBG000MM2P62");
    // "meta" deduped to "META", so only 2 unique jobs sent.
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toHaveLength(2);
  });

  it("sends the API key header when configured", async () => {
    process.env.OPENFIGI_API_KEY = "test-key";
    const spy = mockOnce([{ data: [{ compositeFIGI: "X" }] }]);
    await figiForTicker("META");
    const headers = new Headers((spy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("X-OPENFIGI-APIKEY")).toBe("test-key");
  });

  it("returns empty on a non-2xx without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );
    expect((await mapTickersToFigi(["META"])).size).toBe(0);
  });
});

describe("mapIdsToTickers", () => {
  it("maps ISIN/CUSIP → ticker (US composite), keyed by idValue, in order", async () => {
    const spy = mockOnce([
      { data: [{ ticker: "AAPL", name: "APPLE INC", exchCode: "US" }] },
      { data: [{ ticker: "NVDA", name: "NVIDIA CORP", exchCode: "US" }] },
    ]);
    const m = await mapIdsToTickers([
      { idType: "ID_ISIN", idValue: "US0378331005" },
      { idType: "ID_CUSIP", idValue: "67066G104" },
    ]);
    expect(m.get("US0378331005")).toBe("AAPL");
    expect(m.get("67066G104")).toBe("NVDA");
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual([
      { idType: "ID_ISIN", idValue: "US0378331005", exchCode: "US" },
      { idType: "ID_CUSIP", idValue: "67066G104", exchCode: "US" },
    ]);
  });

  it("skips warning rows (unresolved constituents) and dedups by idValue", async () => {
    const spy = mockOnce([{ data: [{ ticker: "MSFT" }] }, { warning: "No identifier found." }]);
    const m = await mapIdsToTickers([
      { idType: "ID_ISIN", idValue: "US5949181045" },
      { idType: "ID_ISIN", idValue: "US5949181045" }, // dup
      { idType: "ID_CUSIP", idValue: "XXNOTREAL0" },
    ]);
    expect(m.size).toBe(1);
    expect(m.get("US5949181045")).toBe("MSFT");
    // the duplicate ISIN collapsed → 2 unique jobs sent.
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toHaveLength(2);
  });

  it("returns empty on a non-2xx without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("429", { status: 429 }));
    expect((await mapIdsToTickers([{ idType: "ID_ISIN", idValue: "US0378331005" }])).size).toBe(0);
  });
});
