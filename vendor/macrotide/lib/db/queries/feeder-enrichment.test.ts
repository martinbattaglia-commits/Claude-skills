// Unit tests for lib/db/queries/feeder-enrichment.ts
//
// Strategy: mock the DB context (getMarketDb) so tests run without a real SQLite
// instance. Tests cover upsert and read helpers.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock the DB context ──────────────────────────────────────────────────────

vi.mock("../context", () => ({
  getMarketDb: vi.fn(),
}));

import { freshMarketDb } from "@/tests/db-helpers";
import { getMarketDb } from "../context";
import { usSecurities } from "../schema";
import {
  type FeederMasterMapRow,
  getFeederEnrichment,
  getFeederLookThroughHoldings,
  getFeederMasterMap,
  getFeederWeightsForSymbol,
  resolveMasterSymbol,
  upsertFeederLookThroughHoldings,
  upsertFeederMasterMap,
} from "./feeder-enrichment";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDb(rows: unknown[] = []) {
  const run = vi.fn();
  const all = vi.fn().mockReturnValue(rows);
  const get = vi.fn().mockReturnValue(rows[0] ?? null);
  const orderBy = vi.fn().mockReturnValue({ all });
  const where = vi.fn().mockReturnValue({ all, orderBy, run, get });
  const values = vi.fn().mockReturnValue({
    run,
    onConflictDoUpdate: vi.fn().mockReturnValue({ run }),
  });
  const insert = vi.fn().mockReturnValue({ values });
  const deleteFrom = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run }) });
  const txFn = vi.fn((cb: (tx: typeof mockDb) => void) => cb(mockDb));
  const from = vi.fn().mockReturnValue({
    where,
    innerJoin: vi.fn().mockReturnValue({ where }),
    leftJoin: vi.fn().mockReturnValue({ where }),
  });
  const mockDb = {
    select: vi.fn().mockReturnValue({ from }),
    insert,
    delete: deleteFrom,
    transaction: txFn,
  };
  return mockDb;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("feeder-enrichment queries", () => {
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    vi.mocked(getMarketDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getMarketDb>);
  });

  // ─── getFeederWeightsForSymbol ─────────────────────────────────────────────

  describe("getFeederWeightsForSymbol", () => {
    it("maps feeder proj_id → the symbol's transitive weight, skipping nulls", () => {
      const db = makeMockDb([
        { projId: "P1", weightPct: 6.65 },
        { projId: "P2", weightPct: null },
      ]);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const m = getFeederWeightsForSymbol("AAPL");
      expect(m.get("P1")).toBe(6.65);
      expect(m.has("P2")).toBe(false);
    });

    it("returns an empty map for a blank symbol (no query)", () => {
      expect(getFeederWeightsForSymbol("").size).toBe(0);
    });
  });

  // ─── upsertFeederMasterMap ─────────────────────────────────────────────────

  describe("upsertFeederMasterMap", () => {
    it("calls insert with the provided row", () => {
      upsertFeederMasterMap({
        projId: "M0001_2555",
        masterIsin: "IE00B5BMR087",
        masterName: "iShares Core S&P 500 UCITS ETF",
        provider: "ishares",
      });
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  // ─── upsertFeederLookThroughHoldings ──────────────────────────────────────

  describe("upsertFeederLookThroughHoldings", () => {
    it("no-ops when rows array is empty", () => {
      upsertFeederLookThroughHoldings("M0001_2555", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction that deletes then inserts rows", () => {
      upsertFeederLookThroughHoldings("M0001_2555", [
        {
          projId: "M0001_2555",
          rank: 1,
          name: "Apple Inc",
          ticker: "AAPL",
          assetClass: "Equity",
          isin: "US0378331005",
          weightPct: 7.23,
          asOfDate: "2026-05-23",
        },
        {
          projId: "M0001_2555",
          rank: 2,
          name: "Microsoft Corp",
          ticker: "MSFT",
          assetClass: "Equity",
          isin: "US5949181045",
          weightPct: 6.6,
          asOfDate: "2026-05-23",
        },
      ]);
      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── read helpers ─────────────────────────────────────────────────────────

  describe("getFeederMasterMap", () => {
    it("returns null when no row found", () => {
      const db = makeMockDb([]);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const result = getFeederMasterMap("M0001_2555");
      expect(result).toBeNull();
    });

    it("returns the first row when found", () => {
      const row = { projId: "M0001_2555", masterIsin: "IE00B5BMR087" };
      const db = makeMockDb([row]);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const result = getFeederMasterMap("M0001_2555");
      expect(result).toEqual(row);
    });
  });

  describe("getFeederLookThroughHoldings", () => {
    it("returns empty array when no rows", () => {
      const db = makeMockDb([]);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const result = getFeederLookThroughHoldings("M0001_2555");
      expect(result).toEqual([]);
    });

    it("returns rows from DB", () => {
      const rows = [{ projId: "M0001_2555", rank: 1, name: "Apple Inc", weightPct: 7.23 }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const result = getFeederLookThroughHoldings("M0001_2555");
      expect(result).toEqual(rows);
    });
  });

  describe("getFeederEnrichment", () => {
    it("returns null masterMap and empty array when no data", () => {
      const db = makeMockDb([]);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      const result = getFeederEnrichment("M0001_2555");
      expect(result).toMatchObject({
        masterMap: null,
        lookThroughHoldings: [],
      });
    });
  });
});

describe("resolveMasterSymbol (real DB, name-match)", () => {
  const master = (masterName: string | null): FeederMasterMapRow =>
    ({ masterName }) as FeederMasterMapRow;

  function seed() {
    const { db } = freshMarketDb();
    vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
    for (const [symbol, name] of [
      ["IVV", "iShares Core S&P 500 ETF"],
      ["ACWI", "iShares MSCI ACWI ETF"],
      ["ACWX", "iShares MSCI ACWI ex U.S. ETF"],
    ] as const) {
      db.insert(usSecurities).values({ symbol, name, securityType: "etf" }).run();
    }
    return db;
  }

  it("resolves a master fund to its US ETF by exact (case-insensitive) name", () => {
    seed();
    expect(resolveMasterSymbol(master("iShares Core S&P 500 ETF"))).toBe("IVV");
    expect(resolveMasterSymbol(master("ISHARES CORE S&P 500 ETF"))).toBe("IVV");
  });

  it("strips the Thai กองทุน prefix and collapses whitespace before matching", () => {
    seed();
    expect(resolveMasterSymbol(master("กองทุน iShares Core S&P 500 ETF"))).toBe("IVV");
    expect(resolveMasterSymbol(master("iShares  Core   S&P 500 ETF"))).toBe("IVV");
  });

  it("does NOT fuzzy-match — ACWI must not resolve to ACWX (and vice versa)", () => {
    seed();
    expect(resolveMasterSymbol(master("iShares MSCI ACWI ETF"))).toBe("ACWI");
    expect(resolveMasterSymbol(master("iShares MSCI ACWI ex U.S. ETF"))).toBe("ACWX");
  });

  it("returns null for an unmatched name or a missing/blank master name", () => {
    seed();
    expect(resolveMasterSymbol(master("Some European UCITS With No US Listing"))).toBeNull();
    expect(resolveMasterSymbol(master(null))).toBeNull();
    expect(resolveMasterSymbol(master("กองทุน"))).toBeNull(); // strips to empty
    expect(resolveMasterSymbol(null)).toBeNull();
  });
});
