import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  CHARS_PER_TOKEN,
  compressContext,
  estimateMessagesTokens,
  estimateTokens,
  RECENT_MESSAGES_KEPT,
} from "./summarize";

// A deterministic stub summarizer — keeps tests off the live model. Returns a
// short, bounded summary so the compressed input is small regardless of how
// many older turns were folded in.
const stubSummary =
  "The user discussed portfolio rebalancing and stated a moderate risk tolerance.";
const stubSummarize = vi.fn(async (_older: ModelMessage[]) => stubSummary);

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}
function aiMsg(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

/** Build an N-turn conversation (N user+assistant pairs) with sizeable bodies. */
function conversation(turns: number, bodyChars = 400): ModelMessage[] {
  const body = "x".repeat(bodyChars);
  const out: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(userMsg(`Q${i} ${body}`));
    out.push(aiMsg(`A${i} ${body}`));
  }
  return out;
}

describe("estimateTokens", () => {
  it("uses the chars/4 heuristic", () => {
    expect(estimateTokens("a".repeat(40))).toBe(40 / CHARS_PER_TOKEN);
    expect(estimateTokens("")).toBe(0);
  });

  it("sums message content plus per-message overhead", () => {
    const msgs = [userMsg("hello"), aiMsg("world")];
    // Each message: ceil(5/4)=2 tokens content + 4 overhead = 6; two = 12.
    expect(estimateMessagesTokens(msgs)).toBe(12);
  });
});

describe("compressContext", () => {
  it("leaves input untouched below the threshold", async () => {
    const messages = conversation(3);
    const result = await compressContext(messages, {
      budgetTokens: 100_000,
      summarize: stubSummarize,
    });
    expect(result.compressed).toBe(false);
    expect(result.thresholdCrossed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.summary).toBeNull();
    expect(stubSummarize).not.toHaveBeenCalled();
  });

  it("compresses older turns and keeps the recent tail verbatim", async () => {
    const messages = conversation(20); // 40 messages
    const summarize = vi.fn(async (_older: ModelMessage[]) => stubSummary);
    const result = await compressContext(messages, {
      budgetTokens: 4_000, // small budget forces the threshold
      summarize,
    });

    expect(result.compressed).toBe(true);
    expect(result.thresholdCrossed).toBe(true);
    expect(result.summary).toBe(stubSummary);
    expect(summarize).toHaveBeenCalledTimes(1);

    // Summary message first, then exactly the last RECENT_MESSAGES_KEPT verbatim.
    expect(result.messages).toHaveLength(RECENT_MESSAGES_KEPT + 1);
    expect((result.messages[0] as { role: string }).role).toBe("system");
    expect(result.messages[0].content).toContain(stubSummary);
    const tail = result.messages.slice(1);
    expect(tail).toEqual(messages.slice(messages.length - RECENT_MESSAGES_KEPT));

    // The summarizer was handed the OLDER segment only.
    const olderArg = summarize.mock.calls[0][0] as ModelMessage[];
    expect(olderArg).toHaveLength(messages.length - RECENT_MESSAGES_KEPT);

    // Compression actually shrank the model input.
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
  });

  it("flags threshold crossed but does not compress when the summarizer yields nothing", async () => {
    const messages = conversation(20);
    const result = await compressContext(messages, {
      budgetTokens: 4_000,
      summarize: async () => "", // e.g. no provider / model error
    });
    expect(result.thresholdCrossed).toBe(true);
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages); // never drops turns on failure
  });

  it("keeps a 50-turn session under 2× the input-token cost of a 5-turn one", async () => {
    // Same small budget; the long session should compress while the short one
    // stays whole. Acceptance criterion: <2× input-token cost.
    const short = await compressContext(conversation(5), {
      budgetTokens: 4_000,
      summarize: stubSummarize,
    });
    const long = await compressContext(conversation(50), {
      budgetTokens: 4_000,
      summarize: stubSummarize,
    });

    expect(long.compressed).toBe(true);
    expect(long.compressedTokens).toBeLessThan(2 * short.compressedTokens);
  });
});
