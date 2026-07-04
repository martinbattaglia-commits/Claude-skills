import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { modelPortfolios, settings } from "../db/schema";
import { ensureTemplatePresets, PRESETS_HIDDEN_KEY, PRESETS_VERSION_KEY } from "./ensure-presets";
import { PRESETS_VERSION, TEMPLATE_PRESETS } from "./presets";

function freshAppDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = resolve("lib/db/migrations/app");
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  return drizzle(sqlite, { schema });
}

describe("TEMPLATE_PRESETS", () => {
  it("have unique ids", () => {
    const ids = TEMPLATE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("are all built-in (never isCustom)", () => {
    expect(TEMPLATE_PRESETS.every((p) => !p.isCustom)).toBe(true);
  });

  it("each allocate to ~100%", () => {
    for (const p of TEMPLATE_PRESETS) {
      const sum = p.mix.reduce((a, s) => a + s.pct, 0);
      expect(sum, `${p.id} mix sums to ${sum}`).toBeCloseTo(100, 5);
    }
  });
});

describe("ensureTemplatePresets", () => {
  it("inserts every preset as a null-owned built-in on an empty DB", () => {
    const db = freshAppDb();
    const { inserted, version } = ensureTemplatePresets(db);

    expect(inserted.sort()).toEqual(TEMPLATE_PRESETS.map((p) => p.id).sort());
    expect(version).toBe(PRESETS_VERSION);

    const rows = db.select().from(modelPortfolios).all();
    expect(rows).toHaveLength(TEMPLATE_PRESETS.length);
    expect(rows.every((r) => r.builtIn === true)).toBe(true);
    expect(rows.every((r) => r.userId === null)).toBe(true);
    // allocation round-trips from the preset mix.
    const bogle = rows.find((r) => r.id === "bogle3");
    expect(bogle?.allocation).toEqual(TEMPLATE_PRESETS[0].mix);
    expect(
      db.select().from(settings).where(eq(settings.key, PRESETS_VERSION_KEY)).get()?.value,
    ).toBe(PRESETS_VERSION);
  });

  it("is idempotent — a second run inserts nothing and never duplicates", () => {
    const db = freshAppDb();
    ensureTemplatePresets(db);
    const second = ensureTemplatePresets(db);

    expect(second.inserted).toEqual([]);
    expect(db.select().from(modelPortfolios).all()).toHaveLength(TEMPLATE_PRESETS.length);
  });

  it("never overwrites an existing row with the same id (owner edits survive)", () => {
    const db = freshAppDb();
    db.insert(modelPortfolios)
      .values({
        id: "bogle3",
        userId: null,
        name: "Owner-renamed Bogle",
        builtIn: true,
        allocation: [{ label: "All in", pct: 100, color: "var(--accent)" }],
        createdAt: new Date().toISOString(),
      })
      .run();

    const { inserted } = ensureTemplatePresets(db);

    expect(inserted).not.toContain("bogle3");
    const bogle = db.select().from(modelPortfolios).where(eq(modelPortfolios.id, "bogle3")).get();
    expect(bogle?.name).toBe("Owner-renamed Bogle");
  });

  it("respects the hidden tombstone — a removed preset is not resurrected", () => {
    const db = freshAppDb();
    db.insert(settings)
      .values({ key: PRESETS_HIDDEN_KEY, value: ["permanent"] })
      .run();

    const { inserted } = ensureTemplatePresets(db);

    expect(inserted).not.toContain("permanent");
    expect(
      db.select().from(modelPortfolios).where(eq(modelPortfolios.id, "permanent")).get(),
    ).toBeUndefined();
  });
});
