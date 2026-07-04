import { describe, expect, it } from "vitest";
import { classifyReasoningIntent } from "./intent";

describe("classifyReasoningIntent — retrieve-then-explain stays fast (effort none)", () => {
  const simple = [
    "Read my portfolio and tell me my biggest holding.",
    "Am I beating my index?",
    "Give me a quick health check on my portfolio.",
    "What's my blended fee?",
    "What is index investing?",
    "Explain this fund's expense ratio.",
    "How concentrated am I?",
    "",
  ];
  for (const text of simple) {
    it(`none: ${JSON.stringify(text).slice(0, 40)}`, () => {
      const d = classifyReasoningIntent(text);
      expect(d.analytical).toBe(false);
      expect(d.effort).toBe("none");
    });
  }
});

describe("classifyReasoningIntent — multi-step judgment raises effort (medium)", () => {
  const analytical = [
    "Give me a step-by-step rebalance plan to hit my target.",
    "Should I rebalance now or wait?",
    "SSF vs RMF for my situation this year?",
    "Should I tilt more to global equity given the weak baht?",
    "Given the THB has been weak, should I overweight US stocks?",
    "Compare hedged versus unhedged exposure for me.",
    "Is it worth tilting toward gold as a hedge?",
    // Holistic review + planning (Wave 2) — incl. the two motivating questions.
    "What do you think of all of my portfolios?",
    "I feel like my Tax portfolio has low return. Help me plan the next step for that portfolio.",
    "Can you review my portfolio and tell me what to improve?",
    "What should I do next with my retirement money?",
    "My Global fund is lagging its benchmark — what now?",
  ];
  for (const text of analytical) {
    it(`medium: ${text.slice(0, 40)}`, () => {
      const d = classifyReasoningIntent(text);
      expect(d.analytical).toBe(true);
      expect(d.effort).toBe("medium");
      expect(d.signals.length).toBeGreaterThan(0);
    });
  }
});

describe("classifyReasoningIntent — EntryContext intent", () => {
  it("rebalance intent is analytical even with a terse prompt", () => {
    const d = classifyReasoningIntent("help", { intent: "rebalance" });
    expect(d.effort).toBe("medium");
    expect(d.signals).toContain("intent:rebalance");
  });

  it("pure-lookup intents stay none", () => {
    for (const intent of ["fund_lookup", "fee_switch", "strategy_explain"]) {
      const d = classifyReasoningIntent("what does this mean?", { intent });
      expect(d.effort, intent).toBe("none");
    }
  });

  it("the Discuss/review headline intents are analytical (structured review)", () => {
    for (const intent of ["health_review", "score_review", "review", "plan"]) {
      const d = classifyReasoningIntent("help", { intent });
      expect(d.effort, intent).toBe("medium");
      expect(d.signals).toContain(`intent:${intent}`);
    }
  });

  it("combines prompt + intent signals", () => {
    const d = classifyReasoningIntent("step-by-step please", { intent: "rebalance" });
    expect(d.signals).toContain("intent:rebalance");
    expect(d.signals).toContain("step-by-step");
  });
});

describe("classifyReasoningIntent — explicit memory intent (backstop trigger)", () => {
  const memory = [
    "Remember that I prefer low-fee index funds.",
    "From now on, keep your answers short.",
    "Note that I'm 30 with a 20-year horizon.",
    "Don't forget I'm risk-averse.",
    "Forget that I wanted to add bonds.",
    "For your records, my timezone is Asia/Bangkok.",
    "Keep that in mind when you advise me.",
  ];
  for (const text of memory) {
    it(`memoryIntent: ${text.slice(0, 40)}`, () => {
      expect(classifyReasoningIntent(text).memoryIntent).toBe(true);
    });
  }

  // Lookups, analysis, and a RECALL question ("what do you remember") must NOT
  // trigger the forced-save backstop — only an explicit capture/forget directive.
  const notMemory = [
    "Read my portfolio and tell me my biggest holding.",
    "Should I rebalance now or wait?",
    "What do you remember about me?",
    "Actually, always lead with fees when comparing funds.",
    "",
  ];
  for (const text of notMemory) {
    it(`not memoryIntent: ${JSON.stringify(text).slice(0, 40)}`, () => {
      expect(classifyReasoningIntent(text).memoryIntent).toBe(false);
    });
  }
});
