import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveConsolidateProvider,
  resolveDemoProvider,
  resolveOwnerProvider,
  resolveTierProvider,
  resolveVisionEscalateProvider,
  resolveVisionProvider,
} from "./provider";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "DEMO_OPENROUTER_API_KEY",
  "TRUSTED_TIER_MODELS",
  "DEMO_TIER_MODELS",
  "PUBLIC_TIER_MODELS",
  "VISION_CHAT_MODELS",
  "VISION_CHAT_ESCALATE_MODELS",
  "CONSOLIDATE_MODELS",
  "CONSOLIDATE_REASONING_EFFORT",
  "EXTRACT_MODELS",
  "TITLE_MODELS",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("resolveOwnerProvider", () => {
  it("returns not-ready when key is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    const p = resolveOwnerProvider();
    expect(p.ready).toBe(false);
    expect(p.model).toBeNull();
  });

  it("defaults to free → auto fallback chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.TRUSTED_TIER_MODELS;
    const p = resolveOwnerProvider();
    expect(p.ready).toBe(true);
    expect(p.label).toBe("OpenRouter · openrouter/free → openrouter/auto");
  });

  it("honors TRUSTED_TIER_MODELS as comma-separated chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto,anthropic/claude-sonnet-4.5";
    const p = resolveOwnerProvider();
    expect(p.label).toBe("OpenRouter · openrouter/auto → anthropic/claude-sonnet-4.5");
  });

  it("accepts a single-model TRUSTED_TIER_MODELS value (no fallback)", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto";
    const p = resolveOwnerProvider();
    expect(p.label).toBe("OpenRouter · openrouter/auto");
  });
});

describe("resolveTierProvider (tier gating)", () => {
  it("returns not-ready when key is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveTierProvider("public").ready).toBe(false);
    expect(resolveTierProvider("trusted").ready).toBe(false);
  });

  it("trusted tier uses the owner TRUSTED_TIER_MODELS chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto,anthropic/claude-sonnet-4.5";
    const p = resolveTierProvider("trusted");
    expect(p.label).toBe("Trusted · openrouter/auto → anthropic/claude-sonnet-4.5");
  });

  it("trusted tier defaults to free → auto when TRUSTED_TIER_MODELS unset", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.TRUSTED_TIER_MODELS;
    expect(resolveTierProvider("trusted").label).toBe(
      "Trusted · openrouter/free → openrouter/auto",
    );
  });

  it("public tier resolves to openrouter/free only", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.TRUSTED_TIER_MODELS;
    delete process.env.PUBLIC_TIER_MODELS;
    expect(resolveTierProvider("public").label).toBe("Public · openrouter/free");
  });

  it("public tier honors PUBLIC_TIER_MODELS", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.PUBLIC_TIER_MODELS = "google/gemini-2.5-flash";
    expect(resolveTierProvider("public").label).toBe("Public · google/gemini-2.5-flash");
  });

  it("INVARIANT: public tier NEVER resolves to a paid model from TRUSTED_TIER_MODELS", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.PUBLIC_TIER_MODELS;
    // Operator misconfigures TRUSTED_TIER_MODELS with a pricey model — public
    // tier must ignore it entirely. A regression here burns the owner's budget.
    process.env.TRUSTED_TIER_MODELS = "anthropic/claude-opus-4.1,openai/gpt-5";
    const p = resolveTierProvider("public");
    expect(p.label).toBe("Public · openrouter/free");
    expect(p.label).not.toContain("anthropic");
    expect(p.label).not.toContain("openai");
  });
});

describe("resolveDemoProvider", () => {
  it("defaults to openrouter/free with no fallback", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.DEMO_TIER_MODELS;
    const p = resolveDemoProvider();
    expect(p.label).toBe("Demo · openrouter/free");
  });

  it("falls back to owner key when DEMO_OPENROUTER_API_KEY unset", () => {
    process.env.OPENROUTER_API_KEY = "sk-owner";
    delete process.env.DEMO_OPENROUTER_API_KEY;
    const p = resolveDemoProvider();
    expect(p.ready).toBe(true);
  });
});

describe("resolveVisionProvider", () => {
  it("returns not-ready when key is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEMO_OPENROUTER_API_KEY;
    const p = resolveVisionProvider();
    expect(p.ready).toBe(false);
    expect(p.model).toBeNull();
  });

  it("defaults to the gemini-flash-lite primary + EOL-proof fallback chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.VISION_CHAT_MODELS;
    const p = resolveVisionProvider();
    expect(p.ready).toBe(true);
    expect(p.label).toBe("Vision · google/gemini-2.5-flash-lite → google/gemini-3.1-flash-lite");
  });

  it("honors VISION_CHAT_MODELS as a comma-separated chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.VISION_CHAT_MODELS = "google/gemini-2.5-flash,google/gemini-2.0-flash-001";
    const p = resolveVisionProvider();
    expect(p.label).toBe("Vision · google/gemini-2.5-flash → google/gemini-2.0-flash-001");
  });

  it.each([
    "off",
    "OFF",
    "none",
    "false",
    "0",
    "  off  ",
  ])("treats VISION_CHAT_MODELS=%j as disabled (not-ready)", (value) => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.VISION_CHAT_MODELS = value;
    const p = resolveVisionProvider();
    expect(p.ready).toBe(false);
    expect(p.model).toBeNull();
    expect(p.label).toBe("Vision (disabled)");
  });

  it("INVARIANT: vision model derives from VISION_CHAT_MODELS, never TRUSTED_TIER_MODELS", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "anthropic/claude-opus-4.1";
    delete process.env.VISION_CHAT_MODELS;
    const p = resolveVisionProvider();
    expect(p.label).toBe("Vision · google/gemini-2.5-flash-lite → google/gemini-3.1-flash-lite");
    expect(p.label).not.toContain("anthropic");
  });

  describe("demo flavor", () => {
    it("uses DEMO_OPENROUTER_API_KEY when demo:true", () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.DEMO_OPENROUTER_API_KEY = "sk-demo";
      const p = resolveVisionProvider({ demo: true });
      expect(p.ready).toBe(true);
      expect(p.label).toBe(
        "Vision (demo) · google/gemini-2.5-flash-lite → google/gemini-3.1-flash-lite",
      );
    });

    it("falls back to the owner key when DEMO_OPENROUTER_API_KEY unset", () => {
      process.env.OPENROUTER_API_KEY = "sk-owner";
      delete process.env.DEMO_OPENROUTER_API_KEY;
      const p = resolveVisionProvider({ demo: true });
      expect(p.ready).toBe(true);
    });

    it("is not-ready when neither demo nor owner key is set", () => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.DEMO_OPENROUTER_API_KEY;
      expect(resolveVisionProvider({ demo: true }).ready).toBe(false);
    });
  });
});

describe("resolveVisionEscalateProvider", () => {
  it("is NOT-ready by default (escalation dormant until VISION_CHAT_ESCALATE_MODELS is set)", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.VISION_CHAT_ESCALATE_MODELS;
    const p = resolveVisionEscalateProvider();
    expect(p.ready).toBe(false);
    expect(p.model).toBeNull();
  });

  it("resolves the chain when VISION_CHAT_ESCALATE_MODELS is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.VISION_CHAT_ESCALATE_MODELS = "google/gemini-3.1-pro,google/gemini-2.5-flash";
    const p = resolveVisionEscalateProvider();
    expect(p.ready).toBe(true);
    expect(p.label).toBe("Vision escalate · google/gemini-3.1-pro → google/gemini-2.5-flash");
  });

  it("is not-ready when set but no key", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEMO_OPENROUTER_API_KEY;
    process.env.VISION_CHAT_ESCALATE_MODELS = "google/gemini-3.1-pro";
    expect(resolveVisionEscalateProvider().ready).toBe(false);
  });
});

describe("provider-agnostic cache affinity", () => {
  // Capture the headers + body of one doGenerate call for a given chat chain.
  async function capture(
    modelsEnv: string,
    conversationId: string,
  ): Promise<{ headers: Headers; body: Record<string, unknown> }> {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = modelsEnv;
    let capturedBody: string | undefined;
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const p = resolveOwnerProvider({ conversationId });
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }
    return { headers: capturedHeaders as Headers, body: JSON.parse(capturedBody as string) };
  }

  it("grok → x-grok-conv-id header (xAI affinity signal)", async () => {
    const { headers, body } = await capture("x-ai/grok-4.3", "thread-abc");
    expect(headers.get("x-grok-conv-id")).toBe("thread-abc");
    expect(body.session_id).toBeUndefined();
  });

  it("anthropic → session_id body field (sticky-routing pin)", async () => {
    const { headers, body } = await capture("anthropic/claude-sonnet-4.5", "thread-xyz");
    expect(body.session_id).toBe("thread-xyz");
    expect(headers.get("x-grok-conv-id")).toBeNull();
  });

  it("openai / google → no affinity injection (transparent sticky routing)", async () => {
    const a = await capture("openai/gpt-5", "t1");
    expect(a.headers.get("x-grok-conv-id")).toBeNull();
    expect(a.body.session_id).toBeUndefined();
    const g = await capture("google/gemini-2.5-flash", "t2");
    expect(g.headers.get("x-grok-conv-id")).toBeNull();
    expect(g.body.session_id).toBeUndefined();
  });

  it("caps the models fallback array at 3 (OpenRouter's limit) — extras dropped", async () => {
    const { body } = await capture("a/one,b/two,c/three,d/four", "t-cap");
    expect(body.models).toEqual(["a/one", "b/two", "c/three"]);
  });

  it("no conversationId → no affinity signal at all", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "x-ai/grok-4.3";
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const p = resolveOwnerProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }
    expect((capturedHeaders as Headers).get("x-grok-conv-id")).toBeNull();
  });
});

describe("resolveConsolidateProvider", () => {
  it("returns not-ready when key is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    const p = resolveConsolidateProvider();
    expect(p.ready).toBe(false);
    expect(p.model).toBeNull();
  });

  it("defaults to the free reasoning chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.CONSOLIDATE_MODELS;
    const p = resolveConsolidateProvider();
    expect(p.ready).toBe(true);
    expect(p.label).toBe(
      "Consolidate · openai/gpt-oss-20b:free → cohere/north-mini-code:free → openrouter/free",
    );
  });

  it("honors CONSOLIDATE_MODELS as a comma-separated chain", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.CONSOLIDATE_MODELS = "google/gemini-2.5-flash-lite";
    const p = resolveConsolidateProvider();
    expect(p.label).toBe("Consolidate · google/gemini-2.5-flash-lite");
  });

  it("does NOT fall back to EXTRACT_MODELS/TITLE_MODELS — an unset value keeps reasoning", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.CONSOLIDATE_MODELS;
    process.env.EXTRACT_MODELS = "google/gemini-2.5-flash-lite";
    process.env.TITLE_MODELS = "openrouter/free";
    const p = resolveConsolidateProvider();
    // The reasoning default stands; the extractor/title chains are ignored.
    expect(p.label).toBe(
      "Consolidate · openai/gpt-oss-20b:free → cohere/north-mini-code:free → openrouter/free",
    );
  });

  it("injects reasoning:{effort:'low'} by default — reasoning is ON (unlike extract)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.CONSOLIDATE_MODELS = "openai/gpt-oss-20b:free";
    delete process.env.CONSOLIDATE_REASONING_EFFORT;

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = resolveConsolidateProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody as string);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("honors CONSOLIDATE_REASONING_EFFORT override", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.CONSOLIDATE_MODELS = "openai/gpt-oss-20b:free";
    process.env.CONSOLIDATE_REASONING_EFFORT = "medium";

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = resolveConsolidateProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }

    const body = JSON.parse(capturedBody as string);
    expect(body.reasoning).toEqual({ effort: "medium" });
  });
});

describe("openrouter fetch wrapper", () => {
  it("does not inject `models` field for single-model chain", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto";

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = resolveOwnerProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // ai-sdk may post-validate the stub response; we only care about the body
    }

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody as string);
    expect(body.model).toBe("openrouter/auto");
    expect(body.models).toBeUndefined();
  });

  it("injects `models` array when chain has fallbacks", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/free,openrouter/auto";

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = resolveOwnerProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody as string);
    expect(body.model).toBe("openrouter/free");
    expect(body.models).toEqual(["openrouter/free", "openrouter/auto"]);
  });

  it("public tier injects reasoning:{effort:'none'} to disable reasoning", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.PUBLIC_TIER_MODELS;

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = resolveTierProvider("public");
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }

    const body = JSON.parse(capturedBody as string);
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  // Helper: capture the request body for one doGenerate call.
  async function captureBody(resolve: () => { model: unknown }): Promise<Record<string, unknown>> {
    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const p = resolve() as {
      model: { doGenerate: (a: unknown) => Promise<unknown> } | null | string;
    };
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }
    return JSON.parse(capturedBody as string);
  }

  it("owner path injects the intent-gated effort when given one (#58)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto";
    const body = await captureBody(() => resolveOwnerProvider({ reasoningEffort: "medium" }));
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("trusted path injects the intent-gated effort when given one (#58)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto";
    const body = await captureBody(() =>
      resolveTierProvider("trusted", { reasoningEffort: "medium" }),
    );
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("INVARIANT: public tier IGNORES a gated effort and stays pinned to none (#58)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.PUBLIC_TIER_MODELS;
    // Even if the route passed `medium`, public must never reason (cost-protected).
    const body = await captureBody(() =>
      resolveTierProvider("public", { reasoningEffort: "medium" }),
    );
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("owner path FLOORS reasoning to `low` (the eval-backed memory-save floor)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto"; // single model → no models[] override either

    let capturedBody: string | undefined;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // No reasoningEffort passed (gate off / non-analytical) → floored to `low`.
    const p = resolveOwnerProvider();
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }

    const body = JSON.parse(capturedBody as string);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("public effort is PUBLIC_REASONING_EFFORT-overridable (grok-on-public)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.PUBLIC_TIER_MODELS;
    process.env.PUBLIC_REASONING_EFFORT = "low";
    // Fixed by env; still ignores the gated `medium` (public is not intent-gated).
    const body = await captureBody(() =>
      resolveTierProvider("public", { reasoningEffort: "medium" }),
    );
    expect(body.reasoning).toEqual({ effort: "low" });
    delete process.env.PUBLIC_REASONING_EFFORT;
  });

  it("trusted floor is TRUSTED_REASONING_FLOOR-overridable", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.TRUSTED_TIER_MODELS = "openrouter/auto";
    process.env.TRUSTED_REASONING_FLOOR = "medium";
    const body = await captureBody(() => resolveOwnerProvider()); // no effort → floors to medium
    expect(body.reasoning).toEqual({ effort: "medium" });
    delete process.env.TRUSTED_REASONING_FLOOR;
  });

  it("retries WITHOUT reasoning when a model 400s 'reasoning is mandatory'", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.PUBLIC_TIER_MODELS; // public pins effort:none → sends the disable
    delete process.env.PUBLIC_REASONING_EFFORT;
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body as string);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Reasoning is mandatory for this endpoint and cannot be disabled.",
              code: 400,
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const p = resolveTierProvider("public");
    if (!p.model || typeof p.model === "string") throw new Error("expected model object");
    try {
      await p.model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    } catch {
      // forward
    }
    expect(bodies.length).toBe(2); // first (reasoning:none) → 400 → one retry
    expect(JSON.parse(bodies[0]).reasoning).toEqual({ effort: "none" });
    expect(JSON.parse(bodies[1]).reasoning).toBeUndefined(); // dropped on retry
  });
});
