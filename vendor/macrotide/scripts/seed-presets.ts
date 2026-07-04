// Seed the factory template presets (built-in model portfolios) into a real DB.
//
// This is a thin CLI wrapper around `ensureTemplatePresets` for manual/ops use
// — the same routine runs automatically on app boot (lib/db/client.ts). It is
// ADDITIVE and idempotent: it inserts only presets the DB is missing and never
// wipes or overwrites existing rows, so it is safe to run against production
// data (unlike `db:seed`, which reseeds the whole demo dataset).
//
// ── HOW TO RUN ──────────────────────────────────────────────────────────────
//   From the repo root:  npm run db:seed:presets
//   Against a specific DB:  DB_PATH=/path/to/app.db npm run db:seed:presets
//
// Safe to run more than once: a second run reports "(none, already present)".
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as appSchema from "../lib/db/schema/app";
import { ensureTemplatePresets } from "../lib/templates/ensure-presets";

const DB_PATH = resolve(process.env.DB_PATH ?? "data/app.db");
const MIGRATIONS_DIR = resolve("lib/db/migrations/app");

function main(): void {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: appSchema });

  if (existsSync(MIGRATIONS_DIR)) {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }

  const { inserted, version } = ensureTemplatePresets(db);
  console.log(
    `[seed-presets] presets v${version} → inserted ${inserted.length}: ` +
      `${inserted.join(", ") || "(none, already present)"} [${DB_PATH}]`,
  );

  sqlite.close();
}

main();
