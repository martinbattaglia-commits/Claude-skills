import { describe, expect, it } from "vitest";
import { adaptAggregate, adaptBucket, adaptPortfolios } from "./adapter";

const sampleBucket = {
  id: "core",
  userId: null,
  name: "Core",
  typeLabel: "Free",
  icon: "wallet",
  color: "#000",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  position: null,
  targetAllocation: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const sampleHolding = {
  id: 1,
  bucketId: "core",
  ticker: "VWRA",
  thaiName: null,
  englishName: "Vanguard FTSE All-World",
  category: "ETF",
  assetClass: "equity",
  region: "global",
  units: 10,
  avgCost: 100,
  ter: 0.22,
  source: "live",
  quoteSource: "market",
  catalogProjId: null,
  catalogClassName: null,
  catalogIsin: null,
  catalogFigi: null,
  currency: null,
  acquiredOn: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const sampleQuote = {
  ticker: "VWRA",
  nav: 120,
  d1Pct: 0.5,
  ytdPct: 8.5,
  y1Pct: 12.0,
  updatedAt: "2026-05-21",
  deepestRange: null,
};

describe("adaptPortfolios", () => {
  it("groups holdings by bucket and joins quote data", () => {
    const portfolios = adaptPortfolios([sampleBucket], [sampleHolding], [sampleQuote]);
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0].holdings).toHaveLength(1);
    expect(portfolios[0].holdings[0].nav).toBe(120);
    expect(portfolios[0].holdings[0].ticker).toBe("VWRA");
  });

  it("handles holdings whose bucket no longer exists", () => {
    const orphan = { ...sampleHolding, bucketId: "missing" };
    const portfolios = adaptPortfolios([sampleBucket], [orphan], [sampleQuote]);
    expect(portfolios[0].holdings).toHaveLength(0);
  });

  it("falls back to avgCost when no quote is available", () => {
    // No quote → NAV defaults to avgCost so the holding doesn't render at 0.
    const portfolios = adaptPortfolios([sampleBucket], [sampleHolding], []);
    expect(portfolios[0].holdings[0].nav).toBe(100);
  });

  it("preserves the 'mixed' asset class instead of collapsing it to unknown (#267)", () => {
    const balanced = { ...sampleHolding, assetClass: "mixed" };
    const portfolios = adaptPortfolios([sampleBucket], [balanced], [sampleQuote]);
    expect(portfolios[0].holdings[0].class).toBe("mixed");
  });

  it("preserves the DB id and bucketId on adapted holdings", () => {
    const portfolios = adaptPortfolios([sampleBucket], [sampleHolding], [sampleQuote]);
    expect(portfolios[0].holdings[0].id).toBe(1);
    expect(portfolios[0].holdings[0].bucketId).toBe("core");
  });

  it("keeps a blank holding source blank instead of falling back to brokerage", () => {
    const holding = { ...sampleHolding, source: null };
    const bucket = { ...sampleBucket, brokerage: "—" };
    const portfolios = adaptPortfolios([bucket], [holding], [sampleQuote]);
    expect(portfolios[0].holdings[0].source).toBe("");
  });
});

describe("adaptAggregate", () => {
  it("totals units × nav across portfolios", () => {
    const portfolios = adaptPortfolios([sampleBucket], [sampleHolding], [sampleQuote]);
    const agg = adaptAggregate(portfolios);
    expect(agg.totalValue).toBe(1200);
  });

  it("derives asOf from the aggregate series' latest date across buckets", () => {
    const portfolios = adaptPortfolios([sampleBucket], [sampleHolding], [sampleQuote]);
    const agg = adaptAggregate(portfolios, [
      { date: "2026-06-23", value: 100 },
      { date: "2026-06-24", value: 110 },
    ]);
    expect(agg.asOf).toBe("24 Jun 2026");
  });
});

describe("portfolio asOf tracks the data date, not the bucket edit time", () => {
  // Bucket last edited Jun 16 — the label must follow the latest NAV, not this.
  const edited = { ...sampleBucket, updatedAt: "2026-06-16T08:50:56.929Z" };

  it("formats the last series point as the valued-through date", () => {
    const series = [
      { date: "2026-06-23", value: 100 },
      { date: "2026-06-24", value: 110 },
    ];
    expect(adaptBucket(edited, [], new Map(), series).asOf).toBe("24 Jun 2026");
  });

  it("is empty when the portfolio has no priced history", () => {
    expect(adaptBucket(edited, [], new Map(), undefined).asOf).toBe("");
    expect(adaptBucket(edited, [], new Map(), []).asOf).toBe("");
  });
});
