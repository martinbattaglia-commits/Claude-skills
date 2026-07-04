# Research

Prior-art surveys behind Macrotide's design decisions — what existed in the
wider ecosystem at a given moment, and what we took from it. Each survey's
**Decision** links to the feature doc where the *reasoning* lives; this folder
is the evidence ("what's out there"), not the verdict.

## Surveys

| Survey | Behind |
|---|---|
| [memory-systems.md](./memory-systems.md) | The long-term memory design |
| [feedback-mechanisms.md](./feedback-mechanisms.md) | Feedback-by-memory ([ADR 0006](../decisions/0006-feedback-by-memory.md)) — corrections vs. ratings |
| [context-engineering.md](./context-engineering.md) | The Advisor context model + tool-using loop |
| [llm-platform-primitives.md](./llm-platform-primitives.md) | Provider tool-calling / system-prompt / reasoning / structured-output choices |
| [context-and-caching.md](./context-and-caching.md) | Prompt caching + context-window management / progressive loading |
| [agent-evals.md](./agent-evals.md) | The eval harness (`scripts/eval`) — graders, `pass^k`, dead-end metrics |
| [design-systems.md](./design-systems.md) | Design-system consistency + human/AI foolproofing — tokens, typed APIs, lint/CI gates, agent guardrails, governance |

## Conventions

- **One topic per file**, kebab-named (`memory-systems.md`) — no numbering;
  these are dated surveys, not a decision ledger.
- **Each doc opens with** a `*Researched <month year>*` line, then `## Summary`
  and `## Decision` sections — the Decision links to the feature doc where its
  reasoning lives. No status fields to keep bumping; GitHub's outline handles
  navigation. Sub-aspects within the body use `###`.
- **Provenance goes at the end** — a short closing section (e.g.
  `## About this research`) on how the research was gathered (sources, method,
  date) and which claims are unverified. It matters most for AI-gathered research
  — the reader needs to know what was checked against a primary source. Cite
  source URLs inline.
- **Latest vs historical:** the un-suffixed file is current. To re-survey, freeze
  the old one as `<topic>-<YYYY-MM>.md`, add `> Superseded by <new file>` at its
  top, and never touch it again — leaving one current file plus dated archives.
