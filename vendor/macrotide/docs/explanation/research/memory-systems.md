# Agent memory systems — a prior-art survey

*Researched May 2026*

## Summary

How production and open-source agent-memory systems (Hermes, OpenHuman, mem0,
Letta, OpenViking, …) store, write, and retrieve long-term memory. The recurring
splits: auto-extraction vs model-driven writes, and hidden embeddings vs
user-visible entries.

## Decision

Macrotide builds its own visible, real-time, *bitemporal* memory rather than
adopting a framework — full rationale in [memory.md](../memory.md).

## Hermes Agent (Nous Research)

### What it is

A local-first agent harness with a deliberately minimal,
file-based core memory and a pluggable provider system for anything heavier.

### Memory model

Two plain Markdown files in `~/.hermes/memories/`:

- `MEMORY.md` — the agent's own operational notes (environment facts, project
  conventions, learned techniques, a completed-task diary). Cap: **2,200 chars
  / ~800 tokens**.
- `USER.md` — the user profile (name, timezone, comms preferences, skill level,
  pet peeves). Cap: **1,375 chars / ~500 tokens**.

Entries inside each file are delimited by `§`. No database, no vectors, no
embeddings at the core layer. Categorisation is purely target-level (`memory`
vs `user`); there is no further tagging.

Writes are **agent-driven, not auto-extracted**. The model "saves automatically
when it learns" — a preference, a correction, an environment fact — or on an
explicit user instruction ("Remember that…"). There is no background
conversation scraper; the LLM makes intentional save decisions.

Retrieval is a **"frozen snapshot"**: both files are rendered into the system
prompt at session start and **never mutate mid-session** — explicitly to
preserve the LLM prefix cache. In-session writes hit disk but don't appear in
context until the next session.

Pruning is by **hard char cap**. When a file is full the tool errors and dumps
current entries so the agent can consolidate. The docs advise: *"When memory is
above 80% capacity… consolidate entries before adding new ones,"* and give an
explicit "skip these" list — *"Trivial/obvious info"*, *"Easily re-discovered
facts."*

The tool surface is a single `memory` tool with three actions — `add`,
`replace`, `remove` — and notably **no `read`** (memory is always injected).
`replace`/`remove` match on a short unique **substring** rather than full text,
which lowers edit friction. A separate `session_search` tool gives **FTS5**
full-text search over all prior CLI/messaging sessions stored in SQLite —
forming a deliberate two-tier system: a bounded always-on prompt memory plus
unlimited on-demand historical recall.

The **provider** layer sits above the built-in files. Exactly one external
provider can be active at a time, with lifecycle hooks for context injection,
non-blocking per-turn prefetch, post-turn sync, end-of-session extraction,
mirroring of built-in writes, and tool exposure. Backends span local
(Holographic = SQLite; ByteRover = hierarchical tree; OpenViking = filesystem),
cloud (Honcho, Mem0, RetainDB, Supermemory), and hybrid (Hindsight). Two
provider details worth noting: Supermemory *"strips recalled memories from
captured turns to prevent recursive memory pollution"* (avoiding the loop where
re-injected memories get re-saved), and ByteRover does *"pre-compression
extraction"* that "saves insights before context compression discards them."

### The one idea worth stealing

Frozen-snapshot injection as a *cache
discipline* — accept that in-session writes won't be visible until next session,
in exchange for a stable prompt prefix. Plus the two-tier split: a tiny
always-injected core, with FTS recall for everything else.

Sources:
[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[memory-providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).

## OpenHuman (tinyhumansai/openhuman)

### What it is

A Rust desktop "personal AI" with one of the more serious
open-source memory implementations surveyed. Its centerpiece is the **Memory
Tree** — a deterministic hierarchical-summary pipeline, explicitly *not* a vector
database with a thin memory wrapper.

### Memory model

Local-first SQLite at `<workspace>/memory_tree/chunks.db` (the
unified store carries **FTS5 keyword search + vector embeddings + graph
relations** in one), plus an Obsidian-compatible Markdown vault at
`<workspace>/wiki/`. The backend contract is the `Memory` trait
(`src/openhuman/memory/traits.rs`); the canonical row is
`MemoryEntry { id, key, content, namespace, category, timestamp, session_id,
score }`. Categories are `Core | Daily | Conversation | Custom(String)`.

From the feature doc (`gitbooks/features/obsidian-wiki/memory-tree.md`), the
pipeline is:

```
source adapters (chat / email / document)
  → canonicalize   (normalised Markdown + provenance metadata)
  → chunker        (deterministic IDs, ≤3k-token bounded segments)
  → content_store  (atomic .md files on disk)
  → store          (chunks, scores, summaries, jobs)
  → score          (signals + embeddings + entity extraction)
  → source / topic / global trees
  → retrieval      (search / drill_down / topic / global / fetch)
```

It builds **three concurrent summary trees** from the same leaf stream:

- **Source trees** — a per-source rolling buffer (L0) that seals into L1 → L2 …
  as it fills. One per Gmail label, Slack channel, uploaded document, etc.
- **Topic trees** — per-entity summaries materialised lazily by **hotness**: the
  more an entity (person, project, ticker, repo) recurs, the more aggressively
  its tree is built and refreshed.
- **Global tree** — one daily digest across everything ingested that day.

Writes are mostly **automatic and LLM-free on the hot path**: canonicalize →
chunk → fast-score → persist in a single transaction → enqueue follow-up. The
heavy work (embeddings, entity extraction, sealing buckets, daily digests) runs
in **background workers** off a durable on-disk queue, so the UI never blocks.
A chunk's lifecycle is orthogonal to its category: `pending_extraction →
admitted → buffered → sealed | dropped`.

Retrieval is two-track: the `Memory` trait offers blended keyword+vector+
freshness `recall` (with a `RecallOpts.cross_session` flag that surfaces
episodic hits from *other* sessions in the same workspace — workspace == user is
the hard boundary), and the tree side offers scope-selectable `search /
drill_down / topic / global / fetch`.

Pruning *is* the bucket-seal mechanism: L0 buffers fill and seal into L1
summaries that cascade upward; a `flush_stale` job force-seals idle buffers; a
daily UTC scheduler enqueues the global digest.

The doc's own justification for trees over vectors is worth quoting:

> "Vector stores answer 'what is similar to this query?' Memory needs to answer
> more than that … Trees give you compression *and* navigation. Embeddings still
> live inside so semantic search keeps working, but the structure on top is what
> makes the memory feel like a brain instead of a bag of fragments."

One more notable choice: the backend is **pluggable**. Setting
`backend = "agentmemory"` in `config.toml` short-circuits the SQLite+embedder
path and proxies every trait call (`store`, `recall`, `get`, `list`, `forget`,
`namespace_summaries`, `count`, `health_check`) to a self-hosted
[agentmemory](https://github.com/rohitg00/agentmemory) REST daemon — so Claude
Code, Cursor, Codex, OpenCode, and OpenHuman can share one durable store.

### The one idea worth stealing

A deterministic, LLM-free hot path with all the
expensive work deferred to background workers — cost stays bounded under burst —
plus hierarchical summary trees that give you both compression and navigation
rather than a flat similarity search.

Source: [github.com/tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman)
(repo read directly; file paths cited inline).

## OpenClaw — 12-layer memory architecture

### What it is

OpenClaw is an open-source agent framework (Peter Steinberger,
Nov 2025; originally "Clawdbot"), runnable over Discord/Telegram/web and
powerable by Claude models. The core framework ships **no** memory layer; the
de-facto community standard is the
[`coolmanns/openclaw-memory-architecture`](https://github.com/coolmanns/openclaw-memory-architecture)
spec — a 12-layer system whose tagline is that *"agents reconstruct themselves
from files on every boot."*

### Memory model

Its thesis is explicitly **anti-monoculture** — *"Don't rely on
one approach. Use the right memory layer for each type of recall"*:

- "What's my daughter's birthday?" → **structured lookup** (instant, exact)
- "What did we decide about the database?" → **decision fact** (instant, exact)
- "What happened last week with the deployment?" → **semantic search** (fuzzy)

The layers, roughly:

- A **Lossless Context Engine** (`lcm.db`) stores all messages, builds a summary
  DAG, and assembles the context window from the DAG plus live messages (with an
  FTS index).
- **Always-loaded workspace files** — `MEMORY.md`, `USER.md`, `SOUL.md`,
  `AGENTS.md` — injected at 0-token-cost-to-compute on every boot. This is the
  "reconstruct from files" idea.
- A structured **`facts.db`** holding entities, relations, aliases, and **decay
  tiers**.
- A **continuity archive** with embeddings (nomic, 768-d), topics, and anchors.
- **LightRAG on PostgreSQL** / GraphRAG for domain RAG; `llama.cpp` for local
  embeddings.
- **Metacognitive plugins** (main-agent only): Metabolism (fact extraction),
  Stability (entropy / growth vectors), Contemplation (a multi-pass deep-inquiry
  background job).

A single `memory_search` tool **fans out across four backends in parallel**
(continuity / facts / files / lcm) and returns one merged result — the agent
makes one call, not four.

The README is candid about the limitation it's fighting: the underlying memory
is *"fundamentally session-scoped and compaction-dependent — when context
windows fill up, information gets summarized, which means detail loss."*

### The one idea worth stealing

A single retrieval tool that fans out to
several specialised stores in parallel and merges — the model gets one ergonomic
entry point while each backend does what it's best at (exact KV vs FTS vs
vector).

Sources:
[coolmanns/openclaw-memory-architecture](https://github.com/coolmanns/openclaw-memory-architecture),
[robotpaper.ai reference architecture](https://robotpaper.ai/reference-architecture-openclaw-early-feb-2026-edition-opus-4-6/),
[VentureBeat on OpenClaw + Anthropic](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch).

## mem0

### What it is

A managed/open-source memory *layer* that bolts onto an existing
chat loop; the write path is invisible and retrieval is the API.

### Memory model

Three storage layers — **vector + graph + key-value** — under a
four-(plus-one)-scope model: `user_id`, `agent_id`, `run_id`, `app_id`, plus
optional `org_id`. Memories are **extracted automatically from conversation in
the background** and stored against whichever scopes apply.

Retrieval blends **semantic similarity + keyword + entity matching + time
filters in a single query** (the graph-enhanced variant adds traversal). At the
start of a new session, relevant memories are retrieved and injected before the
model responds.

Reported benchmarks (secondary source): on **LOCOMO**, mem0 hits 66.9% accuracy
at 0.71s median latency with ~1,800 tokens/conversation; the graph variant
`mem0g` reaches 68.4% at 1.09s. Its 2026 algorithm's biggest gains were on
temporal queries (+29.6 pts) and multi-hop reasoning (+23.1 pts).

### The one idea worth stealing

A lean, opinionated managed layer where the
write is fully out-of-band — the application never thinks about *when* to save,
only *how* to query. (The flip side, and a reason Macrotide went the other way:
the write is **opaque** to the end user.)

Sources:
[mem0.ai/blog/state-of-ai-agent-memory-2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026),
[github.com/mem0ai/mem0](https://github.com/mem0ai/mem0).

## Letta / MemGPT

### What it is

The OS-as-metaphor system from the MemGPT paper, productised as
Letta. Memory is a hierarchy modeled on a computer's memory pyramid, and the
agent **manages its own memory** through tool calls.

### Memory model

Three tiers:

- **Core memory** — always in-context, like RAM. The agent edits it live.
- **Recall memory** — searchable conversation history kept outside context,
  like a disk cache.
- **Archival memory** — long-term external store queried by tool call, like cold
  storage (embedding-backed).

The agent moves information between tiers by **explicitly calling functions** —
`core_memory_append`, `core_memory_replace` (edit in-context memory),
`conversation_search` (recall), and `archival_memory_insert` /
`archival_memory_search` (the external store). This is the **self-editing /
agent-as-memory-manager** pattern: the model is an active participant in
curating its own memory, not a passive recipient of injected context. The write
is on the **hot path**, decided by the model.

### The one idea worth stealing

The clean RAM / disk-cache / cold-storage
mental model, and treating "what's in context right now" as something the model
edits with first-class tools rather than something the framework decides behind
its back.

Sources:
[docs.letta.com — MemGPT agents (legacy)](https://docs.letta.com/guides/legacy/memgpt_agents_legacy).

## Zep (Graphiti)

### What it is

A production temporal-knowledge-graph memory layer; its open
engine is **Graphiti** (Apache 2.0). Its distinguishing bet is **bitemporality**
— it knows not just *what* a fact is, but *when it was true*.

### Memory model

A temporal graph of entities, relationships, and facts, where
**each fact carries a validity window**. Graphiti records **dual timelines**:

- `t_valid` — when the fact became true, and
- `t_invalid` — when it was superseded.

The canonical example from the research: a customer-service AI hears "I moved to
Taipei" on Monday and "I moved to Kaohsiung" on Wednesday. Zep automatically
marks the first fact `t_invalid` on Wednesday and the second `t_valid` from
Wednesday — **contradicted edges are auto-invalidated rather than overwritten**,
so history is preserved and "what did we believe last Tuesday?" remains
answerable.

> "Unlike traditional knowledge graphs, each fact in a context graph has a
> validity window: when it became true, and when (if ever) it was superseded."

Reported benchmark (secondary source): Zep scored **63.8% on LongMemEval** vs
mem0's 49.0%, and the vendor emphasises SOC 2 / HIPAA / GDPR compliance as a
selling point into finance/medical/legal.

### The one idea worth stealing

Bitemporal validity — never mutate a fact in
place; supersede it with a validity window so the system can reconstruct what was
true at any point. This is the single most directly relevant idea to a finance
app, where "your risk tolerance as of March" matters.

Sources:
[Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956),
[github.com/getzep/graphiti](https://github.com/getzep/graphiti),
[getzep.com](https://www.getzep.com/).

## LangMem

### What it is

LangChain's memory framework — not a store but a set of
**storage-agnostic primitives** you compose with any backend (with native
LangGraph integration available).

### Memory model

Two core primitive families, both implemented as pure functions
over memory state (no side effects, no DB dependency):

- **Memory Managers** — extract new memories, update/remove outdated ones, and
  consolidate or generalise from existing ones based on new conversation.
- **Prompt Optimizers** — update prompt rules and core behavior from
  conversation signal.

Crucially, LangMem offers **both** write paths and refuses to pick one for you:
agent-accessible **hot-path tools** for recording/searching memories *during* a
conversation, **and** a **background memory manager** that extracts, consolidates,
and enriches *outside* the conversation flow.

### The one idea worth stealing

"Don't pick a database, pick primitives" — keep
the extract/update/consolidate logic as pure functions decoupled from storage,
so the same logic runs on the hot path or in a background job.

Sources:
[langchain-ai.github.io/langmem](https://langchain-ai.github.io/langmem/),
[LangMem SDK launch](https://www.langchain.com/blog/langmem-sdk-launch),
[github.com/langchain-ai/langmem](https://github.com/langchain-ai/langmem).

## Cognee

### What it is

A graph-vector hybrid built around an ingestion **pipeline** that
turns raw documents into a knowledge graph layered with embeddings, with an
offline self-improvement pass.

### Memory model

A six-stage pipeline: classify documents → check permissions →
extract chunks → use an LLM to extract entities and relationships → generate
summaries → embed everything into the vector store and commit edges to the graph
(graph and vector index built in parallel, producing subject-relation-object
triplets). It separates **session memory** (short-term working set loaded into
runtime context) from the durable graph.

Its distinctive feature is **`memify`**, a post-ingestion pass that *"prunes
stale nodes, strengthens frequent connections, reweights edges based on usage
signals, and adds derived facts"* — i.e. memory is an evolving structure that
adapts from feedback, not static storage. Cognee ships **14 retrieval modes**,
from classic RAG to chain-of-thought graph traversal, and runs locally on
SQLite (relational) + LanceDB (vector) + Kuzu (graph) with no external services.

### The one idea worth stealing

`memify` — an explicit offline consolidation
step that reweights and prunes the memory graph by usage, rather than letting it
grow monotonically.

Sources:
[cognee.ai — how Cognee builds AI memory](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory),
[best AI agent memory systems 2026 (vectorize.io)](https://vectorize.io/articles/best-ai-agent-memory-systems).

## Anthropic memory tool

### What it is

A built-in tool for Claude (Managed Agents, public beta as of
2026) that gives agents a persistent **filesystem** of memory across sessions —
the simplest possible store, with the intelligence kept in the agent loop.

### Memory model

Memories are **files on a filesystem** (a memory directory,
typically Markdown). Claude can **create, read, update, and delete** files via
the tool, and they persist between sessions; developers can export, edit, and
manage them via API or in the Console. Writes are agent-driven (a CRUD tool
call), not background extraction.

Guidance emphasises **keeping memory lean** — store only what's essential for
every session, push project-specific knowledge into separate docs referenced on
demand, and remember that the aggregate size of loaded memory files directly
costs context and can degrade performance.

A May 2026 addition called **"dreaming"** has the agent review past sessions
**offline** to find patterns and self-improve (reported via secondary sources;
treat specifics as preliminary).

### The one idea worth stealing

Boring files + an offline consolidation pass:
the store is as simple as it can be (CRUD over files), the cleverness lives in
the agent loop and a periodic offline review — and "keep memory lean" is an
explicit, enforced design value.

Sources:
[Memory tool — Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
[Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
[9to5Mac on the May 2026 updates](https://9to5mac.com/2026/05/07/anthropic-updates-claude-managed-agents-with-three-new-features/).

## OpenViking (context note)

Surveyed alongside the above because it is the clearest example of the
"filesystem paradigm" trend and shows up as a Hermes provider. **OpenViking** is
a [Volcengine (ByteDance Cloud) project](https://github.com/volcengine/OpenViking)
(AGPLv3) that bills itself as a *Context Database for AI Agents*. It abandons the
flat vector blob and exposes memory, resources, and skills as a virtual
filesystem under `viking://`, navigable with `ls` / `read` / `find`. Context is
loaded in three tiers — **L0 summary (~100 tok) → L1 overview (~2k) → L2 raw** —
so the agent budgets tokens deterministically rather than gambling on top-k. It
requires both a VLM (for extraction) and an embedding model (for fallback
semantic search), and ships a Claude Code MCP plugin. The takeaway: deterministic,
tiered, navigable context as an alternative to probabilistic similarity search.

Sources:
[github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking),
[OpenViking explained (Medium)](https://medium.com/@techlatest.net/openviking-explained-reinventing-memory-and-context-for-ai-agents-c189b2bea61b).

## Academic landmarks (the patterns the products inherit)

Two research systems aren't shipping products but coined the mechanics the
libraries above implement; a third strand is a 2026 framing worth naming.

- **Stanford Generative Agents (2023, arXiv 2304.03442)** — the canonical
  **memory stream**: an append-only log of observations, each
  `{content, created, last_accessed, importance(1–10, LLM-scored), embedding}`.
  Two ideas the field absorbed: **reflection** (when summed recent importance
  crosses a threshold, the agent synthesizes 2–3 higher-level conclusions and
  stores them back as memories — consolidation as a write-time event), and the
  **recency · importance · relevance** retrieval score that every ranked store
  since cites as its baseline.
- **A-MEM (NeurIPS 2025, arXiv 2502.12110)** — a **Zettelkasten** for agents:
  each `MemoryNote {content, keywords, tags, context, links:{id→relation},
  evolution_history}` links to its nearest neighbors on write *and* can
  **evolve** them (a new note rewrites the tags/context of the notes it
  connects to). The closest prior art to a typed, cross-linked store — but with
  no multi-user scoping and no temporal model, so links can dangle as the graph
  churns. Macrotide takes the linking idea (`memory_links`) but enforces
  integrity in the schema (FK + validity-aware reads) rather than trusting the
  model to keep it clean.
- **Provenance-aware tiered memory** ("From Lossy to Verified", arXiv 2602.17913;
  survey arXiv 2606.04990) — the 2026 framing that a memory's **source tier**
  (raw / extracted / inferred / revised) is first-class metadata: **supersede,
  don't overwrite**, and on a cross-tier conflict **emit the uncertainty rather
  than silently picking a winner**. This is the published basis for Macrotide's
  trust-tier guard (an `extracted` note may never supersede an explicit one).

## At a glance: the pattern matrix

How the surveyed systems compare across the dimensions that mattered — store,
write trigger, retrieval, pruning, and user visibility:

| Dimension | Hermes | OpenHuman | OpenViking/OpenClaw | mem0 | Letta | Zep | LangMem | Anthropic | Cognee |
|---|---|---|---|---|---|---|---|---|---|
| Store | Markdown files | SQLite + vault + workers | FS tree `viking://` | vector+graph+KV | core/recall/archival | bitemporal graph | storage-agnostic (BYO) | files | graph+vector |
| Write trigger | Agent tool | Auto + tool | Auto-extract @ session end | Background extract | Agent tool (hot) | Auto + ingest | Both (hot + background) | Agent tool | Stage pipeline |
| Retrieval | Frozen snapshot @ session start | Blended FTS+vec+freshness | L0/L1/L2 tiered | Hybrid query | Tool calls | Graph traversal | BYO backend | Tool CRUD | 14 modes |
| Pruning | Hard char cap + consolidate | Bucket-seal + daily digest | Tier promotion | Background | Archival overflow | `t_invalid` edges | Manager consolidate/generalize | "Dreaming" | `memify` |
| User visibility | Files | Obsidian vault | FS readable | Opaque | Inspectable | Mostly opaque | Backend-dependent | Files | Mixed |

## Consensus and the genuine splits

By 2026 a few things had clearly converged across these systems; four were still
genuinely contested. The matrix above shows the per-system mechanics — this
section reads the verdicts off it, and the unique findings the columns can't
carry.

### Where the field had converged



- **Hybrid stores won.** The vector-vs-graph argument settled in favor of
  "both" — vectors for semantic entry points, a graph for multi-hop relational
  depth, a short-term episodic buffer (see the Store column). Nuance the matrix
  can't show: on *single-hop* factual lookup, GraphRAG can *under*-perform
  vanilla RAG; graphs pay off only as query complexity rises, at ~2–3× the
  retrieval latency.
- **Retrieval matters more than write strategy.** On the LoCoMo benchmark,
  accuracy spanned ~20 points across *retrieval* methods but only 3–8 points
  across *write* strategies — how you read back matters more than how you wrote.
- **Bounded hot context + on-demand cold recall** is the recurring shape:
  Hermes (core files + `session_search`), Letta (core + archival), Anthropic
  (lean memory + external docs), OpenHuman (always-on recall + tree drill-down).

### Where they still split

Four live tensions — the ones Macrotide had to
actively decide; the next section resolves each:

- **Who writes — hot path vs background.** Letta and the Hermes/Anthropic tool
  models write on the hot path (the agent decides inline); mem0 and
  "enterprise-grade" architectures push extraction to async background jobs to
  keep conversational latency at zero. LangMem refuses to choose and ships both.
  The trade is latency-and-control vs simplicity-and-recall-quality.
- **How memory enters context** — tool-call recall vs implicit injection.
- **User-visible vs opaque.** Hermes/Anthropic/OpenHuman expose memory as
  files/vaults a human can read and edit; mem0 and Letta's stores are largely
  opaque to the end user (you query them, you don't browse them).
- **Storage shape** — single `created_at` vs bitemporal validity windows, and a
  single store vs a vector+graph+KV hybrid.

## Token efficiency and retrieval economics

The survey above is about *correctness*; this is about *cost*, which for a
prefix-cached chat advisor drives as many decisions. The recurring findings:

- **Progressive disclosure beats a fat context.** A tiny always-injected core
  plus on-demand detail (MemGPT core-vs-archival, OKF/LLM-wiki `index.md`,
  TiMem's L1–L5 hierarchy) reports large savings — TiMem ~511 tokens/query vs
  mem0 ~1,070 on LoCoMo. The always-injected core should stay ~500–2k tokens.
  Macrotide's `summary` (injected) vs `body` (recall-only) split is exactly this.
- **Consolidate on write, not just on read.** The triggers seen in the wild:
  every-write reconcile (mem0 ADD/UPDATE/DELETE), importance-threshold
  (Generative Agents reflection), and capacity-saturation. Periodic "lint"
  sweeps are recommended but under-implemented in production.
- **Decay the score, not the data.** A production retrieval rank looks like
  `similarity · recency · reinforcement · confidence`, where **reinforcement
  bumps only on confirmation, not on retrieval** — otherwise a frequently-recalled
  stale fact entrenches itself. This is the basis for Macrotide's
  `last_confirmed_at` (reinforce on affirmation) and the extracted-only decay job.
- **Prompt caching inverts the usual retrieval math.** A *stable* injected prefix
  caches at ~0.1× on the next turn, so per-turn re-scored injection (which mutates
  the prefix every turn) is a net *loss* despite fetching "more relevant" context —
  the cache miss costs more than the relevance gain. This is the single biggest
  reason Macrotide froze the injected block per session rather than re-ranking it.
- **More memory is not better.** Lost-in-the-middle drops accuracy >30 points for
  facts buried mid-context; append-only stores bloat; over-summarization is lossy
  (~60% of facts irrecoverable at ~37× compression). A widely-cited mem0 audit
  found **97.8% of 10,134 auto-extracted entries were junk** with a weak model
  (fabrications plus 808 duplicate "prefers Vim" rows from a re-extraction loop).
  Mitigations the field converged on, all of which Macrotide implements: a
  quality/confidence gate, a REJECT/skip op, **strip already-injected memories
  before re-extracting** (`stripInjectedMemory`), and treat recalled notes as
  untrusted data. Sources: arXiv 2504.19413 (mem0), 2501.13956 (Zep),
  2304.03442 (Generative Agents); mem0 issue #4573; the LoCoMo and
  lost-in-the-middle benchmarks.

## Deduplication: candidate selection (pre-filter vs. whole-set)

*Added 2026-06-23 from a focused web-search pass for macrotide's consolidation sweep.*

When a system merges near-duplicates or resolves contradictions, how does it pick the
candidates to compare? Three families:

- **Lexical pre-filter → LLM.** mem0 (BM25 + MD5 exact-hash), Zep/Graphiti
  (entropy-gated MinHash/LSH + Jaccard 0.9), TiMem (BM25). Cheap; narrows the set
  before the model.
- **Vector top-K → LLM.** mem0 (dense top-10, RRF-fused with BM25 + entity), LangMem
  (top-5), Zep (cosine over 1024-d embeddings). Semantic candidates, then the model
  decides ADD/UPDATE/DELETE/NOOP.
- **Whole-set → LLM (no pre-filter).** Anthropic **Dreams** (the entire memory store
  + ≤100 transcripts handed to Claude to holistically reorganize; hard
  `input_memory_store_too_large` ceiling), OpenAI **"dreaming"**, Supermemory "dream
  cycles", and the research system U-Mem. The model reads everything and finds the
  dups/conflicts itself.

**The finding that drove our design:** every system that pre-filters cites **scale /
cost**, never accuracy — and several note the opposite, that a whole-set LLM pass
catches **antonymic conflicts a top-K vector retrieval misses** ("likes cats" vs
"allergic to cats" aren't embedding-neighbours; a Jaccard pre-filter symmetrically
*misses* reworded dups and *over-clusters* opposites). Token math: a personal store of
a few hundred ~50-token hooks is ~15 k tokens — one context window, ~$0.02 (Sonnet) to
~$0.45 (Opus) per pass, free on our reasoning chain. Pre-filtering only earns its keep
at thousands+ of memories, or when consolidation must run at write-time latency. One
thing worth keeping regardless: an **exact-hash dedup** before any LLM call (mem0's
MD5; our `save()` idempotency net).

**Decision** → macrotide's offline sweep is **holistic**: the whole category goes to
the reasoning model, and lexical clustering survives only as an over-budget scale
fallback. Mechanics in [memory.md](../memory.md). Sources: [mem0 (arXiv 2504.19413)](https://arxiv.org/html/2504.19413v1),
[Zep/Graphiti (arXiv 2501.13956)](https://arxiv.org/html/2501.13956v1),
[Anthropic Dreams](https://platform.claude.com/docs/en/managed-agents/dreams),
[OpenAI dreaming](https://openai.com/index/chatgpt-memory-dreaming/),
[Letta dedup issue #3116](https://github.com/letta-ai/letta/issues/3116).

## Patterns Macrotide adopted

Macrotide is a single-VM, SQLite, TypeScript personal finance advisor — no
Python sidecar, no vector service, a small and structured memory surface. That
constraint set scored the surveyed libraries against a hand-rolled store, then
resolved each of the four field splits above. It borrows specific ideas rather
than adopting any one framework wholesale.

### Build vs. adopt

The libraries were scored against those constraints. The verdict was to
**hand-roll over a single SQLite table** rather than adopt a framework:

| Library | Strength | Fit for Macrotide |
| --- | --- | --- |
| **mem0** | Open-source memory layer that bolts onto existing chat. JS SDK. Vector + relational hybrid. | Strong fallback. Adopt only if the bespoke version starts duplicating significant infrastructure. |
| **Letta (MemGPT)** | OS-inspired tiered memory (core / archival / recall). Self-editing via tool calls. | Heavier than needed; built for autonomous long-running agents, not a chat advisor. Skip unless the explicit-save model proves insufficient. |
| **Zep** | Production-grade vector + graph; strong for long-running enterprise sessions. | Mostly Python, service-oriented. Wrong scale for a personal app. (We still borrow its bitemporal *idea* — see below.) |
| **LangChain Memory** (the legacy conversation buffers/summarizers — distinct from the [LangMem](#langmem) SDK above) | Built-in summarization buffers, vector retrievers. | A heavy dependency for one feature. Prefer a ~50-line bespoke implementation over pulling in LangChain. |
| **Cognee** | Deep knowledge-graph retrieval. | Overkill. |
| **Hand-rolled** | Direct Drizzle + AI SDK. Full control. | **The chosen default.** Memory here is small — preferences + plan + journal already exist as structured tables. |

- **Long-term memory:** start hand-rolled (it's a few hundred lines), keep mem0
  in reserve as the escape hatch if the bespoke store starts reinventing a
  framework.
- **Chat compression:** use the **summarize-and-replace pattern Claude Code
  itself uses** (the `<summary>` block at the start of a long conversation) as
  the proven baseline — a cheap model over the same OpenRouter key, no library.
  Only add semantic retrieval / a vector store over `chat_messages` if
  measurement shows it earns its keep.

### The four splits, called for Macrotide

| Split | Option A | Option B | Call for Macrotide |
|---|---|---|---|
| Who writes? | Agent tool (Letta/Hermes) | Background extractor (mem0) | **Agent tool.** mem0's invisible writes are slick but un-auditable for finance. |
| Auto-inject vs tool-recall? | Inject (Hermes/mem0) | Recall tool (Letta) | **Inject** a bounded, frozen snapshot; recall tool added later as the long tail grows. |
| Bitemporal? | Single `created_at` (most) | `valid_from`/`valid_until` (Zep, OpenHuman drop-state) | **Adopt — two columns.** "Risk tolerance was conservative until 2026-01-15" is a real query in this product. |
| One store vs hybrid? | SQLite rows (Hermes/Letta core) | Vector+graph+KV (mem0/Cognee/OpenHuman) | **SQLite rows.** Hybrid is overkill for ~hundreds of preferences. |

The reasoning the table can't carry — the implementation nuance behind each
call:

- **Inject hot, recall cold** follows **Hermes's frozen-snapshot cache
  discipline**: the injected block is built once per session and held identical
  across turns to preserve the prefix cache, accepting that within-session
  writes won't be visible until the next session.
- **Bitemporal validity** lives in a `user_preferences` table where **updates
  add a new row and supersede the old one — nothing is mutated in place** — and
  `valid_until IS NULL` marks the active set. It is Zep's model without the
  temporal-knowledge-graph cost: "I switched from aggressive to moderate risk
  tolerance" supersedes the old fact with a validity window rather than erasing
  it.
- **Visible, auditable writes** are surfaced on a Journal → Memory page (plus a
  quiet in-chat status line on every write) — content, category, source,
  validity window, delete control, supersession shown rather than hidden. Each row records provenance: who saved it (`user_tool` /
  `advisor_tool`, with `extracted` reserved for any later background extraction),
  the originating session, the source turns, and a nullable `confidence` (NULL
  for explicit tool calls, which are always trusted).
- **Model-driven, real-time saves** are an explicit tool call the model makes in
  the moment — "remember I'm targeting retirement at 50" → the advisor calls a
  save tool → the next session knows it. Edits use **substring matching**
  (Hermes's ergonomic touch) rather than requiring exact full text.

> *How* Macrotide implements these lives in the
> [memory feature guide](../memory.md).

## About this research

This document reconstructs research carried out by a team of scout agents in
May 2026. The Hermes section comes from `WebFetch` against the official Nous
Research docs; OpenHuman from reading the `tinyhumansai/openhuman` repo directly
via the GitHub API (file paths are cited inline); OpenClaw from the
`coolmanns/openclaw-memory-architecture` README plus web search; the rest from a
2025–2026 web survey. The *Academic landmarks* and *Token efficiency and
retrieval economics* sections were added in June 2026 from a follow-up
web-search pass (the feedback-by-memory work, [ADR 0006](../decisions/0006-feedback-by-memory.md))
to close a noted gap on retrieval cost and the data models the products inherit;
quantitative claims there are directional unless a primary arXiv id is linked.
Where a claim couldn't be verified beyond a single secondary source, that is
flagged. Source URLs are linked per-section.
