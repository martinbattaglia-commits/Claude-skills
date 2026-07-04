// Tests for the fund-catalog refresh CLI script.
//
// Coverage: the pure CLI-layer helpers — parseArgs and exceedsErrorThreshold.
// The actual crawl (refreshFundCatalog) is covered in
// lib/jobs/refresh-fund-catalog.test.ts; this file focuses on the exit-code
// policy so a handful of transient upstream errors can't fail the whole job.

import { describe, expect, it } from "vitest";
import {
  ERROR_FLOOR,
  ERROR_RATE,
  exceedsErrorThreshold,
  parseArgs,
} from "../scripts/refresh-fund-catalog";

describe("parseArgs", () => {
  it("defaults to no limit and not dry-run", () => {
    expect(parseArgs([])).toEqual({ limit: 0, dryRun: false });
  });

  it("parses --limit and --dry-run", () => {
    expect(parseArgs(["--limit=25", "--dry-run"])).toEqual({ limit: 25, dryRun: true });
  });

  it("ignores malformed --limit", () => {
    expect(parseArgs(["--limit=abc"])).toEqual({ limit: 0, dryRun: false });
  });
});

describe("exceedsErrorThreshold", () => {
  it("tolerates a handful of errors in a large run (the real-world case)", () => {
    // 3 / 8843 — the nightly crawl that prompted this; must NOT fail.
    expect(exceedsErrorThreshold(3, 8843)).toBe(false);
  });

  it("tolerates errors up to the floor regardless of rate", () => {
    // 5 errors out of 5 funds is 100% rate, but below ERROR_FLOOR → tolerate.
    expect(exceedsErrorThreshold(ERROR_FLOOR, ERROR_FLOOR)).toBe(false);
  });

  it("fails when errors are both above the floor and above the rate", () => {
    // 60 / 100 = 60% > 5% and > floor → systemic, fail.
    expect(exceedsErrorThreshold(60, 100)).toBe(true);
  });

  it("requires BOTH conditions — high count but low rate is tolerated", () => {
    // 50 errors but out of 100k funds = 0.05% << ERROR_RATE → tolerate.
    expect(exceedsErrorThreshold(50, 100_000)).toBe(false);
  });

  it("requires BOTH conditions — high rate but tiny count is tolerated", () => {
    // 3 / 4 = 75% rate but only 3 errors (≤ floor) → tolerate (dev --limit run).
    expect(exceedsErrorThreshold(3, 4)).toBe(false);
  });

  it("is exactly at the rate boundary (strictly greater required)", () => {
    // ERROR_RATE * 1000 = 50 errors is exactly the rate, not above it → tolerate.
    expect(exceedsErrorThreshold(ERROR_RATE * 1000, 1000)).toBe(false);
    expect(exceedsErrorThreshold(ERROR_RATE * 1000 + 1, 1000)).toBe(true);
  });

  it("tolerates zero errors and guards fundsSeen=0", () => {
    expect(exceedsErrorThreshold(0, 1000)).toBe(false);
    expect(exceedsErrorThreshold(5, 0)).toBe(false);
  });
});
