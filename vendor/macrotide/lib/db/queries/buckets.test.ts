import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../context";
import * as schema from "../schema";
import {
  createBucket,
  deleteBucket,
  getBucket,
  listBuckets,
  reorderBuckets,
  updateBucket,
} from "./buckets";

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

const NEW_BUCKET = {
  id: "test-core",
  name: "Test Core",
  typeLabel: "Free",
  icon: "wallet",
  color: "#3b82f6",
  brokerage: "FNDQ",
  notes: null,
  goalText: null,
  targetModelId: null,
  targetAllocation: null,
};

function withFresh<T>(fn: () => T): T {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as T;
}

describe("buckets queries", () => {
  it("creates and lists a bucket", () => {
    const created = withFresh(() => createBucket(NEW_BUCKET));
    expect(created.id).toBe("test-core");
    expect(created.name).toBe("Test Core");
  });

  it("getBucket returns the inserted row, undefined for missing ids", () => {
    withFresh(() => {
      createBucket(NEW_BUCKET);
      expect(getBucket("test-core")?.id).toBe("test-core");
      expect(getBucket("nope")).toBeUndefined();
    });
  });

  it("listBuckets is ordered by createdAt", () => {
    withFresh(() => {
      createBucket({ ...NEW_BUCKET, id: "a", name: "A" });
      createBucket({ ...NEW_BUCKET, id: "b", name: "B" });
      const rows = listBuckets();
      expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    });
  });

  it("reorderBuckets writes position and re-sorts the list", () => {
    withFresh(() => {
      createBucket({ ...NEW_BUCKET, id: "a", name: "A" });
      createBucket({ ...NEW_BUCKET, id: "b", name: "B" });
      createBucket({ ...NEW_BUCKET, id: "c", name: "C" });
      // Default order is createdAt: a, b, c.
      expect(listBuckets().map((r) => r.id)).toEqual(["a", "b", "c"]);

      reorderBuckets(["c", "a", "b"]);
      expect(listBuckets().map((r) => r.id)).toEqual(["c", "a", "b"]);
      expect(getBucket("c")?.position).toBe(0);
      expect(getBucket("a")?.position).toBe(1);
      expect(getBucket("b")?.position).toBe(2);
    });
  });

  it("listBuckets sorts NULL positions last (after positioned rows)", () => {
    withFresh(() => {
      createBucket({ ...NEW_BUCKET, id: "a", name: "A" });
      createBucket({ ...NEW_BUCKET, id: "b", name: "B" });
      createBucket({ ...NEW_BUCKET, id: "c", name: "C" });
      // Only position b — a and c keep NULL position and fall back to createdAt.
      reorderBuckets(["b"]);
      expect(listBuckets().map((r) => r.id)).toEqual(["b", "a", "c"]);
    });
  });

  it("updateBucket patches and bumps updatedAt", () => {
    withFresh(() => {
      const original = createBucket(NEW_BUCKET);
      // Ensure timestamps differ in millisecond precision.
      const updated = updateBucket("test-core", { name: "Renamed" });
      expect(updated?.name).toBe("Renamed");
      expect(updated?.updatedAt).not.toBe(original.updatedAt);
    });
  });

  it("deleteBucket removes the row", () => {
    withFresh(() => {
      createBucket(NEW_BUCKET);
      deleteBucket("test-core");
      expect(getBucket("test-core")).toBeUndefined();
    });
  });

  it("AsyncLocalStorage isolates DB contexts", () => {
    const { sqlite: sa, db: dba, marketDb: marketDbA, marketSqlite: marketSqliteA } = freshDb();
    const { sqlite: sb, db: dbb, marketDb: marketDbB, marketSqlite: marketSqliteB } = freshDb();

    runWithDbContext(
      {
        appDb: dba,
        appSqlite: sa,
        marketDb: marketDbA,
        marketSqlite: marketSqliteA,
        isDemo: true,
        sessionId: "A",
      },
      () => {
        createBucket(NEW_BUCKET);
      },
    );

    // Bucket should not exist in the second DB.
    runWithDbContext(
      {
        appDb: dbb,
        appSqlite: sb,
        marketDb: marketDbB,
        marketSqlite: marketSqliteB,
        isDemo: true,
        sessionId: "B",
      },
      () => {
        expect(getBucket("test-core")).toBeUndefined();
        expect(listBuckets()).toHaveLength(0);
      },
    );

    // ...but should in the first.
    runWithDbContext(
      {
        appDb: dba,
        appSqlite: sa,
        marketDb: marketDbA,
        marketSqlite: marketSqliteA,
        isDemo: true,
        sessionId: "A",
      },
      () => {
        expect(getBucket("test-core")).toBeDefined();
      },
    );
  });
});
