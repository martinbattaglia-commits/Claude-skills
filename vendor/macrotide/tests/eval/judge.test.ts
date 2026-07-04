// Token-free guard for the LLM-judge (scripts/eval/judge.ts, issue #65). The
// judge itself hits the live model API and is NOT part of `npm test`; this tests
// only its PURE pieces — prompt assembly, tolerant JSON parsing + schema
// validation, and score aggregation (mean / 0–1 normalize / Unknown handling) —
// so a broken judge is caught in CI before anyone spends tokens.
import { describe, expect, it } from "vitest";
import {
  aggregateScores,
  buildJudgeUserMessage,
  DEFAULT_JUDGE_MODEL,
  DIMENSION_RUBRIC,
  JUDGE_DIMENSIONS,
  type JudgeScores,
  parseJudge,
} from "../../scripts/eval/judge";

// Use key presence (not ??) so an explicit `null` override survives.
const pick = (o: Partial<Record<string, number | null>>, k: string, dflt: number): number | null =>
  k in o ? (o[k] as number | null) : dflt;

const fullScores = (overrides: Partial<Record<string, number | null>> = {}): JudgeScores => ({
  evidence: "EXAMPLE-FUND-A is 50% per read_portfolio",
  grounded: { why: "cites the 50% figure", score: pick(overrides, "grounded", 5) },
  complete: { why: "covers fees + concentration", score: pick(overrides, "complete", 4) },
  structured: { why: "diagnosis then action", score: pick(overrides, "structured", 4) },
  adaptive: { why: "defines TER", score: pick(overrides, "adaptive", 3) },
  helpful: { why: "commits to a next step", score: pick(overrides, "helpful", 5) },
  verdict: "solid, grounded review",
});

describe("DEFAULT_JUDGE_MODEL", () => {
  it("is a neutral, non-candidate family (not Sonnet, which is out-scored)", () => {
    expect(DEFAULT_JUDGE_MODEL).toBe("openai/gpt-5.5");
  });
  it("has a rubric line for every dimension", () => {
    for (const d of JUDGE_DIMENSIONS) {
      expect(DIMENSION_RUBRIC[d]).toBeTruthy();
    }
  });
});

describe("buildJudgeUserMessage", () => {
  const input = {
    question: {
      id: "P2-plan-tax-next-step",
      prompt: "Help me plan the Tax portfolio.",
      note: "diagnose why it lags",
    },
    answer: "Your Tax portfolio is 36% in one fund...",
    toolTrace: [{ name: "read_portfolio", args: { portfolio: "Tax" } }],
  };

  it("includes the question, its intent, the tool trace, and the answer", () => {
    const msg = buildJudgeUserMessage(input);
    expect(msg).toContain("P2-plan-tax-next-step");
    expect(msg).toContain("Help me plan the Tax portfolio.");
    expect(msg).toContain("diagnose why it lags");
    expect(msg).toContain('read_portfolio({"portfolio":"Tax"})');
    expect(msg).toContain("Your Tax portfolio is 36%");
  });

  it("notes when no tools were called (grounding has no source)", () => {
    const msg = buildJudgeUserMessage({ ...input, toolTrace: [] });
    expect(msg).toContain("(no tools called)");
  });

  it("includes the transcript for a multi-turn judgment", () => {
    const msg = buildJudgeUserMessage({ ...input, transcript: "user: hi\nassistant: hello" });
    expect(msg).toContain("FULL CONVERSATION");
    expect(msg).toContain("user: hi");
  });
});

describe("parseJudge", () => {
  it("parses a clean JSON object", () => {
    const json = JSON.stringify(fullScores());
    const parsed = parseJudge(json);
    expect(parsed?.grounded.score).toBe(5);
    expect(parsed?.adaptive.score).toBe(3);
  });

  it("tolerates prose/code-fences around the JSON", () => {
    const json =
      "```json\n" + JSON.stringify(fullScores({ helpful: 2 })) + "\n```\nThat's my verdict.";
    const parsed = parseJudge(json);
    expect(parsed?.helpful.score).toBe(2);
  });

  it("accepts null (Unknown) for a dimension", () => {
    const parsed = parseJudge(JSON.stringify(fullScores({ adaptive: null })));
    expect(parsed?.adaptive.score).toBeNull();
  });

  it("rejects out-of-range scores (schema guard)", () => {
    const bad = { ...fullScores(), grounded: { why: "x", score: 9 } };
    expect(parseJudge(JSON.stringify(bad))).toBeNull();
  });

  it("returns null on non-JSON", () => {
    expect(parseJudge("the answer was pretty good overall")).toBeNull();
  });

  it("parses JSON wrapped in a ```json code fence (kimi/minimax style)", () => {
    const fenced = "```json\n" + JSON.stringify(fullScores({ grounded: 4 })) + "\n```";
    expect(parseJudge(fenced)?.grounded.score).toBe(4);
  });

  it("skips prose-with-braces before the real object", () => {
    const noisy =
      "Here is my assessment {see below}:\n\n" + JSON.stringify(fullScores({ helpful: 3 }));
    expect(parseJudge(noisy)?.helpful.score).toBe(3);
  });

  it("does not miscount braces that appear inside string values", () => {
    const withBraces = {
      ...fullScores(),
      verdict: "uses a placeholder like {amount} in the answer",
    };
    expect(parseJudge(JSON.stringify(withBraces))?.verdict).toContain("{amount}");
  });

  it("still returns null on a truncated (unbalanced) object", () => {
    const truncated = '{"evidence":"x","grounded":{"why":"ok","score":4';
    expect(parseJudge(truncated)).toBeNull();
  });
});

describe("aggregateScores", () => {
  it("means the dimension scores and normalizes to 0–1", () => {
    const agg = aggregateScores(
      fullScores({ grounded: 5, complete: 5, structured: 5, adaptive: 5, helpful: 5 }),
    );
    expect(agg.mean).toBe(5);
    expect(agg.normalized).toBe(1); // (5-1)/4
    expect(agg.unknowns).toBe(0);
  });

  it("a floor of all-1s normalizes to 0", () => {
    const agg = aggregateScores(
      fullScores({ grounded: 1, complete: 1, structured: 1, adaptive: 1, helpful: 1 }),
    );
    expect(agg.mean).toBe(1);
    expect(agg.normalized).toBe(0);
  });

  it("excludes Unknown dimensions from the mean and counts them", () => {
    const agg = aggregateScores(
      fullScores({ grounded: 4, complete: 4, structured: null, adaptive: null, helpful: 4 }),
    );
    expect(agg.mean).toBe(4); // mean of the three 4s
    expect(agg.unknowns).toBe(2);
  });

  it("is all-Unknown safe (null mean, not NaN)", () => {
    const agg = aggregateScores(
      fullScores({
        grounded: null,
        complete: null,
        structured: null,
        adaptive: null,
        helpful: null,
      }),
    );
    expect(agg.mean).toBeNull();
    expect(agg.normalized).toBeNull();
    expect(agg.unknowns).toBe(5);
  });
});
