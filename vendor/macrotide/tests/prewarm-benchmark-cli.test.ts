// Tests for the benchmark pre-warm CLI script.
//
// Coverage: the pure parseArgs helper. The warm orchestration (prewarmBenchmark)
// is covered in lib/jobs/prewarm-benchmark.test.ts.

import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/prewarm-benchmark";

describe("parseArgs", () => {
  it("defaults to range max (the backfill)", () => {
    expect(parseArgs([])).toEqual({ range: "max" });
  });

  it("parses --range for the daily append", () => {
    expect(parseArgs(["--range=1mo"])).toEqual({ range: "1mo" });
  });

  it("ignores an unknown range and keeps the default", () => {
    expect(parseArgs(["--range=decade"]).range).toBe("max");
  });
});
