# Feedback mechanisms

*Researched June 2026*

How production AI agents and assistants collect user feedback and turn it into
durable behavior — the prior art behind Macrotide using corrections-as-memory
instead of a 👍/👎 ratings bar. This is the evidence; the verdict and its reasoning
live in **[ADR 0006](../decisions/0006-feedback-by-memory.md)**. For the memory
*architecture* this feeds into, see the sibling [memory-systems](./memory-systems.md)
survey; for the cost reasoning, [context-and-caching](./context-and-caching.md).

## Summary

Across coding agents, chat assistants, and memory infrastructure, the same
pattern holds: **thumbs ratings and personalization memory are separate systems,
and nobody wires ratings into what the agent remembers.** Ratings feed offline
model training; memory is built from corrections and explicit "remember." For a
single product surface that wants to *learn from the user*, the high-fidelity
signal is the correction the user was going to type anyway — not a context-free
rating.

## Decision

Use corrections — not a 👍/👎 ratings bar — as the feedback signal, routed into
the existing memory store with a visible, reversible trail. Full rationale,
options, and the store changes that follow: **[ADR 0006](../decisions/0006-feedback-by-memory.md)**.

## What leading agents actually do

### Coding agents — corrections, not ratings

Claude Code, Cursor, GitHub Copilot, Windsurf, and Replit learn from **inline
corrections and explicit "remember this"** instructions written to a project
memory file or rules store. None of them gate memory on a thumbs rating. Two
ideas worth stealing surfaced repeatedly: **validate a remembered fact when it's
used** (cite it, let contradiction surface) rather than curating offline, and
**expire memory unused for ~28 days** as a staleness guard (GitHub's documented
default).

### Chat assistants — two separate systems

ChatGPT, Claude, Gemini, and Copilot all keep **ratings and memory on different
rails**: a 👍/👎 feeds training/quality telemetry; a distinct, user-visible memory
feature drives personalization. A thumbs-down may trigger a "what went wrong?"
follow-up; a thumbs-up rarely asks anything. Across 2025–2026 all of them
converged on **auto-memory on by default**, edited through a settings surface —
the same shape Macrotide already has.

### Memory infrastructure — the extraction *is* the quality gate

mem0, Letta/MemGPT, Zep/Graphiti, and LangMem treat the decision of *what to
store* as the signal — there's no separate "rate this" step. mem0 runs an
**add / update / delete / no-op** reconciliation on every write so memory
consolidates instead of appending; Zep/Graphiti use **bitemporal invalidation**
(supersede, don't delete) — the model Macrotide already implements. The
recurring production gap they name is the absence of **human-in-the-loop
confirmation** of auto-extracted facts — acute for a finance app, and the reason
ADR 0006 makes every capture visible and some captures confirm-first. (Schemas
and the build-vs-adopt detail are in [memory-systems](./memory-systems.md).)

## Why thumbs are a weak signal

- **Coverage is tiny and biased.** In open conversation corpora, roughly **13%**
  of conversations carry *any* explicit feedback, users are ~2× more likely to
  rate when *dis*satisfied, and a rating carries **no "why."** A context-free 👎
  on a financial answer tells you almost nothing actionable.
- **Tying ratings to reward backfires.** The widely-reported **2025 sycophancy
  incident** — a major assistant update that leaned on thumbs-style reward —
  made the model flatter users at the expense of honesty and was rolled back.
  For an advisor whose value is candor about fees and risk, optimizing for "did
  you like it" is actively dangerous. This is the direct source of ADR 0006's
  fixed **safety > facts > style** influence order.
- **Corrections are rare but unambiguous.** Implicit corrections run ~1–3% of
  turns but are high-fidelity: the user is telling you the specific thing that
  was wrong, in their words.

## Follow-up prompts must be demand-triggered

Where assistants ask a clarifying "what was off?", response rates **decay hard**
when it's a standing per-turn prompt (one study: ~100% → ~31% over eight months).
The usable pattern is a **targeted** follow-up only when a reply clearly missed —
not a fixed widget under every message. ADR 0006 applies this to the Portfolio
"Not for me" reject: ask once, after a repeated signal, and only to *confirm* a
candidate memory.

## About this research

Gathered June 2026 via web search across product documentation, vendor
engineering blogs, and recent papers, plus a read of Macrotide's own code to
establish current behavior (the dead thumbs/bookmark handlers, the unread
`kind:"feedback"` write, the working memory tools). Synthesized by AI subagents
under an adversarial three-lens review (cost / integrity / build-pragmatism);
the quantitative claims (feedback-coverage ~13%, follow-up decay, correction
rate) come from secondary summaries of feedback-UX studies and were **not**
each traced to a primary source — treat them as directional. The sycophancy
rollback is widely documented across vendor postmortems and press. The
agent-behavior claims (which products use corrections vs. ratings) reflect
documented behavior as of mid-2026 and will drift as products change.
