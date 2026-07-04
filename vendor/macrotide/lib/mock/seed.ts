// Reseeds the database from the mock data layer. Wipes existing rows first
// so reruns are deterministic. Real portfolio import will eventually replace
// this; for now it's how the prototype data lands in the real DB.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  buckets,
  holdings,
  journalEntries,
  modelPortfolios,
  plans,
  transactions,
} from "../db/schema";
import { MODEL_PORTFOLIOS, PORTFOLIOS, USER_GOALS, USER_JOURNAL, USER_PLAN } from "./data";

// Seeds app.db only — the system of record. Market data (fund catalog, the
// NAV/quote cache) lives in the separate, regenerable market.db and is
// populated by the market refresh path, not this seed.
const DB_PATH = resolve(process.env.DB_PATH ?? "data/app.db");
const MIGRATIONS_DIR = resolve("lib/db/migrations/app");
const REFERENCE_TODAY = new Date("2026-05-21T00:00:00Z");

function parseRelativeDate(text: string, today = REFERENCE_TODAY): string {
  const rel = text.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+ago$/i);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const days = unit.startsWith("day") ? n : unit.startsWith("week") ? n * 7 : n * 30;
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
  }
  const abs = text.match(/^(\d{1,2})\s+(\w{3,})\s+(\d{4})$/);
  if (abs) {
    const parsed = new Date(`${abs[1]} ${abs[2]} ${abs[3]} UTC`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return today.toISOString();
}

async function main() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Wipe in FK-safe order. SQLite without DEFERRABLE FKs can be fussy here.
  // app.db tables only — the market cache lives in market.db.
  sqlite.exec(`
    DELETE FROM chat_messages;
    DELETE FROM chat_threads;
    DELETE FROM journal_entries;
    DELETE FROM plans;
    DELETE FROM transactions;
    DELETE FROM holdings;
    DELETE FROM buckets;
    DELETE FROM model_portfolios;
    DELETE FROM settings;
  `);

  const now = new Date().toISOString();

  // Model portfolios (built-ins)
  for (const m of MODEL_PORTFOLIOS) {
    db.insert(modelPortfolios)
      .values({
        id: m.id,
        name: m.name,
        tagline: m.tagline,
        blurb: m.blurb,
        builtIn: !m.isCustom,
        allocation: m.mix,
        expectedReturn: m.expectedReturn,
        expectedVolatility: m.expectedVol,
        ter: m.ter,
        horizon: m.horizon,
        risk: m.risk,
        pros: m.pros,
        cons: m.cons,
        createdAt: now,
      })
      .run();
  }

  // Buckets + holdings
  for (const p of PORTFOLIOS) {
    db.insert(buckets)
      .values({
        id: p.id,
        name: p.name,
        typeLabel: p.typeLabel,
        icon: p.icon,
        color: p.color,
        brokerage: p.brokerage,
        notes: p.notes,
        goalText: null,
        targetModelId: p.targetModelId,
        targetAllocation: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const h of p.holdings) {
      const avgCost = h.units > 0 ? h.cost / h.units : null;
      db.insert(holdings)
        .values({
          bucketId: p.id,
          ticker: h.ticker,
          thaiName: h.thai ?? null,
          englishName: h.name,
          category: h.category,
          assetClass: h.class,
          region: h.region,
          // Position (units/avgCost) is folded from the opening anchor below, not stored.
          ter: h.ter,
          source: h.source,
          // All mock holdings are Thai mutual funds — route through the SEC
          // Open API by default. Real-world adds via HoldingSheet will pick
          // the right source explicitly via the type selector.
          quoteSource: "thai_mutual_fund",
          acquiredOn: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      // Matching `opening` anchor so the ledger is the source of truth and the
      // holding above is its projection (ADR 0004).
      db.insert(transactions)
        .values({
          bucketId: p.id,
          ticker: h.ticker,
          englishName: h.name,
          quoteSource: "thai_mutual_fund",
          kind: "opening",
          tradeDate: now.slice(0, 10),
          units: h.units,
          pricePerUnit: avgCost,
          amount: avgCost == null ? 0 : -(h.units * avgCost),
          fee: null,
          tradeCurrency: "THB",
          fxToThb: 1,
          source: h.source,
          importBatchId: "seed-opening",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  // Plan (single row, id=1)
  db.insert(plans)
    .values({
      id: 1,
      markdown: USER_PLAN.markdown,
      selectedModelId: USER_GOALS.selectedModelId ?? null,
      updatedAt: parseRelativeDate(USER_PLAN.lastUpdated),
    })
    .run();

  // Journal entries — notes + reading
  for (const n of USER_JOURNAL.notes) {
    db.insert(journalEntries)
      .values({
        kind: "note",
        title: n.title,
        body: n.body,
        url: null,
        source: n.source ?? null,
        tags: n.tags ?? null,
        pinned: false,
        createdAt: parseRelativeDate(n.date),
        archivedAt: null,
      })
      .run();
  }
  for (const r of USER_JOURNAL.reading) {
    db.insert(journalEntries)
      .values({
        kind: "reading",
        title: r.title,
        body: r.summary,
        url: r.url,
        source: r.source ?? null,
        tags: null,
        pinned: false,
        createdAt: parseRelativeDate(r.savedDate),
        archivedAt: null,
      })
      .run();
  }

  // Final counts so the operator sees something useful.
  const counts = {
    buckets: sqlite.prepare("SELECT COUNT(*) AS n FROM buckets").get() as { n: number },
    holdings: sqlite.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number },
    model_portfolios: sqlite.prepare("SELECT COUNT(*) AS n FROM model_portfolios").get() as {
      n: number;
    },
    journal_entries: sqlite.prepare("SELECT COUNT(*) AS n FROM journal_entries").get() as {
      n: number;
    },
    plans: sqlite.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number },
  };

  console.log(`Seeded ${DB_PATH}`);
  for (const [table, { n }] of Object.entries(counts)) {
    console.log(`  ${table}: ${n}`);
  }

  sqlite.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
