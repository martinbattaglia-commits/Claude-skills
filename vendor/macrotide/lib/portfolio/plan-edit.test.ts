import { describe, expect, it } from "vitest";
import { applyPlanEdit } from "./plan-edit";

describe("applyPlanEdit", () => {
  it("appends to an existing section", () => {
    const md = "## Principles\n- Buy and hold\n";
    const out = applyPlanEdit(md, {
      section: "Principles",
      add: "- No individual stocks",
      rm: null,
    });
    expect(out).toBe("## Principles\n- Buy and hold\n- No individual stocks\n");
  });

  it("creates a new section when missing", () => {
    const md = "## Target\n- 70/30 equity/bond\n";
    const out = applyPlanEdit(md, { section: "Risk", add: "- Max 25% drawdown", rm: null });
    expect(out).toBe("## Target\n- 70/30 equity/bond\n\n## Risk\n- Max 25% drawdown\n");
  });

  it("inserts before the next section header, not at end of file", () => {
    const md = "## Principles\n- Buy and hold\n\n## Target\n- 70/30\n";
    const out = applyPlanEdit(md, { section: "Principles", add: "- Index only", rm: null });
    expect(out).toBe("## Principles\n- Buy and hold\n- Index only\n\n## Target\n- 70/30\n");
  });

  it("returns the original when there is no addition", () => {
    const md = "## Risk\n- Existing rule\n";
    const out = applyPlanEdit(md, { section: "Risk", add: null, rm: "- Existing rule" });
    expect(out).toBe(md);
  });

  it("escapes regex metacharacters in section names", () => {
    const md = "## Risk (volatility)\n- Cap at 20%\n";
    const out = applyPlanEdit(md, {
      section: "Risk (volatility)",
      add: "- Rebalance quarterly",
      rm: null,
    });
    expect(out).toContain("- Rebalance quarterly");
  });
});
