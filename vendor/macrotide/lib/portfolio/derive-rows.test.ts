import { describe, expect, it } from "vitest";
import { makeTestDbContext } from "@/tests/db-helpers";
import { getMarketDb, runWithDbContext } from "../db/context";
import { upsertFund } from "../db/queries/funds";
import { upsertFundQuote } from "../db/queries/quotes";
import { upsertShareClasses } from "../db/queries/share-classes";
import { navHistory } from "../db/schema";
import { deriveRowsWithNav, quoteCacheKey } from "./derive-rows";
import type { DerivedRow, ExtractedRow } from "./ocr";

function withDb<T>(fn: () => T): T {
  return runWithDbContext(makeTestDbContext(), fn) as T;
}

// Make a ticker a real catalog fund so the DB-backed source check confirms it as
// thai_mutual_fund (a priced production fund is always in the catalog).
function seedCatalogFund(ticker: string): void {
  upsertFund({
    projId: ticker,
    abbrName: ticker,
    englishName: ticker,
    assetClass: "equity",
    fundType: "Equity",
    status: "active",
  });
  upsertShareClasses([{ projId: ticker, className: "main", ticker, investorType: "retail" }]);
}

// A priced fund is always a catalog fund, so its source — and thus its NAV cache key
// — is thai_mutual_fund. Seed both together so the lookup key matches.
function seedNav(ticker: string, nav: number): void {
  seedCatalogFund(ticker);
  upsertFundQuote({
    ticker: quoteCacheKey("thai_mutual_fund", ticker),
    nav,
    updatedAt: new Date().toISOString(),
  });
}

function seedNavHistory(ticker: string, rows: [string, number][]): void {
  const db = getMarketDb();
  const key = quoteCacheKey("thai_mutual_fund", ticker);
  for (const [date, nav] of rows) db.insert(navHistory).values({ ticker: key, date, nav }).run();
}

describe("quoteCacheKey", () => {
  it("builds the composite source:TICKER key fund_quotes is keyed by", () => {
    expect(quoteCacheKey("thai_mutual_fund", "k-usa-a")).toBe("thai_mutual_fund:K-USA-A");
    expect(quoteCacheKey("market", " voo ")).toBe("market:VOO");
  });
});

describe("deriveRowsWithNav", () => {
  it("returns [] for no rows without touching the DB", () => {
    // No DB context needed — must short-circuit before any query.
    expect(deriveRowsWithNav([])).toEqual([]);
  });

  it("derives units from market NAV and carries the invested total when only value is shown", () => {
    const rows = withDb(() => {
      seedNav("K-USA-A", 20); // catalog fund + NAV 20 → 1000 ÷ 20 = 50 units
      const extracted: ExtractedRow[] = [{ ticker: "K-USA-A", value: 1000, pl: 100 }];
      return deriveRowsWithNav(extracted) as DerivedRow[];
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.units).toBeCloseTo(50);
    expect(r.estimated).toBe(true);
    expect(r.needsUnits).toBe(false);
    expect(r.quoteSource).toBe("thai_mutual_fund");
    // Facts-only: the invested TOTAL (value − pl = 900) is the fact; the per-unit avg
    // cost is derived at the fold (900 ÷ units), never frozen on the imported row.
    expect(r.costTotal).toBeCloseTo(900);
    expect(r.avgCost).toBeUndefined();
  });

  it("trusts units/avgCost printed on the image — derives nothing", () => {
    const rows = withDb(() => {
      // No NAV seeded: everything needed is already on the image, so deriveRow
      // fills in nothing and `estimated` stays false.
      const extracted: ExtractedRow[] = [{ ticker: "VOO", units: 10, avgCost: 5, nav: 6 }];
      return deriveRowsWithNav(extracted) as DerivedRow[];
    });
    expect(rows[0].units).toBe(10);
    expect(rows[0].avgCost).toBe(5);
    expect(rows[0].estimated).toBe(false);
    // VOO isn't in the catalog → custom (no shape guess to "market" anymore).
    expect(rows[0].quoteSource).toBe("manual");
  });

  it("flags needsUnits when there is no NAV on file and none on the image", () => {
    const rows = withDb(() => {
      const extracted: ExtractedRow[] = [{ ticker: "K-NOPRICE-A", value: 500 }];
      return deriveRowsWithNav(extracted) as DerivedRow[];
    });
    expect(rows[0].units).toBeUndefined();
    expect(rows[0].needsUnits).toBe(true);
  });

  it("prices a dated snapshot off NAV(asOf), not today's moving NAV (#130)", () => {
    const rows = withDb(() => {
      // Latest quote drifted to 25, but on the snapshot's own date NAV was 20.
      seedNav("K-USA-A", 25);
      seedNavHistory("K-USA-A", [
        ["2026-01-01", 18],
        ["2026-02-01", 20],
        ["2026-03-01", 25],
      ]);
      const extracted: ExtractedRow[] = [{ ticker: "K-USA-A", value: 1000 }];
      return deriveRowsWithNav(extracted, "2026-02-15") as DerivedRow[];
    });
    // 1000 ÷ NAV(2026-02-01)=20 → 50 units, NOT 1000 ÷ latest 25 = 40.
    expect(rows[0].units).toBeCloseTo(50);
    expect(rows[0].needsUnits).toBe(false);
  });

  it("falls back to the latest quote when no dated NAV is on file for asOf", () => {
    const rows = withDb(() => {
      seedNav("K-USA-A", 25); // only a latest quote, no nav_history
      const extracted: ExtractedRow[] = [{ ticker: "K-USA-A", value: 1000 }];
      return deriveRowsWithNav(extracted, "2026-02-15") as DerivedRow[];
    });
    expect(rows[0].units).toBeCloseTo(40); // 1000 ÷ 25
  });
});
