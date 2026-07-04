import "server-only";
import { asc } from "drizzle-orm";
import { getDb } from "@/lib/db/context";
import { userMarketIndicators } from "@/lib/db/schema";
import { DEFAULT_INDICATOR_SYMBOLS, isKnownIndicator } from "@/lib/market/indicators";
import { ownedBy, ownerId } from "./scope";

/**
 * The current user's Markets indicator list, in display order. Falls back to
 * the curated default set when the user hasn't customized it. Scoping is
 * fail-closed (see {@link ownedBy}): a logged-in user sees only their own rows.
 */
export function getUserIndicatorSymbols(): string[] {
  const rows = getDb()
    .select({ symbol: userMarketIndicators.symbol })
    .from(userMarketIndicators)
    .where(ownedBy(userMarketIndicators.userId))
    .orderBy(asc(userMarketIndicators.position))
    .all();
  if (rows.length === 0) return [...DEFAULT_INDICATOR_SYMBOLS];
  // Drop any symbol no longer in the catalog (e.g. removed in a later release).
  return rows.map((r) => r.symbol).filter(isKnownIndicator);
}

/**
 * Replace the current user's indicator list with `symbols` (in the given
 * order). Unknown symbols are rejected; duplicates are de-duped keeping first
 * position. Passing an empty list resets the user to the default set (we store
 * no rows, so reads fall back to the default).
 */
export function setUserIndicatorSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const s of symbols) {
    if (!isKnownIndicator(s) || seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
  }

  const db = getDb();
  const uid = ownerId();
  // Replace-all within the user's scope so order + membership are authoritative.
  db.delete(userMarketIndicators).where(ownedBy(userMarketIndicators.userId)).run();
  if (clean.length > 0) {
    db.insert(userMarketIndicators)
      .values(clean.map((symbol, i) => ({ userId: uid, symbol, position: i })))
      .run();
  }
  return clean.length > 0 ? clean : [...DEFAULT_INDICATOR_SYMBOLS];
}
