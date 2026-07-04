// One-time multi-user data backfill: attach all pre-multi-user app rows to a
// single "owner" account derived from the OWNER_EMAIL env var.
//
// Before multi-user, every app row had no `user_id`. Migration 0007 adds a nullable
// `user_id` column, so existing rows are NULL = "shared / visible to everyone".
// Once you go multi-user you want YOUR data attached to YOUR account. This
// script finds (or creates) the user row for OWNER_EMAIL and stamps every
// NULL-owned app row with that user's id.
//
// ── HOW TO RUN (the user does this ONCE, by hand) ───────────────────────────
//   1. Apply migration 0007 to the real DB first (the app does this on boot,
//      or run your migrate step).
//   2. Set OWNER_EMAIL in .env.local to the account that should own all
//      existing data. Get it wrong and your data attaches to the wrong user —
//      re-run with the right value, or re-attach via SQL.
//   3. From the repo root:  npx tsx --env-file=.env.local scripts/backfill-owner.ts
//
// Safe to run more than once: only NULL-owned rows are touched, so a second run
// is a no-op. Built-in model portfolios (built_in = 1) stay NULL on purpose —
// they're shared library content, visible to every user.
//
// If OWNER_EMAIL is unset the script no-ops and exits 0, so it's safe to wire
// into automation without forcing every deployment to have an owner.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  accountTier,
  buckets,
  chatThreads,
  journalEntries,
  modelPortfolios,
  plans,
  user,
  userPreferences,
} from "../lib/db/schema";

const DB_PATH = resolve(process.env.DB_PATH ?? "data/app.db");
// Owner-backfill only touches app.db tables (user, buckets, plans, …).
const MIGRATIONS_DIR = resolve("lib/db/migrations/app");

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `owner-${Date.now()}`;
}

function main(): void {
  const ownerEmail = process.env.OWNER_EMAIL?.trim();
  if (!ownerEmail) {
    console.log("[backfill-owner] OWNER_EMAIL is unset — nothing to do. Exiting.");
    return;
  }

  const sqlite = new Database(DB_PATH);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: { user } });

  if (existsSync(MIGRATIONS_DIR)) {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }

  // 1. Find or create the owner user row.
  let owner = db.select().from(user).where(eq(user.email, ownerEmail)).get();
  if (!owner) {
    const now = new Date();
    const name = ownerEmail.split("@")[0] || "Owner";
    owner = db
      .insert(user)
      .values({
        id: randomId(),
        name,
        email: ownerEmail,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    console.log(`[backfill-owner] created owner user ${owner.id} <${ownerEmail}>`);
  } else {
    console.log(`[backfill-owner] found existing owner user ${owner.id} <${ownerEmail}>`);
  }
  const ownerId = owner.id;

  // 2. Stamp all NULL-owned app rows with the owner id. Built-in model
  //    portfolios are left NULL (shared library content).
  const bucketsN = db
    .update(buckets)
    .set({ userId: ownerId })
    .where(isNull(buckets.userId))
    .run().changes;
  const journalN = db
    .update(journalEntries)
    .set({ userId: ownerId })
    .where(isNull(journalEntries.userId))
    .run().changes;
  const plansN = db
    .update(plans)
    .set({ userId: ownerId })
    .where(isNull(plans.userId))
    .run().changes;
  const threadsN = db
    .update(chatThreads)
    .set({ userId: ownerId })
    .where(isNull(chatThreads.userId))
    .run().changes;
  const modelsN = db
    .update(modelPortfolios)
    .set({ userId: ownerId })
    .where(and(isNull(modelPortfolios.userId), eq(modelPortfolios.builtIn, false)))
    .run().changes;
  const prefsN = db
    .update(userPreferences)
    .set({ userId: ownerId })
    .where(isNull(userPreferences.userId))
    .run().changes;

  // 3. Owner gets the 'trusted' tier (full model chain), idempotently.
  db.insert(accountTier)
    .values({ userId: ownerId, tier: "trusted", grantedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: accountTier.userId, set: { tier: "trusted" } })
    .run();

  console.log(
    `[backfill-owner] done. buckets=${bucketsN} journal=${journalN} plans=${plansN} ` +
      `chat_threads=${threadsN} model_portfolios=${modelsN} user_preferences=${prefsN} ` +
      `(built-ins left NULL).`,
  );
}

main();
