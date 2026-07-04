// Per-user row scoping (data layer).
//
// User-owned tables (buckets, journal_entries, plans, chat_threads,
// model_portfolios) carry a nullable `user_id`. Rows with NULL user_id are
// pre-backfill / single-owner data.
//
// Reads/writes are scoped with {@link ownedBy}. The contract is FAIL-CLOSED for
// logged-in users:
//   - No user in context (single-owner / pre-auth / demo — `getUserId()` is
//     null): the clause collapses to `user_id IS NULL`, which is exactly the
//     single-owner row set — behavior is identical to single-owner mode.
//   - A user IS in context: match ONLY that user's own rows
//     (`user_id = me`). A null-owned row is NOT visible by default — forgetting
//     to stamp an owner can no longer leak a row to every account.
//
// Genuinely-shared rows (the built-in model library, which is null-owned on
// purpose) opt in explicitly via the `alsoWhere` predicate — e.g. the
// model-portfolio read passes `eq(modelPortfolios.builtIn, true)`. There is
// deliberately no general `IS NULL` fallback for logged-in users.
import "server-only";
import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getUserId } from "../context";

/**
 * Options for {@link ownedBy}.
 */
export interface OwnedByOptions {
  /**
   * An extra predicate OR'd into the scope clause to admit explicitly-shared
   * rows for logged-in users (e.g. `eq(modelPortfolios.builtIn, true)` for the
   * built-in model library). Ignored in single-owner mode, where the null set
   * already covers shared/built-in rows.
   */
  alsoWhere?: SQL;
}

/**
 * WHERE fragment scoping a user-owned table's `user_id` column to the current
 * request's user (fail-closed). Combine with other conditions via `and(...)`.
 *
 * - No user in context → `user_id IS NULL` (single-owner row set).
 * - User in context → `user_id = me` (strict ownership), optionally OR'd with
 *   `opts.alsoWhere` to include explicitly-shared rows.
 */
export function ownedBy(userIdColumn: SQLiteColumn, opts: OwnedByOptions = {}): SQL {
  const userId = getUserId();
  if (userId === null) return isNull(userIdColumn);
  const mine = eq(userIdColumn, userId);
  if (opts.alsoWhere === undefined) return mine;
  // biome-ignore lint/style/noNonNullAssertion: or() with 2 args always returns SQL
  return or(mine, opts.alsoWhere)!;
}

/**
 * The `user_id` value to stamp on inserts: the current user, or `null` in
 * single-owner / pre-auth / demo mode (matching the legacy inserts, which
 * had no column at all).
 */
export function ownerId(): string | null {
  return getUserId();
}
