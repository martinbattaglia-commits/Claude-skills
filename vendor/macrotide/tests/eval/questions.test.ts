// Cheap, token-free guard for the Advisor eval (scripts/eval). The eval itself
// hits the live model API and isn't part of `npm test`; this verifies its
// STRUCTURE — the question set is well-formed, expected tools exist on the
// synthetic surface, and the deterministic grader behaves — so a broken eval is
// caught in CI before anyone spends tokens running it.
import { describe, expect, it } from "vitest";
import { buildEvalTools, EVAL_TOOL_NAMES } from "../../scripts/eval/fixtures";
import {
  type EvalQuestion,
  gradeAnswer,
  QUESTIONS,
  questionsForTier,
} from "../../scripts/eval/questions";

describe("eval tool surface", () => {
  const tools = buildEvalTools();

  it("mirrors the real advisor + memory surface (9 + 5)", () => {
    expect(EVAL_TOOL_NAMES).toContain("read_portfolio");
    expect(EVAL_TOOL_NAMES).toContain("find_cheaper_alternatives");
    expect(EVAL_TOOL_NAMES.length).toBe(14);
  });

  it("every tool has a description and an execute", () => {
    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.description, name).toBe("string");
      expect(typeof t.execute, name).toBe("function");
    }
  });

  it("read_portfolio returns the synthetic fixture with a clear biggest holding", async () => {
    const out = (await tools.read_portfolio.execute?.({}, {} as never)) as unknown as {
      concentration: { top: { ticker: string; pct: number } };
    };
    expect(out.concentration.top.ticker).toBe("EXAMPLE-FUND-A");
    expect(out.concentration.top.pct).toBe(50);
  });

  it("the empty fixture routes portfolio reads to no-holdings (issue #69)", async () => {
    const empty = buildEvalTools({ empty: true });
    const p = (await empty.read_portfolio.execute?.({}, {} as never)) as { hasHoldings: boolean };
    const perf = (await empty.read_performance.execute?.({}, {} as never)) as { hasData: boolean };
    expect(p.hasHoldings).toBe(false);
    expect(perf.hasData).toBe(false);
    // The catalog is unaffected — funds exist regardless of what the user holds.
    expect(typeof empty.find_funds.execute).toBe("function");
  });
});

describe("eval question set", () => {
  it("has both tiers and no duplicate ids", () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(questionsForTier("retrieve").length).toBeGreaterThan(0);
    expect(questionsForTier("complex").length).toBeGreaterThan(0);
    expect(questionsForTier("all").length).toBe(QUESTIONS.length);
  });

  it("every question is well-formed and references only real tools", () => {
    for (const q of QUESTIONS) {
      expect(q.prompt.trim().length, q.id).toBeGreaterThan(0);
      expect(["retrieve", "complex", "memory"], q.id).toContain(q.tier);
      const e = q.expect;
      const hasCheck =
        !!e.mustInclude?.length ||
        !!e.anyOf?.length ||
        !!e.mustNotInclude?.length ||
        !!e.expectTools?.length;
      expect(hasCheck, `${q.id} has at least one expectation`).toBe(true);
      for (const t of e.expectTools ?? []) {
        expect(EVAL_TOOL_NAMES as string[], `${q.id} expects real tool ${t}`).toContain(t);
      }
    }
  });
});

describe("gradeAnswer", () => {
  const q: EvalQuestion = {
    id: "T",
    tier: "retrieve",
    prompt: "x",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: ["EXAMPLE-FUND-A", /50\s?%/],
      anyOf: [/biggest|largest/i],
      mustNotInclude: [/EXAMPLE-FUND-Z/],
    },
  };

  it("scores a grounded, complete, safe answer 1.0", () => {
    const r = gradeAnswer(q, {
      text: "Your largest holding is EXAMPLE-FUND-A at 50%.",
      toolNames: ["read_portfolio"],
    });
    expect(r.score).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it("penalizes a missing fact and a missing tool call", () => {
    const r = gradeAnswer(q, {
      text: "Your biggest fund is large.",
      toolNames: [],
    });
    expect(r.score).toBeLessThan(1);
    expect(r.failures.join(" ")).toContain("EXAMPLE-FUND-A");
    expect(r.failures.join(" ")).toContain("read_portfolio");
  });

  it("flags a hallucinated holding via mustNotInclude", () => {
    const r = gradeAnswer(q, {
      text: "Your biggest is EXAMPLE-FUND-A at 50% and also EXAMPLE-FUND-Z.",
      toolNames: ["read_portfolio"],
    });
    expect(r.failures.join(" ")).toContain("EXAMPLE-FUND-Z");
  });

  it("splits checks into facts / tools / safety sub-signals", () => {
    const r = gradeAnswer(q, {
      text: "Your largest holding is EXAMPLE-FUND-A at 50%.",
      toolNames: ["read_portfolio"],
    });
    // facts = mustInclude(2) + anyOf(1); tools = expectTool(1) + minToolCalls(1);
    // safety = mustNotInclude(1).
    expect(r.byCategory.facts).toEqual({ passed: 3, total: 3 });
    expect(r.byCategory.tools).toEqual({ passed: 2, total: 2 });
    expect(r.byCategory.safety).toEqual({ passed: 1, total: 1 });
  });

  it("mustNotCallTools penalizes over-calling under the tools category", () => {
    const overcall: EvalQuestion = {
      id: "N",
      tier: "retrieve",
      prompt: "x",
      expect: { anyOf: [/ok/i], mustNotCallTools: ["propose_holding"] },
    };
    const bad = gradeAnswer(overcall, { text: "ok", toolNames: ["propose_holding"] });
    expect(bad.failures.join(" ")).toContain("mustNotCallTool propose_holding");
    expect(bad.byCategory.tools.passed).toBe(0);
    const good = gradeAnswer(overcall, { text: "ok", toolNames: [] });
    expect(good.score).toBe(1);
  });

  it("expectToolArgs checks grounded arguments, not just the tool name (issue #68)", () => {
    const argQ: EvalQuestion = {
      id: "A",
      tier: "complex",
      prompt: "x",
      expect: {
        expectTools: ["find_cheaper_alternatives"],
        expectToolArgs: [{ tool: "find_cheaper_alternatives", contains: /EXAMPLE-FUND-A/i }],
      },
    };
    const grounded = gradeAnswer(argQ, {
      text: "ok",
      toolNames: ["find_cheaper_alternatives"],
      toolCalls: [{ name: "find_cheaper_alternatives", args: { fundAbbr: "EXAMPLE-FUND-A" } }],
    });
    expect(grounded.failures.join(" ")).not.toContain("expectToolArgs");
    expect(grounded.score).toBe(1);

    // Right tool, but the call didn't carry the held fund → the arg check fails
    // even though the name-level check still passes.
    const ungrounded = gradeAnswer(argQ, {
      text: "ok",
      toolNames: ["find_cheaper_alternatives"],
      toolCalls: [{ name: "find_cheaper_alternatives", args: {} }],
    });
    expect(ungrounded.failures.join(" ")).toContain("expectToolArgs");
    expect(ungrounded.byCategory.tools.passed).toBeLessThan(ungrounded.byCategory.tools.total);
  });

  it("maxSteps flags a lookup that thrashed; passes a tight trajectory (issue #68)", () => {
    const stepQ: EvalQuestion = {
      id: "S",
      tier: "retrieve",
      prompt: "x",
      expect: { anyOf: [/ok/i], maxSteps: 3 },
    };
    const tight = gradeAnswer(stepQ, { text: "ok", toolNames: ["read_portfolio"], steps: 2 });
    expect(tight.score).toBe(1);
    const looped = gradeAnswer(stepQ, { text: "ok", toolNames: ["read_portfolio"], steps: 5 });
    expect(looped.failures.join(" ")).toContain("maxSteps");
    expect(looped.byCategory.tools.passed).toBeLessThan(looped.byCategory.tools.total);
    // A bound with no reported step count fails closed rather than silently passing.
    const noSteps = gradeAnswer(stepQ, { text: "ok", toolNames: [] });
    expect(noSteps.failures.join(" ")).toContain("maxSteps");
  });

  it("the empty-holdings control passes a refusal, fails a fabrication (issue #69)", () => {
    const n2 = QUESTIONS.find((q) => q.id === "N2-empty-holdings");
    expect(n2, "N2-empty-holdings exists").toBeDefined();
    if (!n2) return;
    const refusal = gradeAnswer(n2, {
      text: "You have no holdings yet — add a holding to get started.",
      toolNames: ["read_portfolio"],
    });
    expect(refusal.score).toBe(1);
    const fabricated = gradeAnswer(n2, {
      text: "Trim EXAMPLE-FUND-A from 50% and add bonds.",
      toolNames: ["read_portfolio"],
    });
    expect(fabricated.score).toBeLessThan(1);
    expect(fabricated.byCategory.safety.passed).toBeLessThan(fabricated.byCategory.safety.total);
  });
});
