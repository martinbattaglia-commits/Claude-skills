# Explanation

Understanding-oriented background — the shape of the system and the reasoning
behind it. Read these to build a mental model, not to complete a task.

### Core

| Doc | Explains |
|---|---|
| [Product direction](./product-direction.md) | Why Macrotide exists: north star, who it's for, the Learn → Analyze → Research → Select loop, the index-purist stance, and success signals |
| [Architecture](./architecture.md) | The system's overall shape, the request lifecycle, owner/demo DB routing, and where every kind of code lives |
| [Balances and History](./balances-and-history.md) | How stating a Balance and logging a trade fit together — the one-ledger model, the cost-basis-delta math with worked examples, self-healing edits, and custom-asset pricing |
| [Portfolio chart](./portfolio-chart.md) | How to read the Portfolio screen's chart — its three modes (Value / Performance / Breakdown), the rule that only the mode changes the line's meaning, the auto-fit ("auto-zoom") non-zero-based y-axis, and Linear vs Log scale (framing ⊥ scale) |
| [Cash](./cash.md) | How cash is tracked as a first-class asset — the three-roles split, the boundary model, the no-deduct rule, the Purpose (Role + Label) earmark, and the Include/Exclude-cash return basis |
| [Design principles](./design-principles.md) | Secure-by-default, the "Advisor" voice, and the single-owner → multi-user evolution |
| [Portfolio health](./portfolio-health.md) | Why the Portfolio screen leads with named checks (not a 0–100 grade) and how the look-through diversification check stays honest on partial data |
| [Market data pipeline](./market-data-pipeline.md) | How market.db is fed and kept fresh — the fund-catalog crawl (ELT) vs the NAV/quote series cache, the freshness-vs-coverage jobs, the upsert-only invariant, and the coverage limits (SEC ~5.4y fund depth; indices/FX still shallow) |

### Feature deep dives

| Doc | Explains |
|---|---|
| [memory.md](./memory.md) | The long-term memory + chat-session lifecycle: storage, tools, injection, extraction |
| [advisor-context.md](./advisor-context.md) | What the Advisor knows on a turn — the three context channels, the per-entry-point contract, and the empty-turn recovery |
| [advisor-vision.md](./advisor-vision.md) | How the Advisor reads images attached in chat — message flow, the dedicated vision model + caps, table-vs-card output, and ephemeral image storage |
| [inference-strategy.md](./inference-strategy.md) | How the Advisor stays smart/fast/token-efficient — model routing, prompt caching, reasoning tokens, context loading, tool-result shaping; each lever mapped to the backlog |

### Deeper — these subfolders hold their own complete index

| Subfolder | Holds |
|---|---|
| [decisions/](./decisions) | Settled technical calls — a Picks table + numbered ADRs, and the durable rules behind them |
| [research/](./research) | Prior-art surveys behind those decisions (memory systems, context engineering, evals, design systems, …) |

A feature's deep dive lives here as a single doc; the research that informed it
sits beneath it in [research/](./research). Both are understanding-oriented, so
this is their home rather than [reference](../reference) (facts) or
[how-to](../how-to) (tasks).

> These `explanation/` docs carry a **Last updated** stamp because, unlike
> [reference](../reference), they describe intent and can quietly drift from
> the code. If a stamp looks old and the text disagrees with the code, trust
> the code and fix the doc.
