// Barrel re-export so existing `@/lib/db/schema` imports keep resolving after
// the database was split along its lifecycle boundary:
//   - ./app    → app.db    (system of record; env DB_PATH)
//   - ./market → market.db (regenerable; env MARKET_DB_PATH)
// Prefer importing from the specific module in new code so a table's home DB is
// obvious at the import site.
export * from "./app";
export * from "./market";
