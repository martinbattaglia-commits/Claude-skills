import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { tickerKey } from "@/lib/market/sources";
import { getDb } from "../context";
import { earmarks } from "../schema";
import { canonicalTicker } from "./funds";
import { ownedBy, ownerId } from "./scope";

// Cash earmarks — a designation that part (or all) of a cash account is RESERVED for a
// purpose (#149). v1 stores one earmark per cash account (the `account` scope); the
// `portfolio`/`goal` scopes are schema-ready (no UI). The pure split math lives in
// lib/portfolio/earmarks.ts (resolveEarmarks); this is just the owner-scoped store.

export type Earmark = typeof earmarks.$inferSelect;

/** Every earmark the owner has set — fed to `resolveEarmarks` against the cash holdings. */
export function listEarmarks(): Earmark[] {
  return getDb().select().from(earmarks).where(ownedBy(earmarks.userId)).all();
}

export type EarmarkRole = "investable" | "reserved";

export interface SetEarmarkInput {
  bucketId: string;
  /** The cash account ticker (account scope). */
  ticker: string;
  /** 'reserved' (excluded from return) | 'investable' (counts; the row just carries a label). */
  role?: EarmarkRole;
  /** Reserved amount in `currency`; NULL = "All" (the whole balance, auto-tracks). */
  amount: number | null;
  currency?: string | null;
  purpose?: string | null;
}

/**
 * Create or replace the `account`-scope earmark for one cash account. Keyed on
 * (bucketId, ticker, scope) — NOT a holding id (the holdings projection drops/recreates
 * rows, so an id FK would dangle). The ticker is stored in its official case (#235) —
 * a cash account name keeps the case the user typed — matching the ledger ticker; the
 * resolver compares case-insensitively, and a rename cascades the case here too.
 */
export function setAccountEarmark(input: SetEarmarkInput): Earmark {
  const now = new Date().toISOString();
  const db = getDb();
  // Case-insensitive upsert (#235): the unique index is case-sensitive, so re-set
  // the SAME account in a different case onto its existing row (don't fork). Reuse
  // the stored ticker as the conflict target; a brand-new account takes the
  // official/typed case.
  const existing = db
    .select({ ticker: earmarks.ticker })
    .from(earmarks)
    .where(
      and(
        ownedBy(earmarks.userId),
        eq(earmarks.bucketId, input.bucketId),
        eq(earmarks.scope, "account"),
        sql`upper(${earmarks.ticker}) = ${tickerKey(input.ticker)}`,
      ),
    )
    .get();
  const ticker = existing?.ticker ?? canonicalTicker(input.ticker);
  return db
    .insert(earmarks)
    .values({
      userId: ownerId(),
      scope: "account",
      role: input.role ?? "reserved",
      bucketId: input.bucketId,
      ticker,
      amount: input.amount,
      currency: input.currency ?? null,
      purpose: input.purpose ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [earmarks.bucketId, earmarks.ticker, earmarks.scope],
      set: {
        role: input.role ?? "reserved",
        amount: input.amount,
        currency: input.currency ?? null,
        purpose: input.purpose ?? null,
        updatedAt: now,
      },
    })
    .returning()
    .get();
}

/** Remove the `account`-scope earmark for a cash account (the whole balance is investable again). */
export function deleteAccountEarmark(bucketId: string, ticker: string): void {
  getDb()
    .delete(earmarks)
    .where(
      and(
        ownedBy(earmarks.userId),
        eq(earmarks.bucketId, bucketId),
        eq(earmarks.scope, "account"),
        sql`upper(${earmarks.ticker}) = ${tickerKey(ticker)}`,
      ),
    )
    .run();
}
