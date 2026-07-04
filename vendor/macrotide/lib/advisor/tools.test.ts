import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import { createBucket } from "../db/queries/buckets";
import { upsertFund } from "../db/queries/funds";
import { listHoldings } from "../db/queries/holdings";
import { listJournalEntries } from "../db/queries/journal";
import { getPlan, upsertPlan } from "../db/queries/plan";
import { createHoldingViaLedger } from "../db/queries/project-holdings";
import { upsertFundQuote } from "../db/queries/quotes";
import { upsertShareClasses } from "../db/queries/share-classes";
import { insertTransactions } from "../db/queries/transactions";
import { upsertUsSecurities } from "../db/queries/us-securities";
import * as schema from "../db/schema";
import { persistPlanEdit } from "../portfolio/apply-plan-edit";
import { quoteCacheKey } from "../portfolio/derive-rows";
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
  const db = drizzle(sqlite, { schema });
  const market = freshMarketDb();
  return { sqlite, db, marketDb: market.db, marketSqlite: market.sqlite };
}

function withFresh<T>(fn: () => T): T {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as T;
}

const BUCKET = {
  id: "core",
  name: "Core",
  typeLabel: "Free",
  icon: "wallet",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

// Tools are invoked through the AI SDK at runtime; in tests we call the
// `execute` directly. `as never` because the SDK's tool type expects extra
// runtime args (toolCallId / messages) we don't supply in unit tests.
type Exec<T> = (args: T, opts?: never) => Promise<unknown>;

function run<T>(tool: { execute?: unknown }, args: T): Promise<unknown> {
  return (tool.execute as Exec<T>)(args);
}

describe("advisor tools — read_portfolio", () => {
  it("computes allocation, concentration, and blended TER from real holdings", async () => {
    const out = (await withFresh(async () => {
      createBucket(BUCKET);
      // value = units * avgCost (no quote seeded → falls back to avgCost).
      createHoldingViaLedger({
        bucketId: "core",
        ticker: "VOO",
        englishName: "S&P 500",
        quoteSource: "market",
        units: 100,
        avgCost: 6, // value 600
        assetClass: "equity",
        region: "US",
        ter: 0.03,
      });
      createHoldingViaLedger({
        bucketId: "core",
        ticker: "BND",
        englishName: "Total Bond",
        quoteSource: "market",
        units: 100,
        avgCost: 4, // value 400
        assetClass: "bond",
        region: "US",
        ter: 0.05,
      });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, {});
    })) as {
      ok: boolean;
      hasHoldings: boolean;
      totalValue: number;
      byClass: { label: string; pct: number }[];
      blendedTer: number;
      concentration: { top: { ticker: string; pct: number } | null; holdingCount: number };
    };

    expect(out.ok).toBe(true);
    expect(out.hasHoldings).toBe(true);
    expect(out.totalValue).toBe(1000);
    // 60% equity / 40% bonds.
    const equity = out.byClass.find((s) => s.label === "Equity");
    expect(equity?.pct).toBe(60);
    // Blended TER = (600*0.03 + 400*0.05) / 1000 = 0.038.
    expect(out.blendedTer).toBeCloseTo(0.038, 3);
    expect(out.concentration.holdingCount).toBe(2);
    expect(out.concentration.top?.ticker).toBe("VOO");
  });

  it("reports no holdings cleanly on an empty portfolio", async () => {
    const out = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, {});
    })) as { hasHoldings: boolean; totalValue: number; message: string };
    expect(out.hasHoldings).toBe(false);
    expect(out.totalValue).toBe(0);
    expect(out.message).toMatch(/no holdings/i);
  });

  it("surfaces lifetime ledger analytics, a per-fund block, and flags custom holdings", async () => {
    const out = (await withFresh(async () => {
      createBucket(BUCKET);
      insertTransactions([
        // A real contribution (buy) → counts as invested.
        {
          bucketId: "core",
          ticker: "VOO",
          englishName: "S&P 500",
          quoteSource: "market",
          kind: "buy",
          tradeDate: "2024-01-01",
          units: 100,
          pricePerUnit: 6,
          amount: -600,
          fxToThb: 1,
        },
        // A dividend → income (not a contribution).
        {
          bucketId: "core",
          ticker: "VOO",
          englishName: "S&P 500",
          quoteSource: "market",
          kind: "dividend",
          tradeDate: "2024-03-01",
          units: 0,
          amount: 50,
          fxToThb: 1,
        },
        // A custom / self-priced holding (manual source).
        {
          bucketId: "core",
          ticker: "GOLDSAVE",
          englishName: "Gold savings",
          quoteSource: "manual",
          kind: "opening",
          tradeDate: "2024-01-01",
          units: 10,
          pricePerUnit: 100,
          amount: -1000,
          marketPrice: 120,
          fxToThb: 1,
        },
      ]);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, { ticker: "VOO" });
    })) as {
      ledger: { invested: number; realized: number; income: number } | null;
      customHoldings: { ticker: string; pct: number }[];
      position: { ticker: string; invested: number; income: number } | null;
    };

    // Aggregate ledger: invested = cost basis of held units — the VOO buy (600)
    // plus the GOLDSAVE opening balance (1000), which is also invested capital.
    // The dividend is income, not cost basis.
    expect(out.ledger).not.toBeNull();
    expect(out.ledger?.invested).toBe(1600);
    expect(out.ledger?.income).toBe(50);
    // The manual holding is flagged as self-priced.
    expect(out.customHoldings.map((c) => c.ticker)).toContain("GOLDSAVE");
    // Per-fund block, scoped to VOO's own events.
    expect(out.position?.ticker).toBe("VOO");
    expect(out.position?.invested).toBe(600);
    expect(out.position?.income).toBe(50);
  });
});

describe("advisor tools — read_portfolio per-portfolio (Wave 1)", () => {
  const TAX = { ...BUCKET, id: "tax", name: "Tax", typeLabel: "SSF" };

  async function seedTwoBuckets() {
    createBucket(BUCKET);
    createBucket(TAX);
    // Core: 600 of US equity.
    createHoldingViaLedger({
      bucketId: "core",
      ticker: "VOO",
      englishName: "S&P 500",
      quoteSource: "market",
      units: 100,
      avgCost: 6,
      assetClass: "equity",
      region: "US",
      ter: 0.03,
    });
    // Tax: 400 of a Thai bond fund.
    createHoldingViaLedger({
      bucketId: "tax",
      ticker: "K-TAX",
      englishName: "Tax fund",
      quoteSource: "market",
      units: 100,
      avgCost: 4,
      assetClass: "bond",
      region: "TH",
      ter: 0.5,
    });
  }

  type Agg = {
    totalValue: number;
    byBucket?: { name: string; totalValue: number; pctOfTotal: number; blendedTer: number }[];
    scope?: { name: string } | null;
  };

  it("aggregate returns a per-portfolio byBucket breakdown", async () => {
    const out = (await withFresh(async () => {
      await seedTwoBuckets();
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, {});
    })) as Agg;
    expect(out.totalValue).toBe(1000);
    expect(out.byBucket).toBeDefined();
    expect(out.byBucket).toHaveLength(2);
    const tax = out.byBucket?.find((b) => b.name === "Tax");
    expect(tax?.totalValue).toBe(400);
    expect(tax?.pctOfTotal).toBe(40);
    // Per-bucket blended fee uses only that bucket's holdings (Tax = 0.5%).
    expect(tax?.blendedTer).toBeCloseTo(0.5, 3);
  });

  it("scopes to one portfolio by name — its own holdings, no byBucket", async () => {
    const out = (await withFresh(async () => {
      await seedTwoBuckets();
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, { portfolio: "Tax" });
    })) as Agg & { concentration: { top: { ticker: string } | null } };
    expect(out.totalValue).toBe(400);
    expect(out.scope?.name).toBe("Tax");
    expect(out.byBucket).toBeUndefined();
    expect(out.concentration.top?.ticker).toBe("K-TAX");
  });

  it("matches a portfolio by partial name", async () => {
    const out = (await withFresh(async () => {
      await seedTwoBuckets();
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, { portfolio: "ta" });
    })) as Agg;
    expect(out.scope?.name).toBe("Tax");
  });

  it("returns a helpful not-found message listing the user's portfolios", async () => {
    const out = (await withFresh(async () => {
      await seedTwoBuckets();
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, { portfolio: "crypto" });
    })) as { hasHoldings: boolean; message: string };
    expect(out.hasHoldings).toBe(false);
    expect(out.message).toMatch(/No portfolio matching/i);
    expect(out.message).toMatch(/Tax/);
  });

  it("a single-portfolio user gets no byBucket (the aggregate IS that portfolio)", async () => {
    const out = (await withFresh(async () => {
      createBucket(BUCKET);
      createHoldingViaLedger({
        bucketId: "core",
        ticker: "VOO",
        englishName: "S&P 500",
        quoteSource: "market",
        units: 100,
        avgCost: 6,
        assetClass: "equity",
      });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_portfolio, {});
    })) as Agg;
    expect(out.byBucket).toBeUndefined();
  });
});

describe("advisor tools — read_performance per-portfolio (Wave 1)", () => {
  it("an unknown portfolio returns hasData=false with a matching message", async () => {
    const out = (await withFresh(async () => {
      createBucket(BUCKET);
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_performance, { portfolio: "nope" });
    })) as { hasData: boolean; message: string };
    expect(out.hasData).toBe(false);
    expect(out.message).toMatch(/No portfolio matching/i);
  });
});

describe("advisor tools — read_plan", () => {
  it("returns markdown plus parsed spine sections", async () => {
    const out = (await withFresh(async () => {
      upsertPlan({ markdown: "## Risk\n- max 30% drawdown\n\n## Principles\n- index only" });
      const tools = createAdvisorTools({ userId: null });
      return run(tools.read_plan, {});
    })) as { hasPlan: boolean; spine: { risk: string | null; principles: string | null } };
    expect(out.hasPlan).toBe(true);
    expect(out.spine.risk).toContain("30% drawdown");
    expect(out.spine.principles).toContain("index only");
  });
});

describe("advisor tools — journal", () => {
  it("write_journal persists and read_journal reads it back, filtered by tag", async () => {
    const out = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      await run(tools.write_journal, {
        kind: "decision",
        title: "Rebalanced",
        body: "Trimmed VOO back to target.",
        tags: ["rebalance"],
      });
      await run(tools.write_journal, {
        kind: "note",
        body: "Untagged note.",
      });
      const tagged = await run(tools.read_journal, { tag: "rebalance" });
      const decisions = await run(tools.read_journal, { kind: "decision" });
      return { tagged, decisions };
    })) as {
      tagged: { count: number; entries: { kind: string; tags: string[] }[] };
      decisions: { count: number };
    };
    expect(out.tagged.count).toBe(1);
    expect(out.tagged.entries[0].tags).toContain("rebalance");
    expect(out.decisions.count).toBe(1);
  });

  it("write_journal records advisor_tool source", async () => {
    const rows = await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      await run(tools.write_journal, { kind: "note", body: "logged by advisor" });
      return listJournalEntries();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("advisor_tool");
  });
});

describe("advisor tools — propose_plan_edit", () => {
  it("emits a proposal in the card shape and does NOT mutate the plan", async () => {
    const result = await withFresh(async () => {
      upsertPlan({ markdown: "## Principles\n- index only" });
      const tools = createAdvisorTools({ userId: null });
      const out = (await run(tools.propose_plan_edit, {
        section: "Principles",
        add: "no individual stocks",
        rationale: "User wants funds only.",
      })) as { proposal: { section: string; add: string | null; rm: string | null } };
      const planAfter = getPlan();
      return { out, planAfter };
    });
    // Proposal carries the exact PlanProposal shape the card expects.
    expect(result.out.proposal.section).toBe("Principles");
    expect(result.out.proposal.add).toBe("- no individual stocks");
    expect(result.out.proposal.rm).toBeNull();
    // Crucially: proposing did NOT change the persisted plan.
    expect(result.planAfter?.markdown).toBe("## Principles\n- index only");
  });
});

describe("advisor tools — propose_holding", () => {
  it("emits a holding in the card shape and does NOT write a holding", async () => {
    const result = await withFresh(async () => {
      createBucket(BUCKET);
      const tools = createAdvisorTools({ userId: null });
      const out = (await run(tools.propose_holding, {
        ticker: "voo",
        englishName: "Vanguard S&P 500 ETF",
        units: 12.5,
        avgCost: 400,
        assetClass: "equity",
        region: "US",
        quoteSource: "market",
        rationale: "Read from the statement.",
      })) as {
        ok: boolean;
        holding: {
          ticker: string;
          englishName: string;
          units: number;
          avgCost: number | null;
          assetClass: string | null;
          quoteSource: string;
          bucketId: string | null;
        };
      };
      // Proposing must not have written anything.
      const holdingsAfter = listHoldings();
      return { out, count: holdingsAfter.length };
    });
    expect(result.out.ok).toBe(true);
    // A custom (off-catalog) symbol keeps the typed case (#235); only a cataloged
    // fund is normalized to its official catalog case.
    expect(result.out.holding.ticker).toBe("voo");
    expect(result.out.holding.englishName).toBe("Vanguard S&P 500 ETF");
    expect(result.out.holding.units).toBe(12.5);
    expect(result.out.holding.avgCost).toBe(400);
    expect(result.out.holding.assetClass).toBe("equity");
    expect(result.out.holding.quoteSource).toBe("market");
    // Crucially: proposing did NOT insert a holding.
    expect(result.count).toBe(0);
  });

  it("defaults quoteSource to market and nulls absent optional fields", async () => {
    const out = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.propose_holding, {
        ticker: "K-USA-A",
        englishName: "K US Equity",
        units: 100,
        rationale: "row 1",
      });
    })) as { holding: { quoteSource: string; avgCost: number | null; assetClass: string | null } };
    expect(out.holding.quoteSource).toBe("market");
    expect(out.holding.avgCost).toBeNull();
    expect(out.holding.assetClass).toBeNull();
  });

  it("routes a value-only position into the reviewable importer (no units, no DB write)", async () => {
    const result = await withFresh(async () => {
      createBucket(BUCKET);
      // NAV keyed by the composite source:TICKER — a catalog fund resolves to
      // thai_mutual_fund, so value÷NAV derives the (estimated) unit count.
      upsertFundQuote({
        ticker: quoteCacheKey("thai_mutual_fund", "K-USA-A"),
        nav: 20,
        updatedAt: new Date().toISOString(),
      });
      upsertFund({
        projId: "K-USA-A",
        abbrName: "K-USA-A",
        englishName: "K-USA-A",
        assetClass: "equity",
        fundType: "Equity",
        status: "active",
      });
      upsertShareClasses([
        { projId: "K-USA-A", className: "main", ticker: "K-USA-A", investorType: "retail" },
      ]);
      const tools = createAdvisorTools({ userId: null });
      const out = (await run(tools.propose_holding, {
        ticker: "k-usa-a",
        englishName: "K US Equity",
        value: 1000, // 1000 ÷ 20 = 50 units, derived (estimated), value kept as the fact
        pl: 100,
        rationale: "Read from a single-fund screenshot.",
      })) as {
        ok: boolean;
        holding?: unknown;
        holdingsImport: {
          rows: Array<{ ticker: string; units?: number; estimated: boolean; quoteSource: string }>;
          source: string | null;
          note: string | null;
        };
      };
      return { out, count: listHoldings().length };
    });
    expect(result.out.ok).toBe(true);
    // Value-only → a holdingsImport batch, NOT a one-tap holding card.
    expect(result.out.holding).toBeUndefined();
    expect(result.out.holdingsImport.rows).toHaveLength(1);
    const row = result.out.holdingsImport.rows[0];
    expect(row.units).toBeCloseTo(50);
    expect(row.estimated).toBe(true);
    expect(row.quoteSource).toBe("thai_mutual_fund");
    expect(result.out.holdingsImport.note).toBe("Read from a single-fund screenshot.");
    // Proposing must not write a holding.
    expect(result.count).toBe(0);
  });
});

describe("advisor tools — propose_holdings_import", () => {
  type ImportOut = {
    ok: boolean;
    holdingsImport: {
      rows: Array<{
        ticker: string;
        units?: number;
        avgCost?: number;
        quoteSource: string;
        estimated: boolean;
        needsUnits: boolean;
      }>;
      source: string | null;
      note: string | null;
    };
    message: string;
  };

  it("derives units from market NAV and returns the holdingsImport payload (no DB write)", async () => {
    const result = await withFresh(async () => {
      createBucket(BUCKET);
      // NAV keyed by the composite source:TICKER, same as the importer (a catalog
      // fund resolves to thai_mutual_fund).
      upsertFundQuote({
        ticker: quoteCacheKey("thai_mutual_fund", "K-USA-A"),
        nav: 20,
        updatedAt: new Date().toISOString(),
      });
      // Catalog-confirm the fund so the DB-backed source check reads it as a Thai
      // fund (a priced production fund is always in the catalog).
      upsertFund({
        projId: "K-USA-A",
        abbrName: "K-USA-A",
        englishName: "K-USA-A",
        assetClass: "equity",
        fundType: "Equity",
        status: "active",
      });
      upsertShareClasses([
        { projId: "K-USA-A", className: "main", ticker: "K-USA-A", investorType: "retail" },
      ]);
      const tools = createAdvisorTools({ userId: null });
      const out = (await run(tools.propose_holdings_import, {
        rows: [
          { ticker: "k-usa-a", value: 1000, pl: 100 }, // 1000 ÷ 20 = 50 units
          { ticker: "VOO", units: 10, avgCost: 5 },
        ],
        source: "Broker",
        note: "Read from a portfolio screenshot.",
      })) as ImportOut;
      return { out, count: listHoldings().length };
    });
    expect(result.out.ok).toBe(true);
    expect(result.out.holdingsImport.rows).toHaveLength(2);
    const usa = result.out.holdingsImport.rows[0];
    expect(usa.units).toBeCloseTo(50);
    expect(usa.estimated).toBe(true);
    expect(usa.quoteSource).toBe("thai_mutual_fund");
    expect(result.out.holdingsImport.rows[1].units).toBe(10);
    expect(result.out.holdingsImport.source).toBe("Broker");
    // Proposing must not write a holding.
    expect(result.count).toBe(0);
  });

  it("honors an explicit per-row quoteSource override", async () => {
    const out = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      // 'K-USA-A' would infer thai_mutual_fund; override forces market.
      return run(tools.propose_holdings_import, {
        rows: [{ ticker: "K-USA-A", units: 1, quoteSource: "market" }],
      });
    })) as ImportOut;
    expect(out.holdingsImport.rows[0].quoteSource).toBe("market");
  });

  it("flags rows that still need a unit count in the message", async () => {
    const out = (await withFresh(async () => {
      const tools = createAdvisorTools({ userId: null });
      return run(tools.propose_holdings_import, {
        rows: [{ ticker: "K-NOPRICE-A", value: 500 }],
      });
    })) as ImportOut;
    expect(out.holdingsImport.rows[0].needsUnits).toBe(true);
    expect(out.message).toMatch(/need/i);
  });
});

describe("accept path — persistPlanEdit", () => {
  it("applies an additive edit into an existing section and persists it", async () => {
    const md = await withFresh(async () => {
      upsertPlan({ markdown: "## Principles\n- index only\n" });
      persistPlanEdit({ section: "Principles", add: "- no individual stocks", rm: null });
      return getPlan()?.markdown ?? "";
    });
    expect(md).toContain("- index only");
    expect(md).toContain("- no individual stocks");
  });

  it("creates the section when it doesn't exist and preserves selectedModelId", async () => {
    const plan = await withFresh(async () => {
      upsertPlan({ markdown: "## Principles\n- index only\n", selectedModelId: "balanced-60-40" });
      persistPlanEdit({ section: "Risk", add: "- max 30% drawdown", rm: null });
      return getPlan();
    });
    expect(plan?.markdown).toContain("## Risk");
    expect(plan?.markdown).toContain("- max 30% drawdown");
    // selectedModelId carried through the edit (not cleared).
    expect(plan?.selectedModelId).toBe("balanced-60-40");
  });
});

describe("advisor tools — find_us_securities", () => {
  const SEED = [
    {
      symbol: "AAPL",
      name: "Apple Inc. - Common Stock",
      securityType: "stock" as const,
      exchange: "Nasdaq",
    },
    {
      symbol: "VOO",
      name: "Vanguard S&P 500 ETF",
      securityType: "etf" as const,
      exchange: "NYSE Arca",
    },
    { symbol: "QQQ", name: "Invesco QQQ Trust", securityType: "etf" as const, exchange: "Nasdaq" },
  ];

  it("resolves a symbol and cleans the stock-class suffix", async () => {
    const out = (await withFresh(async () => {
      upsertUsSecurities(SEED, "2026-06-25T00:00:00Z");
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_us_securities, { query: "AAPL" });
    })) as { count: number; securities: { symbol: string; name: string; type: string }[] };
    expect(out.securities[0].symbol).toBe("AAPL");
    expect(out.securities[0].name).toBe("Apple Inc.");
    expect(out.securities[0].type).toBe("stock");
  });

  it("filters to ETFs only", async () => {
    const out = (await withFresh(async () => {
      upsertUsSecurities(SEED, "2026-06-25T00:00:00Z");
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_us_securities, { type: "etf" });
    })) as { securities: { symbol: string; type: string }[] };
    expect(out.securities.map((s) => s.symbol).sort()).toEqual(["QQQ", "VOO"]);
    expect(out.securities.every((s) => s.type === "etf")).toBe(true);
  });

  it("returns a helpful message when nothing matches", async () => {
    const out = (await withFresh(async () => {
      upsertUsSecurities(SEED, "2026-06-25T00:00:00Z");
      const tools = createAdvisorTools({ userId: null });
      return run(tools.find_us_securities, { query: "NOTREAL" });
    })) as { count: number; message: string };
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/find_funds/);
  });
});
