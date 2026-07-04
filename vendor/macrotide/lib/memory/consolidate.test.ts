import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Preference } from "../db/queries/preferences";

// Queue of model responses + a call counter, shared with the mocked generateText.
const h = vi.hoisted(() => ({ texts: [] as string[], calls: 0 }));

vi.mock("../ai/provider", () => ({
  resolveConsolidateProvider: () => ({ model: {} as never, ready: true, label: "test" }),
}));
vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    const text = h.texts[h.calls] ?? "";
    h.calls++;
    return { text };
  }),
}));

import { proposeConsolidation } from "./consolidate";

const pair = (): Preference[] =>
  [
    { id: 1, category: "user", content: "be concise", confidence: null, detail: null },
    { id: 2, category: "user", content: "keep it brief", confidence: 0.8, detail: null },
  ] as Preference[];

beforeEach(() => {
  h.texts = [];
  h.calls = 0;
});

describe("proposeConsolidation — JSON retry", () => {
  it("retries an unparseable response and succeeds on a later attempt", async () => {
    // no-brace, then a brace that fails JSON.parse, then valid ops.
    h.texts = ["not json at all", "{not: valid, json}", '{"ops":[{"op":"merge","ids":[1,2]}]}'];
    const ops = await proposeConsolidation("user", pair());
    expect(h.calls).toBe(3);
    expect(ops).toEqual([{ op: "merge", ids: [1, 2] }]);
  });

  it("accepts a valid EMPTY ops array immediately (a legit 'nothing to do' is not retried)", async () => {
    h.texts = ['{"ops":[]}', "should not be reached"];
    const ops = await proposeConsolidation("user", pair());
    expect(h.calls).toBe(1);
    expect(ops).toEqual([]);
  });

  it("gives up after the max attempts on persistent garbage", async () => {
    h.texts = ["garbage", "garbage", "garbage", "garbage"];
    const ops = await proposeConsolidation("user", pair());
    expect(h.calls).toBe(3);
    // null (not []) signals a degraded chain — distinct from a legit empty result.
    expect(ops).toBeNull();
  });
});
