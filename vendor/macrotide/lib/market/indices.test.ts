import { describe, expect, it } from "vitest";
import { fetchIndexMembership, parseSymbolColumn } from "./indices";

describe("parseSymbolColumn", () => {
  it("reads + upper-cases the Symbol column", () => {
    expect(parseSymbolColumn("Symbol,Name\nAAPL,Apple\nmsft,Microsoft")).toEqual(["AAPL", "MSFT"]);
  });

  it("returns [] when there is no Symbol header", () => {
    expect(parseSymbolColumn("Foo,Bar\nx,y")).toEqual([]);
  });
});

describe("fetchIndexMembership", () => {
  const routed = (map: Record<string, string | number>): typeof fetch =>
    (async (url: string) => {
      for (const [frag, body] of Object.entries(map)) {
        if (url.includes(frag)) {
          return typeof body === "number"
            ? new Response("x", { status: body })
            : new Response(body, { status: 200 });
        }
      }
      return new Response("x", { status: 404 });
    }) as unknown as typeof fetch;

  it("merges per-symbol membership across the three lists in stable order", async () => {
    const m = await fetchIndexMembership(
      routed({
        "s-and-p-500": "Symbol,Name\nAAPL,Apple\nXOM,Exxon",
        nasdaq100: "Symbol,Name\nAAPL,Apple\nNVDA,Nvidia",
        dowjones: "Symbol,Name\nAAPL,Apple",
      }),
    );
    const bySym = Object.fromEntries(m.map((r) => [r.symbol, r.indices]));
    expect(bySym.AAPL).toEqual(["sp500", "nasdaq100", "dow"]);
    expect(bySym.XOM).toEqual(["sp500"]);
    expect(bySym.NVDA).toEqual(["nasdaq100"]);
  });

  it("skips a failed list rather than dropping all membership", async () => {
    const m = await fetchIndexMembership(
      routed({ "s-and-p-500": "Symbol\nAAPL", nasdaq100: 500, dowjones: 500 }),
    );
    expect(m).toEqual([{ symbol: "AAPL", indices: ["sp500"] }]);
  });
});
