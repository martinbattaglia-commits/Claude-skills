// Unit tests for the total-return benchmark pre-warm job.
//
// Strategy: the job exposes injectable seams (_options / _warm) so these run
// without a real DB or network. Assertions cover the orchestration: every
// catalog entry warmed through its source + range, error isolation, and counts.

import { describe, expect, it, vi } from "vitest";
import type { BenchmarkOption } from "../market/benchmark-options";
import { prewarmBenchmark } from "./prewarm-benchmark";

const opt = (over: Partial<BenchmarkOption> = {}): BenchmarkOption => ({
  key: "acwi_tr",
  label: "Global equity (MSCI ACWI)",
  short: "MSCI ACWI",
  source: "benchmark_tr",
  ticker: "ACWI",
  ...over,
});

describe("prewarmBenchmark", () => {
  it("warms every option through its source + range and counts ok", async () => {
    const options = [opt({ key: "acwi_tr", ticker: "ACWI" }), opt({ key: "us_tr", ticker: "SPY" })];
    const warm = vi.fn().mockResolvedValue({});

    const res = await prewarmBenchmark({ range: "max", _options: options, _warm: warm });

    expect(res).toEqual({ requested: 2, ok: 2, failed: 0, errors: [] });
    expect(warm).toHaveBeenCalledWith("benchmark_tr", "ACWI", "max");
    expect(warm).toHaveBeenCalledWith("benchmark_tr", "SPY", "max");
  });

  it("plumbs the range through (daily append uses 1mo)", async () => {
    const warm = vi.fn().mockResolvedValue({});
    await prewarmBenchmark({ range: "1mo", _options: [opt()], _warm: warm });
    expect(warm).toHaveBeenCalledWith("benchmark_tr", "ACWI", "1mo");
  });

  it("isolates per-ticker failures — one throw does not abort the run", async () => {
    const options = [
      opt({ key: "acwi_tr", ticker: "ACWI" }),
      opt({ key: "bad", ticker: "BAD" }),
      opt({ key: "us_tr", ticker: "SPY" }),
    ];
    const warm = vi.fn(async (_source: string, ticker: string) => {
      if (ticker === "BAD") throw new Error("no data");
      return {};
    });

    const res = await prewarmBenchmark({ _options: options, _warm: warm });

    expect(res.ok).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.errors).toEqual([{ key: "bad", ticker: "BAD", error: "no data" }]);
  });

  it("defaults to range max when unspecified", async () => {
    const warm = vi.fn().mockResolvedValue({});
    await prewarmBenchmark({ _options: [opt()], _warm: warm });
    expect(warm).toHaveBeenCalledWith("benchmark_tr", "ACWI", "max");
  });
});
