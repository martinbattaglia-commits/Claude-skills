import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnstileConfigured, turnstileSiteKey, verifyTurnstile } from "./turnstile";

describe("Turnstile signup gate", () => {
  let savedSecret: string | undefined;
  let savedSite: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.TURNSTILE_SECRET_KEY;
    savedSite = process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SITE_KEY;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = savedSecret;
    if (savedSite === undefined) delete process.env.TURNSTILE_SITE_KEY;
    else process.env.TURNSTILE_SITE_KEY = savedSite;
    vi.restoreAllMocks();
  });

  it("reports configuration from env", () => {
    expect(turnstileConfigured()).toBe(false);
    expect(turnstileSiteKey()).toBeNull();
    process.env.TURNSTILE_SECRET_KEY = "sk";
    process.env.TURNSTILE_SITE_KEY = "pk";
    expect(turnstileConfigured()).toBe(true);
    expect(turnstileSiteKey()).toBe("pk");
  });

  it("BYPASSES verification (returns true) when no secret is configured — dev path", async () => {
    expect(await verifyTurnstile(null)).toBe(true);
    expect(await verifyTurnstile("anything")).toBe(true);
  });

  it("fails a missing token when the secret IS configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk";
    expect(await verifyTurnstile(null)).toBe(false);
    expect(await verifyTurnstile("")).toBe(false);
  });

  it("returns Cloudflare's verdict when configured + token present", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyTurnstile("good-token")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
    expect(await verifyTurnstile("bad-token")).toBe(false);
  });

  it("fails closed on network error when configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "sk";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await verifyTurnstile("token")).toBe(false);
  });
});
