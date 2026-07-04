// One-time cleanup for the fund_portfolio duplication bugs.
//
// Background: the SEC /outstanding feed sends `period` as a JSON number, which
// was bound to the TEXT column as "202406.0". The incremental-ingest guard
// compared a Set of stored STRINGS against the incoming NUMBER, never matched,
// and re-inserted the whole portfolio on every nightly crawl. The code fix
// (normalizePeriod in lib/db/queries/fund-enrichment.ts) stops new duplicates;
// this script heals the data already on disk, in one transaction:
//
//   1. NORMALIZE period to a clean "YYYYMM" string ("202406.0" → "202406") in
//      fund_portfolio AND fund_portfolio_asset_type.
//   2. SNAPSHOT-COLLAPSE: when the SEC re-publishes (restates) a period, the old
//      broken guard appended the whole new snapshot, so a period can hold rows
//      from several publish dates (differing only in last_upd_date). Keep only
//      the latest snapshot per (proj_id, period) — drop rows whose last_upd_date
//      is older than the newest for that fund+period. Past PERIODS (the quarterly
//      time series) are untouched; only superseded re-publications of the SAME
//      period are dropped.
//   3. EXACT-DEDUP: collapse rows identical in EVERY column except the surrogate
//      id, keeping the lowest id. Distinct securities are never merged.
//
// Dry-run by default (prints what it WOULD do). Pass --apply to mutate.
//   MARKET_DB_PATH=/opt/services/macrotide/data/market.db node scripts/dedupe-fund-portfolio.mjs
//   ... node scripts/dedupe-fund-portfolio.mjs --apply
//
// Idempotent: re-running after a successful --apply is a no-op (already clean).

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

// Every fund_portfolio column except the surrogate id. Grouping on all of them
// means only rows that are byte-identical (including NULLs, which GROUP BY
// treats as equal) collapse — never two genuinely different holdings.
export const CONTENT_COLS = [
  "proj_id",
  "period",
  "as_of_date",
  "assetliab_id",
  "assetliab_desc",
  "issue_code",
  "isin_code",
  "issuer",
  "assetliab_value",
  "percent_nav",
  "last_upd_date",
];

// Rows whose last_upd_date is older than the newest snapshot for their
// (proj_id, period) — i.e. superseded re-publications of the same period.
const STALE_SNAPSHOT_SUBQUERY = `
  SELECT f.id FROM fund_portfolio f
  JOIN (
    SELECT proj_id, period, MAX(last_upd_date) AS mx
    FROM fund_portfolio GROUP BY proj_id, period
  ) m ON f.proj_id = m.proj_id AND f.period = m.period
  WHERE f.last_upd_date < m.mx`;

/** Read current state without mutating. */
export function inspect(db) {
  const pluck = (sql) => db.prepare(sql).pluck().get();
  return {
    total: pluck("SELECT COUNT(*) FROM fund_portfolio"),
    staleSnapshot: pluck(`SELECT COUNT(*) FROM (${STALE_SNAPSHOT_SUBQUERY})`),
    exactDup: pluck(
      `SELECT COUNT(*) FROM fund_portfolio WHERE id NOT IN (
         SELECT MIN(id) FROM fund_portfolio GROUP BY ${CONTENT_COLS.join(", ")}
       )`,
    ),
    dottyPortfolio: pluck("SELECT COUNT(*) FROM fund_portfolio WHERE period LIKE '%.0'"),
    dottyAssetType: pluck("SELECT COUNT(*) FROM fund_portfolio_asset_type WHERE period LIKE '%.0'"),
  };
}

/** Run all three cleanup steps in one transaction. Returns rows removed per step. */
export function cleanup(db) {
  return db.transaction(() => {
    // 1. Normalize period: "202406.0" → "202406" (CAST via INTEGER drops the .0;
    //    a clean "202406" round-trips unchanged, so it's safe to apply to all).
    db.prepare("UPDATE fund_portfolio SET period = CAST(CAST(period AS INTEGER) AS TEXT)").run();
    db.prepare(
      "UPDATE fund_portfolio_asset_type SET period = CAST(CAST(period AS INTEGER) AS TEXT)",
    ).run();

    // 2. Snapshot-collapse: keep only the latest publish per (proj_id, period).
    const snapshot = db
      .prepare(`DELETE FROM fund_portfolio WHERE id IN (${STALE_SNAPSHOT_SUBQUERY})`)
      .run().changes;

    // 3. Exact-dedup: keep the lowest id per byte-identical group.
    const exact = db
      .prepare(
        `DELETE FROM fund_portfolio WHERE id NOT IN (
           SELECT MIN(id) FROM fund_portfolio GROUP BY ${CONTENT_COLS.join(", ")}
         )`,
      )
      .run().changes;

    return { snapshot, exact };
  })();
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const APPLY = process.argv.includes("--apply");
  const DB_PATH = resolve(process.env.MARKET_DB_PATH ?? "data/market.db");

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const before = inspect(db);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Mode: ${APPLY ? "APPLY (will mutate)" : "DRY-RUN (no changes)"}`);
  console.log("");
  console.log("fund_portfolio:");
  console.log(`  total rows              : ${before.total.toLocaleString()}`);
  console.log(
    `  stale-snapshot rows     : ${before.staleSnapshot.toLocaleString()} (older re-publications)`,
  );
  console.log(`  exact-duplicate rows    : ${before.exactDup.toLocaleString()}`);
  console.log(`  rows w/ "….0" period    : ${before.dottyPortfolio.toLocaleString()}`);
  console.log(`fund_portfolio_asset_type:`);
  console.log(`  rows w/ "….0" period    : ${before.dottyAssetType.toLocaleString()}`);
  console.log("");

  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply to normalize periods and remove duplicates.");
    db.close();
    return;
  }

  const { snapshot, exact } = cleanup(db);
  const after = inspect(db);

  console.log("Applied.");
  console.log(`  removed stale-snapshot rows : ${snapshot.toLocaleString()}`);
  console.log(`  removed exact-duplicate rows: ${exact.toLocaleString()}`);
  console.log(`  fund_portfolio now          : ${after.total.toLocaleString()} rows`);
  console.log(
    `  remaining "….0" periods     : ${after.dottyPortfolio + after.dottyAssetType} ` +
      `(portfolio ${after.dottyPortfolio}, asset_type ${after.dottyAssetType})`,
  );

  db.exec("VACUUM");
  db.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
