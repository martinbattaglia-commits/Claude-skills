import { describe, expect, it } from "vitest";
import { buildParts, extractCards, joinStepText } from "./turn-persist";

describe("turn-persist — joinStepText", () => {
  it("concatenates every step's text (not just the last)", () => {
    const steps = [
      { text: "Looking at the screenshot…" },
      { text: "" },
      { text: "Drafted below." },
    ];
    expect(joinStepText(steps)).toBe("Looking at the screenshot…\n\nDrafted below.");
  });

  it("returns empty string when no step has text", () => {
    expect(joinStepText([{ text: "" }, {}])).toBe("");
    expect(joinStepText([])).toBe("");
  });
});

describe("turn-persist — extractCards", () => {
  const result = (output: unknown) => [{ toolResults: [{ output }] }];

  it("captures a transactions import payload", () => {
    const payload = { rows: [{ ticker: "VOO" }], source: null, note: "x" };
    expect(extractCards(result({ ok: true, transactionsImport: payload }))).toEqual({
      transactionsImport: payload,
    });
  });

  it("captures a holdings import payload (incl. propose_holding's value-only branch)", () => {
    const payload = { rows: [{ ticker: "K-USA-A", estimated: true }], source: null, note: null };
    expect(extractCards(result({ ok: true, holdingsImport: payload }))).toEqual({
      holdingsImport: payload,
    });
  });

  it("accumulates multiple single-holding proposals into holdings[]", () => {
    const steps = [
      { toolResults: [{ output: { ok: true, holding: { ticker: "VOO" } } }] },
      { toolResults: [{ output: { ok: true, holding: { ticker: "QQQ" } } }] },
    ];
    expect(extractCards(steps)).toEqual({ holdings: [{ ticker: "VOO" }, { ticker: "QQQ" }] });
  });

  it("captures a plan proposal", () => {
    const proposal = { section: "Principles", add: "- x", rm: null, rationale: "y" };
    expect(extractCards(result({ ok: true, proposal }))).toEqual({ proposal });
  });

  it("does NOT collect memory events — those ride parts, not cards", () => {
    const steps = [
      { toolResults: [{ output: { ok: true, memoryEvent: { kind: "save", id: 1 } } }] },
    ];
    expect(extractCards(steps)).toBeNull();
  });

  it("reads the legacy `result` field when `output` is absent", () => {
    const payload = { rows: [], source: null, note: null };
    expect(extractCards([{ toolResults: [{ result: { holdingsImport: payload } }] }])).toEqual({
      holdingsImport: payload,
    });
  });

  it("returns null when the turn produced no cards", () => {
    expect(extractCards([{ text: "just prose" }])).toBeNull();
    expect(extractCards(result({ ok: true, message: "read the portfolio" }))).toBeNull();
    expect(extractCards([])).toBeNull();
  });
});

describe("turn-persist — buildParts", () => {
  const save = (id: number) => ({
    toolResults: [{ output: { ok: true, memoryEvent: { kind: "save", id, category: "fact" } } }],
  });

  it("interleaves text → memory → text in order", () => {
    const steps = [
      { text: "Got it, I'll remember that." },
      save(1),
      { text: "Here's the cleaner split." },
    ];
    expect(buildParts(steps)).toEqual([
      { type: "text", text: "Got it, I'll remember that." },
      { type: "memory", event: { kind: "save", id: 1, category: "fact" } },
      { type: "text", text: "Here's the cleaner split." },
    ]);
  });

  it("puts a memory-first turn (tool before any prose) ahead of the text", () => {
    const steps = [save(2), { text: "Saved — and here's why it matters." }];
    expect(buildParts(steps)).toEqual([
      { type: "memory", event: { kind: "save", id: 2, category: "fact" } },
      { type: "text", text: "Saved — and here's why it matters." },
    ]);
  });

  it("merges consecutive prose with no memory between into one text part", () => {
    const steps = [{ text: "First line." }, { text: "" }, { text: "Second line." }];
    expect(buildParts(steps)).toEqual([{ type: "text", text: "First line.\n\nSecond line." }]);
  });

  it("returns a single text part for a no-memory turn", () => {
    expect(buildParts([{ text: "just prose" }])).toEqual([{ type: "text", text: "just prose" }]);
  });

  it("returns [] for an empty turn", () => {
    expect(buildParts([])).toEqual([]);
    expect(buildParts([{ text: "" }, {}])).toEqual([]);
  });

  it("ignores non-memory tool outputs (those become cards, not parts)", () => {
    const steps = [
      { text: "Here's a proposal." },
      { toolResults: [{ output: { ok: true, proposal: { section: "x" } } }] },
    ];
    expect(buildParts(steps)).toEqual([{ type: "text", text: "Here's a proposal." }]);
  });
});
