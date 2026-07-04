import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshMarketDb } from "@/tests/db-helpers";
import { runWithDbContext } from "../db/context";
import { appendMessage, createThread } from "../db/queries/chat";
import { listActive, save } from "../db/queries/preferences";
import * as schema from "../db/schema";

// Mutable knobs shared with the hoisted module mocks below.
const h = vi.hoisted(() => ({
  ready: true,
  text: "",
  shouldThrow: false,
  texts: [] as string[],
  calls: 0,
}));

vi.mock("../ai/provider", () => ({
  resolveExtractorProvider: () => ({
    model: h.ready ? ({} as never) : null,
    ready: h.ready,
    label: "stub-extractor",
  }),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    h.calls++;
    // A queue (h.texts) drives multi-call retry tests; "__throw__" simulates a
    // transport error. An empty queue falls back to the single h.text/h.shouldThrow.
    if (h.texts.length > 0) {
      const t = h.texts.shift() ?? "";
      if (t === "__throw__") throw new Error("model exploded");
      return { text: t };
    }
    if (h.shouldThrow) throw new Error("model exploded");
    return { text: h.text };
  }),
}));

import { extractSessionPreferences } from "./extract";
import { buildMemoryBlock } from "./inject";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = resolve("lib/db/migrations/app");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--> statement-breakpoint/g, ";");
  sqlite.exec(sql);
  const db = drizzle(sqlite, { schema });
  const market = freshMarketDb();
  return { sqlite, db, marketDb: market.db, marketSqlite: market.sqlite };
}

function withFresh<T>(fn: () => T | Promise<T>): Promise<T> {
  const { sqlite, db, marketDb, marketSqlite } = freshDb();
  return runWithDbContext(
    { appDb: db, appSqlite: sqlite, marketDb, marketSqlite, isDemo: true, sessionId: "test" },
    fn,
  ) as Promise<T>;
}

/** Seed a thread with one user turn so the transcript is non-empty. */
function seedThread(): string {
  const t = createThread();
  appendMessage({ threadId: t.id, role: "user", content: "I'm targeting retirement at 50." });
  appendMessage({ threadId: t.id, role: "assistant", content: "Noted — a 20-year horizon." });
  return t.id;
}

beforeEach(() => {
  h.ready = true;
  h.text = "";
  h.shouldThrow = false;
  h.texts = [];
  h.calls = 0;
});

describe("extractSessionPreferences", () => {
  it("saves parsed facts as source='extracted' with confidence + provenance", async () => {
    h.text = JSON.stringify({
      summary: "User discussed retirement timing.",
      facts: [{ category: "user", content: "retirement age: 50", confidence: 0.9 }],
    });
    await withFresh(async () => {
      const threadId = seedThread();
      const result = await extractSessionPreferences(threadId);

      expect(result.summary).toBe("User discussed retirement timing.");
      expect(result.saved).toHaveLength(1);
      expect(result.skipped).toBeUndefined();

      const saved = result.saved[0];
      expect(saved.category).toBe("user");
      expect(saved.content).toBe("retirement age: 50");
      expect(saved.injected).toBe(true); // 0.9 >= 0.7

      const active = listActive();
      expect(active).toHaveLength(1);
      expect(active[0].source).toBe("extracted");
      expect(active[0].confidence).toBe(0.9);
      expect(active[0].sourceSessionId).toBe(threadId);
      expect(active[0].sourceTurnIds?.length).toBeGreaterThan(0);
    });
  });

  it("marks mid-confidence rows recall-only (saved but not injected)", async () => {
    h.text = JSON.stringify({
      summary: "s",
      facts: [{ category: "user", content: "maybe likes gold", confidence: 0.5 }],
    });
    await withFresh(async () => {
      const threadId = seedThread();
      const result = await extractSessionPreferences(threadId);
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0].injected).toBe(false); // 0.5 < 0.7

      // Saved (recallable) but kept OUT of the always-on injected block.
      expect(listActive()).toHaveLength(1);
      expect(buildMemoryBlock(null)).toBe("");
    });
  });

  it("drops sub-threshold noise (confidence < 0.3)", async () => {
    h.text = JSON.stringify({
      summary: "s",
      facts: [{ category: "user", content: "wild guess", confidence: 0.1 }],
    });
    await withFresh(async () => {
      const result = await extractSessionPreferences(seedThread());
      expect(result.saved).toHaveLength(0);
      expect(result.skipped).toBe("no_facts");
      expect(listActive()).toHaveLength(0);
    });
  });

  it("de-dupes repeated facts and skips invalid categories", async () => {
    h.text = JSON.stringify({
      summary: "s",
      facts: [
        { category: "user", content: "owns NVDA", confidence: 0.8 },
        { category: "user", content: "Owns NVDA", confidence: 0.8 }, // dup (case-insensitive)
        { category: "nonsense", content: "bad cat", confidence: 0.9 }, // invalid category
      ],
    });
    await withFresh(async () => {
      const result = await extractSessionPreferences(seedThread());
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0].content).toBe("owns NVDA");
    });
  });

  it("skips cleanly when no provider is configured", async () => {
    h.ready = false;
    await withFresh(async () => {
      const result = await extractSessionPreferences(seedThread());
      expect(result.skipped).toBe("no_provider");
      expect(result.saved).toHaveLength(0);
      expect(listActive()).toHaveLength(0);
    });
  });

  it("skips when the session has no user/assistant turns", async () => {
    await withFresh(async () => {
      const t = createThread();
      const result = await extractSessionPreferences(t.id);
      expect(result.skipped).toBe("no_messages");
    });
  });

  it("returns model_error on unparseable output without throwing", async () => {
    h.text = "sorry, I cannot help with that";
    await withFresh(async () => {
      const result = await extractSessionPreferences(seedThread());
      expect(result.skipped).toBe("model_error");
      expect(listActive()).toHaveLength(0);
    });
  });

  it("returns model_error when the model call throws", async () => {
    h.shouldThrow = true;
    await withFresh(async () => {
      const result = await extractSessionPreferences(seedThread());
      expect(result.skipped).toBe("model_error");
    });
  });
});

describe("reconcile (add / update / skip)", () => {
  it("update against an extracted row supersedes it", async () => {
    await withFresh(async () => {
      const existing = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "extracted",
        confidence: 0.8,
      });
      h.text = JSON.stringify({
        summary: "s",
        facts: [
          {
            op: "update",
            target_id: existing.id,
            category: "user",
            content: "risk tolerance: aggressive",
            confidence: 0.85,
          },
        ],
      });
      const result = await extractSessionPreferences(seedThread());
      expect(result.saved[0]?.applied).toBe("updated");
      expect(listActive().map((r) => r.content)).toEqual(["risk tolerance: aggressive"]);
    });
  });

  it("update that EXTENDS an extracted row folds in the combined content", async () => {
    await withFresh(async () => {
      const existing = save({
        category: "user",
        content: "risk tolerance: moderate",
        source: "extracted",
        confidence: 0.8,
      });
      // The model reconciles a newly-mentioned horizon as an EXTEND of the
      // existing note — combined content, not a second near-duplicate row.
      h.text = JSON.stringify({
        summary: "s",
        facts: [
          {
            op: "update",
            target_id: existing.id,
            category: "user",
            content: "risk tolerance: moderate; 20-year horizon",
            confidence: 0.82,
          },
        ],
      });
      const result = await extractSessionPreferences(seedThread());
      expect(result.saved[0]?.applied).toBe("updated");
      // One active row, carrying the combined content — the narrower note is gone.
      expect(listActive().map((r) => r.content)).toEqual([
        "risk tolerance: moderate; 20-year horizon",
      ]);
    });
  });

  it("update against an EXPLICIT row is skipped, not an override", async () => {
    await withFresh(async () => {
      const explicit = save({
        category: "user",
        content: "funds only, no individual stocks",
        source: "advisor_tool",
      });
      h.text = JSON.stringify({
        summary: "s",
        facts: [
          {
            op: "update",
            target_id: explicit.id,
            category: "user",
            content: "individual stocks are fine now",
            confidence: 0.9,
          },
        ],
      });
      const result = await extractSessionPreferences(seedThread());
      // Trust-tier guard: an extracted fact can't supersede an explicit one, and
      // with no pending lane it's simply skipped — nothing saved.
      expect(result.saved).toHaveLength(0);
      // The explicit note is untouched and still injects.
      const block = buildMemoryBlock(null);
      expect(block).toContain("funds only, no individual stocks");
      expect(block).not.toContain("individual stocks are fine now");
    });
  });

  it("skip is a no-op (counts as no new facts)", async () => {
    await withFresh(async () => {
      const existing = save({
        category: "user",
        content: "owns a dog",
        source: "extracted",
        confidence: 0.8,
      });
      h.text = JSON.stringify({
        summary: "s",
        facts: [
          {
            op: "skip",
            target_id: existing.id,
            category: "user",
            content: "has a dog",
            confidence: 0.9,
          },
        ],
      });
      const result = await extractSessionPreferences(seedThread());
      expect(result.skipped).toBe("no_facts");
      expect(listActive()).toHaveLength(1);
    });
  });
});

describe("in-session retry on unparseable output", () => {
  it("retries past a transport error and an unparseable response, then succeeds", async () => {
    await withFresh(async () => {
      h.texts = [
        "not json at all",
        "__throw__",
        JSON.stringify({
          summary: "s",
          facts: [{ category: "user", content: "likes gold", confidence: 0.9 }],
        }),
      ];
      const result = await extractSessionPreferences(seedThread());
      expect(h.calls).toBe(3);
      expect(result.skipped).toBeUndefined();
      expect(result.saved.map((s) => s.content)).toEqual(["likes gold"]);
    });
  });

  it("gives up as model_error after the max attempts on persistent garbage", async () => {
    await withFresh(async () => {
      h.texts = ["garbage", "garbage", "garbage", "garbage"];
      const result = await extractSessionPreferences(seedThread());
      expect(h.calls).toBe(3);
      expect(result.skipped).toBe("model_error");
    });
  });
});
