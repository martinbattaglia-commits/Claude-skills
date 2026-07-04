# Macrotide documentation

> An open-source AI investment companion for Thai index investors. This folder
> is the map of everything written down about the project — for the people who
> use it, the people who build it, and the AI agents that help maintain it.

New here? Start with the **[Getting started tutorial](./tutorials/getting-started.md)**.
Want the 90-second pitch and quick start? See the **[root README](../README.md)**.
Are you an AI agent about to change code? Read **[AGENTS.md](../AGENTS.md)** first.

## How these docs are organized

The docs follow the [Diátaxis](https://diataxis.fr/) framework — four sections,
each answering a different question. Pick by what you're trying to do:

| If you want to… | Go to | Mode |
|---|---|---|
| **Learn the app by doing** (first run, demo, first portfolio) | [tutorials/](./tutorials) | Learning |
| **Get a specific task done** (run it locally, import a portfolio, deploy) | [how-to/](./how-to) | Task |
| **Look up a fact** (env vars, API routes, the data model) | [reference/](./reference) | Information |
| **Understand how & why it works** (architecture, design decisions) | [explanation/](./explanation) | Understanding |

Feature deep dives and the prior-art research behind them live under
**[explanation/](./explanation)** — the per-feature design in
[explanation/memory.md](./explanation/memory.md) and the survey it's based on in
[explanation/research/](./explanation/research).

> **For AI agents — progressive loading.** This file is the L0/L1 map: read it
> first, then open only the section index (each folder's `README.md`) you need,
> then the single doc within it. Files are kept small and single-purpose so you
> load just the context the task requires. A machine-readable entry point lives
> at [/llms.txt](../llms.txt).

## The docs map

Each section's `README.md` is the **complete, authoritative index** for that
section — start there, or jump straight into a folder below. This page stays a
*map*, not a leaf inventory, so it doesn't drift as individual docs come and go.

| Section | What's inside | Complete index |
|---|---|---|
| Tutorials | Learn by doing — first run, demo, your first holding | [tutorials/](./tutorials) |
| How-to | Task recipes — local dev, import a portfolio, deploy | [how-to/](./how-to) |
| Reference | Look up facts — config, API, data model, auth, design system | [reference/](./reference) |
| Explanation | Why it works — architecture, principles, feature deep dives | [explanation/](./explanation) |
| ↳ Decisions | Settled technical calls — a Picks table + numbered ADRs | [explanation/decisions/](./explanation/decisions) |
| ↳ Research | Prior-art surveys behind the decisions | [explanation/research/](./explanation/research) |

[llms.txt](../llms.txt) is the flat, complete, machine-readable map of every
doc — the entry point for AI agents. [SECURITY.md](../SECURITY.md) (threat model)
and the [project board](https://github.com/users/Sitthinut/projects/2)
(forward-looking work) live at the repo root, alongside
[AGENTS.md](../AGENTS.md) (rules for AI agents touching the code).

## Keeping these docs honest

Staleness is the #1 documentation failure mode. The conventions that fight it:

- **Single source of truth.** Each fact lives in exactly one place; everything
  else links to it. The env-var table lives in [AGENTS.md](../AGENTS.md); deploy
  steps in [deploy.md](./how-to/deploy.md); feature status in the
  [README features list](../README.md#features) (built) + the
  [project board](https://github.com/users/Sitthinut/projects/2) (planned).
  Docs here **link**, they don't copy.
- **Docs travel with code.** Update the doc in the same commit as the change.
- **Docs link to code paths** (`see lib/db/schema.ts`) so a moved file is an
  obvious review flag. Many source files reciprocate with `see docs/...`.
- **Last-updated stamps** appear on `explanation/` docs that can drift.
