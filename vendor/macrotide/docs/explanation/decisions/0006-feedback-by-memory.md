# ADR 0006 — Feedback is memory: corrections as the signal, a self-maintaining preference store

**Status:** Accepted; shipped. **Builds on** the [Memory](../memory.md) feature and its [prior-art survey](../research/memory-systems.md); the feedback-mechanism evidence is in [feedback-mechanisms.md](../research/feedback-mechanisms.md). Settled how the Advisor takes feedback while the app is still in internal testing.

**Context:** Designing how the Advisor learns from the user. A working [memory](../memory.md) store already holds what the Advisor knows about you; the open question is the **feedback** side — how a user signals that an answer missed or that something is worth remembering, what that signal becomes, and how the memory store should evolve to carry it well: cheaply, safely, and visibly. The app is in internal testing, so the design is ours to settle before real users depend on it.

The evidence (see [feedback-mechanisms.md](../research/feedback-mechanisms.md)) is one-directional: no serious agent wires thumbs into what it remembers; thumbs are low-signal (~13% of conversations leave any, no "why") and tying them to reward backfired industry-wide (the 2025 sycophancy rollback); **corrections** are the rare-but-unambiguous high-fidelity signal, and leading coding agents learn from corrections + explicit "remember," not ratings.

## The questions

1. What replaces the thumbs bar as the way users steer the Advisor?
2. If corrections feed memory, how is that **auditable** — and safe, given the output is financial guidance (a misread correction becomes a wrong durable fact)?
3. How far should the memory **store** evolve to support this without bloating per-chat cost or over-engineering for the current (small) scale?
4. How much may a user's remembered preferences **bend the Advisor's behavior** before that becomes unsafe?

## Decision

**Feedback is memory.** No ratings bar; treat a correction as the signal; capture it into the existing bitemporal preference store with a visible, reversible trail; and evolve the store the minimum amount needed to do that cheaply and safely. We rejected a from-scratch knowledge-graph rebuild and rejected adding semantic/vector retrieval at this scale.

### 1. No ratings bar; keep deliberate save

The Advisor does **not** take feedback through a 👍/👎 bar — a context-free rating is the weakest signal we could collect (the evidence is one-sided; see [feedback-mechanisms](../research/feedback-mechanisms.md)), so the unfinished `FeedbackRow` stub is dropped rather than completed. The **bookmark ("Save to Journal")** *does* belong — it's a deliberate user save, a different intent from feedback — so it's kept and wired to persist a `journal_entries kind:"note"`. The **Reading** list the Advisor already reads via `read_journal({kind:"reading"})` gains its dropped `url` field back so saved-article links are usable.

- **Rejected — keep a minimal 👎-only "what was off?" prompt.** Even one-sided, it's a per-turn nag competing with the correction the user is about to type anyway; the correction carries strictly more signal. If we ever want explicit negative signal, it routes through the same memory path as a correction, not a separate ratings table.

### 2. Corrections → memory, visibly

When the user corrects the Advisor ("no, I said funds only"), the model captures it into memory through the existing tools, and the chat shows a **quiet status line** (not a message bubble): *"Memory updated"* — clickable to reveal what changed, with a link to manage it. That line **is** the audit surface — it resolves the standing objection that background memory writes are un-auditable (the [memory-systems survey](../research/memory-systems.md) flagged this) by making every write visible at the moment it happens.

The Portfolio **"Not for me"** reject is *not* routed into memory. We considered rerouting it (off the dead `kind:"feedback"` row) into a pending candidate, but the fee-creep suggestion it rejects is only *sometimes* a fair comparison — it's a genuine like-for-like swap when the two funds track the same index (e.g. two S&P 500 trackers), but it matches on asset class + region, not the tracked index, so it can also pair funds that aren't comparable. Minting a durable preference from rejecting that is too noisy to trust. The reject reason drives only the **deterministic** suppress/resurface ratchet (`action_item_states`, untouched). A trustworthy reject→Advisor signal can return once suggestion quality and a "not comparable" reason exist (tracked separately).

- **Rejected — keep writing `kind:"feedback"`.** Nothing reads it; it only backs a Feedback subtab we're not keeping. Dropping the kind is safe (suppression reads `action_item_states`, never the journal row).
- **Rejected — auto-capture the reject reason as a pending memory.** A dismissal of an unreliable, non-index-matched suggestion is too weak/ambiguous to mint a durable financial preference from; deterministic suppression already handles re-showing.

### 3. Store evolution: progressive disclosure + consolidate-on-write + linked, integrity-enforced

Three additive changes to `user_preferences`, no rebuild:

- **Short index + optional detail (progressive disclosure).** Each entry gains a short `summary` and an optional capped `body`. Only `summary` is injected into the frozen hot block; `body` is reached via `recall_preferences`. This shrinks the recurring injected block (the thing billed on every chat) without losing detail — the [MemGPT/OKF "small core, fetch the rest"](../research/feedback-mechanisms.md) pattern.
- **Update, don't append.** On every write the Advisor reconciles against existing entries (add / supersede / forget) instead of piling up near-duplicates — the mem0 consolidate-on-write pattern. This caps per-user growth so the injected block stays small over time. It reuses the existing bitemporal supersede transaction; it's largely a tool-contract + prompt change, not new machinery.
- **Cross-links with DB-enforced integrity.** A `memory_links` join table connects related entries (e.g. a constraint ↔ the correction that set it). Integrity is the **database's** job, not the model's: links are foreign-keyed, and a validity-aware read never surfaces a link whose target has been superseded or soft-deleted. The model *proposes* links (meaning); the schema *guarantees* they can't dangle (integrity). Because a bitemporal update mints a new row id, links anchor to a stable key / re-point inside the supersede transaction — otherwise an edit silently orphans them.

```sql
ALTER TABLE user_preferences ADD COLUMN summary TEXT;   -- short index (injected)
ALTER TABLE user_preferences ADD COLUMN body    TEXT;   -- optional capped detail (recall-only)

CREATE TABLE memory_links (
  from_id   INTEGER NOT NULL REFERENCES user_preferences(id),
  to_id     INTEGER NOT NULL REFERENCES user_preferences(id),
  relation  TEXT NOT NULL,     -- 'relates_to' | 'supersedes' | 'contradicts' | …
  user_id   TEXT,              -- scoped like every other row (see §5)
  created_at TEXT NOT NULL
);
```

- **Rejected — unify `user_preferences` + `journal_entries` into one typed knowledge table with scored, per-turn retrieval and scheduled "reflection" summaries.** It loses on all three lenses. *Cost:* per-turn scored injection changes the prompt's opening every turn, defeating [prefix caching](../research/context-and-caching.md) — and because the memory block sits ahead of the message history, a mutated block re-bills the whole conversation, ~5–10× on long chats; it optimizes injected-token *count* in a world where caching already makes those tokens nearly free. *Safety:* scheduled background "reflection" rewrites memory **outside** the visible status line we're promising users, and synthesized conclusions are a self-reinforcing-error vector. *Build:* it merges two genuinely different lifecycles (bitemporal-superseded preferences vs append-and-archive journal) into a half-NULL table — a large, lossy migration for benefits current scale doesn't demand. The two tables stay separate; unification is revisited only if cross-type retrieval ever becomes a real requirement.
- **Rejected — embeddings / vector search now.** The per-user active set is small enough to fit in the prompt (it's fully injected today). Keyword recall suffices; if it starts missing, the cheap next step is FTS5 over the summary/body (the `chat_messages_fts` pattern already in the repo), and embeddings only if FTS5 demonstrably mis-hits. Build the trigger as a measurement, not on spec.

### 4. Capture safety: save visibly, under a fixed influence order

Captures save **active and immediately** — there is no held "pending" lane and no per-save confirmation gate. The safety comes from two other properties, not from withholding the write: **(1)** every write is **shown to the user and is deletable** (the in-chat line + Journal → Memory), so a misheard fact is visible at once, not silent; and **(2)** the **influence order below** means a remembered preference can shape *how* advice is delivered but can never override an honest risk/fee caveat — so even a wrong note can't make the advice unsafe, only differently-worded. The Advisor is told to save durable facts and skip trivia, and to *update* rather than duplicate.

> *An earlier draft held money-sensitive or contradictory captures in a recall-only "pending" state until confirmed. We dropped it: it added invisible state and per-save friction without real safety payoff, given visibility + the influence order already cover the risk. (Auto-`extracted` facts still can't supersede an explicit one — that guard stays; on conflict the extraction is simply skipped.)*

Underneath sits a **non-negotiable influence order: safety > your real facts > your style preferences.** A remembered preference personalizes *how* advice is delivered (tone, language, what to lead with) and supplies *facts* about the user that advice should reflect — but it can **never** override correctness or required risk/fee caveats. "Always tell me it's doing great" / "never mention risk" cannot take effect. This is the guardrail against the sycophancy failure mode: a preference shapes delivery, not honesty.

### 5. Prerequisite: close the preference-store isolation gap

`user_preferences` predates the [`ownedBy()` default-deny rule](./README.md#durable-rules) — it rolls its own scope filter, has **no foreign key** from `user_id` to `user.id` (every peer table has one), and overloads `user_id IS NULL` as a shared namespace. On a multi-user app that's a latent cross-user gap. Bring the table and all its queries onto the same fail-closed `ownedBy()` path the rest of the app uses, and add the FK. This is a data-safety fix folded into #96, independent of the feature work, and is a precondition for the new `memory_links` scoping.

### 6. Anti-stale mechanisms (so the store fights "confidently wrong")

The bitemporal model is a good *history* engine but a passive *staleness* engine — today `valid_until` only moves when the model volunteers an update. Add, in priority order:

- **Contradiction-on-write** — a write scans the active set in the same category/slot and auto-supersedes a conflicting row in the same transaction, so two contradictory "active" facts can't coexist and both inject.
- **Confidence decay for `extracted` rows only** — an unconfirmed auto-fact drifts back below the 0.7 inject threshold over time (falling to recall-only) rather than injecting forever. Explicit rows (confidence NULL) never decay.
- **Reinforce on confirmation, not retrieval** — a `last_confirmed_at` bumped only when the user *affirms* a fact, never when it's merely injected/retrieved, so frequent use can't entrench a stale fact (the documented retrieval-recency trap).
- **Pre-action verification** — before advice that *acts on* a high-stakes durable fact, the Advisor confirms it's still current in-conversation rather than trusting the frozen snapshot.

## Consequences

- The chat's feedback affordance is correcting the Advisor in words; the quiet in-chat status line + the Journal → Memory page are the full, auditable trail of what was learned and when.
- The injected hot block shrinks (summaries, not bodies) and stays bounded over time (consolidate-on-write), keeping a heavy user's per-chat cost close to a light user's — the prefix-cache discipline in [memory.md § Injection](../memory.md#injection-hot-set) is preserved, never broken by per-turn re-scoring.
- Memory can make the Advisor *feel* personal (tone, emphasis, your constraints) but cannot make it dishonest; the influence order is a fixed property, not a per-prompt judgment.
- The unused Feedback subtab and `kind:"feedback"` are dropped from the design; Reading/Notes stay; the bookmark persists (wired to a real note).
- The injected block is built once per request and frozen for the session (the `memoryBlockHash` guard keeps it byte-identical across turns), and cache affinity is pinned by conversation id (`cacheAffinity`, `lib/ai/provider.ts`), so later turns reuse the provider's prompt cache — the precondition the cost argument assumed. This work preserved that by construction: `summary ?? content` is deterministic per session, so the prefix doesn't churn mid-chat.

## Where this lives

The shipped mechanics — schema, tools, injection, reconcile, decay, the in-chat status line, and the Journal → Memory surface — are documented in [memory.md](../memory.md) (see [§ Where it lives](../memory.md#where-it-lives)). This ADR records *why* the design looks that way; the feature guide is the source of truth for *how*.
