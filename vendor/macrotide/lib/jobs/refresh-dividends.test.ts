import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { getDividends } from "@/lib/db/queries/us-dividends";
import type { DividendFetch } from "@/lib/market/corporate-actions";
import { makeTestDbContext } from "@/tests/db-helpers";
import { ensureDividends, refreshDividends } from "./refresh-dividends";
import { refreshUsSecurities } from "./refresh-us-securities";

const dirLine = (symbol: string, name: string) =>
  `Y|${symbol}|${name}|Q| |N|100|N||${symbol}|${symbol}|N`;
const HEADER =
  "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const directory = (...lines: string[]) => [HEADER, ...lines].join("\n");

const ok = (...exDates: string[]): DividendFetch => ({
  fetched: true,
  dividends: exDates.map((exDate) => ({
    exDate,
    payableDate: null,
    recordDate: null,
    cashAmount: 0.25,
    special: false,
  })),
});

const hoisted = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function run<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!hoisted.ctx) throw new Error("no ctx");
  return runWithDbContext(hoisted.ctx, fn) as Promise<T>;
}
beforeEach(() => {
  hoisted.ctx = makeTestDbContext();
});

async function seed(symbol: string) {
  await refreshUsSecurities({
    fetchText: async () => directory(dirLine(symbol, `${symbol} Inc - Common Stock`)),
    seenAt: "2026-06-26T00:00:00Z",
  });
}

describe("refreshDividends", () => {
  it("stores newest-first dividends + stamps freshness on a real fetch", async () => {
    await run(async () => {
      await seed("AAPL");
      const res = await refreshDividends({
        symbols: ["AAPL"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getDividendsFor: async () => ok("2025-02-10", "2025-05-12"),
      });
      expect(res).toEqual({ selected: 1, withDividends: 1, errored: 0 });
      const got = getDividends("aapl"); // case-insensitive
      expect(got.fetchedAt).toBe("2026-06-26T01:00:00Z");
      expect(got.dividends.map((d) => d.exDate)).toEqual(["2025-05-12", "2025-02-10"]);
    });
  });

  it("caches a genuine non-payer (fetched, empty) without flagging an error", async () => {
    await run(async () => {
      await seed("NVDA");
      const res = await refreshDividends({
        symbols: ["NVDA"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getDividendsFor: async () => ({ fetched: true, dividends: [] }),
      });
      expect(res).toEqual({ selected: 1, withDividends: 0, errored: 0 });
      expect(getDividends("NVDA").fetchedAt).toBe("2026-06-26T01:00:00Z");
    });
  });

  it("does NOT cache a failed fetch (fetched:false) — leaves it stale", async () => {
    await run(async () => {
      await seed("AAPL");
      const res = await refreshDividends({
        symbols: ["AAPL"],
        fetchedAt: "2026-06-26T01:00:00Z",
        getDividendsFor: async () => ({ fetched: false, dividends: [] }),
      });
      expect(res).toEqual({ selected: 1, withDividends: 0, errored: 1 });
      expect(getDividends("AAPL").fetchedAt).toBeNull();
    });
  });
});

describe("ensureDividends (JIT)", () => {
  it("fetches when cold, no-ops when fresh", async () => {
    await run(async () => {
      await seed("AAPL");
      let calls = 0;
      const getDividendsFor = async () => {
        calls++;
        return ok("2025-05-12");
      };
      await ensureDividends("AAPL", { getDividendsFor });
      expect(calls).toBe(1);
      await ensureDividends("AAPL", { getDividendsFor });
      expect(calls).toBe(1);
    });
  });
});
