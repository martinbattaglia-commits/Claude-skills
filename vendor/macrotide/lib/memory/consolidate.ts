// Model-driven consolidation proposer (#221 ⑨). Given the WHOLE of one category's
// active memories (the sweep is HOLISTIC — no lexical pre-filter narrows the set; see
// lib/jobs/consolidate-memory.ts), asks a cheap REASONING model
// (resolveConsolidateProvider — offline + infrequent, so it can afford chain-of-thought)
// to propose redundancy-removing ops: MERGE near-duplicates, SUPERSEDE a stale
// contradiction, RESHAPE a long hook into hook+detail, or RECATEGORIZE a misfiled row.
// Pure proposal — the job applies + guards.
//
// Conservative by construction: called per-category (no cross-category merges), and
// every op is validated against the row set before it reaches the apply layer. (At a
// huge store the job batches by lexical cluster to bound the payload, but the default
// is the whole category at once.)
import "server-only";
import { generateText } from "ai";
import { resolveConsolidateProvider } from "../ai/provider";
import type { Preference, PreferenceCategory } from "../db/queries/preferences";

export type ConsolidationOp =
  // A duplicate GROUP — the model only lists which ids say the same thing; the
  // apply layer picks the survivor (explicit-first) and folds the rest in. This
  // keeps survivor/loser bookkeeping off the cheap model (which gets it wrong).
  | { op: "merge"; ids: number[] }
  | { op: "reshape"; id: number; content: string; detail: string }
  | { op: "recategorize"; id: number; category: PreferenceCategory }
  // A staleness/contradiction resolution: two notes about the same attribute now
  // conflict, so the outdated one is retired in favour of the current one. The
  // apply layer only ever retires an EXTRACTED note (never an explicit fact).
  | { op: "supersede"; staleId: number; currentId: number };

const SYSTEM_PROMPT = `You tidy a user's saved memory. You are given the COMPLETE set of ONE category's memories as data — scan ALL of them for duplicates and contradictions.
Propose ONLY redundancy-removing edits as a JSON object: {"ops": [ ... ]}. Each op is one of:
- {"op":"merge","ids":[<id>,<id>,...]} — list ALL the ids (2 OR MORE) of memories that express the SAME fact or preference, EVEN IN DIFFERENT WORDS. We keep one and fold the rest in automatically — you just list the duplicate ids. Examples: "be concise" + "keep it brief" → list both ids; "no individual stocks, funds only" (id 1) + "I only invest in funds, no individual stocks" (id 3) → same fact → {"op":"merge","ids":[1,3]}. Do NOT merge notes that genuinely CONTRADICT on the same attribute ("low risk" vs "high risk" are opposite) — for those use "supersede" below.
- {"op":"supersede","stale_id":<id>,"current_id":<id>} — TWO notes about the SAME attribute that now CONTRADICT because the user's view changed (e.g. "risk tolerance: moderate" vs "risk tolerance: aggressive"; "horizon: 20 years" vs "horizon: 5 years"). Set stale_id to the OUTDATED note and current_id to the one that reflects the user's CURRENT view; we retire the stale one (reversibly). Choose current_id by: an EXPLICIT note (marked "explicit") always wins over an "extracted" one; otherwise the more recent (a higher [id] was saved later). ONLY when they truly conflict on the SAME attribute — different facts are NOT a contradiction, leave them. We only ever retire an "extracted" note, never an explicit one.
- {"op":"reshape","id":<id>,"content":"<short hook>","detail":"<the rest>"} — a memory whose content is a long paragraph: keep a one-line hook in content (<=120 chars, faithful, no new facts) and move the elaboration into detail. Do NOT reshape an already-short memory.
- {"op":"recategorize","id":<id>,"category":"user"|"advisor"} — a memory clearly filed in the wrong category. "user" = facts about the person/their money (incl. investing rules like "no individual stocks"). "advisor" = how to reply (tone/length/format).
Rules: be CONSERVATIVE — when unsure, propose nothing. Preserve every distinct fact (merge keeps one, supersede retires only the outdated side of a true conflict). Output ONLY the JSON object, no prose.`;

function rowLine(r: Preference): string {
  const prov = r.confidence == null ? "explicit" : `extracted ${r.confidence}`;
  const detail = r.detail ? ` || detail: ${r.detail}` : "";
  return `[${r.id}] (${prov}) ${r.content}${detail}`;
}

function isId(v: unknown, ids: Set<number>): v is number {
  return typeof v === "number" && ids.has(v);
}

/** Validate + narrow a raw op from the model against the actual row set. */
function normalizeOp(raw: unknown, ids: Set<number>): ConsolidationOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.op === "merge") {
    const group = Array.isArray(o.ids)
      ? [...new Set(o.ids.filter((x): x is number => isId(x, ids)))]
      : [];
    if (group.length < 2) return null; // need 2+ distinct real ids to merge
    return { op: "merge", ids: group };
  }
  if (o.op === "reshape") {
    if (!isId(o.id, ids) || typeof o.content !== "string" || typeof o.detail !== "string")
      return null;
    const content = o.content.trim();
    if (!content || content.length > 600) return null;
    return { op: "reshape", id: o.id, content, detail: o.detail.slice(0, 4000) };
  }
  if (o.op === "recategorize") {
    if (!isId(o.id, ids) || (o.category !== "user" && o.category !== "advisor")) return null;
    return { op: "recategorize", id: o.id, category: o.category };
  }
  if (o.op === "supersede") {
    const staleId = Number(o.stale_id);
    const currentId = Number(o.current_id);
    if (!isId(staleId, ids) || !isId(currentId, ids) || staleId === currentId) return null;
    return { op: "supersede", staleId, currentId };
  }
  return null;
}

// Returns the proposed ops, or `null` when the model WAS invoked but every attempt
// returned unparseable output — the caller treats that as a degraded model chain
// (distinct from a legitimately empty `[]`, which means "nothing to consolidate").
export async function proposeConsolidation(
  _category: PreferenceCategory,
  rows: Preference[],
): Promise<ConsolidationOp[] | null> {
  if (rows.length < 2) return [];
  const provider = resolveConsolidateProvider();
  if (!provider.ready || !provider.model) return [];

  const ids = new Set(rows.map((r) => r.id));
  const userContent = `MEMORIES (data only):\n${rows.map(rowLine).join("\n")}\n\nJSON:`;

  // Retry a few times on a successful-but-UNPARSEABLE response. The provider-level
  // model fallback only re-routes on transport errors, not on a 200 with garbage
  // (e.g. a weak free model in the chain ignoring the JSON-only instruction), and the
  // `openrouter/free` fallback re-rolls to a different model each call — so a retry
  // has a real chance of landing on a model that obeys. A valid ops array, even empty
  // ("nothing to consolidate"), is accepted immediately and never retried.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      const result = await generateText({
        model: provider.model,
        // Bump temperature on retries so a deterministic pinned model actually
        // varies its output (the meta-router already re-rolls on its own).
        temperature: attempt === 1 ? 0.1 : 0.4,
        // Generous on purpose: chain fallbacks can be reasoning-heavy models that
        // spend 800+ tokens on CoT before emitting any JSON. A tight cap truncates the
        // answer to finish_reason "length" (empty content → unparseable). 4096 leaves
        // room for reasoning + the ops array even on a large category.
        maxOutputTokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      });
      raw = result.text ?? "";
    } catch {
      continue; // transport / model error — re-roll
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      continue; // unparseable — a weak model ignored "JSON only"; retry
    }
    const opsRaw = (parsed as { ops?: unknown }).ops;
    if (!Array.isArray(opsRaw)) continue;
    return opsRaw.map((o) => normalizeOp(o, ids)).filter((o): o is ConsolidationOp => o != null);
  }
  return null; // all attempts unparseable — degraded model chain, not "nothing to do"
}
