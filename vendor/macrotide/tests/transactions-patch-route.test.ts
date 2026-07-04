import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";

// Drive the real PATCH handler against a shared in-memory DB context (like the POST
// route test). Locks the facts-only edit path: editing to a value-only Balance, an
// amount-only trade, or a units-only trade stores the fact and derives at the fold.
const h = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function ctx() {
  if (!h.ctx) throw new Error("test DB context not set");
  return h.ctx;
}
vi.mock("@/lib/api/with-db", () => ({
  withDb: async <T>(fn: (c: unknown) => T | Promise<T>) => {
    const { runWithDbContext } = await import("@/lib/db/context");
    return runWithDbContext(ctx(), () => fn(ctx()));
  },
}));

import { PATCH } from "@/app/api/transactions/[id]/route";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { listHoldings } from "@/lib/db/queries/holdings";
import { insertTransactions, listTransactionsByBucket } from "@/lib/db/queries/transactions";
import { navHistory } from "@/lib/db/schema";

function seedNav(key: string, rows: [string, number][]): void {
  for (const [date, nav] of rows)
    ctx().marketDb.insert(navHistory).values({ ticker: key, date, nav }).run();
}
function heldUnits(ticker: string): number | undefined {
  return runWithDbContext(ctx(), () => listHoldings().find((x) => x.ticker === ticker)?.units) as
    | number
    | undefined;
}
function stored() {
  return (
    runWithDbContext(ctx(), () => listTransactionsByBucket("b1")) as ReturnType<
      typeof listTransactionsByBucket
    >
  )[0];
}
function seedBuy(ticker: string): number {
  const rows = runWithDbContext(ctx(), () =>
    insertTransactions([
      {
        bucketId: "b1",
        ticker,
        quoteSource: "thai_mutual_fund",
        kind: "buy",
        tradeDate: "2026-03-01",
        units: 10,
        pricePerUnit: 5,
        amount: -50,
        importBatchId: "seed",
      },
    ]),
  ) as ReturnType<typeof insertTransactions>;
  return rows[0].id;
}
async function patch(id: number, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/transactions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: String(id) }) });
  return { status: res.status };
}

beforeEach(() => {
  h.ctx = makeTestDbContext();
  runWithDbContext(h.ctx, () =>
    createBucket({
      id: "b1",
      name: "Core",
      typeLabel: "F",
      icon: "○",
      color: "#000",
      brokerage: "X",
      notes: null,
      goalText: null,
      targetModelId: null,
      targetAllocation: null,
    }),
  );
});

describe("PATCH /api/transactions/[id] — facts-only edit parity", () => {
  it("edits a trade into a value-only Balance (stores value, units NULL, derives at fold)", async () => {
    seedNav("thai_mutual_fund:EXAMPLE-FUND-A", [["2026-03-01", 12.5]]);
    const id = seedBuy("EXAMPLE-FUND-A");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "opening",
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      value: 200000,
      amount: 0,
    });
    expect(status).toBe(200);
    expect(stored().kind).toBe("opening");
    expect(stored().value).toBe(200000);
    expect(stored().units).toBeNull();
    expect(heldUnits("EXAMPLE-FUND-A")).toBeCloseTo(16000); // 200000 ÷ 12.5
  });

  it("edits to an amount-only trade (units NULL, derived from NAV)", async () => {
    seedNav("thai_mutual_fund:EXAMPLE-FUND-B", [["2026-03-01", 20]]);
    const id = seedBuy("EXAMPLE-FUND-B");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "EXAMPLE-FUND-B",
      quoteSource: "thai_mutual_fund",
      amount: 1000,
    });
    expect(status).toBe(200);
    expect(stored().units).toBeNull();
    expect(stored().amount).toBe(-1000); // signed cash out
    expect(heldUnits("EXAMPLE-FUND-B")).toBeCloseTo(50); // 1000 ÷ 20
  });

  it("accepts a UNITS-only trade (amount 0 + units) and derives the amount from NAV", async () => {
    seedNav("thai_mutual_fund:EXAMPLE-FUND-B", [["2026-03-01", 20]]);
    const id = seedBuy("EXAMPLE-FUND-B");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "EXAMPLE-FUND-B",
      quoteSource: "thai_mutual_fund",
      units: 50,
      amount: 0,
    });
    expect(status).toBe(200);
    expect(stored().units).toBeCloseTo(50);
    expect(stored().amount).toBe(0); // the fact is units; amount derives at the fold
    expect(heldUnits("EXAMPLE-FUND-B")).toBeCloseTo(50);
  });

  it("edits a trade into a cash dividend (฿ amount, units NULL, no position)", async () => {
    const id = seedBuy("EXAMPLE-FUND-B");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "dividend",
      ticker: "EXAMPLE-FUND-B",
      quoteSource: "thai_mutual_fund",
      amount: 500,
    });
    expect(status).toBe(200);
    expect(stored().kind).toBe("dividend");
    expect(stored().units).toBeNull();
    expect(stored().amount).toBe(500); // cash in (positive)
    expect(heldUnits("EXAMPLE-FUND-B")).toBeUndefined(); // the only event is a cash dividend
  });

  it("edits a trade into a split (units = ratio, amount 0)", async () => {
    const id = seedBuy("EXAMPLE-FUND-B"); // 10 units
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "split",
      ticker: "EXAMPLE-FUND-B",
      quoteSource: "thai_mutual_fund",
      units: 3, // 3-for-1
      amount: 0,
    });
    expect(status).toBe(200);
    expect(stored().kind).toBe("split");
    expect(stored().amount).toBe(0); // a split moves no cash
    // The seed buy was replaced by a split with no prior position on this ticker, so
    // a split alone rebases nothing — it holds no units.
    expect(heldUnits("EXAMPLE-FUND-B")).toBeUndefined();
  });

  it("stores tradeCurrency + fxToThb on a non-THB edit (#233 History currency editing)", async () => {
    const id = seedBuy("USSTK"); // quoteSource thai_mutual_fund in the seed; PATCH sets market
    // The editor sends THB money (native × rate) + the currency/rate pair.
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "USSTK",
      quoteSource: "market",
      units: 10,
      pricePerUnit: 400 * 35, // $400 × 35
      amount: 400 * 35 * 10,
      tradeCurrency: "USD",
      fxToThb: 35,
    });
    expect(status).toBe(200);
    expect(stored().tradeCurrency).toBe("USD");
    expect(stored().fxToThb).toBe(35);
    expect(stored().pricePerUnit).toBe(14000); // THB avg cost
  });

  it("an omitted currency pair leaves the row THB (default 1)", async () => {
    const id = seedBuy("EXAMPLE-FUND-A");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      units: 10,
      pricePerUnit: 5,
      amount: 50,
    });
    expect(status).toBe(200);
    expect(stored().tradeCurrency).toBe("THB");
    expect(stored().fxToThb).toBe(1);
  });

  it("keeps the verbatim native figures on a non-THB edit; THB stays authoritative", async () => {
    const id = seedBuy("USSTK");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "USSTK",
      quoteSource: "market",
      units: 10,
      pricePerUnit: 400 * 35,
      amount: 400 * 35 * 10,
      tradeCurrency: "USD",
      fxToThb: 35,
      nativeInputs: { amount: 4000, price: 400 },
    });
    expect(status).toBe(200);
    // The exact figures the user typed round-trip, not a ฿ ÷ rate reconstruction.
    expect(stored().nativeInputs).toEqual({ amount: 4000, price: 400 });
    // THB money is unchanged and still drives the fold.
    expect(Math.abs(stored().amount)).toBe(400 * 35 * 10);
    expect(stored().pricePerUnit).toBe(14000);
  });

  it("clears native figures on a THB edit even if the client sends them", async () => {
    const id = seedBuy("EXAMPLE-FUND-A");
    const { status } = await patch(id, {
      tradeDate: "2026-03-01",
      kind: "buy",
      ticker: "EXAMPLE-FUND-A",
      quoteSource: "thai_mutual_fund",
      units: 10,
      pricePerUnit: 5,
      amount: 50,
      nativeInputs: { amount: 999 }, // a THB row has no native side — dropped
    });
    expect(status).toBe(200);
    expect(stored().nativeInputs).toBeNull();
  });
});
