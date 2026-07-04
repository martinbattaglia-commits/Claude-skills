// Integration test (real in-memory SQLite) for the portfolio/asset-type
// storage + display contract:
//   - ingest is INCREMENTAL: new periods are added, existing periods are never
//     rewritten, nothing is ever deleted (history accumulates; a re-fetch of an
//     already-stored period is a no-op);
//   - the read side shows only the LATEST period and drops the 903 grand-total
//     summary row.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withFreshContext } from "@/tests/db-helpers";
import { getMarketDb } from "../lib/db/context";
import {
  getFundPortfolio,
  getFundPortfolioAssetType,
  normalizePeriod,
  upsertFundPortfolio,
  upsertFundPortfolioAssetType,
} from "../lib/db/queries/fund-enrichment";
import { fundCatalog, fundPortfolio } from "../lib/db/schema";

const withFresh = withFreshContext;

describe("fund portfolio history (incremental ingest + latest-period display)", () => {
  it("adds new periods, preserves and never rewrites existing ones", () => {
    withFresh(() => {
      getMarketDb().insert(fundCatalog).values({ projId: "P1" }).run();

      // First crawl: period 202509 (one holding + a 903 grand-total row).
      upsertFundPortfolio("P1", [
        { projId: "P1", period: "202509", assetliabId: "108", issuer: "iShares", percentNav: 100 },
        {
          projId: "P1",
          period: "202509",
          assetliabId: "903",
          assetliabDesc: "total",
          percentNav: 100,
        },
      ]);

      // Second crawl: the API re-returns 202509 (with a DIFFERENT value, which
      // must be ignored) AND a new period 202512.
      upsertFundPortfolio("P1", [
        { projId: "P1", period: "202509", assetliabId: "108", issuer: "CHANGED", percentNav: 999 },
        { projId: "P1", period: "202512", assetliabId: "108", issuer: "iShares", percentNav: 101 },
        {
          projId: "P1",
          period: "202512",
          assetliabId: "903",
          assetliabDesc: "total",
          percentNav: 100,
        },
      ]);

      // Raw: both periods retained (4 rows), and 202509 keeps its ORIGINAL value.
      const raw = getMarketDb()
        .select()
        .from(fundPortfolio)
        .where(eq(fundPortfolio.projId, "P1"))
        .all();
      expect(raw).toHaveLength(4);
      const old = raw.find((r) => r.period === "202509" && r.assetliabId === "108");
      expect(old?.percentNav).toBe(100); // not overwritten by the 999 re-fetch
      expect(old?.issuer).toBe("iShares");

      // Display: latest period only, 903 dropped → just the one 108 holding.
      const shown = getFundPortfolio("P1");
      expect(shown).toHaveLength(1);
      expect(shown[0].period).toBe("202512");
      expect(shown[0].percentNav).toBe(101);
      expect(shown.some((r) => r.assetliabId === "903")).toBe(false);
    });
  });

  it("dedupes across crawls when the feed sends `period` as a NUMBER (the real wire type)", () => {
    withFresh(() => {
      getMarketDb().insert(fundCatalog).values({ projId: "P3" }).run();

      // The SEC /outstanding feed types `period` as a string but sends a JSON
      // NUMBER at runtime. Binding that to the TEXT column stored "202509.0",
      // and the Set-of-strings guard never matched the incoming number — so
      // every nightly crawl re-inserted the whole portfolio (the 6× bug).
      const numericPeriod = 202509 as unknown as string;
      const crawl = [
        {
          projId: "P3",
          period: numericPeriod,
          assetliabId: "108",
          issuer: "iShares",
          percentNav: 50,
        },
        {
          projId: "P3",
          period: numericPeriod,
          assetliabId: "139",
          issuer: "BlackRock",
          percentNav: 50,
        },
      ];

      // Six nightly crawls of the identical snapshot.
      for (let i = 0; i < 6; i++) upsertFundPortfolio("P3", crawl);

      const raw = getMarketDb()
        .select()
        .from(fundPortfolio)
        .where(eq(fundPortfolio.projId, "P3"))
        .all();
      expect(raw).toHaveLength(2); // not 12 — no duplication
      // Stored clean ("202509"), not the legacy "202509.0" float artifact.
      expect(raw.every((r) => r.period === "202509")).toBe(true);
    });
  });

  it("an empty re-fetch never wipes stored asset-type history", () => {
    withFresh(() => {
      getMarketDb().insert(fundCatalog).values({ projId: "P2" }).run();
      upsertFundPortfolioAssetType("P2", [
        { projId: "P2", period: "202601", assetliabCode: "108", percentNav: 99 },
        { projId: "P2", period: "202601", assetliabCode: "903", percentNav: 100 },
      ]);

      // A flaky/204 day → empty rows → no-op, history intact.
      upsertFundPortfolioAssetType("P2", []);

      const shown = getFundPortfolioAssetType("P2");
      expect(shown).toHaveLength(1); // 903 dropped
      expect(shown[0].period).toBe("202601");
      expect(shown[0].assetliabCode).toBe("108");
    });
  });
});

describe("normalizePeriod", () => {
  it("coerces the feed's numeric period to a clean YYYYMM string", () => {
    expect(normalizePeriod(202509 as unknown as string)).toBe("202509");
  });
  it("strips the legacy float artifact left by number→TEXT coercion", () => {
    expect(normalizePeriod("202509.0")).toBe("202509");
  });
  it("passes a clean string through unchanged", () => {
    expect(normalizePeriod("202509")).toBe("202509");
  });
  it("returns an empty string for nullish input", () => {
    expect(normalizePeriod(null)).toBe("");
    expect(normalizePeriod(undefined)).toBe("");
  });
});
