// Unit tests for the NAV pre-warm job (issue #104).
//
// Strategy: the job exposes injectable seams (_listTickers / _prime / _warm) so
// these run without a real DB or network. Assertions are on the orchestration:
// limit, retailOnly passthrough, concurrency cap, error isolation, and priming.

import { describe, expect, it, vi } from "vitest";
import type { ShareClassTicker } from "../db/queries/share-classes";
import { prewarmNav } from "./prewarm-nav";

const makeTicker = (over: Partial<ShareClassTicker> = {}): ShareClassTicker => ({
  projId: "P1",
  ticker: "FUND-A",
  className: "main",
  investorType: null,
  name: "FUND",
  ...over,
});

describe("prewarmNav", () => {
  it("warms every listed ticker through the source + range and counts ok", async () => {
    const list = [
      makeTicker({ ticker: "A", projId: "P1", className: "main" }),
      makeTicker({ ticker: "B", projId: "P2", className: "B" }),
    ];
    const warm = vi.fn().mockResolvedValue({});
    const prime = vi.fn();

    const res = await prewarmNav({
      range: "max",
      _listTickers: () => list,
      _prime: prime,
      _warm: warm,
    });

    expect(res).toEqual({ tickersSeen: 2, ok: 2, failed: 0, errors: [] });
    expect(warm).toHaveBeenCalledWith("thai_mutual_fund", "A", "max");
    expect(warm).toHaveBeenCalledWith("thai_mutual_fund", "B", "max");
  });

  it("primes the resolution cache from the work-list (ticker → projId + className)", async () => {
    const list = [
      makeTicker({ ticker: "MDIVA-A", projId: "P9", className: "MDIVA-A", name: "MDIV" }),
    ];
    const prime = vi.fn();

    await prewarmNav({
      _listTickers: () => list,
      _prime: prime,
      _warm: vi.fn().mockResolvedValue({}),
    });

    expect(prime).toHaveBeenCalledWith([
      { ticker: "MDIVA-A", projId: "P9", fundClassName: "MDIVA-A", name: "MDIV" },
    ]);
  });

  it("passes retailOnly through to the lister and applies limit after listing", async () => {
    const list = [
      makeTicker({ ticker: "A" }),
      makeTicker({ ticker: "B" }),
      makeTicker({ ticker: "C" }),
    ];
    const lister = vi.fn(() => list);
    const warm = vi.fn().mockResolvedValue({});

    const res = await prewarmNav({
      limit: 2,
      retailOnly: true,
      _listTickers: lister,
      _prime: vi.fn(),
      _warm: warm,
    });

    expect(lister).toHaveBeenCalledWith({ retailOnly: true });
    expect(res.tickersSeen).toBe(2); // limited to 2 of 3
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("isolates per-ticker failures — one throw does not abort the run", async () => {
    const list = [
      makeTicker({ ticker: "OK1" }),
      makeTicker({ ticker: "BAD" }),
      makeTicker({ ticker: "OK2" }),
    ];
    const warm = vi.fn(async (_source: string, ticker: string) => {
      if (ticker === "BAD") throw new Error("No NAV data");
      return {};
    });

    const res = await prewarmNav({
      _listTickers: () => list,
      _prime: vi.fn(),
      _warm: warm,
    });

    expect(res.ok).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.errors).toEqual([{ ticker: "BAD", error: "No NAV data" }]);
  });

  it("never exceeds the concurrency cap", async () => {
    const list = Array.from({ length: 10 }, (_, i) => makeTicker({ ticker: `T${i}` }));
    let inFlight = 0;
    let peak = 0;
    const warm = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return {};
    });

    await prewarmNav({ concurrency: 3, _listTickers: () => list, _prime: vi.fn(), _warm: warm });

    expect(peak).toBeLessThanOrEqual(3);
    expect(warm).toHaveBeenCalledTimes(10);
  });
});
