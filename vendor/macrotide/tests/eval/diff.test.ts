// Token-free guard for the eval result-diff logic (scripts/eval/diff.ts, issue
// #67): pairing by model::qid, score deltas, pass^k flips, the paired test, and
// set-change detection — on hand-built result objects with known answers.
import { describe, expect, it } from "vitest";
import { type DiffRow, diffRuns, type ResultFile } from "../../scripts/eval/diff";

const file = (rows: DiffRow[]): ResultFile => ({ rows });
const row = (qid: string, score: number, pass: boolean, tier = "retrieve"): DiffRow => ({
  model: "m",
  qid,
  tier,
  score,
  pass,
  ok: true,
  err: false,
});

describe("diffRuns", () => {
  const before = file([row("Q1", 1, true), row("Q2", 0.5, false), row("Q3", 1, true, "complex")]);
  const after = file([
    row("Q1", 0.5, false), // regressed + new failure
    row("Q2", 1, true), // improved + fixed
    row("Q3", 1, true, "complex"), // unchanged
  ]);

  it("pairs by model::qid and reports score deltas", () => {
    const d = diffRuns(before, after);
    expect(d.beforeMean).toBeCloseTo((1 + 0.5 + 1) / 3, 6);
    expect(d.afterMean).toBeCloseTo((0.5 + 1 + 1) / 3, 6);
    expect(d.regressions.map((r) => r.qid)).toEqual(["Q1"]);
    expect(d.improvements.map((r) => r.qid)).toEqual(["Q2"]);
  });

  it("tracks pass^k flips both ways", () => {
    const d = diffRuns(before, after);
    expect(d.newFailures.map((r) => r.qid)).toEqual(["Q1"]);
    expect(d.newFixes.map((r) => r.qid)).toEqual(["Q2"]);
  });

  it("runs a paired McNemar over the shared set (one flip each way → p=1)", () => {
    const d = diffRuns(before, after);
    expect(d.mcnemar.b).toBe(1);
    expect(d.mcnemar.c).toBe(1);
    expect(d.mcnemar.pValue).toBe(1);
  });

  it("flags questions present in only one file", () => {
    const d = diffRuns(before, file([...after.rows, row("Q4", 1, true, "complex")]));
    expect(d.addedKeys).toContain("m::Q4");
    expect(d.removedKeys).toEqual([]);
  });

  it("aggregates multiple runs per question (avg score, pass^k = all passed)", () => {
    const a = file([row("Q1", 1, true), row("Q1", 0, false)]); // avg .5, not all-pass
    const b = file([row("Q1", 1, true), row("Q1", 1, true)]); // avg 1, all-pass
    const d = diffRuns(a, b);
    expect(d.beforeMean).toBeCloseTo(0.5, 6);
    expect(d.afterMean).toBe(1);
    expect(d.newFixes.map((r) => r.qid)).toEqual(["Q1"]);
  });
});
