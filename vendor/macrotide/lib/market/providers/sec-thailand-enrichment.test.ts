// Unit tests for the new SEC enrichment fetch helpers in sec-thailand.ts.
//
// Tests: fetchFundPerformance, fetchFundAssetAllocation, fetchFundTop5Holdings,
//        fetchFundPortfolio, fetchFundPortfolioAssetType.
//
// Strategy: stub global fetch to return synthetic SEC API responses.
// All test data is synthetic — no real fund codes or API keys.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSecThailandCache,
  __setSecThailandRetry,
  fetchFundAssetAllocation,
  fetchFundPerformance,
  fetchFundPortfolio,
  fetchFundPortfolioAssetType,
  fetchFundTop5Holdings,
} from "./sec-thailand";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function envelope<T>(items: T[], next_cursor = ""): string {
  return JSON.stringify({
    message: "success",
    page_size: 100,
    next_cursor,
    items,
  });
}

const FAKE_PROJ_ID = "T0001_2555";

// ─── Setup ────────────────────────────────────────────────────────────────────

describe("SEC enrichment fetch helpers", () => {
  beforeEach(() => {
    __resetSecThailandCache();
    __setSecThailandRetry({ minIntervalMs: 0, baseDelayMs: 0 });
    process.env.SEC_API_KEY = "test-key-synthetic";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-22T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SEC_API_KEY;
  });

  // ─── fetchFundPerformance ──────────────────────────────────────────────────

  describe("fetchFundPerformance", () => {
    it("fetches all performance types from /v2/fund/factsheet/performance", async () => {
      const items = [
        {
          proj_id: FAKE_PROJ_ID,
          fund_class_name: "main",
          start_date: "2025-01-01",
          end_date: null,
          prospectus_type: "Monthly",
          performance_type_desc: "ความผันผวนของกองทุนรวม",
          reference_period: "1 year",
          performance_value: "11.89",
          last_upd_date: "2025-02-01T00:00:00Z",
        },
        {
          proj_id: FAKE_PROJ_ID,
          fund_class_name: "main",
          start_date: "2025-01-01",
          end_date: null,
          prospectus_type: "Monthly",
          performance_type_desc: "ผลการดำเนินงานของกองทุนรวม",
          reference_period: "1 year",
          performance_value: "8.45",
          last_upd_date: "2025-02-01T00:00:00Z",
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          expect(u.pathname).toBe("/v2/fund/factsheet/performance");
          expect(u.searchParams.get("proj_id")).toBe(FAKE_PROJ_ID);
          expect(u.searchParams.get("latest")).toBe("true");
          return new Response(envelope(items), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const result = await fetchFundPerformance(FAKE_PROJ_ID);
      expect(result).toHaveLength(2);
      expect(result[0].performance_type_desc).toBe("ความผันผวนของกองทุนรวม");
      expect(result[1].performance_type_desc).toBe("ผลการดำเนินงานของกองทุนรวม");
    });

    it("returns empty array on 204 response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 204 })),
      );

      const result = await fetchFundPerformance(FAKE_PROJ_ID);
      expect(result).toEqual([]);
    });
  });

  // ─── fetchFundAssetAllocation ──────────────────────────────────────────────

  describe("fetchFundAssetAllocation", () => {
    it("fetches asset allocation from /v2/fund/factsheet/asset-allocation", async () => {
      const items = [
        {
          proj_id: FAKE_PROJ_ID,
          start_date: "2025-01-01",
          end_date: null,
          prospectus_type: "Monthly",
          asset_seq: 1,
          asset_name: "หุ้นสามัญ",
          asset_ratio: 95.68,
          last_upd_date: "2025-02-01T00:00:00Z",
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          expect(u.pathname).toBe("/v2/fund/factsheet/asset-allocation");
          expect(u.searchParams.get("latest")).toBe("true");
          return new Response(envelope(items), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const result = await fetchFundAssetAllocation(FAKE_PROJ_ID);
      expect(result).toHaveLength(1);
      expect(result[0].asset_name).toBe("หุ้นสามัญ");
      expect(result[0].asset_ratio).toBe(95.68);
    });

    it("returns empty array when no items", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(envelope([]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );

      const result = await fetchFundAssetAllocation(FAKE_PROJ_ID);
      expect(result).toEqual([]);
    });
  });

  // ─── fetchFundTop5Holdings ─────────────────────────────────────────────────

  describe("fetchFundTop5Holdings", () => {
    it("fetches top-5 holdings from /v2/fund/factsheet/top5-holdings", async () => {
      const items = [
        {
          proj_id: FAKE_PROJ_ID,
          start_date: "2025-01-01",
          end_date: null,
          prospectus_type: "Monthly",
          asset_seq: 1,
          asset_name: "AOT",
          asset_ratio: 5.3,
          last_upd_date: "2025-02-01T00:00:00Z",
        },
        {
          proj_id: FAKE_PROJ_ID,
          start_date: "2025-01-01",
          end_date: null,
          prospectus_type: "Monthly",
          asset_seq: 2,
          asset_name: "GULF",
          asset_ratio: 4.1,
          last_upd_date: "2025-02-01T00:00:00Z",
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          expect(u.pathname).toBe("/v2/fund/factsheet/top5-holdings");
          expect(u.searchParams.get("latest")).toBe("true");
          return new Response(envelope(items), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const result = await fetchFundTop5Holdings(FAKE_PROJ_ID);
      expect(result).toHaveLength(2);
      expect(result[0].asset_seq).toBe(1);
      expect(result[1].asset_seq).toBe(2);
    });
  });

  // ─── fetchFundPortfolio ────────────────────────────────────────────────────

  describe("fetchFundPortfolio", () => {
    it("fetches portfolio from /v2/fund/outstanding/portfolio using bare proj_id only", async () => {
      const items = [
        {
          proj_id: FAKE_PROJ_ID,
          period: "202412",
          as_of_date: "2024-12-31",
          assetliab_id: "101",
          assetliab_desc: "หุ้นสามัญ",
          issue_code: "ADVANC",
          isin_code: "TH0268010Z03",
          issuer: "ADVANCED INFO SERVICE PUBLIC COMPANY LIMITED",
          assetliab_value: 105_670_500,
          percent_nav: 2.80362,
          last_upd_date: "2025-02-21T05:00:25Z",
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          expect(u.pathname).toBe("/v2/fund/outstanding/portfolio");
          expect(u.searchParams.get("proj_id")).toBe(FAKE_PROJ_ID);
          // Must NOT send date params (API returns 400 with them).
          expect(u.searchParams.has("start_period")).toBe(false);
          expect(u.searchParams.has("end_period")).toBe(false);
          return new Response(envelope(items), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const result = await fetchFundPortfolio(FAKE_PROJ_ID);
      expect(result).toHaveLength(1);
      expect(result[0].period).toBe("202412");
      expect(result[0].issuer).toBe("ADVANCED INFO SERVICE PUBLIC COMPANY LIMITED");
    });

    it("follows cursor pagination for large portfolios", async () => {
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          callCount++;
          if (callCount === 1) {
            // First page: return one item + a cursor.
            return new Response(
              JSON.stringify({
                message: "success",
                page_size: 100,
                next_cursor: "cursor-page-2",
                items: [{ proj_id: FAKE_PROJ_ID, period: "202412", assetliab_id: "101" }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Second page: return item + no cursor (signals last page).
          expect(u.searchParams.get("next_cursor")).toBe("cursor-page-2");
          return new Response(
            JSON.stringify({
              message: "success",
              page_size: 100,
              next_cursor: "",
              items: [{ proj_id: FAKE_PROJ_ID, period: "202412", assetliab_id: "102" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
      );

      const result = await fetchFundPortfolio(FAKE_PROJ_ID);
      expect(result).toHaveLength(2);
      expect(callCount).toBe(2);
    });
  });

  // ─── fetchFundPortfolioAssetType ───────────────────────────────────────────

  describe("fetchFundPortfolioAssetType", () => {
    it("fetches from /v2/fund/outstanding/portfolio-asset-type", async () => {
      const items = [
        {
          proj_id: FAKE_PROJ_ID,
          period: "202412",
          assetliab_code: "101",
          assetliab_desc: "หุ้น",
          market_value: 1_296_947_797.6,
          percent_nav: 91.18823,
        },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const u = new URL(input);
          expect(u.pathname).toBe("/v2/fund/outstanding/portfolio-asset-type");
          expect(u.searchParams.get("proj_id")).toBe(FAKE_PROJ_ID);
          return new Response(envelope(items), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const result = await fetchFundPortfolioAssetType(FAKE_PROJ_ID);
      expect(result).toHaveLength(1);
      expect(result[0].assetliab_code).toBe("101");
      expect(result[0].percent_nav).toBe(91.18823);
    });
  });
});
