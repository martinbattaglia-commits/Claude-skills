import { afterEach, describe, expect, it } from "vitest";
import { globalRateLimit, rateLimit } from "./rate-limit";

const TEST_CFG = { scope: "test", limit: 3, windowMs: 1000 };

const globalForRl = globalThis as unknown as { __macrotideRateBuckets?: Map<string, unknown> };

afterEach(() => {
  globalForRl.__macrotideRateBuckets?.clear();
});

describe("rateLimit", () => {
  it("allows requests up to the limit", () => {
    expect(rateLimit("1.1.1.1", TEST_CFG).ok).toBe(true);
    expect(rateLimit("1.1.1.1", TEST_CFG).ok).toBe(true);
    expect(rateLimit("1.1.1.1", TEST_CFG).ok).toBe(true);
    const denied = rateLimit("1.1.1.1", TEST_CFG);
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("scopes buckets per key", () => {
    rateLimit("1.1.1.1", TEST_CFG);
    rateLimit("1.1.1.1", TEST_CFG);
    rateLimit("1.1.1.1", TEST_CFG);
    expect(rateLimit("1.1.1.1", TEST_CFG).ok).toBe(false);
    // Different IP should still be allowed.
    expect(rateLimit("2.2.2.2", TEST_CFG).ok).toBe(true);
  });

  it("scopes buckets per scope", () => {
    rateLimit("1.1.1.1", TEST_CFG);
    rateLimit("1.1.1.1", TEST_CFG);
    rateLimit("1.1.1.1", TEST_CFG);
    // Same IP but different scope — fresh bucket.
    expect(rateLimit("1.1.1.1", { ...TEST_CFG, scope: "other" }).ok).toBe(true);
  });

  it("counts remaining requests", () => {
    expect(rateLimit("3.3.3.3", TEST_CFG).remaining).toBe(2);
    expect(rateLimit("3.3.3.3", TEST_CFG).remaining).toBe(1);
    expect(rateLimit("3.3.3.3", TEST_CFG).remaining).toBe(0);
  });
});

describe("globalRateLimit (IP-independent circuit breaker)", () => {
  const G = { scope: "ocr-global-test", limit: 3, windowMs: 1000 };

  it("trips on total volume regardless of caller — spoofed IPs share one budget", () => {
    // The per-IP limiter would let each of these through; the global breaker
    // counts them all against one bucket.
    expect(globalRateLimit(G).ok).toBe(true);
    expect(globalRateLimit(G).ok).toBe(true);
    expect(globalRateLimit(G).ok).toBe(true);
    expect(globalRateLimit(G).ok).toBe(false);
  });

  it("is independent per scope", () => {
    globalRateLimit(G);
    globalRateLimit(G);
    globalRateLimit(G);
    expect(globalRateLimit(G).ok).toBe(false);
    expect(globalRateLimit({ ...G, scope: "chat-global-test" }).ok).toBe(true);
  });
});
