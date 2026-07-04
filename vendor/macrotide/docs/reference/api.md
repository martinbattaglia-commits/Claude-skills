# API routes

Catalog of the Next.js App Router route handlers under
[`app/api/`](../../app/api). This is a hand-maintained map; the route files
themselves are the source of truth for exact request/response shapes. A test
(`tests/api-doc-catalog.test.ts`) gates it against drift — it fails CI if a route
is undocumented, a documented route no longer exists, or an exported HTTP method
is missing from the Methods column. Keep this table in step when you add, remove,
or rename a route.

> **Convention.** Every handler that reads or writes the database runs inside
> `withDb`, which routes the query to the owner DB or the per-session demo DB
> based on the `macrotide_demo` cookie. See
> [architecture § owner vs demo databases](../explanation/architecture.md#owner-vs-demo-databases)
> and [AGENTS.md § DB routing](../../AGENTS.md#db-routing--read-before-touching-a-route-handler).

## Portfolio data

| Route | Methods | Purpose |
|---|---|---|
| `/api/buckets` | GET, POST | List / create investment buckets (portfolio slices) |
| `/api/buckets/[id]` | GET, PATCH, DELETE | Read / update / delete a bucket |
| `/api/holdings` | GET, POST | List positions / add one. POST writes an `opening` anchor to the ledger; the holding is its projection ([ADR 0004](../explanation/decisions/0004-unified-ledger-positions-derived.md)); adding a ticker a broker connection already syncs into that portfolio is refused (`409 synced_duplicate`) to prevent a silent double-count |
| `/api/holdings/[id]` | GET, PATCH, DELETE | Read / edit / delete. PATCH edits the single backing event in place (or appends a `snapshot` for multi-event positions); metadata updates the row; DELETE removes the ticker's ledger events. On a broker-synced holding, changing its `source` or `ticker` is refused (`409 managed_source`) since the connection owns its identity and the edit would desync on the next sync; other metadata stays editable |
| `/api/holdings/series` | GET | Value-over-time for one holding — `units × NAV × fx` per date plus its cost-basis line (`?ticker=`, `range`). The per-position slice of the portfolio replay ([ADR 0005](../explanation/decisions/0005-value-over-time-ledger-replay.md)), folded across every bucket the instrument appears in; powers the Position page chart |
| `/api/transactions` | GET, POST | List / batch-add ledger transactions (bucket-scoped). POST accepts trade deltas **and** position anchors (`opening`/`snapshot`, both shown as a "Balance"); an anchor or a split may carry `amount` 0. An optional per-row `marketPrice` records the asset's current price (custom-asset pricing). When a row gives a ฿ figure but no `units`, the server derives them from the price on the row's own date — `units = total ÷ (row price ?? NAV(tradeDate))`, never average cost. A Balance states a ฿ `value`; a buy/sell/reinvest uses its `amount`. A value-only **Balance** it can't price returns **422** `{ error: "needs_units", tickers }`; an un-priceable amount-only **trade** is best-effort (saved with units left empty for the lot engine to flag). Repeat anchors for a fund auto-promote (the first is `opening`, later ones become `snapshot`) so a later balance re-bases units without double-counting. Sign derived from `kind`; every write rebuilds the affected buckets' derived holdings |
| `/api/transactions/[id]` | PATCH, DELETE | Edit / delete a single ledger event (the inline-edit path); rebuilds the bucket's holdings. PATCH also accepts `marketPrice` (a Balance's current price). Amount sign is re-derived server-side from `kind` |
| `/api/transactions/analytics` | GET | Realized gains, money-weighted return (XIRR), cost-basis timeline. Scoped to the caller's buckets; `?bucket=<id>` narrows to one portfolio (404 if not the caller's) and `?ticker=<sym>` to one instrument for a Position page. `?cash=funds` sets the return basis to **Funds only** — excludes uninvested investable cash from the money-weighted return (the default includes it); `role=reserved` cash is excluded either way (its earmarked tickers are read from the earmarks store and carved out symmetrically) |
| `/api/earmarks` | GET, POST, DELETE | List / set / remove cash earmarks — designate part (`amount`) or all (`null`) of a cash account as reserved for a purpose. Keyed on `(bucketId, ticker)`; POST upserts, DELETE removes. Owner-scoped; the reserved-vs-investable split is computed read-time (`resolveEarmarks`) |
| `/api/plan` | GET, PUT | Read / replace the investment plan (markdown) |
| `/api/plan/edit` | POST | Apply an Advisor-proposed plan edit (`applyPlanEdit` + upsert) |
| `/api/journal` | GET, POST | List / create journal entries |
| `/api/journal/[id]` | GET, PATCH, DELETE | Read / update / delete a journal entry |
| `/api/models` | GET, POST | List / create model portfolios |
| `/api/models/[id]` | GET, PATCH, DELETE | Read / update / delete a model portfolio |
| `/api/analysis` | GET | Portfolio health / composite score |
| `/api/analysis/look-through` | GET | Underlying-exposure look-through for the caller's holdings — aggregated across all buckets or scoped to one (`?bucket=<id>`); needs market.db (per-fund underlying data), so it is computed server-side and injected into the Portfolio health check for accurate diversification scoring |
| `/api/portfolio/fee-creep` | GET | Identifies held funds that have a cheaper active peer with the same asset-class and region exposure; each finding includes the held fund's current TER, up to three cheaper alternatives sorted cheapest-first, and a deterministic suppression key; returns an empty array when no savings opportunities exist; archived/rejected findings are hidden via the resurface ratchet |
| `/api/portfolio/action-items` | GET, POST, DELETE | Persist user actions on generated portfolio advice items (Archive / "Not for me"); GET returns the caller's current hidden set; POST records an action by deterministic `itemKey` with an optional reason chip or free text (a "Not for me" also writes a Journal feedback entry in the same transaction so the rejection is reviewable by Advisor); DELETE restores a hidden item |
| `/api/portfolios/series` | GET | Portfolio value time series (for charts) |
| `/api/portfolios/reorder` | PATCH | Persist a manual display ordering for the caller's portfolios — accepts `{ orderedIds: string[] }` and writes a `position` index for each; ids the caller does not own are silently skipped |
| `/api/holdings/propose` | POST | Accept side of the Advisor holding-proposal flow — commits a `propose_holding` tool-call result to the ledger once the user clicks Accept in the chat card; the proposal can only attach a holding to a bucket the caller owns; a ticker a broker connection already syncs into that bucket is refused (`409 synced_duplicate`) to prevent a double-count; rejecting a proposal is client-only and never reaches this route |
| `/api/holdings/source` | GET, POST | GET lists the caller's distinct source labels with holding counts and a `managed` flag (label belongs to a live broker connection). POST renames a label across all of the caller's holdings — `{ from, to }` body; empty `to` clears the label; scoped to the user's own buckets so it cannot touch another user's rows; a managed label is refused (`409 managed_source`) since renaming it would desync the connection, and renaming a manual label *into* a managed one is refused (`409 managed_target`) since it would trap the holdings under a read-only managed source |
| `/api/settings` | GET, PUT | Read / write key-value settings |

## Market data

| Route | Methods | Purpose |
|---|---|---|
| `/api/quotes` | GET | Latest NAV / price quotes for tickers; `refresh=1` re-fetches through the provider chain, `refresh=1&mine=1` derives the refs from the caller's holdings server-side |
| `/api/fx` | GET | Trade-date FX rate for a currency into THB (`?from=USD&on=YYYY-MM-DD`) — "1 `from` unit, in baht" on that date, via the keyless Frankfurter cross-rate cache. Powers the Add/Record currency picker's auto-filled rate for a non-THB cost basis; `rate` is null on a cold cache so the client falls back to a manual figure |
| `/api/market/indices` | GET | SET + global index levels and deltas |
| `/api/market/news` | GET | Market news (RSS) |
| `/api/market/benchmark` | GET | Total-return index series for a named benchmark (`?key=`, `?range=`); used by the Portfolio "VS" overlay to draw the benchmark line; returns an empty series when the market cache is cold (client treats that as unavailable, never as zero) |
| `/api/market/indicators` | GET, PUT | GET returns the caller's selected market-indicator symbols plus the full addable catalog (label / group / tier metadata); PUT `{ symbols: string[] }` replaces the selection (order preserved; unknown symbols dropped; empty list resets to defaults) |
| `/api/admin/refresh-market` | GET, POST | Trigger a market data refresh (admin) |
| `/api/admin/status` | GET | Returns `{ isOwner: boolean }` for the current session; used by the UI to decide whether to show the Admin entry point — not a security boundary (each admin action enforces authorization independently); always 200 |
| `/api/admin/users` | GET | Owner-only — lists every user with id, email, name, tier, and today's token usage; returns 403 for non-owners |
| `/api/admin/users/[id]/tier` | POST | Owner-only — sets a user's account tier (`{ tier: "public" \| "trusted" }`); returns 403 for non-owners; the owner cannot demote their own account to `public` (409 lockout guard) |

## Funds & screener

| Route | Methods | Purpose |
|---|---|---|
| `/api/funds` | GET | Parent fund catalog, filtered + cheapest-TER first (the advisor `find_funds` view) |
| `/api/fund-classes` | GET | Priceable **share classes** for the Explore screener (per-class fee / tax / NAV / 1Y return / fund size; `trackingIndex` filters to index-style funds tracking a normalized index family, e.g. `S&P 500`). **Browse** is a buy list filtered to one audience — default retail; `access` (the "Access" facet: `accredited` \| `ultra` \| `both`) instead shows **only** that restricted tier. **Search** (`query`) finds any *active* fund, including ones an individual can't subscribe to (accredited/ultra/provident/institutional/fixed-term), but deprioritizes them — they surface only on a strong/exact match and rank below buyable hits |
| `/api/fund-classes/resolve` | GET | Validate a ticker — is it a priceable class, or a parent with multiple classes |
| `/api/funds/index-families` | GET | The live "Tracks" facet menu — every index family with at least one active index-style tracker, most-tracked first, with tracker counts |
| `/api/quote-source` | GET | Resolve each `tickers=A,B,C` symbol's price source against the real catalog — the single authority: in the catalog → `thai_mutual_fund`, otherwise → `manual` (custom). No shape guessing. Powers the importer's on-the-fly source badge |
| `/api/funds/[projId]` | GET | Fund detail + enrichment + share classes (accepts a proj_id, parent abbr, or class ticker) |
| `/api/funds/[projId]/series` | GET | Daily NAV + AUM history for one share class (`range` param) |
| `/api/us-securities` | GET | US-listed **stock & ETF** catalog for the Explore US segment + Add-holding autofill: search by `query` (symbol prefix / name), filter `type` (`stock` \| `etf`), `sort` (`symbol` \| `name`), paged via `limit`/`offset` |
| `/api/us-securities/[symbol]` | GET | One US security's catalog row (symbol, name, type, exchange) |
| `/api/us-securities/[symbol]/series` | GET | Daily price history (USD) for one US stock / ETF (`range` param), through the shared market cache |
| `/api/us-securities/[symbol]/view` | POST | Fire-and-forget demand signal on a real detail open (bumps `view_count`) — kept off the series GET so the chart's cache key stays prefetch-warmable |
| `/api/search` | GET | Unified Explore **"All"** search across both catalogs (Thai funds + US stocks & ETFs): `query` (free text → flat relevance), `type` (`all` \| `thai` \| `us` \| `us_stock` \| `us_etf`), paged via `limit`/`offset`. Idle (no `query`) ranks by popularity (US) / AUM (Thai) |
| `/api/explore/shelves` | GET | Explore "All" **idle browse** — curated cross-asset shelves (low-cost Thai index funds, low-cost index ETFs, popular US stocks), each ranked by its own signal. Searching uses `/api/search` instead |

## Chat & Advisor

| Route | Methods | Purpose |
|---|---|---|
| `/api/chat` | POST | Streaming chat; injects memory, runs Advisor tool-calls |
| `/api/chat/capabilities` | GET | Reports which optional chat features are available for this session (e.g. `imageUpload`); computed server-side because the relevant config and the demo cookie are not visible to the client; purely informational — the chat route enforces the actual capability gates |
| `/api/chat/threads` | GET, POST | List / create chat threads |
| `/api/chat/threads/[id]` | GET, PATCH, DELETE | Read / rename / soft-delete a thread |
| `/api/chat/threads/[id]/title` | POST | Auto-title a thread after its first exchange |
| `/api/chat/threads/[id]/close` | POST | Close a session → extract memory + mark idle |
| `/api/chat/threads/[id]/latest-reply` | DELETE | Remove the latest assistant reply (Retry re-asks the prior user turn) |
| `/api/chat/search` | GET | Full-text search across the user's chats |
| `/api/import/image` | POST | OCR an import screenshot. Auto-classifies holdings-snapshot vs transaction-history, then runs the matching extractor; returns `{ docType, confidence, holdings? \| transactions? }` so the client can confirm a low-confidence guess. An optional `as=holdings\|transactions` form field skips detection (used when the user picks). Needs `OPENROUTER_API_KEY` (503 without) |
| `/api/import/transactions-image` | POST | OCR a transaction-history image into ledger rows directly (same key + rate limit + 5 MB cap as `/api/import/image`) |
| `/api/import/broker/connectors` | GET | Lists every configured broker connector (display name, host, login / open links, and install URL) for the Connect-a-broker picker; session-gated, so the install URL it returns embeds the caller's own import token (its path credential); 404 in a demo session |
| `/api/import/broker/token` | GET, POST | GET mints (or returns the existing) per-user broker import token together with the connector's display name, install URL, and broker-history URL; POST rotates the token, invalidating any installed userscript; 404 when no broker is configured or in a demo session |
| `/api/import/broker/userscript/[token]/[name]` | GET | Serves the install-ready userscript for the configured brokers — the full loader for a `.user.js` `[name]`, or the metadata-only block for a `.meta.js` (the manager's `@updateURL` version check). Authenticated by the import `[token]` in the path, NOT a session cookie, so the manager's cookie-less install/update fetch succeeds (CORS-opened for the same reason); the served script carries `@downloadURL`/`@updateURL` for manager auto-update whenever `@version` (`1.<protocol>.<revision>`) moves — a breaking protocol bump or a silent script-revision bump. Broker endpoints stay server-side (env only); 404 when no broker is configured; 401 for an unknown/rotated token |
| `/api/import/broker/runtime` | GET | Returns the runtime connector config for the installed userscript (`?c=` or `?host=` selects a connector); authenticated by the import token (no cookies); drives the gather so broker endpoints can change without a reinstall; the response's `collectorVersion` (the protocol axis only) tells an old loader when a breaking change means it must reinstall |
| `/api/import/broker/ingest` | POST | Commit-and-deduplicate a broker export into the ledger; accepts the raw broker export JSON (authenticated by either a session cookie or the `x-import-token` header); routes each broker account's orders to its own portfolio (created on first import, then follows the user's mapping in Settings → Connections); skips orders already in the ledger by `external_id` so re-syncs are idempotent |
| `/api/import/broker/connections` | GET, PATCH, DELETE | Manage broker-import connections (Settings → Connections): GET lists each known account with its mapped portfolio and last-sync status; PATCH remaps or merges an account to a portfolio (existing or newly-named); DELETE unlinks an account or an entire broker connector, with an optional `mode=purge` to also remove that account's imported transaction history |

## Memory

| Route | Methods | Purpose |
|---|---|---|
| `/api/memory/preferences` | GET | List active stored preferences |
| `/api/memory/preferences/[id]` | POST, DELETE | Restore / delete a preference (30-day trash) |

See the [memory feature guide](../explanation/memory.md) for the model behind these.

## Auth, account & demo

| Route | Methods | Purpose |
|---|---|---|
| `/api/auth/[...all]` | (better-auth) | All better-auth endpoints (sign-in, sign-up, passkey, OAuth callbacks); IP-rate-limited via `AUTH_RATE_LIMIT` |
| `/api/auth-config` | GET | Which auth methods are enabled (drives the `/login` UI; exposes the public Turnstile site key) |
| `/api/account/usage` | GET | Per-user token usage against the daily budget |
| `/api/demo` | POST, DELETE | Start / end a demo session (sets / clears the `macrotide_demo` cookie) |
