import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithDbContext } from "@/lib/db/context";
import { createBucket } from "@/lib/db/queries/buckets";
import { listEarmarks, setAccountEarmark } from "@/lib/db/queries/earmarks";
import { canonicalTicker } from "@/lib/db/queries/funds";
import { listHoldings } from "@/lib/db/queries/holdings";
import {
  createHoldingViaLedger,
  deleteHoldingViaLedger,
  editHoldingViaLedger,
} from "@/lib/db/queries/project-holdings";
import { listTransactionsByBucket } from "@/lib/db/queries/transactions";
import { fundCatalog, fundShareClasses } from "@/lib/db/schema";
import { makeTestDbContext } from "@/tests/db-helpers";

// #235 — tickers are stored in their official catalog case (custom/cash keep the
// typed case), and ALL matching is case-folded. Synthetic codes only (AGENTS.md).

const h = vi.hoisted(() => ({ ctx: null as ReturnType<typeof makeTestDbContext> | null }));
function ctx() {
  if (!h.ctx) throw new Error("test DB context not set");
  return h.ctx;
}
function run<T>(fn: () => T): T {
  return runWithDbContext(ctx(), fn) as T;
}

const BUCKET = {
  id: "b1",
  name: "Core",
  typeLabel: "Free",
  icon: "○",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

/** Seed a cataloged fund whose canonical case is MIXED (mirrors the real
 * lowercase-suffixed SSF/RMF families). */
function seedCatalogFund(canonicalTickerCase: string) {
  ctx()
    .marketDb.insert(fundCatalog)
    .values({ projId: `proj-${canonicalTickerCase}`, abbrName: canonicalTickerCase })
    .run();
  ctx()
    .marketDb.insert(fundShareClasses)
    .values({
      projId: `proj-${canonicalTickerCase}`,
      className: "main",
      ticker: canonicalTickerCase,
    })
    .run();
}

beforeEach(() => {
  h.ctx = makeTestDbContext();
  run(() => createBucket(BUCKET));
});

describe("canonicalTicker", () => {
  it("returns the official catalog case regardless of typed case", () => {
    run(() => {
      seedCatalogFund("Tsp1-Preserver-SSF");
      expect(canonicalTicker("tsp1-preserver-ssf")).toBe("Tsp1-Preserver-SSF");
      expect(canonicalTicker("TSP1-PRESERVER-SSF")).toBe("Tsp1-Preserver-SSF");
    });
  });

  it("preserves the typed case for a custom (off-catalog) symbol", () => {
    run(() => {
      expect(canonicalTicker("MyGold")).toBe("MyGold");
      expect(canonicalTicker("  brk.b  ")).toBe("brk.b");
    });
  });
});

describe("createHoldingViaLedger stores the official catalog case", () => {
  it("normalizes a lowercase-typed cataloged code to one holding in catalog case", () => {
    const holding = run(() => {
      seedCatalogFund("EXAMPLE-Fund-A");
      return createHoldingViaLedger({
        bucketId: "b1",
        ticker: "example-fund-a",
        englishName: "App English",
        quoteSource: "thai_mutual_fund",
        units: 10,
      });
    });
    expect(holding?.ticker).toBe("EXAMPLE-Fund-A");
    const all = run(() => listHoldings("b1"));
    expect(all).toHaveLength(1);
    expect(all[0].ticker).toBe("EXAMPLE-Fund-A");
  });
});

describe("case-variant custom tickers fold to ONE holding", () => {
  it("treats free-typed voo and VOO as the same position", () => {
    const all = run(() => {
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "voo",
        englishName: "Vanguard S&P 500",
        quoteSource: "manual",
        units: 5,
        avgCost: 100,
      });
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "VOO",
        englishName: "Vanguard S&P 500",
        quoteSource: "manual",
        units: 3,
        avgCost: 110,
      });
      return listHoldings("b1");
    });
    expect(all).toHaveLength(1);
    // Most-recent typed case wins as the display case.
    expect(all[0].ticker).toBe("VOO");
  });
});

describe("rename cascade is case-insensitive across the ledger + earmark", () => {
  it("re-tickers every ledger row and the cash Purpose when only the case differs", () => {
    const out = run(() => {
      const holding = createHoldingViaLedger({
        bucketId: "b1",
        ticker: "My Bank",
        englishName: "My Bank",
        quoteSource: "cash",
        units: 1000,
      });
      // A cash account name keeps its typed case (no upper-casing).
      expect(holding?.ticker).toBe("My Bank");
      setAccountEarmark({ bucketId: "b1", ticker: "MY BANK", role: "reserved", amount: null });
      // Rename to a new display case; the cascade must find the old case.
      editHoldingViaLedger(holding?.id as number, { ticker: "My Bank Account" });
      const txns = listTransactionsByBucket("b1");
      const marks = listEarmarks();
      return { txns, marks };
    });
    expect(out.txns.every((t) => t.ticker === "My Bank Account")).toBe(true);
    expect(out.marks).toHaveLength(1);
    expect(out.marks[0].ticker).toBe("My Bank Account");
  });
});

describe("deleting a holding cascades its earmark", () => {
  it("drops the cash Purpose so it can't orphan or re-attach", () => {
    const marks = run(() => {
      const holding = createHoldingViaLedger({
        bucketId: "b1",
        ticker: "Petty Cash",
        englishName: "Petty Cash",
        quoteSource: "cash",
        units: 5000,
      });
      setAccountEarmark({ bucketId: "b1", ticker: "petty cash", role: "reserved", amount: null });
      deleteHoldingViaLedger(holding?.id as number);
      return listEarmarks();
    });
    expect(marks).toHaveLength(0);
  });
});

describe("cash account name keeps its case", () => {
  it("stores the typed case directly as the ticker (no upper-casing workaround)", () => {
    const holding = run(() =>
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "SCB Savings",
        englishName: "SCB Savings",
        quoteSource: "cash",
        units: 50000,
      }),
    );
    expect(holding?.ticker).toBe("SCB Savings");
  });
});
