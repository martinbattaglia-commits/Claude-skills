// Tests for the catalog TRANSFORM (the API-free half of the ELT crawl).
//
// Two layers:
//   1. Pure mapper tests — profileToFundInsert / feeItemToFeeRow turn a raw SEC
//      item into an insert shape. This is where SEC fields become catalog columns
//      (asset class, fee-type normalization, tax/region/feeder), so the
//      classification matrix is asserted here, DB-free.
//   2. Round-trip tests — land raw payloads in sec_raw, run transformFundCatalog,
//      and assert the derived fund_catalog / fund_fees rows (incl. the current_ter
//      cache and the AUM merge). This proves land → transform end to end.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";
import { getMarketDb, runWithDbContext } from "../db/context";
import { getFundBenchmarks, getFundStatistics } from "../db/queries/fund-enrichment";
import { getCurrentTer } from "../db/queries/funds";
import { makeSecRaw, SEC_ENDPOINTS, type SecRawInsert, upsertSecRaw } from "../db/queries/sec-raw";
import { fundCatalog } from "../db/schema";
import type { SecFundFeeItem } from "../market/fund-fees";
import type { SecFundProfile } from "../market/providers/sec-thailand";
import {
  type AumSnapshot,
  benchmarkItemToRow,
  dividendHistoryItemToRow,
  dividendPolicyItemToRow,
  factsheetUrlItemToRow,
  feeItemToFeeRow,
  minimumItemToRow,
  profileToFundInsert,
  specificationItemToRow,
  statisticsItemToRow,
  transformFundCatalog,
} from "./transform-fund-catalog";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeProfile = (overrides: Partial<SecFundProfile> = {}): SecFundProfile => ({
  proj_id: "1234",
  proj_abbr_name: "TEST-FUND",
  proj_name_th: "กองทุนทดสอบ",
  proj_name_en: "Test Fund",
  amc_name: "Test AMC",
  fund_status: "Registered",
  policy_desc: "ตราสารทุน", // equity
  management_style: "AM",
  fund_class_tax_incentive_type: null,
  fund_class_detail: "สะสมมูลค่า", // accumulating
  invest_country_flag: "4", // domestic
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

/** Land raw rows and run the transform inside a fresh in-memory market.db. */
function transformWith(rows: SecRawInsert[], assert: () => void) {
  return runWithDbContext(makeTestDbContext(), () => {
    upsertSecRaw(rows);
    transformFundCatalog();
    assert();
  });
}

// ─── Pure mapper: profileToFundInsert ───────────────────────────────────────

describe("profileToFundInsert", () => {
  it("maps the core catalog columns from a profile", () => {
    const insert = profileToFundInsert(makeProfile(), {
      aum: 1_500_000_000,
      aumDate: "2026-05-23",
    });
    expect(insert).toMatchObject({
      projId: "1234",
      abbrName: "TEST-FUND",
      thaiName: "กองทุนทดสอบ",
      englishName: "Test Fund",
      amcName: "Test AMC",
      policyDescTh: "ตราสารทุน",
      assetClass: "equity",
      secStatus: "Registered",
      status: "active",
      managementStyle: "AM",
      distributionPolicy: "accumulating",
      investRegion: "domestic",
      isFeederFund: false,
      feederMasterFund: null,
      isFixedTerm: false,
      initDate: "2010-01-15",
      isinCode: "TH1234567890",
      aum: 1_500_000_000,
      aumDate: "2026-05-23",
    });
  });

  it("infers asset class from policy_desc, money market from the name", () => {
    const cases: Array<[string | null, string, string | null]> = [
      ["ตราสารทุน", "กองทุนทดสอบ", "equity"],
      ["ตราสารหนี้", "กองทุนทดสอบ", "bond"],
      ["ตราสารหนี้", "กองทุนเปิดเค ตลาดเงิน", "cash"], // money market → cash, from name
      ["ทรัพย์สินทางเลือก", "กองทุนทดสอบ", "alternative"],
      ["ผสม", "กองทุนทดสอบ", null], // mixed stays null
      [null, "กองทุนทดสอบ", null],
    ];
    for (const [policyDesc, nameTh, expected] of cases) {
      const insert = profileToFundInsert(
        makeProfile({ policy_desc: policyDesc, proj_name_th: nameTh }),
      );
      expect(insert.assetClass).toBe(expected);
    }
  });

  it("maps tax incentive and feeder fields", () => {
    const ssf = profileToFundInsert(
      makeProfile({
        fund_class_tax_incentive_type: "กองทุนรวมเพื่อการออม",
        feederfund_master_fund: "MASTER-GLOBAL",
      }),
    );
    expect(ssf.taxIncentiveType).toBe("SSF");
    expect(ssf.isFeederFund).toBe(true);
    expect(ssf.feederMasterFund).toBe("MASTER-GLOBAL");

    const rmf = profileToFundInsert(
      makeProfile({ fund_class_tax_incentive_type: "กองทุนรวมเพื่อการเลี้ยงชีพ" }),
    );
    expect(rmf.taxIncentiveType).toBe("RMF");
    expect(rmf.isFeederFund).toBe(false);
  });

  it("derives status from secStatus (IPO active, Liquidated inactive)", () => {
    expect(profileToFundInsert(makeProfile({ fund_status: "IPO" })).status).toBe("active");
    expect(profileToFundInsert(makeProfile({ fund_status: "Liquidated" })).status).toBe("inactive");
  });

  it("uses the risk-spectrum code for asset class, overriding policy_desc", () => {
    // policy says bond, RS1 says money market → cash wins.
    const cash = profileToFundInsert(makeProfile({ policy_desc: "ตราสารหนี้" }), null, "RS1");
    expect(cash.assetClass).toBe("cash");
    // policy says nothing, RS6 → equity recovered.
    const equity = profileToFundInsert(makeProfile({ policy_desc: null }), null, "RS6");
    expect(equity.assetClass).toBe("equity");
  });

  it("persists the raw risk-spectrum code (kept after classification)", () => {
    // The code survives even when it doesn't drive the asset class (RS5 → policy
    // wins) and even when it's an off-ladder variant (RS81) the classifier drops.
    expect(profileToFundInsert(makeProfile(), null, "RS6").riskSpectrum).toBe("RS6");
    expect(
      profileToFundInsert(makeProfile({ policy_desc: "ตราสารหนี้" }), null, "RS5").riskSpectrum,
    ).toBe("RS5");
    expect(profileToFundInsert(makeProfile(), null, "RS81").riskSpectrum).toBe("RS81");
    // No code published → null, not undefined (an explicit "not published").
    expect(profileToFundInsert(makeProfile(), null, undefined).riskSpectrum).toBeNull();
  });

  it("falls back to policy when the RS code is ambiguous (RS5) or absent", () => {
    // RS5 mixes balanced + high-yield-bond funds, so policy disambiguates.
    expect(
      profileToFundInsert(makeProfile({ policy_desc: "ตราสารหนี้" }), null, "RS5").assetClass,
    ).toBe("bond");
    // No RS code → the money-market name match still works as the fallback.
    expect(
      profileToFundInsert(
        makeProfile({ policy_desc: "ตราสารหนี้", proj_name_th: "กองทุนเปิดเค ตลาดเงิน" }),
        null,
        undefined,
      ).assetClass,
    ).toBe("cash");
  });

  it("leaves AUM fields undefined when no snapshot is given (no clobber)", () => {
    const insert = profileToFundInsert(makeProfile(), null);
    expect(insert.aum).toBeUndefined();
    expect(insert.aumDate).toBeUndefined();
  });

  it("maps null optional fields gracefully", () => {
    const insert = profileToFundInsert(
      makeProfile({
        proj_name_th: null,
        proj_name_en: null,
        amc_name: null,
        policy_desc: null,
        management_style: null,
        fund_class_detail: null,
        invest_country_flag: null,
        init_date: null,
        fund_class_isin_code: null,
      }),
    );
    expect(insert).toMatchObject({
      thaiName: null,
      englishName: null,
      amcName: null,
      policyDescTh: null,
      assetClass: null,
      managementStyle: null,
      taxIncentiveType: null,
      distributionPolicy: null,
      investRegion: null,
      initDate: null,
      isinCode: null,
    });
  });

  it("maps the enrichment fields: FX policy, stripped policy text, dates, feeder country", () => {
    const insert = profileToFundInsert(
      makeProfile({
        exchange_rate_protection_policy: "ทั้งหมด (fully hedged) (95%-105% ของมูลค่าความเสี่ยง)",
        investment_policy_desc: "<p>ลงทุนใน&nbsp;ETF ต่างประเทศ</p>\n<p>ไม่น้อยกว่า 80%</p>",
        feederfund_master_fund: "EXAMPLE MASTER UCITS",
        feederfund_country: "ลักเซมเบิร์ก",
        regis_date: "2019-01-16",
        cancel_date: null,
      }),
    );
    expect(insert).toMatchObject({
      fxHedgingPolicy: "full",
      investmentPolicyDesc: "ลงทุนใน ETF ต่างประเทศ ไม่น้อยกว่า 80%",
      feederFundCountry: "ลักเซมเบิร์ก",
      regisDate: "2019-01-16",
      cancelDate: null,
    });
  });

  it("prefers the formal dividend-policy code over the class-detail text", () => {
    // Code says dividend, text says accumulating — the formal code wins.
    const coded = profileToFundInsert(
      makeProfile({ fund_class_detail: "สะสมมูลค่า" }),
      null,
      null,
      "Y",
    );
    expect(coded.distributionPolicy).toBe("dividend");
    // No code → text parsing stays the fallback.
    const fallback = profileToFundInsert(makeProfile({ fund_class_detail: "สะสมมูลค่า" }));
    expect(fallback.distributionPolicy).toBe("accumulating");
  });

  it("maps term components only for fixed-term funds (0s elsewhere stay null)", () => {
    const fixed = profileToFundInsert(
      makeProfile({ proj_term_flag: "Y", proj_term_year: 0, proj_term_month: 6, proj_term_day: 0 }),
    );
    expect(fixed).toMatchObject({ isFixedTerm: true, termYears: 0, termMonths: 6, termDays: 0 });

    const openEnded = profileToFundInsert(
      makeProfile({ proj_term_flag: "N", proj_term_year: 0, proj_term_month: 0, proj_term_day: 0 }),
    );
    expect(openEnded).toMatchObject({
      isFixedTerm: false,
      termYears: null,
      termMonths: null,
      termDays: null,
    });
  });
});

// ─── Pure mapper: feeItemToFeeRow ───────────────────────────────────────────

describe("feeItemToFeeRow", () => {
  it("maps a fee item and keeps the raw type label", () => {
    expect(feeItemToFeeRow(makeFeeItem())).toMatchObject({
      projId: "1234",
      fundClassName: "main",
      feeType: "total_expense",
      feeTypeRaw: "Total Fee and Expense",
      rateCeilingPct: 1.5,
      actualRatePct: 1.2,
      periodStart: "2024-01-01",
      periodEnd: null,
      prospectusType: "Main",
      lastUpdDate: "2024-06-01",
    });
  });

  it("normalizes the SEC fee-type labels", () => {
    const labels: Array<[string, string]> = [
      ["Front-end Fee", "front_end"],
      ["Back-end Fee", "back_end"],
      ["Management Fee", "management"],
      ["ค่าธรรมเนียมและค่าใช้จ่ายรวมทั้งหมด (Total Fee and Expense)", "total_expense"],
      ["Some Unknown Fee Type", "other"],
    ];
    for (const [raw, expected] of labels) {
      expect(feeItemToFeeRow(makeFeeItem({ fee_type_desc: raw })).feeType).toBe(expected);
    }
  });
});

// ─── Round-trip: land raw → transform → derived rows ────────────────────────

describe("benchmarkItemToRow", () => {
  it("maps a benchmark item, defaulting group_seq to 1 and trimming text", () => {
    expect(
      benchmarkItemToRow({
        proj_id: "B1",
        benchmark: "  ดัชนี SET TRI ",
        benchmark_remark: "",
        start_date: "2026-01-31",
      }),
    ).toMatchObject({
      projId: "B1",
      groupSeq: 1,
      benchmark: "ดัชนี SET TRI",
      benchmarkRemark: null,
      startDate: "2026-01-31",
    });
    // group_seq arrives as number OR string depending on the payload.
    expect(benchmarkItemToRow({ proj_id: "B1", group_seq: "2", benchmark: "X" })?.groupSeq).toBe(2);
  });

  it("returns null when the item names no benchmark", () => {
    expect(benchmarkItemToRow({ proj_id: "B1", benchmark: "  " })).toBeNull();
    expect(benchmarkItemToRow({ proj_id: "", benchmark: "X" })).toBeNull();
  });
});

describe("statisticsItemToRow", () => {
  it("parses the string figures, keeping unparseable values null", () => {
    expect(
      statisticsItemToRow({
        proj_id: "S1",
        fund_class_name: "A",
        portfolio_turnover_ratio: "24.63",
        maximum_drawdown: "-0.02",
        sharpe_ratio: "1.1",
        beta: "0.95",
        alpha: "0",
        fx_hedging: "92.5",
        tracking_error: "0.31",
        yield_to_maturity: "2.45",
        recovering_period: "1 เดือน",
        portfolio_duration_period: "1 เดือน 13 วัน",
      }),
    ).toMatchObject({
      projId: "S1",
      fundClassName: "A",
      portfolioTurnoverRatio: 24.63,
      maximumDrawdown: -0.02,
      sharpeRatio: 1.1,
      beta: 0.95,
      alpha: 0,
      fxHedgingRatio: 92.5,
      trackingError: 0.31,
      yieldToMaturity: "2.45",
      recoveringPeriod: "1 เดือน",
    });
    expect(
      statisticsItemToRow({ proj_id: "S1", sharpe_ratio: "N/A", fund_class_name: null }),
    ).toMatchObject({ sharpeRatio: null, fundClassName: "main" });
  });
});

describe("P1/P2 sweep mappers", () => {
  it("specificationItemToRow keeps the code, drops codeless items", () => {
    expect(
      specificationItemToRow({ proj_id: "X", fund_class_name: "A", spec_code: "CIV" }),
    ).toMatchObject({ projId: "X", fundClassName: "A", specCode: "CIV" });
    expect(specificationItemToRow({ proj_id: "X", spec_code: " " })).toBeNull();
  });

  it("factsheetUrlItemToRow needs at least one URL", () => {
    expect(
      factsheetUrlItemToRow({ proj_id: "X", pdf_factsheet: "https://sec.example/f.pdf" }),
    ).toMatchObject({
      projId: "X",
      fundClassName: "main",
      pdfFactsheet: "https://sec.example/f.pdf",
    });
    expect(factsheetUrlItemToRow({ proj_id: "X", amc_url_factsheet: "" })).toBeNull();
  });

  it("minimumItemToRow parses amounts and keeps currency/unit labels", () => {
    expect(
      minimumItemToRow({
        proj_id: "X",
        fund_class_name: "A",
        minimum_sub_ipo: "5000",
        minimum_sub: "100.50",
        minimum_sub_cur: "THB",
        minimum_redempt_unit: "หน่วย",
      }),
    ).toMatchObject({
      minimumSubIpo: 5000,
      minimumSub: 100.5,
      minimumSubCur: "THB",
      minimumRedempt: null,
      minimumRedemptUnit: "หน่วย",
    });
  });

  it("dividendHistoryItemToRow needs a book-close date and parses the per-unit value", () => {
    expect(
      dividendHistoryItemToRow({
        proj_id: "X",
        class_abbr_name: "EXAMPLE-D",
        book_close_date: "2026-03-15",
        dividend_date: "2026-03-30",
        dividend_value: "0.25",
      }),
    ).toMatchObject({
      projId: "X",
      classAbbrName: "EXAMPLE-D",
      bookCloseDate: "2026-03-15",
      dividendValue: 0.25,
    });
    expect(dividendHistoryItemToRow({ proj_id: "X", dividend_value: "0.25" })).toBeNull();
  });

  it("dividendPolicyItemToRow keeps the verbatim code", () => {
    expect(
      dividendPolicyItemToRow({ proj_id: "X", fund_class_name: "D", dividend_policy: "Y" }),
    ).toMatchObject({ projId: "X", fundClassName: "D", dividendPolicy: "Y" });
  });
});

describe("transformFundCatalog", () => {
  it("derives a catalog row + fee rows + current_ter from landed raw", () =>
    transformWith(
      [
        makeSecRaw(SEC_ENDPOINTS.profiles, "1234", "", makeProfile()),
        makeSecRaw(SEC_ENDPOINTS.fees, "1234", "", [makeFeeItem()]),
        makeSecRaw(SEC_ENDPOINTS.aum, "1234", "", {
          aum: 1_500_000_000,
          aumDate: "2026-05-23",
        } satisfies AumSnapshot),
      ],
      () => {
        const fund = getMarketDb()
          .select()
          .from(fundCatalog)
          .where(eq(fundCatalog.projId, "1234"))
          .get();
        expect(fund).toMatchObject({
          projId: "1234",
          abbrName: "TEST-FUND",
          assetClass: "equity",
          aum: 1_500_000_000,
          aumDate: "2026-05-23",
          // current_ter cache picks the actual TER rate (1.2), not the ceiling.
          currentTer: 1.2,
        });
        expect(getCurrentTer("1234")).toBe(1.2);
      },
    ));

  it("returns counts and upserts every landed fund", () =>
    transformWith(
      [
        makeSecRaw(SEC_ENDPOINTS.profiles, "R1", "", makeProfile({ proj_id: "R1" })),
        makeSecRaw(SEC_ENDPOINTS.profiles, "R2", "", makeProfile({ proj_id: "R2" })),
        makeSecRaw(SEC_ENDPOINTS.fees, "R1", "", [makeFeeItem({ proj_id: "R1" })]),
      ],
      () => {
        const result = transformFundCatalog(); // idempotent re-run returns the counts
        expect(result.fundsUpserted).toBe(2);
        expect(result.fundsWithFees).toBe(1);
        expect(result.feeRowsUpserted).toBe(1);
      },
    ));

  it("derives benchmark + statistics tables from landed sweeps (blend rows kept)", () =>
    transformWith(
      [
        makeSecRaw(SEC_ENDPOINTS.profiles, "BM1", "", makeProfile({ proj_id: "BM1" })),
        makeSecRaw(SEC_ENDPOINTS.benchmarks, "BM1", "1", {
          proj_id: "BM1",
          group_seq: 1,
          benchmark: "ดัชนี SET TRI (50%)",
        }),
        makeSecRaw(SEC_ENDPOINTS.benchmarks, "BM1", "2", {
          proj_id: "BM1",
          group_seq: 2,
          benchmark: "S&P 500 Total Return (50%)",
        }),
        makeSecRaw(SEC_ENDPOINTS.statistics, "BM1", "A", {
          proj_id: "BM1",
          fund_class_name: "A",
          tracking_error: "0.4",
          fx_hedging: "95",
        }),
      ],
      () => {
        const result = transformFundCatalog();
        expect(result.fundsWithBenchmarks).toBe(1);
        expect(result.fundsWithStatistics).toBe(1);
        expect(getFundBenchmarks("BM1").map((b) => b.benchmark)).toEqual([
          "ดัชนี SET TRI (50%)",
          "S&P 500 Total Return (50%)",
        ]);
        expect(getFundStatistics("BM1")[0]).toMatchObject({
          fundClassName: "A",
          trackingError: 0.4,
          fxHedgingRatio: 95,
        });
      },
    ));

  it("is idempotent — a second transform yields the same single catalog row", () =>
    transformWith([makeSecRaw(SEC_ENDPOINTS.profiles, "1234", "", makeProfile())], () => {
      transformFundCatalog();
      const rows = getMarketDb().select().from(fundCatalog).all();
      expect(rows).toHaveLength(1);
    }));

  it("classifies asset class from landed risk-spectrum, policy as fallback", () =>
    transformWith(
      [
        // RS1 fund whose policy says bond → cash (RS overrides).
        makeSecRaw(
          SEC_ENDPOINTS.profiles,
          "MM",
          "",
          makeProfile({ proj_id: "MM", policy_desc: "ตราสารหนี้" }),
        ),
        makeSecRaw(SEC_ENDPOINTS.riskSpectrum, "MM", "", { proj_id: "MM", risk_spectrum: "RS1" }),
        // No RS landed for this fund → policy fallback (equity).
        makeSecRaw(
          SEC_ENDPOINTS.profiles,
          "EQ",
          "",
          makeProfile({ proj_id: "EQ", policy_desc: "ตราสารทุน" }),
        ),
      ],
      () => {
        const db = getMarketDb();
        const mm = db.select().from(fundCatalog).where(eq(fundCatalog.projId, "MM")).get();
        const eqf = db.select().from(fundCatalog).where(eq(fundCatalog.projId, "EQ")).get();
        expect(mm?.assetClass).toBe("cash");
        expect(eqf?.assetClass).toBe("equity");
      },
    ));

  it("merges AUM only when landed (inactive fund keeps null)", () =>
    transformWith(
      [
        makeSecRaw(
          SEC_ENDPOINTS.profiles,
          "L1",
          "",
          makeProfile({ proj_id: "L1", fund_status: "Liquidated" }),
        ),
      ],
      () => {
        const fund = getMarketDb().select().from(fundCatalog).all()[0];
        expect(fund.status).toBe("inactive");
        expect(fund.aum).toBeNull();
      },
    ));
});
