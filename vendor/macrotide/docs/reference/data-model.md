# Data model

Macrotide stores data in **two** SQLite databases via Drizzle ORM, split along a
lifecycle boundary. The schema is defined in `lib/db/schema/` (split into
[app.ts](../../lib/db/schema/app.ts) + [market.ts](../../lib/db/schema/market.ts),
re-exported from `index.ts`) — **those files are the source of truth**; this page
is an orientation map. Migrations live in `lib/db/migrations/` and run
automatically on boot.

## The two databases

- **app.db** (`DB_PATH`, default `data/app.db`) — the **system of record**:
  accounts/auth, buckets, holdings, plans, journal, models, settings, chat,
  preferences, usage/tier, and `user_market_indicators`. Precious; backed up
  nightly. Reached via `getAppDb()` (alias `getDb()`).
- **market.db** (`MARKET_DB_PATH`, default `data/market.db`) — **regenerable**
  market data: the fund catalog/fees/performance/portfolio, feeder look-through,
  and the NAV/quote cache (`fund_quotes`/`nav_history`). Rebuilt from upstream;
  **not** backed up. Reached via `getMarketDb()`.

No FK or SQL join crosses the boundary. `holdings` links to market data only via
the soft `quote_source` + `ticker` cache key, resolved in app code (never a
join); a query module touching both reads each handle and joins app-side. Both
files sit under the same `data/` volume. Demo sessions get an isolated in-memory
app.db but share the real market.db read-write (same warm cache as real users).

## Tables at a glance

### Application data (app.db)

| Table | Holds | Key columns / notes |
|---|---|---|
| `buckets` | Portfolio slices (Core, SSF, experiment, …) | `target_allocation` (JSON), `target_model_id`, `position` (sidebar order), `user_id` |
| `transactions` | The canonical event ledger — the single source of truth for positions ([ADR 0004](../explanation/decisions/0004-unified-ledger-positions-derived.md)). DELTAS (`buy`/`sell`/`dividend`/`fee`/`split`/`reinvest`) move a position; ANCHORS (`opening`/`snapshot`) assert an absolute position at a date. | `bucket_id` (FK, cascade), `kind` (TEXT, Zod-validated), `trade_date` (economic event date), `units`, `price_per_unit` (avg cost on anchors), signed THB `amount` (the return primitive; 0 for a snapshot, −cost for a costed opening), `fee`, `quote_source`, `fx_to_thb`, `import_batch_id`. **No `user_id`** — scoped through its bucket. |
| `holdings` | A DERIVED projection of the ledger (one row per held ticker), reconciled after every ledger write — not typed directly. Stores no position columns: `units`/`avg_cost` are folded from the ledger on READ (`listHoldings`/`getHolding` overlay the live position — ADR 0004), so they always reflect the latest NAV and can't go stale; `avg_cost` is `null` when cost is unknown. The row also stores portfolio/source/color and custom-asset metadata. The `ticker` is stored in its official **catalog case** (custom/cash keep the typed case) and matched case-insensitively (`tickerKey`). For catalog-backed funds, fund facts (`thai_name`, `english_name`, `category`, `asset_class`, `region`, `ter`) **and the current symbol** are read from `market.db` at read time and stale `app.db` values are ignored — resolved through a **layered, most-stable-first** catalog anchor — `catalog_isin` → `(catalog_proj_id, catalog_class_name)` — so even a multi-class rebrand (which changes the ticker *and* the class_name) stays linked where an ISIN is published (#235). A US (`market`) holding anchors instead on `catalog_figi` (its composite FIGI — the rename-persistent US security id), so a US ticker rename (FB→META) resolves the same way. | `bucket_id` (FK, cascade), `quote_source` (routing key), `catalog_isin` + `catalog_proj_id` + `catalog_class_name` (the layered Thai share-class anchor) + `catalog_figi` (the US anchor); all `null` for custom/cash. (The SEC `unique_id` is an AMC/company code, not a security id, so it is NOT used as an anchor.) Read overlay + projection: `lib/db/queries/holdings.ts`, `lib/db/queries/holding-enrichment.ts`, `lib/db/queries/project-holdings.ts`. |
| `plans` | The investment plan | Single-row in v1; `markdown`, `selected_model_id`, `user_id` |
| `journal_entries` | Notes, decisions, questions, reading, and feedback (a `kind: "feedback"` entry records a 👍/👎 reaction — e.g. a Portfolio "Not for me" rejection — with its rating in a `rating:up\|down` tag) | `kind`, `tags` (JSON), `pinned`, `archived_at`, `user_id` |
| `model_portfolios` | Built-in + custom model allocations | `built_in`, `allocation` (JSON slices), risk/return metadata, `user_id` |
| `action_item_states` | Archive / "Not for me" suppression for generated Portfolio action items (fee-creep flags today) | one row per (`user_id`, `item_key`); `state` ∈ archived / not_for_me, optional `reason` (chip key or free text), `snapshot_savings_pp` (magnitude baseline for the resurface check), `item_type`. Keyed by a deterministic `item_key` (`lib/portfolio/action-item-key.ts`) since the items carry no row of their own. (`snooze_until` is a dormant legacy column — Snooze is dropped.) |
| `settings` | Generic key-value app settings | `key` → `value` (JSON) |
| `user_market_indicators` | Per-user Markets-screen indicator list — which symbols a user pins and in what order | `user_id` (nullable), `symbol` (canonical ticker from the indicator catalog), `position` (display order, ascending); unique on (`user_id`, `symbol`). No rows → app falls back to the curated default set. Despite the `market_` name this is a user preference (lives in app.db, not market.db) |

### Market data (market.db — written by the market layer + the SEC crawl)

The SEC crawl is **ELT**: it lands verbatim payloads in `sec_raw`, then a separate
API-free transform ([lib/jobs/transform-fund-catalog.ts](../../lib/jobs/transform-fund-catalog.ts))
derives the `fund_catalog` + `fund_fees` columns from them. Re-deriving a field is
a seconds-long transform re-run (`npm run jobs:transform-catalog`), not an ~80-min
re-crawl — and nothing fetched is discarded, so a later transform can read fields
the current mappers ignore.

| Table | Holds | Key columns / notes |
|---|---|---|
| `sec_raw` | Verbatim SEC Open API payloads — the **raw landing** (EXTRACT/LOAD) the crawl writes before any transform | PK (`endpoint`, `proj_id`, `row_key`); `payload` is the JSON-stringified SEC item; `fetched_at` stamps the land. One table per *every* endpoint (`general-info/profiles`, `factsheet/fees`, `factsheet/risk-spectrum`, the `daily-info/aum` snapshot, …) — adding one (any of the ~20 the API exposes) is a new `endpoint` value + a transform step, never a schema change. `row_key` discriminates rows within one (endpoint, proj_id): share class for profiles, fee identity for fees, `""` for a per-fund singleton |
| `fund_quotes` | Latest NAV + performance per ticker | `ticker` PK, `nav`, `d1_pct`, `ytd_pct`, `y1_pct`, `deepest_range` (widest series range fetched — lets a wider request deepen a fresh-but-shallow cache) |
| `nav_history` | Daily NAV (+ fund AUM) history — **append/update only, never time-pruned** | Composite PK (`ticker`, `date`); `nav`, `net_asset` (fund total net assets / AUM, when the source reports it) |
| `fund_catalog` | SEC-sourced fund universe (parent-level: one row per `proj_id`) — **derived by the transform from `sec_raw`**, not hand-edited | keyed by `proj_id`; `current_ter` is a **derived cache** of the latest TER (maintained by `upsertFundFees`; source of truth stays `fund_fees`) — picked from the **representative retail class**, not a fee-waived sibling, so the parent fee reflects what a retail buyer pays; a `0` rate is read as "not actualized" (a new fund's unrealized rate falls through to its ceiling; an all-zero row — including the SEC `main` placeholder — resolves to NULL "no published fee"), never a fake free fund; `proj_retail_type` is the SEC's audience code; `retailTier()` (lib/market/retail-tier.ts) maps it to an eligibility tier — `retail` (R/G/null), `accredited` (A/B/H = AI/HNW), `ultra` (X = UI), `provident` (V), `institutional` (N/F) — driving the screener's buy-list gate (browse filters to one audience via the "Access" facet — default retail, or exclusively accredited/ultra/both) and the search demotion of non-buyable funds; `asset_class` is derived **risk-spectrum-first**: the SEC factsheet risk code (RS1/RS2 → `cash`, RS3/RS4 → `bond`, RS6/RS7 → `equity`, RS8 → `alternative`) is the primary signal, falling back to the `policy_desc` label + money-market name match for funds without a code or with an ambiguous one (RS5, RS8x) |
| `fund_share_classes` | The **priceable units** of each fund (one row per SEC share class) | composite PK (`proj_id`, `class_name`); `ticker` is `UNIQUE` and is the holdable/cache-key id — see below |
| `fund_fees` | Fee history per fund class — derived by the transform from `sec_raw` | source of truth for TER among the derived tables (raw fee payloads live in `sec_raw`) |
| `fund_benchmarks` | Declared benchmark index per fund (factsheet §8.1) — derived by the transform from the nightly bulk sweep | composite PK (`proj_id`, `group_seq`) — a blended benchmark keeps its several weighted rows; the benchmark string names the index, geography, and hedging variant. Drives the derived `fund_catalog` facets `region_focus` / `sector_focus` / `index_family` (benchmark first — fresh signals outrank frozen ones), with the AIMC peer-group snapshot (`aimc_category`; one-shot from the legacy v1 API via `scripts/backfill-aimc-v1.ts`) as a gap-filler and the name gazetteer last; `index_family` additionally falls back to the MASTER fund's name (SEC profile field + `feeder_master_map`) — a feeder invests ≥80% in its single master, so a master named "…S&P 500 ETF" is fact, not inference, while a fund's own marketing name still never claims a family; `region_focus_source` records provenance; unknown stays NULL — see `lib/market/fund-facets.ts` |
| `fund_statistics` | Factsheet risk/return statistics per share class (Sharpe, max drawdown, FX-hedging ratio, tracking error, turnover) — derived by the transform from the nightly bulk sweep | composite PK (`proj_id`, `fund_class_name`); figures parsed from the SEC's string values, verbatim payload stays in `sec_raw` |
| `fund_performance`, `fund_asset_allocation`, `fund_top_holdings`, `fund_portfolio`, `fund_portfolio_asset_type` | Per-fund enrichment depth | ingested behind default-off crawl flags; composite `(proj_id, period)` indexes |
| `feeder_master_map`, `feeder_look_through_holdings` | Feeder-fund → US master look-through | from SEC EDGAR N-PORT |
| `us_securities` | US-listed **stock & ETF** catalog (powers the Explore US segment + Add-holding ticker autofill + the popular-prewarm warm set) | `symbol` PK; `name`, `security_type` (`stock`\|`etf`), `exchange`, `currency` (USD), `status` (`active`\|`delisted`). Seeded nightly from the official, keyless Nasdaq Trader symbol directory (`lib/jobs/refresh-us-securities.ts`) — a single flat file, so no `sec_raw`-style raw landing; a `seen_at` run-marker delist sweep flips rows the latest directory dropped, kept for held-history. **Demand/popularity columns** (`view_count`, `last_viewed_at`, `popularity_score`, `last_scored_at`) drive the instant-on-open warm set: `view_count` bumps on a real detail open (the `[symbol]/view` ping), `popularity_score` is the daily most-actives dollar-volume rank (`lib/jobs/refresh-popular.ts`); the nightly catalog upsert leaves them untouched, so they accumulate. `figi` is the composite **FIGI** (rename-persistent anchor, enriched nightly from OpenFIGI) — a delisted symbol whose FIGI matches an active one is a rename, bridged in the NAV cache (`findUsRenames`/`repointUsNav`). **Index cross-links:** `indices` = comma-joined membership keys for a stock (`sp500,nasdaq100`, from public constituent lists); `tracks_index` = the index an **ETF** tracks (`sp500`, `sector:it`), **derived** (`lib/market/etf-tracking.ts` + `lib/db/queries/etf-tracking.ts`) rather than a curated map, so "own the index" stays comprehensive and self-updating — NULL when no covered index matches (broad S&P 500 / Nasdaq-100 / Dow + the 11 S&P sectors; global/bond indices lack a free constituent list). The derivation reads `holdings_count` (total holdings in the latest filing, before the stored top-N cap): an ETF tracks an index when its top holdings sit inside it AND its total count matches the index size — the count is what tells a full-replication S&P 500 fund (~505) from a total-market fund (~3,600) whose stored top holdings look identical. Pricing is NOT here — a held US ticker prices through `market:${symbol}` in `fund_quotes`/`nav_history` |
| `us_etf_holdings`, `security_id_map` | US ETF constituents (SEC N-PORT) + the ISIN/CUSIP→ticker crosswalk that powers look-through | `us_etf_holdings`: per-ETF top-N by weight (`symbol`,`rank` PK; `name`,`cusip`,`isin`,`weight_pct`,`country`,`asset_cat`), replaced wholesale per refresh (`lib/jobs/refresh-etf-holdings.ts`). A holdings file carries CUSIP/ISIN but **no ticker**, so `resolved_symbol` is the constituent's ticker, resolved from those ids via OpenFIGI (`mapIdsToTickers`) and cached in **`security_id_map`** (`id_value`→`ticker`; a `null` ticker records an attempted-but-unmappable id — bond/cash/derivative — so it isn't retried). `lib/jobs/resolve-etf-tickers.ts` resolves + stamps; the holdings refresh re-stamps from cache (cheap). Makes ETF holdings tappable and powers the reverse "held via" list (`getEtfsHoldingSymbol`, indexed on `resolved_symbol`) |

> Cache keys in `fund_quotes`/`nav_history` are the combined `${source}:${ticker}`
> (ticker upper-cased — built by the canonical `quoteCacheKey` in `lib/market/sources.ts`),
> so one table holds quotes from different providers without a schema change.
> See [AGENTS.md § Provider routing](../../AGENTS.md#provider-routing-via-holdingsquote_source).

#### Parent fund vs. share classes

`fund_catalog` is **parent-level** — one row per `proj_id` carries fund-level
metadata (name, AMC, policy, region, feeder relationship). But NAV, fees, tax
wrapper, and distribution policy differ **per share class**, so each priceable
class gets its own row in **`fund_share_classes`**:

| Column | Holds |
|---|---|
| `proj_id` | Parent fund (FK → `fund_catalog`, cascade delete) |
| `class_name` | Raw SEC `fund_class_name` (`"main"` for single-class funds, e.g. `"MDIVA-A"` for multi-class) |
| `ticker` | The **priceable id** — holdable identifier + NAV cache-key tail |
| `class_detail_th` | Raw Thai class detail string |
| `distribution_policy` | `accumulating` \| `dividend` \| NULL (parsed from `class_detail_th`) |
| `investor_type` | `retail` \| `restricted` \| `institutional` \| `insurance` \| NULL. Browse hides `institutional`/`insurance` classes (uninvestable directly), keeps `retail`/NULL, and down-ranks `restricted` (provident/private/special-group — investable in principle, not sold to the public); search keeps `institutional`/`insurance` too but demotes them (surface only on a strong/exact match) |
| `tax_incentive_type` | Per-class wrapper: `SSF` \| `RMF` \| `ThaiESG` \| NULL |
| `isin_code` | Per-class ISIN |
| `current_ter` | Per-class total expense ratio %, derived from `fund_fees` (NULL when unpublished) |

The **PK is composite `(proj_id, class_name)`** because `class_name` `"main"` is
not unique across funds. The **`ticker` carries the `UNIQUE` index** and is the
single id that `holdings`, search, and the NAV chart key on. It is **derived**:
the parent's `abbr_name` when the SEC class is `"main"` (single-class funds), else
the class code itself (e.g. `MDIVA-A`). Because `ticker` is the cache-key tail of
`${source}:${ticker}`, each share class resolves to its own NAV/quote rows in
`fund_quotes`/`nav_history`.

Rows are populated by the same SEC general-info/profiles enumeration that builds
the catalog, de-duped per class — **no extra API calls**. Queries live in
[lib/db/queries/share-classes.ts](../../lib/db/queries/share-classes.ts)
(`upsertShareClasses`, `listShareClassesByProj`, `getShareClassByTicker`);
[lib/market/share-class-select.ts](../../lib/market/share-class-select.ts)'s
`pickDefaultClass` chooses the default class (retail-first, then accumulating).
Why parent and class are split: [explanation/architecture.md § Market data](../explanation/architecture.md#market-data).

#### Holding metadata ownership

`market.db` is the source of truth for catalog-backed fund metadata. `app.db`
stores user-entered metadata only for unresolved/custom holdings, plus
portfolio-owned fields such as source and color.

| Case | Metadata source | Editable fields | Display/analysis behavior |
|---|---|---|---|
| Known fund: ticker resolves in `fund_share_classes.ticker` or `fund_catalog.abbr_name` | `market.db` | Portfolio/source/color, plus normal ledger edits | Locked fields show catalog data; stale `app.db.holdings` metadata is ignored |
| Unknown/custom holding: no market catalog match | `app.db.holdings` | Metadata fields editable | User-entered metadata is used; missing asset class stays unknown |
| Known becomes unknown after catalog change | `app.db.holdings` | Metadata fields become editable | Next read treats it as custom/unresolved |
| Unknown becomes known after catalog refresh | `market.db` | Catalog-owned fields lock | Next read switches to catalog metadata without copying it into `app.db` |
| Deleted holding | None | N/A | The holding row is deleted, so any stale app metadata disappears with it |

### Chat & memory

| Table | Holds | Key columns / notes |
|---|---|---|
| `chat_threads` | One row per conversation | `status` (`active`/`idle`/`archived`), `archived_at`, `deleted_at` (30-day trash), `extracted_through_id` (extraction watermark) |
| `chat_messages` | Turns within a thread | `thread_id` (FK, cascade), `role`, `content`, `tool_call_id`, `feedback`, `model` (provider model id that served this response; NULL for user/tool rows), `cards` (JSON-encoded `propose_*` tool payloads — the durable proposal store; NULL when absent) |
| `user_preferences` | Long-term memory | **Bitemporal** — see below |

The `user_preferences` table is bitemporal: an update inserts a new row and
end-dates the old one (`valid_until`), never mutating in place; the active set
is `WHERE valid_until IS NULL`. Columns include `category` (enum:
`profile`/`finance_context`/`response_style`/`fact`), `source`
(`user_tool`/`advisor_tool`/`extracted`), `confidence`, and provenance
(`source_session_id`, `source_turn_ids`). Full design:
[memory.md](../explanation/memory.md).

### Auth (better-auth)

`user`, `session`, `account`, `verification`, and `passkey`. Names match
better-auth's defaults so its Drizzle adapter resolves them without a mapping.
These timestamps are stored as integer epoch-ms (app tables use ISO-8601 text).

### Multi-user metering

| Table | Holds | Key columns / notes |
|---|---|---|
| `usage` | Per-user daily token usage | Composite PK (`user_id`, `date`); `input_tokens`, `output_tokens` |
| `account_tier` | Per-user tier gating | `tier` (`public`/`trusted`); public is pinned to the public model chain in code |

## Ownership & multi-user

Most app tables carry a nullable `user_id` referencing `user.id`. Today, in
single-owner mode, it is `NULL` and rows are visible to the owner; multi-user
mode scopes every query by `user_id`. The evolution is described in
[design principles § single-owner → multi-user](../explanation/design-principles.md#from-single-owner-to-multi-user).

## Relationships (sketch)

```text
user ──< buckets ──< transactions  (the source of truth for positions)
                 └─▶ holdings  (derived projection of the ledger, rebuilt on write)
user ──< plans
user ──< journal_entries
user ──< model_portfolios
user ──< chat_threads ──< chat_messages
                       └─ user_preferences.source_session_id (provenance)
user ──< usage
user ──1 account_tier
holdings.quote_source ──▶ market registry ──▶ fund_quotes / nav_history
```
