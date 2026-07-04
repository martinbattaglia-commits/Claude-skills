import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  type EntryContext,
  entryContextMessage,
  injectEntryContext,
  isEmptyEntryContext,
  parseEntryContext,
} from "./entry-context";

describe("parseEntryContext", () => {
  it("returns null for non-objects / junk / empty", () => {
    expect(parseEntryContext(null)).toBeNull();
    expect(parseEntryContext(undefined)).toBeNull();
    expect(parseEntryContext("nope")).toBeNull();
    expect(parseEntryContext(42)).toBeNull();
    expect(parseEntryContext({})).toBeNull();
    expect(parseEntryContext({ screen: "   " })).toBeNull(); // blank trims to empty
  });

  it("keeps string fields and numeric/string signals", () => {
    const ctx = parseEntryContext({
      screen: "portfolio",
      intent: "fee_switch",
      subject: "EXAMPLE-FUND-A",
      signals: { heldTer: 0.9, alternative: "EXAMPLE-FUND-B", altTer: 0.2 },
    });
    expect(ctx).toEqual({
      screen: "portfolio",
      intent: "fee_switch",
      subject: "EXAMPLE-FUND-A",
      signals: { heldTer: 0.9, alternative: "EXAMPLE-FUND-B", altTer: 0.2 },
    });
  });

  it("drops non-string/number signal values and non-finite numbers", () => {
    const ctx = parseEntryContext({
      screen: "portfolio",
      signals: { good: 1, bad: { nested: true }, arr: [1], nan: Number.NaN, ok: "x" },
    });
    expect(ctx?.signals).toEqual({ good: 1, ok: "x" });
  });

  it("caps the number of signals at 12", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = i;
    const ctx = parseEntryContext({ intent: "x", signals: big });
    expect(Object.keys(ctx?.signals ?? {})).toHaveLength(12);
  });

  it("does not yet parse the reserved image field", () => {
    // image-only envelope has no text fields → treated as empty.
    expect(parseEntryContext({ image: { ref: "blob:123" } })).toBeNull();
  });

  it("keeps a trimmed detail block and caps its length", () => {
    expect(parseEntryContext({ detail: "  the full memory body  " })?.detail).toBe(
      "the full memory body",
    );
    const long = "x".repeat(5000);
    expect(parseEntryContext({ detail: long })?.detail).toHaveLength(2000);
    // a detail-only envelope is non-empty (the memory-edit handoff).
    expect(parseEntryContext({ detail: "body" })).toEqual({ detail: "body" });
    expect(parseEntryContext({ detail: "   " })).toBeNull();
  });
});

describe("isEmptyEntryContext", () => {
  it("is true for null/empty and false when any text field or signal exists", () => {
    expect(isEmptyEntryContext(null)).toBe(true);
    expect(isEmptyEntryContext({})).toBe(true);
    expect(isEmptyEntryContext({ signals: {} })).toBe(true);
    expect(isEmptyEntryContext({ screen: "portfolio" })).toBe(false);
    expect(isEmptyEntryContext({ signals: { a: 1 } })).toBe(false);
  });
});

describe("entryContextMessage", () => {
  it("renders a compact labeled block as a USER message (cache-safety)", () => {
    const msg = entryContextMessage({
      screen: "portfolio",
      intent: "rebalance",
      subject: "Bogle 3-fund",
      signals: { trackingGapPp: 6.2 },
    });
    expect(msg?.role).toBe("user"); // never `system` — must sit after the cached prefix
    const text = msg?.content as string;
    expect(text).toContain("Screen: portfolio");
    expect(text).toContain("Intent: rebalance");
    expect(text).toContain("Subject: Bogle 3-fund");
    expect(text).toContain("trackingGapPp: 6.2");
  });

  it("tolerates missing optional fields", () => {
    const msg = entryContextMessage({ screen: "funds", intent: "fund_lookup" });
    const text = msg?.content as string;
    expect(text).toContain("Screen: funds");
    expect(text).not.toContain("Subject:");
  });

  it("returns null when the envelope is empty", () => {
    expect(entryContextMessage({})).toBeNull();
  });

  it("renders a detail block as its own labeled section", () => {
    const msg = entryContextMessage({
      screen: "journal",
      intent: "edit_memory",
      detail: "Prefers low-fee index funds and dislikes single-stock bets.",
    });
    const text = msg?.content as string;
    expect(text).toContain("Screen: journal");
    expect(text).toContain("Detail:\nPrefers low-fee index funds");
  });
});

describe("injectEntryContext", () => {
  const base: ModelMessage[] = [
    { role: "user", content: "older question" },
    { role: "assistant", content: "older answer" },
    { role: "user", content: "current question" },
  ];

  it("splices the context immediately BEFORE the latest user turn", () => {
    const ctx: EntryContext = { screen: "portfolio", intent: "rebalance" };
    const out = injectEntryContext(base, ctx);
    expect(out).toHaveLength(base.length + 1); // exactly one extra message
    // the current user question is still last…
    expect(out[out.length - 1]).toEqual({ role: "user", content: "current question" });
    // …and the injected context sits right before it, as a user message.
    expect(out[out.length - 2].role).toBe("user");
    expect(out[out.length - 2].content).toContain("Screen: portfolio");
    // earlier turns are untouched.
    expect(out.slice(0, 2)).toEqual(base.slice(0, 2));
  });

  it("is a no-op (same array) when context is null or empty", () => {
    expect(injectEntryContext(base, null)).toBe(base);
    expect(injectEntryContext(base, {})).toBe(base);
  });

  it("appends when there is no user turn at all", () => {
    const onlyAssistant: ModelMessage[] = [{ role: "assistant", content: "hi" }];
    const out = injectEntryContext(onlyAssistant, { screen: "portfolio" });
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe("user");
  });
});
