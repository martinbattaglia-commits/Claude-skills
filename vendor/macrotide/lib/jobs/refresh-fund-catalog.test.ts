// Tests for the refresh-fund-catalog job — the LAND phase + orchestration of the
// ELT crawl. The derivation (raw item → catalog column) is covered separately in
// transform-fund-catalog.test.ts; here we assert the crawl LANDS verbatim SEC
// payloads in sec_raw, drives the transform to produce the end-to-end catalog,
// and handles concurrency / errors / enrichment flags.
//
// Strategy: real in-memory market.db (so landing + the transform run for real),
// injected SEC fetchers (no network). Only the enrichment query module is mocked
// — those tables are out of the ELT path and FK-reference fund_catalog, which is
// not populated until the transform runs after the loop.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/fund-enrichment", () => ({
  upsertFundPerformance: vi.fn(),
  upsertFundAssetAllocation: vi.fn(),
  upsertFundTopHoldings: vi.fn(),
  upsertFundPortfolio: vi.fn(),
  upsertFundPortfolioAssetType: vi.fn(),
  // Derived by the transform from landed sweeps — stubbed here because this
  // suite focuses on the land half (sweeps land [], so these never fire).
  upsertFundBenchmarks: vi.fn(),
  upsertFundStatistics: vi.fn(),
  upsertFundSpecifications: vi.fn(),
  upsertFundFactsheetUrls: vi.fn(),
  upsertFundSubscriptionMinimums: vi.fn(),
  upsertFundDividendPolicy: vi.fn(),
  upsertFundDividendHistory: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { makeTestDbContext } from "@/tests/db-helpers";
import { getMarketDb, runWithDbContext } from "../db/context";
import {
  upsertFundAssetAllocation,
  upsertFundPerformance,
  upsertFundPortfolio,
  upsertFundPortfolioAssetType,
  upsertFundTopHoldings,
} from "../db/queries/fund-enrichment";
import { getCurrentTer } from "../db/queries/funds";
import { readSecRaw, SEC_ENDPOINTS } from "../db/queries/sec-raw";
import { fundCatalog, fundFees } from "../db/schema";
import type { SecFundFeeItem } from "../market/fund-fees";
import type { SecFundProfile, SecRiskSpectrumItem } from "../market/providers/sec-thailand";
import { refreshFundCatalog } from "./refresh-fund-catalog";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeProfile = (overrides: Partial<SecFundProfile> = {}): SecFundProfile => ({
  proj_id: "1234",
  proj_abbr_name: "TEST-FUND",
  proj_name_th: "กองทุนทดสอบ",
  proj_name_en: "Test Fund",
  amc_name: "Test AMC",
  fund_status: "Registered",
  policy_desc: "ตราสารทุน",
  management_style: "AM",
  fund_class_tax_incentive_type: null,
  fund_class_detail: "สะสมมูลค่า",
  invest_country_flag: "4",
  feederfund_master_fund: null,
  proj_term_flag: "N",
  init_date: "2010-01-15",
  fund_class_isin_code: "TH1234567890",
  fund_class_name: "main",
  ...overrides,
});

const makeFeeItem = (overrides: Partial<SecFundFeeItem> = {}): SecFundFeeItem => ({
  proj_id: "1234",
  fund_class_name: "main",
  start_date: "2024-01-01",
  end_date: null,
  prospectus_type: "Main",
  fee_type_desc: "Total Fee and Expense",
  rate: 1.5,
  actual_value: 1.2,
  last_upd_date: "2024-06-01",
  ...overrides,
});

const makeAum = () => ({ aum: 1_500_000_000, aumDate: "2026-05-23" });

function makeEnumerate(profiles: SecFundProfile[]) {
  return vi.fn().mockResolvedValue(profiles);
}
function makeFetchFees(items: SecFundFeeItem[]) {
  return vi.fn().mockResolvedValue(items);
}
function makeFetchAum(result: { aum: number; aumDate: string } | null = makeAum()) {
  return vi.fn().mockResolvedValue(result);
}
function makeFetchRS(items: SecRiskSpectrumItem[] = []) {
  return vi.fn().mockResolvedValue(items);
}

/**
 * refreshFundCatalog with default (empty) bulk-sweep stubs (risk-spectrum,
 * benchmarks, statistics) so tests don't hit the real bulk APIs; pass the
 * corresponding _fetch* to override.
 */
function refresh(opts: Parameters<typeof refreshFundCatalog>[0] = {}) {
  return refreshFundCatalog({
    _fetchRiskSpectrum: makeFetchRS(),
    _fetchBenchmarks: vi.fn().mockResolvedValue([]),
    _fetchStatistics: vi.fn().mockResolvedValue([]),
    _fetchSpecifications: vi.fn().mockResolvedValue([]),
    _fetchFactsheetUrls: vi.fn().mockResolvedValue([]),
    _fetchMinimums: vi.fn().mockResolvedValue([]),
    _fetchDividendPolicy: vi.fn().mockResolvedValue([]),
    _fetchDividendHistory: vi.fn().mockResolvedValue([]),
    ...opts,
  });
}

/** Run a job body inside a fresh in-memory market.db context. */
function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWithDbContext(makeTestDbContext(), fn) as Promise<T>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("refreshFundCatalog", () => {
  beforeEach(() => {
    vi.mocked(upsertFundPerformance).mockReset();
    vi.mocked(upsertFundAssetAllocation).mockReset();
    vi.mocked(upsertFundTopHoldings).mockReset();
    vi.mocked(upsertFundPortfolio).mockReset();
    vi.mocked(upsertFundPortfolioAssetType).mockReset();
    delete process.env.SEC_INGEST_PERFORMANCE;
    delete process.env.SEC_INGEST_ALLOCATION;
    delete process.env.SEC_INGEST_HOLDINGS;
    delete process.env.SEC_INGEST_PORTFOLIO;
  });

  it("returns zero counts and lands nothing when no profiles are enumerated", () =>
    run(async () => {
      const result = await refresh({
        _enumerate: makeEnumerate([]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
      });

      expect(result).toEqual({
        fundsSeen: 0,
        fundsUpserted: 0,
        fundsActive: 0,
        fundsWithFees: 0,
        feeRowsUpserted: 0,
        fundsWithPerformance: 0,
        fundsWithAllocation: 0,
        fundsWithHoldings: 0,
        fundsWithPortfolio: 0,
        fundsWithFeederLookThrough: 0,
        riskSpectrumLanded: 0,
        benchmarksLanded: 0,
        statisticsLanded: 0,
        specificationsLanded: 0,
        factsheetUrlsLanded: 0,
        minimumsLanded: 0,
        dividendPolicyLanded: 0,
        dividendHistoryLanded: 0,
        errors: [],
      });
      expect(readSecRaw(SEC_ENDPOINTS.profiles)).toHaveLength(0);
      expect(getMarketDb().select().from(fundCatalog).all()).toHaveLength(0);
    }));

  it("lands verbatim profile/fees/AUM in sec_raw and derives the catalog end-to-end", () =>
    run(async () => {
      const profile = makeProfile();
      const feeItem = makeFeeItem();
      const aum = makeAum();

      const result = await refresh({
        _enumerate: makeEnumerate([profile]),
        _fetchFees: makeFetchFees([feeItem]),
        _fetchAum: makeFetchAum(aum),
      });

      expect(result.fundsSeen).toBe(1);
      expect(result.fundsUpserted).toBe(1);
      expect(result.fundsActive).toBe(1);
      expect(result.fundsWithFees).toBe(1);
      expect(result.feeRowsUpserted).toBe(1);
      expect(result.errors).toHaveLength(0);

      // 1. Raw landed verbatim (round-trips to the original payloads).
      const profileRaw = readSecRaw(SEC_ENDPOINTS.profiles);
      expect(profileRaw).toHaveLength(1);
      expect(profileRaw[0]).toMatchObject({
        endpoint: SEC_ENDPOINTS.profiles,
        projId: "1234",
        rowKey: "",
      });
      expect(JSON.parse(profileRaw[0].payload)).toEqual(profile);

      const feeRaw = readSecRaw(SEC_ENDPOINTS.fees);
      expect(feeRaw).toHaveLength(1);
      expect(JSON.parse(feeRaw[0].payload)).toEqual([feeItem]);

      const aumRaw = readSecRaw(SEC_ENDPOINTS.aum);
      expect(JSON.parse(aumRaw[0].payload)).toEqual(aum);

      // 2. Transform derived the catalog + fees from what was landed.
      const fund = getMarketDb()
        .select()
        .from(fundCatalog)
        .where(eq(fundCatalog.projId, "1234"))
        .get();
      expect(fund).toMatchObject({
        projId: "1234",
        abbrName: "TEST-FUND",
        assetClass: "equity",
        aum: aum.aum,
        aumDate: aum.aumDate,
        currentTer: 1.2,
      });
      const fees = getMarketDb().select().from(fundFees).all();
      expect(fees).toHaveLength(1);
      expect(fees[0]).toMatchObject({ feeType: "total_expense", actualRatePct: 1.2 });
      expect(getCurrentTer("1234")).toBe(1.2);
    }));

  it("bulk-lands risk-spectrum (scoped to enumerated funds) and drives asset class from it", () =>
    run(async () => {
      // policy_desc says bond, but the risk-spectrum code RS1 = money market.
      const profile = makeProfile({
        proj_id: "MM1",
        policy_desc: "ตราสารหนี้",
        proj_name_th: "กองทุนพันธบัตร",
      });
      const fetchRS = makeFetchRS([
        { proj_id: "MM1", risk_spectrum: "RS1", risk_spectrum_desc: "money market" },
        { proj_id: "OTHER", risk_spectrum: "RS6" }, // not enumerated → must be filtered out
      ]);

      const result = await refresh({
        _enumerate: makeEnumerate([profile]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
        _fetchRiskSpectrum: fetchRS,
      });

      expect(fetchRS).toHaveBeenCalledOnce();
      expect(result.riskSpectrumLanded).toBe(1); // only MM1, OTHER filtered out
      const rsRaw = readSecRaw(SEC_ENDPOINTS.riskSpectrum);
      expect(rsRaw.map((r) => r.projId)).toEqual(["MM1"]);

      // RS1 (cash) overrides the bond policy_desc.
      const fund = getMarketDb()
        .select()
        .from(fundCatalog)
        .where(eq(fundCatalog.projId, "MM1"))
        .get();
      expect(fund?.assetClass).toBe("cash");
    }));

  it("survives a risk-spectrum fetch failure — logs it and falls back to policy", () =>
    run(async () => {
      const fetchRS = vi.fn().mockRejectedValue(new Error("RS API down"));
      const result = await refresh({
        _enumerate: makeEnumerate([makeProfile()]), // policy ตราสารทุน → equity
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
        _fetchRiskSpectrum: fetchRS,
      });

      expect(result.riskSpectrumLanded).toBe(0);
      expect(result.errors.some((e) => e.projId === "(risk-spectrum)")).toBe(true);
      // The crawl still produced a catalog row, classified by the policy fallback.
      expect(result.fundsUpserted).toBe(1);
      const fund = getMarketDb()
        .select()
        .from(fundCatalog)
        .where(eq(fundCatalog.projId, "1234"))
        .get();
      expect(fund?.assetClass).toBe("equity");
    }));

  it("skips fee + AUM fetch for non-Registered funds; catalog row is inactive, AUM null", () =>
    run(async () => {
      const fetchFees = vi.fn();
      const fetchAum = vi.fn();

      const result = await refresh({
        _enumerate: makeEnumerate([
          makeProfile({ fund_status: "Liquidated" }),
          makeProfile({ proj_id: "9999", proj_abbr_name: "NEW-IPO", fund_status: "IPO" }),
        ]),
        _fetchFees: fetchFees,
        _fetchAum: fetchAum,
        concurrency: 1,
      });

      // IPO is "active" per statusFromSec but shouldFetchFees is false for it too,
      // so neither fund triggers a fetch.
      expect(fetchFees).not.toHaveBeenCalled();
      expect(fetchAum).not.toHaveBeenCalled();
      expect(result.fundsUpserted).toBe(2);
      expect(result.fundsActive).toBe(0);
      expect(result.fundsWithFees).toBe(0);

      // No fees/AUM landed; profiles landed for both.
      expect(readSecRaw(SEC_ENDPOINTS.fees)).toHaveLength(0);
      expect(readSecRaw(SEC_ENDPOINTS.aum)).toHaveLength(0);
      expect(readSecRaw(SEC_ENDPOINTS.profiles)).toHaveLength(2);

      const rows = getMarketDb().select().from(fundCatalog).all();
      const liquidated = rows.find((r) => r.secStatus === "Liquidated");
      expect(liquidated?.status).toBe("inactive");
      expect(liquidated?.aum).toBeNull();
      expect(rows.find((r) => r.secStatus === "IPO")?.status).toBe("active");
    }));

  it("collects per-fund errors; an errored fund lands nothing and gets no catalog row", () =>
    run(async () => {
      const profiles = [
        makeProfile({ proj_id: "A", proj_abbr_name: "FUND-A" }),
        makeProfile({ proj_id: "B", proj_abbr_name: "FUND-B" }),
        makeProfile({ proj_id: "C", proj_abbr_name: "FUND-C" }),
      ];
      const fetchFees = vi.fn().mockImplementation((projId: string) => {
        if (projId === "B") return Promise.reject(new Error("network timeout"));
        return Promise.resolve([makeFeeItem({ proj_id: projId })]);
      });

      const result = await refresh({
        _enumerate: makeEnumerate(profiles),
        _fetchFees: fetchFees,
        _fetchAum: makeFetchAum(),
        concurrency: 1,
      });

      expect(result.fundsSeen).toBe(3);
      expect(result.fundsActive).toBe(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].projId).toBe("B");
      expect(result.errors[0].error).toContain("network timeout");
      expect(result.feeRowsUpserted).toBe(2); // A and C

      // B lands nothing → no catalog row for B; A and C are present.
      const projIds = getMarketDb()
        .select()
        .from(fundCatalog)
        .all()
        .map((r) => r.projId)
        .sort();
      expect(projIds).toEqual(["A", "C"]);
      expect(
        readSecRaw(SEC_ENDPOINTS.profiles)
          .map((r) => r.projId)
          .sort(),
      ).toEqual(["A", "C"]);
    }));

  it("calls onProgress for each fund processed", () =>
    run(async () => {
      const progressCalls: unknown[] = [];
      await refresh({
        _enumerate: makeEnumerate([
          makeProfile({ proj_id: "X1", proj_abbr_name: "F1" }),
          makeProfile({ proj_id: "X2", proj_abbr_name: "F2" }),
        ]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
        onProgress: (info) => progressCalls.push(info),
        concurrency: 1,
      });
      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0]).toMatchObject({ total: 2, ok: true });
    }));

  it("passes limit to the enumerate function", () =>
    run(async () => {
      const enumerate = makeEnumerate([]);
      await refresh({
        _enumerate: enumerate,
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
        limit: 5,
      });
      expect(enumerate).toHaveBeenCalledWith(5);
    }));

  it("reports fundsActive and fundsWithFees separately", () =>
    run(async () => {
      const profiles = [
        makeProfile({ proj_id: "R1" }),
        makeProfile({ proj_id: "R2" }),
        makeProfile({ proj_id: "L1", fund_status: "Liquidated" }),
      ];
      const fetchFees = vi.fn().mockImplementation((projId: string) => {
        if (projId === "R2") return Promise.resolve([]); // R2 has no fee rows
        return Promise.resolve([makeFeeItem({ proj_id: projId })]);
      });

      const result = await refresh({
        _enumerate: makeEnumerate(profiles),
        _fetchFees: fetchFees,
        _fetchAum: makeFetchAum(),
        concurrency: 1,
      });

      expect(result.fundsUpserted).toBe(3);
      expect(result.fundsActive).toBe(2); // R1 + R2
      expect(result.fundsWithFees).toBe(1); // only R1 has fee rows
      expect(result.feeRowsUpserted).toBe(1);
    }));

  // ─── Enrichment flags ──────────────────────────────────────────────────────

  it("does NOT call enrichment fetchers when all flags are OFF (default)", () =>
    run(async () => {
      const fetchPerformance = vi.fn().mockResolvedValue([]);
      const fetchAllocation = vi.fn().mockResolvedValue([]);
      const fetchHoldings = vi.fn().mockResolvedValue([]);
      const fetchPortfolio = vi.fn().mockResolvedValue([]);
      const fetchPortfolioAssetType = vi.fn().mockResolvedValue([]);

      await refresh({
        _enumerate: makeEnumerate([makeProfile()]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(),
        _fetchPerformance: fetchPerformance,
        _fetchAssetAllocation: fetchAllocation,
        _fetchTop5Holdings: fetchHoldings,
        _fetchPortfolio: fetchPortfolio,
        _fetchPortfolioAssetType: fetchPortfolioAssetType,
      });

      expect(fetchPerformance).not.toHaveBeenCalled();
      expect(fetchAllocation).not.toHaveBeenCalled();
      expect(fetchHoldings).not.toHaveBeenCalled();
      expect(fetchPortfolio).not.toHaveBeenCalled();
      expect(fetchPortfolioAssetType).not.toHaveBeenCalled();
    }));

  it("calls performance fetcher and upserts when SEC_INGEST_PERFORMANCE=1", () =>
    run(async () => {
      process.env.SEC_INGEST_PERFORMANCE = "1";
      const perfItem = {
        proj_id: "1234",
        fund_class_name: "main",
        start_date: "2025-01-01",
        end_date: null,
        prospectus_type: "Monthly",
        performance_type_desc: "ความผันผวนของกองทุนรวม",
        reference_period: "1 year",
        performance_value: "11.89",
        last_upd_date: "2025-02-01T00:00:00Z",
      };
      const fetchPerformance = vi.fn().mockResolvedValue([perfItem]);

      const result = await refresh({
        _enumerate: makeEnumerate([makeProfile()]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(),
        _fetchPerformance: fetchPerformance,
      });

      expect(fetchPerformance).toHaveBeenCalledWith("1234");
      expect(upsertFundPerformance).toHaveBeenCalledOnce();
      expect(result.fundsWithPerformance).toBe(1);
    }));

  it("calls allocation fetcher and upserts when SEC_INGEST_ALLOCATION=1", () =>
    run(async () => {
      process.env.SEC_INGEST_ALLOCATION = "1";
      const allocItem = {
        proj_id: "1234",
        start_date: "2025-01-01",
        end_date: null,
        prospectus_type: "Monthly",
        asset_seq: 1,
        asset_name: "หุ้นสามัญ",
        asset_ratio: 95.68,
        last_upd_date: "2025-02-01T00:00:00Z",
      };
      const fetchAllocation = vi.fn().mockResolvedValue([allocItem]);

      const result = await refresh({
        _enumerate: makeEnumerate([makeProfile()]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(),
        _fetchAssetAllocation: fetchAllocation,
      });

      expect(fetchAllocation).toHaveBeenCalledWith("1234");
      expect(upsertFundAssetAllocation).toHaveBeenCalledOnce();
      expect(result.fundsWithAllocation).toBe(1);
    }));

  it("calls portfolio fetchers and upserts when SEC_INGEST_PORTFOLIO=1", () =>
    run(async () => {
      process.env.SEC_INGEST_PORTFOLIO = "1";
      const portItem = {
        proj_id: "1234",
        period: "202412",
        as_of_date: "2024-12-31",
        assetliab_id: "101",
        assetliab_desc: "หุ้นสามัญ",
        issue_code: "ADVANC",
        isin_code: "TH0268010Z03",
        issuer: "ADVANCED INFO SERVICE",
        assetliab_value: 100_000_000,
        percent_nav: 5.0,
        last_upd_date: "2025-02-21T00:00:00Z",
      };
      const portTypeItem = {
        proj_id: "1234",
        period: "202412",
        assetliab_code: "101",
        assetliab_desc: "หุ้น",
        market_value: 100_000_000,
        percent_nav: 91.18,
      };
      const fetchPortfolio = vi.fn().mockResolvedValue([portItem]);
      const fetchPortfolioAssetType = vi.fn().mockResolvedValue([portTypeItem]);

      const result = await refresh({
        _enumerate: makeEnumerate([makeProfile()]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(),
        _fetchPortfolio: fetchPortfolio,
        _fetchPortfolioAssetType: fetchPortfolioAssetType,
      });

      expect(fetchPortfolio).toHaveBeenCalledWith("1234");
      expect(fetchPortfolioAssetType).toHaveBeenCalledWith("1234");
      expect(upsertFundPortfolio).toHaveBeenCalledOnce();
      expect(upsertFundPortfolioAssetType).toHaveBeenCalledOnce();
      expect(result.fundsWithPortfolio).toBe(1);
    }));

  it("skips enrichment for non-Registered funds even when flags are ON", () =>
    run(async () => {
      process.env.SEC_INGEST_PERFORMANCE = "1";
      process.env.SEC_INGEST_PORTFOLIO = "1";
      const fetchPerformance = vi.fn().mockResolvedValue([]);
      const fetchPortfolio = vi.fn().mockResolvedValue([]);

      await refresh({
        _enumerate: makeEnumerate([makeProfile({ fund_status: "Liquidated" })]),
        _fetchFees: makeFetchFees([]),
        _fetchAum: makeFetchAum(null),
        _fetchPerformance: fetchPerformance,
        _fetchPortfolio: fetchPortfolio,
      });

      expect(fetchPerformance).not.toHaveBeenCalled();
      expect(fetchPortfolio).not.toHaveBeenCalled();
    }));
});
