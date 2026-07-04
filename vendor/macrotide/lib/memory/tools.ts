// AI SDK tool surface for memory. Tools exposed to the chat model; all
// delegate to the existing query layer at lib/db/queries/preferences.ts.
//
// Source attribution: the model invokes these tools on the user's behalf during
// a chat turn, so every save records source = 'advisor_tool'.
//
// Confirmation copy follows AGENTS.md § Product copy & vocabulary — the AI is
// "Advisor". A write takes effect immediately for the rest of THIS chat (the tool
// result tells the model its write overrides the start-of-chat snapshot) and also
// loads in future chats; the injected block itself stays frozen per session for
// prompt-cache stability (see memory.md).
import { tool } from "ai";
import { z } from "zod";
import {
  confirm,
  createLink,
  forget,
  isCategory,
  listActive,
  PREFERENCE_CATEGORIES,
  type Preference,
  recall,
  save,
  update,
} from "../db/queries/preferences";

const categoryEnum = z.enum(PREFERENCE_CATEGORIES);

function categoryLabel(category: string): string {
  switch (category) {
    case "user":
      return "About you";
    case "advisor":
      return "How to respond";
    default:
      return category;
  }
}

function formatCandidates(rows: Preference[]): string {
  return rows.map((r) => `  - [${r.id}] ${r.content}`).join("\n");
}

export interface MemoryToolOptions {
  // Single owner: pass null. Multi-user threads the authenticated user id
  // through here.
  userId: string | null;
}

export function createMemoryTools({ userId }: MemoryToolOptions) {
  // Row scoping is enforced by ownedBy() context (see lib/db/queries/scope.ts);
  // userId is kept on the options for call-site symmetry but not re-threaded.
  void userId;
  const save_preference = tool({
    description:
      "Save a durable preference about the user so it loads automatically " +
      "in future chats. Use when the user explicitly states a stable fact, " +
      "preference, account detail, or how they want Advisor to respond. " +
      "FIRST check whether this UPDATES something already saved (it's in your " +
      "memory block, or use list_preferences) — if so call update_preference " +
      "instead of saving a near-duplicate. Choose the most specific category. " +
      "A saved preference takes effect immediately for the REST OF THIS chat " +
      "(treat it as overriding the start-of-chat memory snapshot) and also loads " +
      "automatically in future chats. Confirm to the user with the returned message.",
    inputSchema: z.object({
      category: categoryEnum.describe(
        "Which party the memory is about. `user` = any fact/context about the " +
          "person & their money — identity, goals, risk tolerance, holdings, " +
          "constraints, AND investing rules ('don't recommend individual " +
          "stocks' → `user`: that's advice CONTENT). `advisor` = how Advisor " +
          "should respond — tone, length, format ('be concise', 'answer in " +
          "Thai', 'skip disclaimers' → `advisor`: reply FORM). The cut is what " +
          "it controls (advice content vs reply form), not whether it sounds " +
          "like an instruction.",
      ),
      content: z
        .string()
        .min(1)
        .max(600, {
          message:
            "Memory line too long (max 600 chars). Write a one-line hook for `content` and move the elaboration into `detail`.",
        })
        .describe(
          "The fact to remember, as a SHORT one-line hook " +
            "(e.g. 'risk tolerance: moderate', 'no individual stocks, " +
            "funds only', 'be concise; skip disclaimers').",
        ),
      detail: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "Optional longer elaboration recalled on demand (NOT injected every " +
            "chat — keep `content` as the short hook). Use only when there's " +
            "genuinely more nuance worth keeping.",
        ),
    }),
    execute: async ({ category, content, detail }) => {
      const row = save({
        category,
        content,
        detail: detail ?? null,
        source: "advisor_tool",
      });
      return {
        ok: true as const,
        id: row.id,
        category: row.category,
        // Structured signal the chat UI turns into the muted status line
        // (see ChatScreen). The natural-language `message` is for the model.
        memoryEvent: {
          kind: "save" as const,
          id: row.id,
          category: row.category,
          content: row.content,
        },
        message: `Saved: ${content}. In effect now — use it for the rest of this chat (it overrides the start-of-chat memory snapshot) and it loads automatically in future chats.`,
      };
    },
  });

  const update_preference = tool({
    description:
      "Update an existing preference. Pass either the numeric id (from a " +
      "previous list_preferences call) or a distinctive substring of the " +
      "current content. If the substring matches more than one active " +
      "preference, the tool returns the candidates so you can ask the " +
      "user to clarify before retrying.",
    inputSchema: z.object({
      id_or_substring: z
        .string()
        .min(1)
        .describe(
          "Numeric id (e.g. '42') or a distinctive substring of the " +
            "existing content (e.g. 'retirement age').",
        ),
      new_content: z
        .string()
        .min(1)
        .max(600, {
          message:
            "Memory line too long (max 600 chars). Keep `new_content` a one-line hook; move elaboration into `detail`.",
        })
        .describe("The replacement one-line hook for the preference."),
      detail: z
        .string()
        .max(4000)
        .optional()
        .describe("Optional replacement for the longer recalled-on-demand detail."),
    }),
    execute: async ({ id_or_substring, new_content, detail }) => {
      const result = update(id_or_substring, new_content, detail ? { detail } : {});
      if (result.kind === "none") {
        return {
          ok: false as const,
          reason: "not_found" as const,
          message:
            `I couldn't find an active preference matching "${id_or_substring}". ` +
            "Try list_preferences to see what's saved.",
        };
      }
      if (result.kind === "ambiguous") {
        return {
          ok: false as const,
          reason: "ambiguous" as const,
          candidates: (result.candidates ?? []).map((r) => ({
            id: r.id,
            category: r.category,
            content: r.content,
          })),
          message:
            `I found multiple matches for "${id_or_substring}":\n` +
            `${formatCandidates(result.candidates ?? [])}\n` +
            "Ask the user which one to update, then call update_preference " +
            "again with the specific id.",
        };
      }
      const oldRow = result.oldRow;
      const newRow = result.newRow;
      return {
        ok: true as const,
        old_id: oldRow?.id,
        new_id: newRow?.id,
        category: newRow?.category,
        // The update created `new_id` (now active) and superseded `old_id`;
        // Undo restores the old row and forgets the new one.
        memoryEvent:
          newRow && oldRow
            ? {
                kind: "update" as const,
                id: newRow.id,
                oldId: oldRow.id,
                category: newRow.category,
                content: newRow.content,
              }
            : undefined,
        message: `Updated: "${oldRow?.content}" → "${newRow?.content}". The new value is in effect now — use it for the rest of this chat (it overrides the start-of-chat snapshot) and it loads in future chats.`,
      };
    },
  });

  const forget_preference = tool({
    description:
      "Forget (soft-delete) a preference so it no longer loads in future " +
      "chats. Pass either the numeric id or a distinctive substring. " +
      "The row stays for 30 days in case the user changes their mind " +
      "(restorable from Journal → Memory). If the substring is " +
      "ambiguous, the tool returns the candidates so you can disambiguate.",
    inputSchema: z.object({
      id_or_substring: z
        .string()
        .min(1)
        .describe("Numeric id or a distinctive substring of the content."),
    }),
    execute: async ({ id_or_substring }) => {
      const result = forget(id_or_substring);
      if (result.kind === "none") {
        return {
          ok: false as const,
          reason: "not_found" as const,
          message:
            `I couldn't find an active preference matching "${id_or_substring}". ` +
            "Try list_preferences to see what's saved.",
        };
      }
      if (result.kind === "ambiguous") {
        return {
          ok: false as const,
          reason: "ambiguous" as const,
          candidates: (result.candidates ?? []).map((r) => ({
            id: r.id,
            category: r.category,
            content: r.content,
          })),
          message:
            `I found multiple matches for "${id_or_substring}":\n` +
            `${formatCandidates(result.candidates ?? [])}\n` +
            "Ask the user which one to forget, then call forget_preference " +
            "again with the specific id.",
        };
      }
      const row = result.row;
      return {
        ok: true as const,
        id: row?.id,
        category: row?.category,
        memoryEvent: row
          ? { kind: "forget" as const, id: row.id, category: row.category, content: row.content }
          : undefined,
        message:
          `Forgotten: ${row?.content}. It no longer applies — disregard it for the rest of this chat too — ` +
          "and it won't load in future chats (restorable from Journal → Memory for 30 days).",
      };
    },
  });

  const list_preferences = tool({
    description:
      "List the user's active preferences. Optionally filter by category. " +
      "Useful before update_preference / forget_preference when you need " +
      "the id of an existing row, or when the user asks 'what do you " +
      "remember about me'.",
    inputSchema: z.object({
      category: categoryEnum.optional().describe("Optional: restrict to one category."),
    }),
    execute: async ({ category }) => {
      const filter = category && isCategory(category) ? category : undefined;
      const rows = listActive(filter);
      return {
        ok: true as const,
        count: rows.length,
        rows: rows.map((r) => ({
          id: r.id,
          category: r.category,
          content: r.content,
          // Provenance so the model attributes honestly: a `stated` memory the
          // user set deliberately vs an `inferred` one you picked up from chat
          // (paraphrased — never quote it back as the user's exact words).
          origin: r.source === "advisor_tool" ? ("stated" as const) : ("inferred" as const),
          ...(r.source === "extracted" && r.confidence != null ? { confidence: r.confidence } : {}),
        })),
        message:
          rows.length === 0
            ? filter
              ? `No active preferences in ${categoryLabel(filter)}.`
              : "No active preferences saved yet."
            : `${rows.length} active preference${rows.length === 1 ? "" : "s"}` +
              (filter ? ` in ${categoryLabel(filter)}.` : "."),
      };
    },
  });

  const recall_preferences = tool({
    description:
      "Recall saved preferences relevant to a topic. This is the cold-recall " +
      "complement to the always-on memory block: the active preferences are " +
      "already injected at the top of the conversation, so use this only when " +
      "you need to look something up that may not be top-of-mind — e.g. the " +
      "user asks 'what did I tell you about my taxes?' or you want to check " +
      "for a relevant constraint before answering. Matches active preferences " +
      "by keyword (any word in the query). Returns the matching rows; if " +
      "nothing matches, say so plainly rather than guessing.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text topic or keywords to search saved preferences for " +
            "(e.g. 'retirement age', 'tax', 'how should you respond').",
        ),
    }),
    execute: async ({ query }) => {
      const { rows, total } = recall(query);
      const truncated = total > rows.length;
      return {
        ok: true as const,
        count: rows.length,
        total,
        rows: rows.map((r) => ({
          id: r.id,
          category: r.category,
          content: r.content,
          // See list_preferences — `stated` vs `inferred` so recalled memories
          // are attributed honestly, not quoted back as the user's exact words.
          origin: r.source === "advisor_tool" ? ("stated" as const) : ("inferred" as const),
          ...(r.source === "extracted" && r.confidence != null ? { confidence: r.confidence } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
        })),
        message:
          rows.length === 0
            ? `No saved preferences match "${query}".`
            : `Showing ${rows.length} of ${total} match${total === 1 ? "" : "es"} for "${query}":\n` +
              formatCandidates(rows) +
              (truncated ? "\nNarrow your query (add a more specific term) to see the rest." : ""),
      };
    },
  });

  const confirm_preference = tool({
    description:
      "Reinforce a saved preference the user has just re-affirmed or re-stated " +
      "(e.g. they repeat a constraint, or say 'yes, still true'). Records the " +
      "confirmation so the fact reads as current and resists decay. Optional — " +
      "use only on a clear re-affirmation. Pass the numeric id or a distinctive " +
      "substring.",
    inputSchema: z.object({
      id_or_substring: z
        .string()
        .min(1)
        .describe("Numeric id or a distinctive substring of the content to confirm."),
    }),
    execute: async ({ id_or_substring }) => {
      const result = confirm(id_or_substring);
      if (result.kind === "none") {
        return {
          ok: false as const,
          reason: "not_found" as const,
          message: `I couldn't find a preference matching "${id_or_substring}".`,
        };
      }
      if (result.kind === "ambiguous") {
        return {
          ok: false as const,
          reason: "ambiguous" as const,
          candidates: (result.candidates ?? []).map((r) => ({
            id: r.id,
            category: r.category,
            content: r.content,
          })),
          message:
            `Multiple matches for "${id_or_substring}":\n` +
            `${formatCandidates(result.candidates ?? [])}\n` +
            "Ask which one, then confirm by id.",
        };
      }
      const row = result.row;
      return {
        ok: true as const,
        id: row?.id,
        category: row?.category,
        memoryEvent: row
          ? { kind: "confirm" as const, id: row.id, category: row.category, content: row.content }
          : undefined,
        message: `Confirmed: ${row?.content}. Active in your next chat.`,
      };
    },
  });

  const link_preferences = tool({
    description:
      "Link two related preferences so the relationship is recorded (e.g. a " +
      "hard constraint and the correction that set it). Pass the numeric ids " +
      "(from list_preferences) and a short relation label like 'relates_to', " +
      "'supersedes', or 'contradicts'. Optional — use only when a connection is " +
      "genuinely useful.",
    inputSchema: z.object({
      from_id: z.number().int().describe("Numeric id of the source preference."),
      to_id: z.number().int().describe("Numeric id of the related preference."),
      relation: z
        .string()
        .min(1)
        .max(40)
        .describe("Short relation label, e.g. 'relates_to' | 'supersedes' | 'contradicts'."),
    }),
    execute: async ({ from_id, to_id, relation }) => {
      const link = createLink(from_id, to_id, relation);
      if (!link) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          message:
            "Couldn't link those — both ids must be your own active preferences " +
            "and they must differ. Check list_preferences for valid ids.",
        };
      }
      return {
        ok: true as const,
        message: `Linked #${from_id} —${relation}→ #${to_id}.`,
      };
    },
  });

  return {
    save_preference,
    update_preference,
    forget_preference,
    confirm_preference,
    link_preferences,
    list_preferences,
    recall_preferences,
  };
}

export type MemoryTools = ReturnType<typeof createMemoryTools>;
