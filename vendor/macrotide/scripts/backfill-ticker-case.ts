// One-time data fix (#235): normalize stored tickers to their OFFICIAL catalog
// case, and migrate cash accounts off the legacy upper-case + englishName-shadow
// workaround onto their natural-case name as the ticker.
//
// WHY: tickers used to be force-upper-cased on save. We now store a cataloged
// fund in the catalog's native case (`fund_share_classes.ticker` /
// `fund_catalog.abbr_name`) and a cash account in the user's own case, so the
// user sees the real symbol/name. New writes already do this (canonicalTicker);
// this script brings EXISTING rows in line. Comparisons everywhere are
// case-folded (tickerKey), so this is a display/consistency fix, not a
// correctness one — but it also lets a future case-sensitive read line up.
//
// Crosses the DB boundary by design (a one-off script, not a request): reads the
// canonical case from market.db, rewrites app.db. Pure data fix on the precious
// app.db — no schema change. BACK UP app.db first. Idempotent: a second run
// reports 0 rows changed.
//
// ── HOW TO RUN (once, after deploying the case change) ──────────────────────
//   npx tsx --tsconfig tsconfig.scripts.json scripts/backfill-ticker-case.ts
// Set DB_PATH / MARKET_DB_PATH to point at non-default locations.

import { resolve } from "node:path";
import Database from "better-sqlite3";

const APP_DB_PATH = resolve(process.env.DB_PATH ?? "data/app.db");
const MARKET_DB_PATH = resolve(process.env.MARKET_DB_PATH ?? "data/market.db");

const up = (s: string) => s.trim().toUpperCase();

/** upper(code) → official catalog case. Share-class ticker (the priceable unit)
 * wins over the parent abbr on the rare overlap. */
function loadCanonicalCase(marketDb: Database.Database): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of marketDb
    .prepare("SELECT abbr_name AS code FROM fund_catalog WHERE abbr_name IS NOT NULL")
    .all() as { code: string }[])
    out.set(up(r.code), r.code);
  for (const r of marketDb
    .prepare("SELECT ticker AS code FROM fund_share_classes WHERE ticker IS NOT NULL")
    .all() as { code: string }[])
    out.set(up(r.code), r.code);
  return out;
}

function main(): void {
  const app = new Database(APP_DB_PATH);
  const market = new Database(MARKET_DB_PATH, { readonly: true });
  const canonical = loadCanonicalCase(market);

  let catalogRows = 0;
  let cashRows = 0;

  const run = app.transaction(() => {
    // 1. Cataloged funds → official catalog case. The code's canonical case is
    //    global (same code, same case everywhere), so a per-table case-folded
    //    UPDATE keeps holdings/transactions/earmarks in step.
    const codes = app
      .prepare(
        `SELECT DISTINCT ticker FROM (
           SELECT ticker FROM holdings
           UNION SELECT ticker FROM transactions
           UNION SELECT ticker FROM earmarks WHERE ticker IS NOT NULL
         )`,
      )
      .all() as { ticker: string }[];
    for (const { ticker } of codes) {
      const want = canonical.get(up(ticker));
      if (!want || want === ticker) continue; // not cataloged, or already canonical
      for (const table of ["holdings", "transactions", "earmarks"]) {
        const res = app
          .prepare(`UPDATE ${table} SET ticker = ? WHERE upper(ticker) = ?`)
          .run(want, up(ticker));
        catalogRows += res.changes;
      }
    }

    // 2. Cash accounts → natural-case name as the ticker (#235 supersedes the
    //    #149 upper-case + englishName-shadow). Per-account (bucket-scoped): a
    //    cash name is unique within its bucket, not globally.
    const cash = app
      .prepare(
        `SELECT bucket_id, ticker, english_name FROM holdings
         WHERE quote_source = 'cash' AND english_name IS NOT NULL
           AND english_name <> '' AND ticker <> english_name`,
      )
      .all() as { bucket_id: string; ticker: string; english_name: string }[];
    for (const c of cash) {
      for (const table of ["holdings", "transactions", "earmarks"]) {
        const res = app
          .prepare(`UPDATE ${table} SET ticker = ? WHERE bucket_id = ? AND upper(ticker) = ?`)
          .run(c.english_name, c.bucket_id, up(c.ticker));
        cashRows += res.changes;
      }
    }
  });
  run();

  console.log(
    `[backfill-ticker-case] catalog-case rows updated: ${catalogRows}; cash rows updated: ${cashRows}.`,
  );
  app.close();
  market.close();
}

main();
