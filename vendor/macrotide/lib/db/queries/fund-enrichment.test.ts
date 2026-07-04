// Unit tests for lib/db/queries/fund-enrichment.ts
//
// Strategy: mock the DB context (getMarketDb) so tests run without a real SQLite
// instance. Each test focuses on the upsert/read logic in isolation.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock the DB context ──────────────────────────────────────────────────────

vi.mock("../context", () => ({
  getMarketDb: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { freshMarketDb } from "@/tests/db-helpers";
import { getMarketDb } from "../context";
import { fundCatalog, fundPortfolioAssetType } from "../schema";
import type { FundPerformanceInsert, FundPortfolioInsert } from "./fund-enrichment";
import {
  getFundAssetAllocation,
  getFundEnrichment,
  getFundPerformance,
  getFundPortfolio,
  getFundPortfolioAssetType,
  getFundTopHoldings,
  upsertFundAssetAllocation,
  upsertFundPerformance,
  upsertFundPortfolio,
  upsertFundPortfolioAssetType,
  upsertFundTopHoldings,
  usTickerFromIssueCode,
} from "./fund-enrichment";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock DB transaction/chain. */
function makeMockDb(rows: unknown[] = []) {
  const run = vi.fn();
  const all = vi.fn().mockReturnValue(rows);
  const orderBy = vi.fn().mockReturnValue({ all });
  const where = vi.fn().mockReturnValue({ all, orderBy, run });
  const values = vi
    .fn()
    .mockReturnValue({ run, onConflictDoUpdate: vi.fn().mockReturnValue({ run }) });
  const insert = vi.fn().mockReturnValue({ values });
  const deleteFrom = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run }) });
  const txFn = vi.fn((cb: (tx: typeof mockDb) => void) => cb(mockDb));
  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where, leftJoin: vi.fn().mockReturnValue({ where }) }),
    }),
    insert,
    delete: deleteFrom,
    transaction: txFn,
  };
  return mockDb;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("usTickerFromIssueCode", () => {
  it("extracts a US ticker from a Bloomberg-style issue_code", () => {
    expect(usTickerFromIssueCode("QQQM US")).toBe("QQQM");
    expect(usTickerFromIssueCode("AAPL UW")).toBe("AAPL");
    expect(usTickerFromIssueCode("BRK.B UN")).toBe("BRK.B");
    expect(usTickerFromIssueCode("  VOO US  ")).toBe("VOO"); // trimmed
  });

  it("rejects Thai internal codes and anything not a US Bloomberg ticker", () => {
    expect(usTickerFromIssueCode("USD-CASH-NDQ100-UH")).toBeNull();
    expect(usTickerFromIssueCode("SCBT89745-2")).toBeNull();
    expect(usTickerFromIssueCode("KKP MP FUND")).toBeNull(); // 2 words but not a venue code
    expect(usTickerFromIssueCode("QQQM")).toBeNull(); // no venue suffix
    expect(usTickerFromIssueCode("QQQM LN")).toBeNull(); // London, not a US venue
    expect(usTickerFromIssueCode(null)).toBeNull();
    expect(usTickerFromIssueCode("")).toBeNull();
  });
});

describe("fund-enrichment queries", () => {
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    vi.mocked(getMarketDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getMarketDb>);
  });

  // ─── upsertFundPerformance ─────────────────────────────────────────────────

  describe("upsertFundPerformance", () => {
    it("no-ops when rows array is empty", () => {
      upsertFundPerformance("proj-1", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction that deletes then inserts rows", () => {
      const rows: FundPerformanceInsert[] = [
        {
          projId: "proj-1",
          fundClassName: "main",
          startDate: "2025-01-01",
          endDate: null,
          prospectusType: "Monthly",
          performanceTypeDesc: "ความผันผวนของกองทุนรวม",
          referencePeriod: "1 year",
          performanceValue: "11.89",
          lastUpdDate: "2025-02-01T00:00:00Z",
        },
      ];

      upsertFundPerformance("proj-1", rows);

      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── upsertFundPortfolio ───────────────────────────────────────────────────

  describe("upsertFundPortfolio", () => {
    it("no-ops when rows array is empty", () => {
      upsertFundPortfolio("proj-1", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction for a portfolio row batch", () => {
      const rows: FundPortfolioInsert[] = [
        {
          projId: "proj-1",
          period: "202412",
          asOfDate: "2024-12-31",
          assetliabId: "101",
          assetliabDesc: "หุ้นสามัญ",
          issueCode: "AOT",
          isinCode: "TH1234",
          issuer: "AIRPORTS OF THAILAND",
          assetliabValue: 105_000_000,
          percentNav: 5.25,
          lastUpdDate: "2025-02-21T00:00:00Z",
        },
      ];

      upsertFundPortfolio("proj-1", rows);

      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── upsertFundAssetAllocation ─────────────────────────────────────────────

  describe("upsertFundAssetAllocation", () => {
    it("no-ops when rows array is empty", () => {
      upsertFundAssetAllocation("proj-1", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction for non-empty rows", () => {
      upsertFundAssetAllocation("proj-1", [
        {
          projId: "proj-1",
          startDate: "2025-01-01",
          endDate: null,
          prospectusType: "Monthly",
          assetSeq: 1,
          assetName: "หุ้นสามัญ",
          assetRatio: 95.68,
          lastUpdDate: "2025-02-01T00:00:00Z",
        },
      ]);
      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── upsertFundTopHoldings ────────────────────────────────────────────────

  describe("upsertFundTopHoldings", () => {
    it("no-ops when rows array is empty", () => {
      upsertFundTopHoldings("proj-1", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction for non-empty rows", () => {
      upsertFundTopHoldings("proj-1", [
        {
          projId: "proj-1",
          startDate: "2025-01-01",
          endDate: null,
          prospectusType: "Monthly",
          assetSeq: 1,
          assetName: "AOT",
          assetRatio: 5.3,
          lastUpdDate: "2025-02-01T00:00:00Z",
        },
      ]);
      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });
  });

  // ─── upsertFundPortfolioAssetType ─────────────────────────────────────────

  describe("upsertFundPortfolioAssetType", () => {
    it("no-ops when rows array is empty", () => {
      upsertFundPortfolioAssetType("proj-1", []);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("runs a transaction for non-empty rows", () => {
      upsertFundPortfolioAssetType("proj-1", [
        {
          projId: "proj-1",
          period: "202412",
          assetliabCode: "101",
          assetliabDesc: "หุ้น",
          marketValue: 1_000_000,
          percentNav: 91.2,
        },
      ]);
      expect(mockDb.transaction).toHaveBeenCalledOnce();
    });

    it("upserts duplicate (period, assetliab_code) rows in one call without throwing (real DB)", () => {
      // The SEC can return two rows with the same (period, code); the composite
      // PK would trip a plain insert. Exercise the real onConflictDoUpdate path.
      const { db } = freshMarketDb();
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);
      db.insert(fundCatalog).values({ projId: "P1", abbrName: "X" }).run();

      expect(() =>
        upsertFundPortfolioAssetType("P1", [
          {
            projId: "P1",
            period: "202412",
            assetliabCode: "101",
            assetliabDesc: "a",
            marketValue: 1,
            percentNav: 50,
          },
          {
            projId: "P1",
            period: "202412",
            assetliabCode: "101",
            assetliabDesc: "b",
            marketValue: 2,
            percentNav: 60,
          },
        ]),
      ).not.toThrow();

      const rows = db
        .select()
        .from(fundPortfolioAssetType)
        .where(eq(fundPortfolioAssetType.projId, "P1"))
        .all();
      expect(rows).toHaveLength(1); // deduped to the one key
      expect(rows[0].marketValue).toBe(2); // last write wins
    });
  });

  // ─── read helpers ─────────────────────────────────────────────────────────

  describe("read helpers", () => {
    it("getFundPerformance returns rows from DB", () => {
      const rows = [{ projId: "proj-1", performanceTypeDesc: "vol" }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundPerformance("proj-1");
      expect(result).toEqual(rows);
    });

    it("getFundAssetAllocation returns ordered rows from DB", () => {
      const rows = [{ projId: "proj-1", assetSeq: 1 }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundAssetAllocation("proj-1");
      expect(result).toEqual(rows);
    });

    it("getFundTopHoldings returns ordered rows from DB", () => {
      const rows = [{ projId: "proj-1", assetSeq: 1 }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundTopHoldings("proj-1");
      expect(result).toEqual(rows);
    });

    it("getFundPortfolio returns rows from DB", () => {
      const rows = [{ projId: "proj-1", period: "202412" }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundPortfolio("proj-1");
      expect(result).toEqual(rows);
    });

    it("getFundPortfolioAssetType returns rows from DB", () => {
      const rows = [{ projId: "proj-1", period: "202412" }];
      const db = makeMockDb(rows);
      vi.mocked(getMarketDb).mockReturnValue(db as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundPortfolioAssetType("proj-1");
      expect(result).toEqual(rows);
    });

    it("getFundEnrichment aggregates all five tables", () => {
      // Empty DB — returns empty arrays for all tables.
      const emptyDb = makeMockDb([]);
      vi.mocked(getMarketDb).mockReturnValue(emptyDb as unknown as ReturnType<typeof getMarketDb>);

      const result = getFundEnrichment("proj-1");
      expect(result).toMatchObject({
        performance: [],
        assetAllocation: [],
        topHoldings: [],
        portfolio: [],
        portfolioAssetType: [],
      });
    });
  });
});
