// Tests for the one-time fund_portfolio cleanup script. Drives the REAL
// exported helpers against a synthetic in-memory DB (no SQL replica), covering
// the three steps: period normalization, snapshot-collapse (keep latest
// re-publication per period), and exact-dedup.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, inspect } from "../scripts/dedupe-fund-portfolio.mjs";

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fund_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proj_id TEXT, period TEXT, as_of_date TEXT, assetliab_id TEXT,
      assetliab_desc TEXT, issue_code TEXT, isin_code TEXT, issuer TEXT,
      assetliab_value REAL, percent_nav REAL, last_upd_date TEXT
    );
    CREATE TABLE fund_portfolio_asset_type (
      proj_id TEXT, period TEXT, assetliab_code TEXT, percent_nav REAL
    );
  `);
});

afterEach(() => db.close());

// Insert a portfolio row; period is passed as-is (number to simulate the wire type).
function ins(row: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO fund_portfolio
       (proj_id, period, as_of_date, assetliab_id, issue_code, isin_code, issuer, percent_nav, last_upd_date)
     VALUES (@proj_id, @period, @as_of_date, @assetliab_id, @issue_code, @isin_code, @issuer, @percent_nav, @last_upd_date)`,
  ).run({
    as_of_date: "2026-03-31",
    assetliab_id: "108",
    issue_code: null,
    isin_code: null,
    issuer: null,
    percent_nav: 100,
    last_upd_date: null,
    ...row,
  });
}

const rows = (projId: string, period: string) =>
  db
    .prepare("SELECT * FROM fund_portfolio WHERE proj_id = ? AND period = ? ORDER BY id")
    .all(projId, period) as Array<Record<string, unknown>>;

describe("dedupe-fund-portfolio cleanup", () => {
  it("keeps only the latest snapshot when a period was re-published (restated)", () => {
    // Period 202603 published twice; the SECOND (May) supersedes the first (Apr).
    const OLD = "2026-04-16T16:32:05";
    const NEW = "2026-05-14T15:01:26";
    for (const upd of [OLD, NEW]) {
      ins({
        proj_id: "A",
        period: "202603",
        issue_code: "MSAIOPZLX",
        isin_code: "LU1378878604",
        percent_nav: 100.16,
        last_upd_date: upd,
      });
      ins({
        proj_id: "A",
        period: "202603",
        issue_code: "CASH",
        percent_nav: 1.63,
        last_upd_date: upd,
      });
    }

    expect(inspect(db).staleSnapshot).toBe(2); // the two April rows
    cleanup(db);

    const kept = rows("A", "202603");
    expect(kept).toHaveLength(2); // one MSAIOPZLX, one CASH — not four
    expect(kept.every((r) => r.last_upd_date === NEW)).toBe(true); // newest snapshot wins
    expect(kept.map((r) => r.issue_code).sort()).toEqual(["CASH", "MSAIOPZLX"]);
  });

  it("preserves distinct past PERIODS (the time series is not touched)", () => {
    ins({ proj_id: "A", period: "202512", issue_code: "X", last_upd_date: "2026-01-10T00:00:00" });
    ins({ proj_id: "A", period: "202603", issue_code: "X", last_upd_date: "2026-04-10T00:00:00" });
    cleanup(db);
    expect(rows("A", "202512")).toHaveLength(1);
    expect(rows("A", "202603")).toHaveLength(1);
  });

  it("normalizes the numeric/float period artifact to a clean YYYYMM string", () => {
    // The wire bug stored numbers as "202512.0".
    ins({
      proj_id: "B",
      period: "202512.0",
      issue_code: "X",
      last_upd_date: "2026-01-10T00:00:00",
    });
    db.prepare("INSERT INTO fund_portfolio_asset_type VALUES ('B','202512.0','EQ',100)").run();
    cleanup(db);
    expect(rows("B", "202512")).toHaveLength(1);
    expect(db.prepare("SELECT period FROM fund_portfolio_asset_type").pluck().get()).toBe("202512");
    expect(inspect(db).dottyPortfolio).toBe(0);
  });

  it("removes exact-duplicate rows, keeping the lowest id", () => {
    for (let i = 0; i < 6; i++) {
      ins({
        proj_id: "C",
        period: "202603",
        issue_code: "EWT US",
        isin_code: "US46434G7723",
        percent_nav: 19.14,
        last_upd_date: "2026-04-16T16:32:05",
      });
    }
    expect(inspect(db).exactDup).toBe(5);
    cleanup(db);
    expect(rows("C", "202603")).toHaveLength(1);
  });

  it("is idempotent — a second run changes nothing", () => {
    const OLD = "2026-04-16T16:32:05";
    const NEW = "2026-05-14T15:01:26";
    for (const upd of [OLD, NEW])
      ins({ proj_id: "A", period: "202603", issue_code: "Y", last_upd_date: upd });
    cleanup(db);
    const first = inspect(db);
    const second = cleanup(db);
    expect(second).toEqual({ snapshot: 0, exact: 0 });
    expect(inspect(db).total).toBe(first.total);
  });
});
