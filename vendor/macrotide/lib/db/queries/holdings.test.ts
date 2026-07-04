// renameHoldingSource rewrites a `source` label, but only within the bucket ids
// it's handed. The route resolves those from the user-scoped listBuckets, so
// these tests lock in that the query itself confines the rewrite to the given
// buckets (never touching holdings in other buckets), and that an empty target
// clears the label.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { type DbContext, getDb, getMarketDb, runWithDbContext } from "../context";
import * as schema from "../schema";
import { deleteBrokerConnection, upsertBrokerConnection } from "./broker-connections";
import { createBucket } from "./buckets";
import {
  getHolding,
  listHoldings,
  managedSourceLabels,
  renameHoldingSource,
  sourceLabelSummary,
} from "./holdings";
import {
  createHoldingViaLedger,
  deleteHoldingViaLedger,
  editHoldingViaLedger,
  rebuildHoldingsForBucket,
  syncedBrokerForTicker,
} from "./project-holdings";

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

const BUCKET = {
  name: "B",
  typeLabel: null,
  icon: null,
  color: null,
  brokerage: "X",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

function seedHolding(bucketId: string, ticker: string, source: string | null) {
  createHoldingViaLedger({
    bucketId,
    ticker,
    englishName: ticker,
    units: 1,
    source,
    quoteSource: "market",
  });
}

function ctx(): DbContext {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return {
    appDb: db,
    appSqlite: sqlite,
    marketDb,
    marketSqlite,
    isDemo: false,
    sessionId: "s",
    userId: null,
  };
}

function seedCatalogFund(
  ticker: string,
  meta: {
    thaiName?: string;
    englishName?: string;
    category?: string;
    assetClass?: string;
    region?: "domestic" | "foreign" | "mixed";
    ter?: number;
  } = {},
) {
  getMarketDb()
    .insert(schema.fundCatalog)
    .values({
      projId: `proj-${ticker}`,
      abbrName: ticker,
      thaiName: meta.thaiName ?? `Thai ${ticker}`,
      englishName: meta.englishName ?? `English ${ticker}`,
      policyDescTh: meta.category ?? "Catalog category",
      assetClass: meta.assetClass ?? "equity",
      investRegion: meta.region ?? "foreign",
      currentTer: meta.ter ?? 0.5,
    })
    .run();
  getMarketDb()
    .insert(schema.fundShareClasses)
    .values({
      projId: `proj-${ticker}`,
      className: "main",
      ticker,
      currentTer: meta.ter ?? 0.5,
    })
    .run();
}

describe("holding catalog enrichment", () => {
  it("overlays known fund metadata from market.db without mutating app.db", () => {
    const c = ctx();
    runWithDbContext(c, () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedCatalogFund("EXAMPLE-FUND-A", {
        thaiName: "Official Thai",
        englishName: "Official English",
        category: "Official category",
        assetClass: "bond",
        region: "domestic",
        ter: 0.25,
      });
      const h = createHoldingViaLedger({
        bucketId: "b1",
        ticker: "EXAMPLE-FUND-A",
        englishName: "Stale app name",
        quoteSource: "thai_mutual_fund",
        units: 10,
        thaiName: "Stale Thai",
        category: "Stale category",
        assetClass: "equity",
        region: "Old region",
        ter: 1.5,
      });

      const read = listHoldings("b1")[0];
      expect(read.thaiName).toBe("Official Thai");
      expect(read.englishName).toBe("Official English");
      expect(read.category).toBe("Official category");
      expect(read.assetClass).toBe("bond");
      expect(read.region).toBe("Thailand");
      expect(read.ter).toBe(0.25);

      const raw = c.appDb
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, h?.id as number))
        .get();
      expect(raw?.thaiName).toBe("Stale Thai");
      expect(raw?.englishName).toBe("Stale app name");
      expect(raw?.category).toBe("Stale category");
      expect(raw?.assetClass).toBe("equity");
      expect(raw?.region).toBe("Old region");
      expect(raw?.ter).toBe(1.5);
    });
  });

  it("reflects market.db metadata changes on the next read", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedCatalogFund("EXAMPLE-FUND-A", { englishName: "Before", assetClass: "equity" });
      createHoldingViaLedger({
        bucketId: "b1",
        ticker: "EXAMPLE-FUND-A",
        englishName: "App name",
        quoteSource: "thai_mutual_fund",
        units: 10,
      });
      expect(listHoldings("b1")[0].englishName).toBe("Before");

      getMarketDb()
        .update(schema.fundCatalog)
        .set({ englishName: "After", assetClass: "cash" })
        .where(eq(schema.fundCatalog.abbrName, "EXAMPLE-FUND-A"))
        .run();

      const read = listHoldings("b1")[0];
      expect(read.englishName).toBe("After");
      expect(read.assetClass).toBe("cash");
    });
  });

  it("uses app metadata for unknown holdings and switches modes when catalog membership changes", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      const h = createHoldingViaLedger({
        bucketId: "b1",
        ticker: "CUSTOM-1",
        englishName: "Custom holding",
        quoteSource: "manual",
        units: 10,
        assetClass: "alternative",
        ter: 2,
      });
      expect(listHoldings("b1")[0].assetClass).toBe("alternative");

      seedCatalogFund("CUSTOM-1", { englishName: "Catalog holding", assetClass: "cash", ter: 0.1 });
      expect(getHolding(h?.id as number)?.englishName).toBe("Catalog holding");
      expect(getHolding(h?.id as number)?.assetClass).toBe("cash");

      getMarketDb()
        .delete(schema.fundShareClasses)
        .where(eq(schema.fundShareClasses.ticker, "CUSTOM-1"))
        .run();
      getMarketDb()
        .delete(schema.fundCatalog)
        .where(eq(schema.fundCatalog.abbrName, "CUSTOM-1"))
        .run();
      expect(getHolding(h?.id as number)?.englishName).toBe("Custom holding");
      expect(getHolding(h?.id as number)?.assetClass).toBe("alternative");

      editHoldingViaLedger(h?.id as number, { assetClass: "bond", ter: 1.1 });
      expect(getHolding(h?.id as number)?.assetClass).toBe("bond");
      expect(getHolding(h?.id as number)?.ter).toBe(1.1);
    });
  });

  it("deleting a holding removes its app metadata row", () => {
    const c = ctx();
    runWithDbContext(c, () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedCatalogFund("EXAMPLE-FUND-A");
      const h = createHoldingViaLedger({
        bucketId: "b1",
        ticker: "EXAMPLE-FUND-A",
        englishName: "Stale app name",
        quoteSource: "thai_mutual_fund",
        units: 10,
        assetClass: "equity",
      });
      expect(h).toBeTruthy();
      expect(deleteHoldingViaLedger(h?.id as number)).toBe(true);
      expect(listHoldings("b1")).toHaveLength(0);
      expect(
        getMarketDb()
          .select()
          .from(schema.fundCatalog)
          .where(eq(schema.fundCatalog.abbrName, "EXAMPLE-FUND-A"))
          .get(),
      ).toBeTruthy();
      expect(getHolding(h?.id as number)).toBeUndefined();
      expect(
        c.appDb
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.id, h?.id as number))
          .get(),
      ).toBeUndefined();
    });
  });
});

// A holding is "synced" only when a backing ledger row carries a non-null
// external_id (the marker only broker imports stamp) — a hand-typed `source`
// that merely names a broker must NOT qualify. These lock in that reliable
// detection plus the broker label + last-synced timestamp surfaced to the UI.
describe("syncedBroker detection", () => {
  /** Insert a broker-imported buy (external_id set) and rebuild the projection. */
  function seedSynced(
    bucketId: string,
    ticker: string,
    opts: { source: string | null; sourceTag: string; account: string; ref: string },
  ) {
    getDb()
      .insert(schema.transactions)
      .values({
        bucketId,
        ticker,
        englishName: ticker,
        quoteSource: "thai_mutual_fund",
        kind: "buy",
        tradeDate: "2026-01-01",
        units: 10,
        pricePerUnit: 10,
        amount: -100,
        tradeCurrency: "THB",
        fxToThb: 1,
        source: opts.source,
        externalId: `${opts.sourceTag}:${opts.account}:${opts.ref}`,
        externalAccount: opts.account,
        importBatchId: "test-sync",
      })
      .run();
    rebuildHoldingsForBucket(bucketId);
  }

  it("flags a broker-imported holding with its broker label, not a manual one", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedSynced("b1", "EXAMPLE-FUND-A", {
        source: "Finnomena",
        sourceTag: "finnomena",
        account: "AC-001",
        ref: "ord-1",
      });
      // Manual holding whose free-text source merely *names* a broker (no external_id).
      seedHolding("b1", "EXAMPLE-FUND-B", "Finnomena");

      const bySym = new Map(listHoldings("b1").map((h) => [h.ticker, h]));
      expect(bySym.get("EXAMPLE-FUND-A")?.syncedBroker).toBe("Finnomena");
      expect(bySym.get("EXAMPLE-FUND-B")?.syncedBroker).toBeNull();
    });
  });

  it("falls back to the sourceTag when the synced row has no source label", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedSynced("b1", "EXAMPLE-FUND-A", {
        source: null,
        sourceTag: "krungsri",
        account: "AC-002",
        ref: "ord-2",
      });
      expect(listHoldings("b1")[0].syncedBroker).toBe("krungsri");
    });
  });
});

describe("renameHoldingSource", () => {
  it("renames the label only within the given buckets", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: null,
    };
    runWithDbContext(ctx, () => {
      createBucket({ ...BUCKET, id: "b1" });
      createBucket({ ...BUCKET, id: "b2" });
      seedHolding("b1", "VOO", "SCB");
      seedHolding("b1", "VTI", "SCB");
      seedHolding("b2", "QQQ", "SCB"); // different bucket, same label — must stay

      const changed = renameHoldingSource(["b1"], "SCB", "SCB Easy Invest");
      expect(changed).toBe(2);
      expect(listHoldings("b1").every((h) => h.source === "SCB Easy Invest")).toBe(true);
      expect(listHoldings("b2")[0].source).toBe("SCB");
    });
  });

  it("clears the label when the new value is empty", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: null,
    };
    runWithDbContext(ctx, () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedHolding("b1", "VOO", "SCB");
      renameHoldingSource(["b1"], "SCB", "");
      expect(listHoldings("b1")[0].source).toBeNull();
    });
  });

  it("is a no-op when given no buckets", () => {
    const { sqlite, db, marketDb, marketSqlite } = freshDb();
    const ctx: DbContext = {
      appDb: db,
      appSqlite: sqlite,
      marketDb,
      marketSqlite,
      isDemo: false,
      sessionId: "s",
      userId: null,
    };
    runWithDbContext(ctx, () => {
      expect(renameHoldingSource([], "SCB", "Y")).toBe(0);
    });
  });
});

// A source label is "managed" when it belongs to a LIVE broker connection: the
// provenance of a synced ledger row (external_id set) whose external_account
// still maps to a brokerConnections row. Managed labels can't be free-text
// renamed (that would desync the connector); a manual label always can. And a
// broker connection that already feeds a ticker into a bucket blocks a manual
// add of the same ticker there, so the two can't silently double-count.
describe("managed sources (Sources × Connections)", () => {
  /** A broker-imported buy (external_id set) + its live connection row. */
  function seedSyncedWithConnection(
    bucketId: string,
    ticker: string,
    opts: { source: string; sourceTag: string; account: string },
  ) {
    getDb()
      .insert(schema.transactions)
      .values({
        bucketId,
        ticker,
        englishName: ticker,
        quoteSource: "thai_mutual_fund",
        kind: "buy",
        tradeDate: "2026-01-01",
        units: 10,
        pricePerUnit: 10,
        amount: -100,
        tradeCurrency: "THB",
        fxToThb: 1,
        source: opts.source,
        externalId: `${opts.sourceTag}:${opts.account}:ord-1`,
        externalAccount: opts.account,
        importBatchId: "test-sync",
      })
      .run();
    rebuildHoldingsForBucket(bucketId);
    upsertBrokerConnection({ source: opts.sourceTag, accountCode: opts.account, bucketId });
  }

  it("flags a live-connection label as managed and a manual label as not", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedSyncedWithConnection("b1", "EXAMPLE-FUND-A", {
        source: "Broker One",
        sourceTag: "broker-one",
        account: "AC-001",
      });
      seedHolding("b1", "EXAMPLE-FUND-B", "My Bank"); // hand-typed, no connection

      expect(managedSourceLabels(["b1"])).toEqual(new Set(["Broker One"]));

      const summary = new Map(sourceLabelSummary(["b1"]).map((s) => [s.source, s]));
      expect(summary.get("Broker One")?.managed).toBe(true);
      expect(summary.get("Broker One")?.count).toBe(1);
      expect(summary.get("My Bank")?.managed).toBe(false);
    });
  });

  it("stops treating a label as managed once its connection is disconnected", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedSyncedWithConnection("b1", "EXAMPLE-FUND-A", {
        source: "Broker One",
        sourceTag: "broker-one",
        account: "AC-001",
      });
      expect(managedSourceLabels(["b1"]).has("Broker One")).toBe(true);

      // Disconnect keeps the imported rows (external_id intact) but drops the
      // connection → the label is no longer managed and can be renamed again.
      deleteBrokerConnection("broker-one", "AC-001");
      expect(managedSourceLabels(["b1"]).has("Broker One")).toBe(false);
      expect(sourceLabelSummary(["b1"])[0].managed).toBe(false);
    });
  });

  it("reports the broker for a synced ticker, null for a manual one", () => {
    runWithDbContext(ctx(), () => {
      createBucket({ ...BUCKET, id: "b1" });
      seedSyncedWithConnection("b1", "EXAMPLE-FUND-A", {
        source: "Broker One",
        sourceTag: "broker-one",
        account: "AC-001",
      });
      seedHolding("b1", "EXAMPLE-FUND-B", "My Bank");

      expect(syncedBrokerForTicker("b1", "EXAMPLE-FUND-A")).toBe("Broker One");
      expect(syncedBrokerForTicker("b1", "example-fund-a")).toBe("Broker One"); // case-fold
      expect(syncedBrokerForTicker("b1", "EXAMPLE-FUND-B")).toBeNull();
    });
  });
});
