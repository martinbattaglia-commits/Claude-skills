# Architecture

*Last updated: 2026-05-27*

How Macrotide is put together, and why it's shaped this way. For the working
rules an agent must follow when editing (the `withDb` contract, streaming
context re-entry, the `server-only` boundary), see [AGENTS.md](../../AGENTS.md) —
this page builds the mental model those rules sit on.

## The shape: one process, local SQLite

Macrotide is **a single Next.js process talking to local SQLite files.** No
separate database service, no message broker, no cache layer. The smallest
viable deploy is one small VM with a reverse proxy for TLS.

This is a deliberate choice for a personal-scale app: it keeps operations
trivial, keeps latency low (in-process DB reads), and keeps the whole thing
comprehensible. The trade-offs — single-writer SQLite, no horizontal scaling,
in-memory rate limits — are acceptable until there are real users, and are
documented in [SECURITY.md](../../SECURITY.md) and
[deploy.md](../how-to/deploy.md).

### Two databases, split by lifecycle

The store is split along a lifecycle boundary into **app.db** (the system of
record — accounts, buckets, the `transactions` ledger + its derived `holdings`
projection (ADR 0004), plans, journal, chat, preferences, market
indicators) and **market.db** (regenerable — fund catalog/fees/performance/
portfolio, feeder look-through, and the NAV/quote cache). A two-handle
`DbContext` ([lib/db/context.ts](../../lib/db/context.ts)) routes each query to
the right handle by domain (`getAppDb()` / `getMarketDb()`). **No FK or join
crosses the boundary** — `holdings` reaches market data only via the soft
`quote_source`+`ticker` cache key, resolved app-side.

Why split: **blast-radius isolation** (the nightly SEC crawl rewrites market.db
and can never endanger an account), **lean backups** (only app.db is precious,
so the backup is small and market.db is excluded), **credential-free dev clones**
(market.db re-crawls from public sources), and **demo-with-real-data** (a demo
session gets an isolated in-memory app.db but shares the real market.db
read-only, so it sees the same warm cache as real users).

The market cache has two clocks, easily confused: a **24h freshness TTL** (when
to re-fetch a quote/series from upstream) and **row retention (indefinite)**.
`nav_history` is append-or-update only — writes upsert on `(ticker, date)`, so a
re-fetch corrects a day in place but never deletes or time-prunes history. A
refresh fetches a *window* and upserts it; older rows outside that window stay.
A wider request than the cached depth (e.g. "All" on a fund only ever pulled at
6mo) deepens the series even while the quote is fresh — the deepest range fetched
is tracked per key (`fund_quotes.deepest_range`). Never add a time-based
retention sweep or a delete-then-replace to `nav_history`, or historical series
are lost.

```text
Browser ──HTTPS──▶ Reverse proxy (Caddy) ──▶ Next.js (App Router) ──▶ app.db + market.db (SQLite)
                                                   │
                                                   └──▶ OpenRouter (AI); FMP/EODHD/Twelve Data/Frankfurter/Yahoo + Thai SEC (market data)
```

## Layers

| Layer | Lives in | Responsibility |
|---|---|---|
| **UI** | [components/](../../components) | Screens (Portfolio, Markets, Explore, Advisor, Journal, Models, Connect, Settings, Account) and shared components. Client-rendered; never imports server-only code or mock data directly. |
| **Client data** | [lib/fetchers/](../../lib/fetchers) | SWR fetchers — the only way components reach the API. |
| **API** | [app/api/](../../app/api) | Route handlers. Validate, run inside `withDb`, call queries. See [api reference](../reference/api.md). |
| **Domain logic** | [lib/portfolio/](../../lib/portfolio), [lib/market/](../../lib/market), [lib/memory/](../../lib/memory), [lib/advisor/](../../lib/advisor), [lib/ai/](../../lib/ai) | Pure-ish helpers and integrations: analytics, market providers, memory, Advisor tools, model provider. |
| **Persistence** | [lib/db/](../../lib/db) | Drizzle client, [schema](../../lib/db/schema) (split app/market), the two-handle context, migrations, and all queries (`server-only`). |
| **Auth** | [lib/auth/](../../lib/auth) | better-auth singleton, session helpers, providers. |
| **Content** | [lib/static/](../../lib/static) | Editorial strings and placeholder analytics, shipped in the bundle. |

A strict boundary: **components never import `lib/db/queries/*` or
`lib/mock/data`.** They go through a fetcher → API route → query. Queries are
gated by `import "server-only"` because `better-sqlite3` is Node-native.

## Owner vs demo databases

The one piece of cleverness worth internalising. Macrotide serves two kinds of
traffic from the same code:

- **Owner** — the authenticated user; app data persists in `app.db` at `DB_PATH`.
- **Demo** — anyone who clicked *Try the demo*; gets a private, **in-memory**
  app.db seeded from [lib/mock/demo-seed.ts](../../lib/mock/demo-seed.ts), keyed
  by the `macrotide_demo` cookie, swept after 1h idle, capped at 10 chat turns.
  It **shares the real market.db** (read-write, like a real user), so demo charts
  use — and warm — the same fund/index cache as real users (no per-session
  re-fetch; market data is global, so demo writes are just shared cache fills).

`withDb` ([lib/api/with-db.ts](../../lib/api/with-db.ts)) reads the demo cookie
and opens an `AsyncLocalStorage` scope so every `getDb()` call inside it routes
to the right app.db automatically. **Any route that queries must run inside
`withDb`**, or demo writes would leak into the owner DB.

The subtle case: `streamText`'s `onFinish` callback fires *after* `withDb`
returns, so the chat route captures the context and re-enters it with
`runWithDbContext`. This pattern is mandatory for any deferred write — the
canonical example is [app/api/chat/route.ts](../../app/api/chat/route.ts), and
the rule is spelled out in
[AGENTS.md](../../AGENTS.md#db-routing--read-before-touching-a-route-handler).

## Request lifecycle (a typical read)

1. A screen renders and its SWR fetcher GETs an API route.
2. The route handler wraps its body in `withDb`, which resolves owner-vs-demo
   from the cookie.
3. Inside, it calls a query from `lib/db/queries/*`, which runs against the
   scoped SQLite.
4. JSON comes back; SWR caches it and the component renders.

Writes follow the same path with POST/PATCH/DELETE and revalidation.

## The chat path

`POST /api/chat` is the most involved route:

1. Resolve the model provider by tier and demo status ([lib/ai/provider.ts](../../lib/ai/provider.ts)).
   Public/demo traffic is pinned to the public model chain in code so it can never
   resolve to a paid model.
2. Inject the user's active memory into the system prompt
   ([lib/memory/inject.ts](../../lib/memory/inject.ts)), frozen for the session.
3. Stream the response with the Advisor's tool surface available
   ([lib/advisor/tools.ts](../../lib/advisor/tools.ts), [lib/memory/tools.ts](../../lib/memory/tools.ts)) —
   reading portfolio/plan/journal, proposing plan edits, saving preferences.
4. On finish (re-entering the DB context), persist the turn, meter usage, and —
   on session close — extract durable facts into memory.

The full memory + session-lifecycle design is its own document:
[memory.md](./memory.md).

## Market data

Holdings carry a `quote_source` routing key. A provider **registry**
([lib/market/registry.ts](../../lib/market/registry.ts)) dispatches NAV/price
fetches to the matching provider, with a cache layer in front. The routing key
names the *asset class*, not the provider, so swapping a provider only touches
the registry. Adding one is a documented four-step recipe in
[AGENTS.md § Provider routing](../../AGENTS.md#provider-routing-via-holdingsquote_source).

For index/FX/stock symbols (the `market` source) the registry tries a **graceful
chain**: FMP and EODHD (keyed; **real** index levels where a free source exists)
→ Twelve Data (keyed; ETF proxies) → Frankfurter (keyless; FX) → Yahoo (keyless
fallback). The keyed providers drop out when their env var is unset, so the app
degrades from real levels → ETF proxy → Yahoo with no config; this is what fixed
Yahoo's datacenter-IP 429s. The chain is detailed in
[auth-and-providers.md](../reference/auth-and-providers.md#market-data-providers-indices--fx--stocks).
Thai mutual-fund NAVs come from the Thai SEC Open API.

A third source, `manual`, has **no live provider**: it's a custom asset (crypto,
a private fund, anything off-catalog) the user prices themselves. Its current
price is the latest positive `transactions.market_price` recorded in its own
ledger — a Balance's *current price* field, or a trade's execution price — read
straight from app.db by the analytics layer
([transaction-analytics.ts](../../lib/portfolio/transaction-analytics.ts)) rather
than the registry. An unrecognized symbol infers `manual` rather than assuming a
feed that returns nothing.

**The fund catalog is ELT.** The SEC crawl
([refresh-fund-catalog.ts](../../lib/jobs/refresh-fund-catalog.ts)) *lands* verbatim
SEC payloads in `sec_raw` (the EXTRACT/LOAD), then an API-free *transform*
([transform-fund-catalog.ts](../../lib/jobs/transform-fund-catalog.ts)) derives the
`fund_catalog` + `fund_fees` columns from them. Splitting the two means a
classification change — a new asset-class rule, a recovered field — re-derives the
whole universe in seconds (`npm run jobs:transform-catalog`) instead of an ~80-min
re-crawl, and nothing fetched is discarded at land time, so a later transform can
read fields the current mappers ignore. One `sec_raw` table holds every endpoint
(keyed by `endpoint`/`proj_id`/`row_key`), so landing a new SEC endpoint is a new
key value plus a transform step, not a schema change. Enrichment snapshot tables
are written after the transform so their `fund_catalog` foreign keys resolve.

**Parent fund vs. share class.** The `fund_catalog` row is *parent-level* — one
per SEC `proj_id`, carrying fund-level metadata — while the **priceable units**
live in `fund_share_classes`: one row per SEC share class. NAV, fees, tax wrapper,
and distribution policy all differ *per class*, so the class is the unit that
gets a price. Each class's `ticker` (the parent abbr for single-class `"main"`
funds, else the class code like `MDIVA-A`) is what `holdings` and the NAV cache
key on, so each class resolves to its own quote series. The Explore screener lists
priceable classes (hiding institutional/insurance by default); the fund detail
resolves a ticker to its class, offers a class selector, and defaults via a
retail-first, then-accumulating heuristic. Both tables are populated by the same
SEC enumeration in one crawl — no extra API calls. Column-level detail:
[data-model.md § Parent fund vs. share classes](../reference/data-model.md#parent-fund-vs-share-classes).

## Asset search

The **Explore** tab's typeahead is served by **in-memory MiniSearch indexes**
over the bounded, read-only catalogs — not a `LIKE` scan or a search server.
Both catalogs use the same pattern and share the query pre-processing (the same
curated index-nickname synonyms and fuzzy/prefix rules), so results feel uniform
across them:

- **Thai funds** ([lib/search/fund-index.ts](../../lib/search/fund-index.ts)) —
  fuzzy + prefix matching with field boosting, and **folds each feeder fund's
  master fund name into the document** so "S&P500" surfaces feeder funds like
  KKP US500-UH.
- **US securities** ([lib/search/us-security-index.ts](../../lib/search/us-security-index.ts)) —
  over symbol + cleaned name; `findUsSecurities` orders exact-symbol-first, then
  by relevance. Replaced the old `symbol LIKE 'q%' OR name LIKE '%q%'` path,
  whose leading-wildcard name scan used no index and had no typo tolerance.

Each index builds lazily per market.db handle and rebuilds transparently when a
cheap staleness signal (active-row count + `MAX(updated_at)`) changes after the
nightly refresh.

## Client UI state: typed external stores

Cross-component UI signals that aren't server data (e.g. the Portfolios
panel↔screen handshake, Chat UI events) go through small typed
`useSyncExternalStore` stores in [lib/stores/](../../lib/stores) — replacing the
earlier ad-hoc `window`-event buses. The store is the single source of truth, is
type-checked end to end, and integrates cleanly with React's concurrent
rendering (no manual event wiring or stale-closure hazards).

## Portfolio action items: suppress, resurface, and feedback

Generated Portfolio findings (fee-creep flags today; the headline and rebalance
suggestions can adopt the same model) carry two honest controls — **Archive**
("I've seen this; file it") and **"Not for me"** (reject, with an optional
reason). There is no Snooze: a timed re-nag is the wrong default for a calm,
anti-tinkering index app, so the only way an item comes back passively is a
**material change** in the finding.

In the fee-check UI these controls live on a dedicated **"See details" page**,
not on the Portfolio tab. On the tab the section is **information-only** — each
held fund, its cheaper comparable alternative(s), and the annual saving — with
exactly one section-level **Ask advisor** (a single fee-focused Advisor prompt
scoped to the most material finding and its cheapest comparable alternative) and
one **See details** button for the whole section. "See details" opens a
full-height detail `Modal` (the same dialog primitive as the fund detail sheet,
a sub-view of Portfolio rather than a new route) that houses all the management
UI: each fee check with its own **Archive** / **"Not for me"** controls (the four
reason chips + a free-text "Other…") and a **"Hidden checks (N)"** restore list.
The Modal owns its own focus trap, Escape/close, and scroll region, so the
Portfolio tab's per-screen scroll memory is untouched while it is open. This
keeps the tab calm rather than button-heavy; the actions and their backend wiring
are unchanged — only *where* they are triggered moved.

Each item is keyed by a deterministic `item_key`
([lib/portfolio/action-item-key.ts](../../lib/portfolio/action-item-key.ts)) —
identity only (e.g. `fee_creep:{ticker}`), so a choice survives NAV ticks. A
suppression is one row in `action_item_states` recording the `state`, an optional
`reason`, and a `snapshot_savings_pp` (the finding's magnitude — annual saving in
pp/yr — at the moment it was hidden).

**Resurfacing is deterministic and pure**
([lib/portfolio/action-item-resurface.ts](../../lib/portfolio/action-item-resurface.ts),
no clock, no AI, no DB): a hidden item reappears only when the *current* saving is
materially **worse** than the snapshot, by a bar the rejection reason selects —
a magnitude reason ("Too small") takes the normal bar, a switch-cost reason
("Tax & switching cost") takes a high bar, and a preference/structural reason
("I prefer this fund" / "Already considered") or free-text-only reject stays
hidden in this layer. A **ratchet** re-snapshots the new, higher value on each
re-suppression, so anything fires at most once per material jump and never
drip-nags. An improvement (the saving shrinking) never resurfaces. The query
layer ([lib/db/queries/action-items.ts](../../lib/db/queries/action-items.ts))
subtracts the still-hidden set from the live findings, and the route
(`app/api/portfolio/action-items`) records the state inside `withDb`. A
**"Hidden checks (N)"** list on the "See details" page restores anything filed
or rejected.

A **"Not for me"** also writes a **Journal ▸ Feedback** entry in the same
`withDb` transaction — reusing `journal_entries` with `kind: "feedback"` (the
rating rides in a `rating:up|down` tag) rather than a new table. The adapter
([lib/portfolio/adapter.ts](../../lib/portfolio/adapter.ts)) reads those entries
back into the Journal Feedback subtab, and the rejection (with its reason) is
available to the Advisor's "don't repeat rejected advice" context.

## Where it lives

A quick index from concept to code (reciprocates the `see docs/...` comments in
the source):

```text
app/api/                  HTTP route handlers (run inside withDb)
app/(auth)/login/         Passkey / OAuth / demo sign-in screen
components/screens/        The seven app screens + Account
components/                Shared UI, charts, sheets, thread list
lib/api/with-db.ts         Owner-vs-demo DB routing (AsyncLocalStorage)
lib/db/context.ts          Two-handle DB context (app.db + market.db)
lib/db/schema/             The data model — app.ts + market.ts (source of truth)
lib/db/queries/            All DB access, server-only
lib/auth/                  better-auth singleton + session helpers
lib/ai/                    OpenRouter provider, summarization
lib/advisor/, lib/memory/  Advisor tools + long-term memory
lib/market/                Provider registry, cache, index/FX chain + Thai SEC
lib/search/                In-memory MiniSearch indexes (fund + US security)
lib/stores/                Typed useSyncExternalStore UI stores
lib/portfolio/             Analytics, plan parsing, plan-edit, OCR, health/score
lib/static/                Editorial content + placeholder analytics
lib/mock/                  Seed data (db:seed) + demo seed (never imported by UI)
```

For the full status of what's built vs. planned, the authoritative sources are
the [README features list](../../README.md#features) (built) and the
[GitHub Project board](https://github.com/users/Sitthinut/projects/2) (planned).
