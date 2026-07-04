// The committed Advisor benchmark questions + a deterministic grader.
//
// Two tiers (issue #59):
//  - "retrieve": the common path — read a tool, report the number. Reasoning is
//    pure cost here (see docs/explanation/inference-strategy.md §3).
//  - "complex":  multi-step judgment the tools didn't pre-compute (rebalance
//    sequencing, SSF-vs-RMF weighing, a plan-anchored tilt). Where reasoning may
//    earn its cost — the tier that lets us MEASURE that, not guess.
//
// Quality is graded deterministically, not by an LLM judge: each question lists
// the grounded facts the answer must carry (it read the synthetic data), the
// tools it should have called, and guards against inventing data. That measures
// the two things that actually make Advisor answers good — grounded + complete +
// safe — cheaply and repeatably. An optional LLM-judge layer can be added later;
// the deterministic floor is what guards a model/prompt change.

export type Matcher = string | RegExp;

/**
 * Assert a tool was called with grounded ARGUMENTS, not just by name (issue
 * #68): some call to `tool` had a serialized argument object matching `contains`.
 * Checks the call carried the right inputs (e.g. find_cheaper_alternatives was
 * asked about the fund the user actually holds), which a name-only check misses.
 */
export interface ToolArgCheck {
  tool: string;
  contains: Matcher;
}

export interface Expect {
  /** Every matcher must appear in the answer (grounded facts / completeness). */
  mustInclude?: Matcher[];
  /** At least one must appear (tolerates phrasing variation). */
  anyOf?: Matcher[];
  /** None may appear (hallucination / wrong-direction guards). */
  mustNotInclude?: Matcher[];
  /** These tool names must have been called during the turn. */
  expectTools?: string[];
  /** These tool names must NOT have been called — guards against over-calling
   * (a simple lookup spuriously proposing an edit, or a concept question that
   * fires a fund search). Per the agent-evals research: test negative cases. */
  mustNotCallTools?: string[];
  /** Minimum number of tool calls (defaults to expectTools.length when unset). */
  minToolCalls?: number;
  /** A tool was called with arguments matching a pattern (grounding, not just
   * the tool name). Needs the run to capture tool inputs (run.ts). */
  expectToolArgs?: ToolArgCheck[];
  /** Upper bound on trajectory length (model generations) — catches a lookup
   * that thrashes or loops instead of answering in a step or two (issue #68).
   * Graded under "tools"; needs the run to report `steps`. */
  maxSteps?: number;
  /** Lower bound on trajectory length (rarely needed; a turn that should have
   * taken at least one tool round-trip). Graded under "tools". */
  minSteps?: number;
}

export type EvalTier = "retrieve" | "complex" | "memory";

export interface EvalQuestion {
  id: string;
  tier: EvalTier;
  prompt: string;
  /** Optional FOLLOW-UP user messages after `prompt`, turning the question into a
   * multi-turn "long discussion". The run threads the assistant + tool messages
   * back between turns; the deterministic grader + the LLM-judge evaluate the
   * FINAL turn (the judge also sees the whole transcript for cross-turn coherence
   * + did-it-remember-context). Single-turn questions omit this. */
  turns?: string[];
  expect: Expect;
  /** Which synthetic data surface to run against (issue #69). "empty" routes the
   * portfolio reads to the no-holdings fixture; defaults to the populated one. */
  fixture?: "default" | "empty";
  /** Why this question is here / what it probes. */
  note?: string;
}

// NOTE: the per-turn safety disclaimer is no longer a hard requirement. The
// Advisor now gives a light, natural "your decision" note only when it adds value
// (not a rote sign-off on every guidance turn), so a mandatory mustInclude on it
// would gate on undesired behavior. Grounding/completeness checks below still
// assert the answer carries the real figures and the right action.

export const QUESTIONS: EvalQuestion[] = [
  // ── Tier 1: retrieve-then-explain (the common path) ───────────────────────
  {
    id: "R1-biggest-holding",
    tier: "retrieve",
    prompt: "Read my portfolio and tell me my single biggest holding and what percent it is.",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: ["EXAMPLE-FUND-A", /50\s?%/],
      // A read-only lookup must not propose changes to the portfolio/plan.
      mustNotCallTools: ["propose_holding", "propose_plan_edit"],
      // One read + one answer ≈ 2 generations; >3 means it looped on a lookup.
      maxSteps: 3,
    },
    note: "Pure lookup: a tool returns the answer. Reasoning is wasted cost.",
  },
  {
    id: "R2-beating-index",
    tier: "retrieve",
    prompt: "Am I beating my index? Check my performance.",
    expect: {
      expectTools: ["read_performance"],
      mustInclude: [/7\.1/, /4\.3/],
      anyOf: [/beat/i, /ahead/i, /outperform/i, /\bSET\b/],
    },
    note: "Beats the SET (+4.3) but trails the S&P (+9.8) — a good answer reports the real split.",
  },
  {
    id: "R3-health-check",
    tier: "retrieve",
    prompt: "Give me a quick health check on my portfolio.",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/drift/i, /underweight/i, /concentrat/i, /fee|ter|expense/i, /bond/i],
    },
    note: "Reads health and summarizes — knowledge-light, no deduction.",
  },
  {
    id: "R4-concentration",
    tier: "retrieve",
    prompt: "How concentrated is my portfolio? Is any one fund too big?",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: ["EXAMPLE-FUND-A"],
      anyOf: [/50\s?%/, /top\s*3|top-3|90\s?%/i, /concentrat/i],
    },
  },
  {
    id: "R5-blended-fee",
    tier: "retrieve",
    prompt: "What's my blended fee, and is it high?",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/0\.58|0\.59|0\.6\b/, /blended|weighted/i],
    },
    note: "blendedTer 0.585 — the tool computes it; the model just reports.",
  },
  {
    id: "R6-explain-concept",
    tier: "retrieve",
    prompt: "In one short paragraph, what is index investing and why does it suit me?",
    expect: {
      anyOf: [/index/i],
      mustNotInclude: [/EXAMPLE-FUND-[B-Z]/],
      // A concept explanation shouldn't search the catalog or propose anything.
      mustNotCallTools: ["find_funds", "propose_holding", "propose_plan_edit"],
    },
    note: "Knowledge recall + clear writing, not deduction; no tool strictly required.",
  },
  {
    // Negative control: a definitional question the model should answer from
    // knowledge with NO tool call at all — guards against reflexive over-calling.
    id: "N1-no-overcall",
    tier: "retrieve",
    prompt: "Quick one — what does the abbreviation TER stand for?",
    expect: {
      anyOf: [/total expense ratio/i, /expense ratio/i],
      mustNotCallTools: [
        "read_portfolio",
        "read_performance",
        "find_funds",
        "find_cheaper_alternatives",
        "propose_holding",
        "propose_plan_edit",
      ],
    },
    note: "No tool needed; a model that reads the portfolio to define an acronym is over-calling.",
  },
  {
    // Negative control (issue #69): the user has NO holdings. The honest answer
    // is "you have nothing to analyze yet" — refusing to fabricate an analysis.
    // Inventing a fund code or an allocation here is the hallucination this
    // synthetic-data eval most needs to catch.
    id: "N2-empty-holdings",
    tier: "retrieve",
    fixture: "empty",
    prompt: "How's my portfolio doing? Give me a rebalance plan to get back on target.",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [
        /no holding|don'?t have any|haven'?t added|nothing to|once you add|add (a |your )?holding|get started|empty/i,
      ],
      // With no data, there is nothing real to name or quantify — any fund code
      // or concrete allocation % is invented.
      mustNotInclude: [/EXAMPLE-FUND-[A-Z]/, /\b\d{1,3}\s?%/],
    },
    note: "Refusal control: empty portfolio → must say 'no holdings', not fabricate a plan.",
  },

  // ── Tier 2: complex multi-step (where reasoning may help) ─────────────────
  {
    id: "C1-rebalance-plan",
    tier: "complex",
    prompt: "Give me a step-by-step rebalance plan to get my portfolio back to my target model.",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/trim|sell|reduce|cut/i],
      mustInclude: [/bond/i],
    },
    note: "Multi-step: compute trades to close +10/+5/−15pp drift, sequence them. Reasoning candidate.",
  },
  {
    id: "C2-ssf-vs-rmf",
    tier: "complex",
    prompt:
      "I have ฿100,000 to invest in a tax-advantaged fund this year. Should I use an SSF or an RMF for my situation? Find me options.",
    expect: {
      expectTools: ["find_funds"],
      mustInclude: [/SSF/i, /RMF/i],
      anyOf: [/lock|withdraw|until|age 55|horizon|liquid/i],
      // Grounding: the search was actually filtered to a tax wrapper, not generic.
      expectToolArgs: [{ tool: "find_funds", contains: /SSF|RMF/i }],
    },
    note: "Rules interplay (lock-up, deductions) + the user's numbers → a real weighing.",
  },
  {
    id: "C3-fx-tilt",
    tier: "complex",
    prompt:
      "The Thai baht has been weak lately. Should I tilt more toward global equity given that, or stick to my plan?",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/plan|target|already|overweight|50\s?%|discipline|stick/i],
    },
    note: "Weighs a macro factor against the plan — must stay plan-anchored, not chase FX.",
  },
  {
    id: "C4-fee-switch",
    tier: "complex",
    prompt:
      "I hold EXAMPLE-FUND-A. Is there a cheaper fund with the same exposure, and should I switch?",
    expect: {
      expectTools: ["find_cheaper_alternatives"],
      mustInclude: ["EXAMPLE-FUND-D", /0\.2(0)?\s?%/],
      anyOf: [/0\.4(0)?\s?(pp|%)|saving|cheaper|lower fee/i],
      // Grounding: it asked about the fund the user actually said they hold.
      expectToolArgs: [{ tool: "find_cheaper_alternatives", contains: /EXAMPLE-FUND-A/i }],
    },
    note: "Fee delta reasoning + a switch recommendation grounded in the alternative the tool returned.",
  },

  // ── Per-portfolio review & planning (the user keeps SEPARATE portfolios) ────
  {
    // The motivating "what do you think of ALL my portfolios?" — a holistic
    // review that must use the per-portfolio breakdown to compare them and name
    // the laggard, not collapse everything into one whole-book number.
    id: "P1-review-all-portfolios",
    tier: "complex",
    prompt: "What do you think of all of my portfolios? Which one is doing worst, and why?",
    expect: {
      expectTools: ["read_portfolio"],
      // Both portfolios named, and the laggard (Tax) flagged with its weak return.
      mustInclude: [/Core/, /Tax/],
      anyOf: [/1\.2\s?%|lag|worst|low(er)? return|trail|behind|weak/i],
      // No fabricated portfolios or funds beyond the synthetic set.
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Holistic review across portfolios — compare each (per-bucket breakdown) and name the laggard.",
  },
  {
    // The motivating "my Tax portfolio's return is low — plan the next step".
    // Must SCOPE to the Tax portfolio (grounded tool arg), diagnose why, and end
    // with a concrete next step + the educational disclaimer (it gives guidance).
    id: "P2-plan-tax-next-step",
    tier: "complex",
    prompt:
      "I feel like my Tax portfolio has a low return. Help me plan the next step for that portfolio.",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: [/Tax/],
      // A concrete, prioritized action — not a vague "consider rebalancing".
      anyOf: [/cash|rebalanc|add|contribut|diversif|switch|trim|concentrat|single fund/i],
      // Grounding: it scoped the read to the Tax portfolio by name.
      expectToolArgs: [{ tool: "read_portfolio", contains: /tax/i }],
    },
    note: "Diagnose WHY the Tax portfolio lags (single-fund concentration, cash drag) → a prioritized next step.",
  },
  {
    // Scoped performance: one portfolio's return vs the market.
    id: "P3-tax-performance-scoped",
    tier: "complex",
    prompt: "How is just my Tax portfolio doing versus the market lately?",
    expect: {
      expectTools: ["read_performance"],
      mustInclude: [/Tax/],
      anyOf: [/0\.7\s?%|trail|behind|lag|below|under/i],
      // Grounding: the performance read was scoped to the Tax portfolio.
      expectToolArgs: [{ tool: "read_performance", contains: /tax/i }],
    },
    note: "Per-portfolio performance — scope the return to one portfolio and compare to the indices.",
  },

  // ── Expanded complex-tier golden set (issue #70) ────────────────────────────
  // These deliberately under-specify the deterministic checks (grounding + safety
  // floor only) and lean on the LLM-judge (EVAL_JUDGE=on) for the qualities regex
  // can't see — adaptivity, structure, genuine helpfulness. Freeze-then-extend:
  // additive, no loosening of the questions above.
  {
    // Adaptivity probe: a self-described beginner. The judge's `adaptive` lens
    // does the real grading; deterministically we only guard grounding + that it
    // didn't bury a beginner in fund codes they didn't ask about.
    id: "G1-beginner-review",
    tier: "complex",
    prompt:
      "I'm new to investing and I don't really understand all the jargon. Can you look at my portfolios and explain in simple terms how I'm doing?",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: [/Core/, /Tax/],
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Beginner framing — judge scores `adaptive` (defines jargon, plain language) above all.",
  },
  {
    // New-money allocation: bonds are 15pp under target in the book, so the
    // grounded answer steers new money toward bonds. A real number/sleeve, not
    // 'talk to an advisor'.
    id: "G2-new-money-allocation",
    tier: "complex",
    prompt: "I just got a ฿200,000 bonus to invest. Where should it go across what I already hold?",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/bond/i, /underweight/i, /target/i],
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Plan-anchored allocation of new money — bonds are −15pp, so a grounded answer tilts there.",
  },
  {
    // Decision-forcing diagnosis of the weak, single-fund Tax portfolio.
    id: "G3-weak-subportfolio",
    tier: "complex",
    prompt:
      "My Tax portfolio is basically all in one fund. Is that actually a problem, and what would you do about it?",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: [/Tax/],
      anyOf: [/83\s?%/, /concentrat/i, /diversif/i, /single fund|one fund/i, /add|spread/i],
      expectToolArgs: [{ tool: "read_portfolio", contains: /tax/i }],
    },
    note: "Concentration diagnosis + a committed action — judge scores `structured` + `helpful`.",
  },
  {
    // Cross-portfolio comparison: which is healthier, with the per-bucket numbers.
    id: "G4-compare-portfolios",
    tier: "complex",
    prompt: "Compare my Core and Tax portfolios — which one is healthier, and why?",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: [/Core/, /Tax/],
      anyOf: [/9\.4|1\.2/, /return|irr/i, /fee|ter/i, /concentrat|cash/i],
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Side-by-side using the per-bucket breakdown (Core IRR 9.4% vs Tax 1.2%) — judge: `complete`.",
  },
  {
    // Prioritization: force ONE most-important action across the whole book.
    id: "G5-single-priority",
    tier: "complex",
    prompt:
      "Across everything I hold, what's the single most important thing I should fix this month?",
    expect: {
      expectTools: ["read_portfolio"],
      anyOf: [/bond/i, /cash/i, /concentrat/i, /fee/i, /rebalanc/i, /Tax/],
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Commit to ONE prioritized fix, not a laundry list — judge scores `helpful` (does it commit?).",
  },
  {
    // The motivating "long discussion" (issue #70, multi-turn). Threads four user
    // turns; the run carries the assistant + tool messages between them. The
    // deterministic floor grades the FINAL (beginner-explanation) turn; the judge
    // scores the whole transcript for coherence + did-it-remember + adaptivity.
    id: "M1-long-discussion",
    tier: "complex",
    prompt: "What do you think of all of my portfolios?",
    turns: [
      "Focus on the Tax one — why is its return so low?",
      "OK. What exactly should I do about it this month?",
      "I'm a beginner — explain in plain terms why that actually helps.",
    ],
    expect: {
      // read_portfolio must be called somewhere across the discussion.
      expectTools: ["read_portfolio"],
      mustInclude: [/Tax/],
      // The final turn is a plain-language rationale for the recommended action.
      anyOf: [/concentrat|diversif|one fund|single fund|cash|bond|spread|risk/i],
      mustNotInclude: [/EXAMPLE-FUND-[E-Z]/],
    },
    note: "Multi-turn long discussion: review → scope to Tax → concrete action → beginner rationale. Judge scores cross-turn coherence + memory + adaptivity.",
  },

  // ── Tier 3: memory capture (does the model CALL save_preference?) ────────────
  // Measures the failure this tier exists to fix: on an explicit memory request
  // the model often acknowledges in prose but never calls the write tool. Each
  // MEM question must fire save_preference (the save-rate metric); the two CTRL
  // questions must NOT (the false-positive guard — a lookup/definition shouldn't
  // write a memory). Run the reasoning A/B (EVAL_REASONING=none|low) on this tier.
  {
    id: "MEM1-explicit-save",
    tier: "memory",
    prompt: "Remember that I prefer low-fee index funds.",
    expect: {
      expectTools: ["save_preference"],
      expectToolArgs: [{ tool: "save_preference", contains: /index|low|fee|fund/i }],
      maxSteps: 3,
    },
    note: "The canonical explicit save. At effort 'none' grok tends to acknowledge without calling the tool.",
  },
  {
    id: "MEM2-style-instruction",
    tier: "memory",
    prompt: "From now on, keep your answers short and skip the long disclaimers.",
    expect: {
      expectTools: ["save_preference"],
      expectToolArgs: [
        { tool: "save_preference", contains: /short|concise|brief|disclaimer|style/i },
      ],
      maxSteps: 3,
    },
    note: "A durable response-style instruction ('from now on') — should persist as a response_style memory.",
  },
  {
    id: "MEM3-profile-fact",
    tier: "memory",
    prompt: "For your records, I'm 30 years old and investing with a 20-year time horizon.",
    expect: {
      expectTools: ["save_preference"],
      expectToolArgs: [{ tool: "save_preference", contains: /30|horizon|20|age/i }],
      maxSteps: 3,
    },
    note: "A stable profile fact stated explicitly — should land as a profile memory.",
  },
  {
    id: "MEM4-correction",
    tier: "memory",
    prompt: "Actually, always lead with fees when you compare funds for me.",
    expect: {
      expectTools: ["save_preference"],
      expectToolArgs: [{ tool: "save_preference", contains: /fee/i }],
      maxSteps: 3,
    },
    note: "A correction phrased as a standing instruction ('always') — capture as a memory, not just an apology.",
  },
  {
    // Control: a plain lookup must NOT write a memory (false-positive guard).
    id: "MEM-C1-lookup-no-save",
    tier: "memory",
    prompt: "What's my single biggest holding right now?",
    expect: {
      expectTools: ["read_portfolio"],
      mustInclude: ["EXAMPLE-FUND-A"],
      mustNotCallTools: ["save_preference", "update_preference", "forget_preference"],
    },
    note: "Negative control: reading the portfolio is not a memory request — no write should fire.",
  },
  {
    // Control: a definition must NOT write a memory (or call any data tool).
    id: "MEM-C2-definition-no-save",
    tier: "memory",
    prompt: "Quick definition — what does NAV stand for?",
    expect: {
      anyOf: [/net asset value/i],
      mustNotCallTools: [
        "save_preference",
        "update_preference",
        "forget_preference",
        "read_portfolio",
      ],
    },
    note: "Negative control: a definitional question carries no durable preference — no write should fire.",
  },
];

// ── Grading ───────────────────────────────────────────────────────────────

function matches(text: string, m: Matcher): boolean {
  return typeof m === "string" ? text.includes(m) : m.test(text);
}

/** One captured tool call: its name, the arguments the model passed, and (when
 * captured) the tool's RESULT — the figures the answer should be grounded in.
 * The deterministic grader uses name + args; the LLM-judge also reads `result`
 * to verify grounding against the real numbers (issue #65). */
export interface ToolCall {
  name: string;
  args: unknown;
  result?: unknown;
}

export interface GradeInput {
  text: string;
  toolNames: string[];
  /** Tool calls with arguments, for expectToolArgs grounding checks (issue #68).
   * Optional: callers that only track names still grade name-level checks. */
  toolCalls?: ToolCall[];
  /** Trajectory length (model generations) for maxSteps/minSteps checks (#68). */
  steps?: number;
}

// The three sub-signals the agent-evals research recommends reporting separately
// rather than collapsing into one number (so a regression localizes):
//   - facts:  grounded completeness (mustInclude / anyOf) — did it carry the data
//   - tools:  trajectory (expectTools / minToolCalls / mustNotCallTools) — right
//             tools, no over-calling
//   - safety: no-hallucination guards (mustNotInclude)
export type GradeCategory = "facts" | "tools" | "safety";
export interface CategoryScore {
  passed: number;
  total: number;
}

export interface GradeResult {
  passed: number;
  total: number;
  score: number; // passed / total, 1 = perfect
  failures: string[];
  byCategory: Record<GradeCategory, CategoryScore>;
}

/**
 * Deterministically grade one answer against a question's expectations. Each
 * matcher / group / tool requirement is one check, tagged with a category; the
 * overall score is the pass fraction and per-category sub-scores localize a
 * regression. A grounded, complete, safe answer scores 1.0; a dead-end (empty
 * text) scores 0 on every text check.
 */
export function gradeAnswer(q: EvalQuestion, input: GradeInput): GradeResult {
  const { text, toolNames, toolCalls, steps } = input;
  const checks: Array<{ ok: boolean; label: string; cat: GradeCategory }> = [];

  for (const m of q.expect.mustInclude ?? []) {
    checks.push({ ok: matches(text, m), label: `mustInclude ${String(m)}`, cat: "facts" });
  }
  if (q.expect.anyOf?.length) {
    checks.push({
      ok: q.expect.anyOf.some((m) => matches(text, m)),
      label: `anyOf ${q.expect.anyOf.map(String).join(" | ")}`,
      cat: "facts",
    });
  }
  for (const m of q.expect.mustNotInclude ?? []) {
    checks.push({ ok: !matches(text, m), label: `mustNotInclude ${String(m)}`, cat: "safety" });
  }
  for (const t of q.expect.expectTools ?? []) {
    checks.push({ ok: toolNames.includes(t), label: `expectTool ${t}`, cat: "tools" });
  }
  for (const t of q.expect.mustNotCallTools ?? []) {
    checks.push({ ok: !toolNames.includes(t), label: `mustNotCallTool ${t}`, cat: "tools" });
  }
  const minTools = q.expect.minToolCalls ?? q.expect.expectTools?.length ?? 0;
  if (minTools > 0) {
    checks.push({
      ok: toolNames.length >= minTools,
      label: `minToolCalls ${minTools}`,
      cat: "tools",
    });
  }
  for (const a of q.expect.expectToolArgs ?? []) {
    // Match `contains` against the serialized args of any call to that tool.
    // Fails closed when args weren't captured (toolCalls absent).
    const ok = (toolCalls ?? []).some(
      (c) => c.name === a.tool && matches(JSON.stringify(c.args ?? {}), a.contains),
    );
    checks.push({ ok, label: `expectToolArgs ${a.tool} ~ ${String(a.contains)}`, cat: "tools" });
  }
  // Trajectory-length bounds (issue #68). Only graded when the run reported a
  // step count; a question that sets a bound but runs without one fails closed.
  if (q.expect.maxSteps != null) {
    checks.push({
      ok: steps != null && steps <= q.expect.maxSteps,
      label: `maxSteps ${q.expect.maxSteps} (got ${steps ?? "?"})`,
      cat: "tools",
    });
  }
  if (q.expect.minSteps != null) {
    checks.push({
      ok: steps != null && steps >= q.expect.minSteps,
      label: `minSteps ${q.expect.minSteps} (got ${steps ?? "?"})`,
      cat: "tools",
    });
  }

  const byCategory: Record<GradeCategory, CategoryScore> = {
    facts: { passed: 0, total: 0 },
    tools: { passed: 0, total: 0 },
    safety: { passed: 0, total: 0 },
  };
  for (const c of checks) {
    byCategory[c.cat].total++;
    if (c.ok) byCategory[c.cat].passed++;
  }

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length || 1;
  return {
    passed,
    total,
    score: passed / total,
    failures: checks.filter((c) => !c.ok).map((c) => c.label),
    byCategory,
  };
}

export function questionsForTier(tier: EvalTier | "all"): EvalQuestion[] {
  return tier === "all" ? QUESTIONS : QUESTIONS.filter((q) => q.tier === tier);
}
