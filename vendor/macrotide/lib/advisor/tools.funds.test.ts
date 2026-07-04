// Tests for the fee-aware advisor tools: find_funds and find_cheaper_alternatives.
//
// These tools are the consumer side of the fund catalog — they wrap findFunds()
// and getCheaperAlternatives() with AI-SDK tool shapes and product-voice copy.
// Tests verify the tool output shapes, fee-first framing, and edge-case handling.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import { updateFundFacets, upsertFund, upsertFundFees } from "../db/queries/funds";
import * as schema from "../db/schema";
import { createAdvisorTools } from "./tools";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = resolve("lib/db/migrations/app");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  const market = freshMarketDb();
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    marketDb: market.db,
    marketSqlite: market.sqlite,
  };
}

function withFresh<T>(fn: () => T | Promise<T>): Promise<T> {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: true,
      sessionId: "test",
      userId: null,
    },
    fn,
  ) as Promise<T>;
}

// Invoke a tool's execute directly (same pattern as the main tools.test.ts).
type Exec<T> = (args: T, opts?: never) => Promise<unknown>;
function run<T>(tool: { execute?: unknown }, args: T): Promise<unknown> {
  return (tool.execute as Exec<T>)(args);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function seedFund(
  projId: string,
  {
    assetClass = "equity",
    ter,
    abbrName,
    managementStyle,
    taxIncentiveType,
    investRegion,
    regionFocus,
    sectorFocus,
  }: {
    assetClass?: string;
    ter?: number;
    abbrName?: string;
    managementStyle?: string;
    taxIncentiveType?: string;
    investRegion?: string;
    regionFocus?: string;
    sectorFocus?: string;
  } = {},
) {
  upsertFund({
    projId,
    abbrName: abbrName ?? projId,
    englishName: `${projId} Fund`,
    amcName: "Demo AMC",
    assetClass,
    managementStyle: managementStyle ?? null,
    taxIncentiveType: taxIncentiveType ?? null,
    investRegion: investRegion ?? null,
    regionFocus: regionFocus ?? null,
    sectorFocus: sectorFocus ?? null,
    isFixedTerm: false,
    status: "active",
  });
  if (ter != null) {
    upsertFundFees([
      {
        projId,
        fundClassName: "A",
        feeType: "total_expense",
        feeTypeRaw: "Total Fee and Expense",
        actualRatePct: ter,
        rateCeilingPct: ter + 0.5,
        periodStart: "2026-01-01",
        periodEnd: null,
      },
    ]);
  }
}

// ─── find_funds ───────────────────────────────────────────────────────────────

describe("advisor tools — find_funds", () => {
  it("returns funds sorted cheapest-first with TER in output", async () => {
    const result = (await withFresh(async () => {
      seedFund("CHEAP", { ter: 0.3 });
      seedFund("PRICEY", { ter: 1.5 });
      seedFund("MID", { ter: 0.8 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { assetClass: "equity" });
    })) as {
      ok: boolean;
      count: number;
      funds: { abbr: string; terPct: number | null }[];
      cheapestAbbr: string;
      message: string;
    };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    // cheapest-first ordering
    expect(result.funds[0].abbr).toBe("CHEAP");
    expect(result.funds[1].abbr).toBe("MID");
    expect(result.funds[2].abbr).toBe("PRICEY");
    // TER values present
    expect(result.funds[0].terPct).toBe(0.3);
    // cheapestAbbr convenience field
    expect(result.cheapestAbbr).toBe("CHEAP");
  });

  it("puts no-TER funds last in the ranked list", async () => {
    const result = (await withFresh(async () => {
      seedFund("WITHFEE", { ter: 0.9 });
      seedFund("NOFEE"); // no TER data
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { assetClass: "equity" });
    })) as { funds: { abbr: string; terPct: number | null }[] };

    expect(result.funds[0].abbr).toBe("WITHFEE");
    expect(result.funds[1].abbr).toBe("NOFEE");
    expect(result.funds[1].terPct).toBeNull();
  });

  it("filters by assetClass correctly", async () => {
    const result = (await withFresh(async () => {
      seedFund("EQ1", { assetClass: "equity", ter: 0.5 });
      seedFund("BD1", { assetClass: "bond", ter: 0.3 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { assetClass: "bond" });
    })) as { count: number; funds: { abbr: string }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("BD1");
  });

  it("returns empty result gracefully with helpful message", async () => {
    const result = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { assetClass: "cash" });
    })) as { ok: boolean; count: number; funds: unknown[]; message: string };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.funds).toHaveLength(0);
    expect(result.message).toMatch(/no funds found/i);
  });

  it("supports free-text query search against fund name", async () => {
    const result = (await withFresh(async () => {
      upsertFund({
        projId: "SPFUND",
        abbrName: "SCBSP500",
        englishName: "SCB S&P 500 Index Fund",
        assetClass: "equity",
        fundType: "Foreign Investment Fund",
        status: "active",
      });
      upsertFundFees([
        {
          projId: "SPFUND",
          fundClassName: "A",
          feeType: "total_expense",
          feeTypeRaw: "Total Fee and Expense",
          actualRatePct: 0.5,
          rateCeilingPct: 0.6,
          periodStart: "2026-01-01",
          periodEnd: null,
        },
      ]);
      upsertFund({
        projId: "BONDFUND",
        abbrName: "K-FIXED",
        englishName: "Kasikorn Fixed Income",
        assetClass: "bond",
        fundType: "Fixed Income Fund",
        status: "active",
      });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { query: "S&P 500" });
    })) as { count: number; funds: { abbr: string }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("SCBSP500");
  });

  it("output includes abbr, englishName, amc, terLabel fields", async () => {
    const result = (await withFresh(async () => {
      upsertFund({
        projId: "F99",
        abbrName: "TESTFUND",
        englishName: "Test Index Fund",
        amcName: "Test AMC",
        assetClass: "equity",
        status: "active",
      });
      upsertFundFees([
        {
          projId: "F99",
          fundClassName: "A",
          feeType: "total_expense",
          feeTypeRaw: "Total Fee and Expense",
          actualRatePct: 0.45,
          rateCeilingPct: 0.6,
          periodStart: "2026-01-01",
          periodEnd: null,
        },
      ]);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, {});
    })) as {
      funds: {
        abbr: string;
        englishName: string | null;
        amc: string | null;
        terLabel: string;
      }[];
    };

    expect(result.funds).toHaveLength(1);
    const f = result.funds[0];
    expect(f.abbr).toBe("TESTFUND");
    expect(f.englishName).toBe("Test Index Fund");
    expect(f.amc).toBe("Test AMC");
    expect(f.terLabel).toBe("0.45% p.a.");
  });

  it("output includes enrichment fields: isIndex, taxIncentiveType, isFeederFund, feederMasterFund", async () => {
    const result = (await withFresh(async () => {
      upsertFund({
        projId: "ENRICHED",
        abbrName: "IDX-SSF",
        englishName: "Index SSF Feeder Fund",
        amcName: "Demo AMC",
        assetClass: "equity",
        managementStyle: "PN",
        taxIncentiveType: "SSF",
        investRegion: "foreign",
        isFeederFund: true,
        feederMasterFund: "Vanguard Total World",
        distributionPolicy: "accumulating",
        isFixedTerm: false,
        status: "active",
      });
      upsertFundFees([
        {
          projId: "ENRICHED",
          fundClassName: "A",
          feeType: "total_expense",
          feeTypeRaw: "Total Fee and Expense",
          actualRatePct: 0.5,
          rateCeilingPct: 0.6,
          periodStart: "2026-01-01",
          periodEnd: null,
        },
      ]);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, {});
    })) as {
      funds: {
        isIndex: boolean;
        managementStyle: string | null;
        taxIncentiveType: string | null;
        investRegion: string | null;
        isFeederFund: boolean;
        feederMasterFund: string | null;
        distributionPolicy: string | null;
      }[];
    };

    expect(result.funds).toHaveLength(1);
    const f = result.funds[0];
    expect(f.isIndex).toBe(true);
    expect(f.managementStyle).toBe("PN");
    expect(f.taxIncentiveType).toBe("SSF");
    expect(f.investRegion).toBe("foreign");
    expect(f.isFeederFund).toBe(true);
    expect(f.feederMasterFund).toBe("Vanguard Total World");
  });

  it("trackingIndex filters to index-style funds of that family, cheapest first", async () => {
    const result = (await withFresh(async () => {
      // Real tracker, cheapest — own name never mentions the index (feeder case).
      seedFund("TRACKER", { ter: 0.3, managementStyle: "PN" });
      // Pricier tracker of the same family.
      seedFund("TRACKER2", { ter: 0.7, managementStyle: "PN" });
      // Active fund merely BENCHMARKED against the family — must be excluded.
      seedFund("ACTIVEBM", { ter: 1.8, managementStyle: "OT" });
      // Tracker of a DIFFERENT family — must be excluded.
      seedFund("OTHERIDX", { ter: 0.2, managementStyle: "PN" });
      const facets = {
        regionFocus: null,
        regionFocusSource: null,
        sectorFocus: null,
        aimcCategory: null,
      };
      updateFundFacets([
        { projId: "TRACKER", ...facets, indexFamily: "S&P 500" },
        { projId: "TRACKER2", ...facets, indexFamily: "S&P 500" },
        { projId: "ACTIVEBM", ...facets, indexFamily: "S&P 500" },
        { projId: "OTHERIDX", ...facets, indexFamily: "SET50" },
      ]);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { trackingIndex: "S&P 500" });
    })) as { count: number; funds: { abbr: string }[]; cheapestAbbr: string; message: string };

    expect(result.count).toBe(2);
    expect(result.funds.map((f) => f.abbr)).toEqual(["TRACKER", "TRACKER2"]);
    expect(result.cheapestAbbr).toBe("TRACKER");
    expect(result.message).toContain("sorted cheapest first");
  });

  it("names the true lowest-TER fund even when a query ranks by relevance", async () => {
    const result = (await withFresh(async () => {
      // Strong name match but pricey — relevance puts it first.
      seedFund("EXACTMATCH", { ter: 1.2, abbrName: "GOLDX" });
      // Weaker match but cheapest — must still be the named cheapest.
      upsertFund({
        projId: "CHEAPGOLD",
        abbrName: "CHEAPFUND",
        englishName: "Cheap Gold Bullion Tracker",
        assetClass: "alternative",
        status: "active",
      });
      upsertFundFees([
        {
          projId: "CHEAPGOLD",
          fundClassName: "A",
          feeType: "total_expense",
          feeTypeRaw: "Total Fee and Expense",
          actualRatePct: 0.4,
          rateCeilingPct: 0.9,
          periodStart: "2026-01-01",
          periodEnd: null,
        },
      ]);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { query: "GOLDX" });
    })) as { funds: { abbr: string }[]; cheapestAbbr: string; message: string };

    // Relevance order is preserved…
    expect(result.funds[0].abbr).toBe("GOLDX");
    // …but the cheapest label points at the true lowest TER in the result set.
    if (result.funds.length > 1) {
      expect(result.cheapestAbbr).toBe("CHEAPFUND");
    }
    expect(result.message).toContain("relevance");
  });

  it("indexOnly param restricts results to PN/PM management style", async () => {
    const result = (await withFresh(async () => {
      seedFund("ACTIVE_FUND", { managementStyle: "AM", ter: 0.5 });
      seedFund("INDEX_FUND", { managementStyle: "PN", ter: 0.3 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { indexOnly: true });
    })) as { count: number; funds: { abbr: string; isIndex: boolean }[]; message: string };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("INDEX_FUND");
    expect(result.funds[0].isIndex).toBe(true);
    // message notes the index count
    expect(result.message).toMatch(/index/i);
  });

  it("taxIncentive param filters by wrapper and message notes it", async () => {
    const result = (await withFresh(async () => {
      seedFund("SSF_FUND", { taxIncentiveType: "SSF", ter: 0.5 });
      seedFund("RMF_FUND", { taxIncentiveType: "RMF", ter: 0.4 });
      seedFund("PLAIN_FUND", { ter: 0.3 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { taxIncentive: "SSF" });
    })) as { count: number; funds: { abbr: string; taxIncentiveType: string | null }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("SSF_FUND");
    expect(result.funds[0].taxIncentiveType).toBe("SSF");
  });

  it("region param filters by geographic mandate", async () => {
    const result = (await withFresh(async () => {
      seedFund("FOREIGN_FUND", { investRegion: "foreign", ter: 0.5 });
      seedFund("DOMESTIC_FUND", { investRegion: "domestic", ter: 0.4 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { region: "foreign" });
    })) as { count: number; funds: { abbr: string; investRegion: string | null }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("FOREIGN_FUND");
    expect(result.funds[0].investRegion).toBe("foreign");
  });

  it("regionFocus filters to a specific geography (finer than region)", async () => {
    const result = (await withFresh(async () => {
      seedFund("US_FUND", { regionFocus: "us", ter: 0.5 });
      seedFund("CHINA_FUND", { regionFocus: "china", ter: 0.4 });
      const tools = createAdvisorTools({ userId: null });
      // The model passes what the user said; the tool lower-cases it.
      return run(tools.find_funds, { regionFocus: "US" });
    })) as { count: number; funds: { abbr: string }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("US_FUND");
  });

  it("sectorFocus filters to a specific theme", async () => {
    const result = (await withFresh(async () => {
      seedFund("GOLD_FUND", { assetClass: "alternative", sectorFocus: "gold", ter: 0.6 });
      seedFund("TECH_FUND", { sectorFocus: "technology", ter: 0.7 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_funds, { sectorFocus: "gold" });
    })) as { count: number; funds: { abbr: string }[] };

    expect(result.count).toBe(1);
    expect(result.funds[0].abbr).toBe("GOLD_FUND");
  });
});

// ─── find_cheaper_alternatives ───────────────────────────────────────────────

describe("advisor tools — find_cheaper_alternatives", () => {
  it("returns cheaper peers with correct TER values sorted cheapest-first", async () => {
    const result = (await withFresh(async () => {
      seedFund("HELD", { assetClass: "equity", ter: 0.9 });
      seedFund("CHEAPER", { assetClass: "equity", ter: 0.5 });
      seedFund("CHEAPEST", { assetClass: "equity", ter: 0.25 });
      seedFund("DEARER", { assetClass: "equity", ter: 1.2 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_cheaper_alternatives, { projId: "HELD" });
    })) as {
      ok: boolean;
      count: number;
      alternatives: {
        abbr: string;
        terPct: number | null;
        isIndex: boolean;
        taxIncentiveType: string | null;
        investRegion: string | null;
        isFeederFund: boolean;
      }[];
      referenceAbbr: string;
      cheapestAlternativeAbbr: string;
      message: string;
    };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    // Cheapest-first
    expect(result.alternatives[0].abbr).toBe("CHEAPEST");
    expect(result.alternatives[1].abbr).toBe("CHEAPER");
    // DEARER excluded
    expect(result.alternatives.map((a) => a.abbr)).not.toContain("DEARER");
    expect(result.cheapestAlternativeAbbr).toBe("CHEAPEST");
    // Message mentions the fee opportunity
    expect(result.message).toMatch(/cheaper/i);
  });

  it("resolves fundAbbr to projId via getFundsByAbbr", async () => {
    const result = (await withFresh(async () => {
      seedFund("HELD_ID", { assetClass: "equity", ter: 0.8, abbrName: "MY-FUND" });
      seedFund("ALT_ID", { assetClass: "equity", ter: 0.3 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_cheaper_alternatives, { fundAbbr: "MY-FUND" });
    })) as { ok: boolean; count: number; referenceAbbr: string };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.referenceAbbr).toBe("MY-FUND");
  });

  it("returns empty result when abbr not found in catalog", async () => {
    const result = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_cheaper_alternatives, { fundAbbr: "NONEXISTENT" });
    })) as { ok: boolean; count: number; message: string };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.message).toMatch(/could not find/i);
  });

  it("returns empty result when held fund is already the cheapest", async () => {
    const result = (await withFresh(async () => {
      seedFund("CHEAPEST_HELD", { assetClass: "equity", ter: 0.1 });
      seedFund("DEARER_OTHER", { assetClass: "equity", ter: 0.9 });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_cheaper_alternatives, { projId: "CHEAPEST_HELD" });
    })) as { ok: boolean; count: number; message: string };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.message).toMatch(/cheaper alternatives/i);
  });

  it("returns error shape when neither fundAbbr nor projId is provided", async () => {
    const result = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_cheaper_alternatives, {});
    })) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/fundAbbr or projId/i);
  });
});
