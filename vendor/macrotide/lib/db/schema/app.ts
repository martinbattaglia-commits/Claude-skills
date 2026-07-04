import { isNotNull, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { NativeInputs } from "@/lib/portfolio/native-inputs";

// ───────────────────────────────────────────────────────────────────────────
// app.db — the system of record (env DB_PATH, default data/app.db). Holds every
// precious, user-authored record: accounts/sessions, buckets, holdings, plans,
// journal, models, chat, preferences, settings. Backed up nightly (see
// lib/db/backup.ts). Market data lives in a separate, regenerable market.db
// (lib/db/schema/market.ts); no FK crosses the boundary.
// ───────────────────────────────────────────────────────────────────────────

// Investment buckets — a "bucket" is a portfolio slice (Core, SSF, experiment, etc.).
export const buckets = sqliteTable("buckets", {
  id: text("id").primaryKey(),
  // Owner. NULL pre-backfill / single-owner mode → visible to everyone.
  userId: text("user_id").references(() => user.id),
  name: text("name").notNull(),
  typeLabel: text("type_label"),
  icon: text("icon"),
  color: text("color"),
  brokerage: text("brokerage").notNull(),
  notes: text("notes"),
  goalText: text("goal_text"),
  targetModelId: text("target_model_id"),
  // Manual sort order (ascending). Nullable: existing rows stay NULL and sort
  // last, falling back to createdAt, until the user drag-reorders them.
  position: integer("position"),
  targetAllocation: text("target_allocation", { mode: "json" }).$type<{
    equity: number;
    bond: number;
    alternative: number;
    cash: number;
  }>(),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

// Fund positions inside a bucket.
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bucketId: text("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    thaiName: text("thai_name"),
    englishName: text("english_name").notNull(),
    category: text("category"),
    assetClass: text("asset_class"),
    region: text("region"),
    // NOTE: a holding's POSITION (units, avg cost) is NOT stored — it is folded
    // from the `transactions` ledger on read (ADR 0004; listHoldings/getHolding).
    // The row holds only instrument metadata + ledger-carried identity. Never
    // re-add units/avg_cost columns: they'd be a stale copy of regenerable math.
    ter: real("ter"),
    /** Brokerage / import provenance — free-text, displayed in UI. */
    source: text("source"),
    /**
     * Data-routing key. Tells the market registry which provider to call when
     * fetching NAV / price (see lib/market/sources.ts). One of:
     *   - "market"            — stocks, ETFs, indices, FX via Yahoo
     *   - "thai_mutual_fund"  — Thai mutual fund NAVs via the SEC Open API
     *
     * This + `ticker` is the soft routing key into market.db's nav_history /
     * fund_quotes cache (see lib/market/cache.ts). It is NOT a SQL foreign key —
     * `holdings` denormalizes its display fields and never joins fund_catalog.
     */
    quoteSource: text("quote_source").notNull().default("market"),
    /**
     * Stable catalog anchor (#235): the SEC `(proj_id, class_name)` of the
     * priceable share class this holding tracks. Bound when the ticker matches the
     * catalog; NULL for custom / cash / not-yet-resolved holdings. UNLIKE the
     * ticker (which a fund house can RENAME over time), `(proj_id, class_name)` is
     * permanent — so a renamed fund stays linked to its current name + NAV by this
     * anchor even after its symbol changes and the old symbol leaves the catalog.
     * Resolution + display of the current symbol go through it (resolveCatalogSymbol).
     *
     * The anchor is LAYERED, most-stable first: `catalog_isin` (global security id)
     * → `(catalog_proj_id, catalog_class_name)`. The `(proj_id, class_name)` pair
     * covers single-class funds (class_name = "main", constant); ISIN additionally
     * covers a multi-class rebrand (which changes the ticker AND class_name) for the
     * ~10% of classes that publish one. (The SEC `unique_id` field is an AMC/company
     * code, not a security id, so it can't anchor a class.)
     */
    catalogProjId: text("catalog_proj_id"),
    catalogClassName: text("catalog_class_name"),
    catalogIsin: text("catalog_isin"),
    /**
     * Stable catalog anchor for a US `market` holding: the composite FIGI of the
     * security (the US analogue of `catalog_isin`). FIGI is rename-persistent, so a
     * held US ticker that gets renamed (FB→META) stays linked to its current symbol
     * + NAV through this anchor. Bound at holding creation via OpenFIGI; NULL when
     * OpenFIGI is unavailable or the symbol isn't US (then the bare ticker anchors).
     */
    catalogFigi: text("catalog_figi"),
    /**
     * Native currency for a `cash` holding (issue #149) — e.g. "THB", "USD".
     * The ticker of a cash account is its NAME, not a symbol, so currency can't
     * be inferred and is stored here; valuation prices cash at 1.0 in this
     * currency × FX. NULL for non-cash holdings (currency inferred from the
     * routing key, see lib/market/currency.ts).
     */
    currency: text("currency"),
    acquiredOn: text("acquired_on"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [index("idx_holdings_bucket").on(table.bucketId)],
);

// Cash earmarks (issue #149) — a DESIGNATION of existing cash, never new money. An
// earmark marks part (or all) of a cash account as "reserved" for a purpose, which
// excludes that slice from INVESTMENT return while net worth + allocation still count
// the full balance. One mechanism, multi-scope: `account` (v1) sets aside cash on one
// account; `portfolio`/`goal` scopes are schema-ready for a later UI / #36.
//
// Keyed on the STABLE identity `(bucketId, ticker)` — NOT a `holdings.id` FK: holdings
// is a derived projection whose rows are dropped/recreated on rebuild (id reassigned),
// so an id reference would dangle or silently re-point. A ticker rename must cascade
// here exactly as the ledger rename does (editHoldingViaLedger). Stores no money fact
// — it is metadata, never a ledger event (facts-only stays intact).
export const earmarks = sqliteTable(
  "earmarks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => user.id),
    // 'account' (v1) | 'portfolio' | 'goal' (schema-ready, no UI yet).
    scope: text("scope").notNull().default("account"),
    // The account's RETURN role (#149): 'reserved' = set aside, excluded from the
    // investment return (its own allocation slice; full balance still in net worth);
    // 'investable' = counts toward the return — the row then exists only to carry the
    // `purpose` label (an objective on dry powder, e.g. "Retirement"). Only `reserved`
    // rows drive the reserve math (resolveEarmarks).
    role: text("role").notNull().default("reserved"),
    bucketId: text("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    // The cash account's ticker for `account` scope; NULL for `portfolio` scope.
    ticker: text("ticker"),
    // Reserved amount in `currency`; NULL means "All" (the whole balance, auto-tracks).
    amount: real("amount"),
    // Native currency the `amount` is expressed in (matches the cash account currency).
    currency: text("currency"),
    // Optional free-text purpose label (e.g. "Emergency"). Rich named goals are #36.
    purpose: text("purpose"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    // One earmark per (bucket, ticker, scope) in v1 — the account split is single.
    uniqueIndex("idx_earmarks_target").on(table.bucketId, table.ticker, table.scope),
    index("idx_earmarks_bucket").on(table.bucketId),
  ],
);

// Transaction ledger — the buy/sell/dividend event log behind realized gains,
// money-weighted return (XIRR), and the contribution timeline. Deliberately
// SEPARATE from `holdings`: holdings is the snapshot of what you hold now;
// `transactions` is how you got there. See
// docs/explanation/decisions/0003-transaction-ledger-data-model.md.
//
// Scoping: like `holdings`, this table has NO `user_id` — it is scoped through
// its parent bucket. The scoping invariant lives in the CALLER (resolve the
// owner's bucket set, then query); the query layer exposes no unscoped list.
// This intentionally overrides the general "new app tables carry user_id"
// guidance, because a transaction belongs to a bucket, not directly to a user.
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bucketId: text("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    englishName: text("english_name"),
    /**
     * NAV/price-routing key, same semantics as holdings.quote_source — needed
     * so proceeds and the terminal portfolio value can be priced.
     *   - "market"            — stocks, ETFs, indices, FX via Yahoo
     *   - "thai_mutual_fund"  — Thai mutual fund NAVs via the SEC Open API
     */
    quoteSource: text("quote_source").notNull().default("market"),
    /**
     * Event type. Plain TEXT validated by Zod at the route boundary (the
     * action_item_states precedent) so a new kind needs no migration. Set:
     *   buy | sell | dividend | fee | split | reinvest    (fund deltas)
     *   opening | snapshot                                 (fund position anchors)
     *   deposit | withdraw | cash_balance                 (explicit cash, #149)
     */
    kind: text("kind").notNull(),
    /**
     * ISO-8601 ECONOMIC event date — the cash-flow date the return math orders
     * and discounts by. Distinct from `createdAt` (the UTC insert time): a
     * date-only Bangkok screenshot must land on its correct local day, never
     * drift onto the wrong UTC day.
     */
    tradeDate: text("trade_date").notNull(),
    // Nullable: a cash dividend / standalone fee has no units. For a value-only
    // Balance (the Thai-app case) units are LEFT NULL and DERIVED at the projection
    // fold from `value ÷ NAV(tradeDate)` — never frozen here. See `value` below.
    units: real("units"),
    // Native-currency NAV/price at execution. Derivable for display; not the
    // primary money field.
    pricePerUnit: real("price_per_unit"),
    /**
     * The asset's MARKET price at `tradeDate` (per unit), independent of cost.
     * For a trade this equals the execution price; for a Balance it's the
     * user-entered "current price". Its LATEST value per ticker is the current
     * price used to value an asset that has no live NAV (a custom / "manual"
     * holding) — see lib/portfolio/transaction-analytics.ts. Null = no price
     * point recorded by this row.
     */
    marketPrice: real("market_price"),
    /**
     * SIGNED THB cash flow — the SOLE money-weighted-return primitive, always
     * present even when units/price are blank. Sign convention (validated at
     * the route, never silently coerced):
     *   buy / fee / reinvest-buy leg / cash deposit → NEGATIVE (cash out)
     *   sell / cash dividend / cash withdraw → POSITIVE (cash in)
     *   split / snapshot / cash_balance → 0 (no cash moves)
     * Already in THB. `fxToThb` is NEVER re-applied to this value — doing so
     * re-introduces the mixed-currency double-count.
     */
    amount: real("amount").notNull(),
    // Nullable; folds into basis on buys, nets from proceeds on sells.
    fee: real("fee"),
    tradeCurrency: text("trade_currency").notNull().default("THB"),
    /**
     * Trade-date FX rate captured AT IMPORT (historical FX is not reliably
     * re-fetchable later). Used only to derive native price for display and to
     * compute `amount` once at import when only a native amount was captured.
     * THB-denominated funds: tradeCurrency "THB", fxToThb 1 (a no-op).
     */
    fxToThb: real("fx_to_thb").notNull().default(1),
    /**
     * The native figures the user typed for a non-THB row, stored verbatim (see
     * `NativeInputs`). Null on THB rows and legacy rows — those reconstruct
     * native from `THB ÷ fxToThb` at read. Never folded; provenance only.
     */
    nativeInputs: text("native_inputs", { mode: "json" }).$type<NativeInputs>(),
    note: text("note"),
    // Free-text broker / import provenance label, like holdings.source.
    source: text("source"),
    // Groups the rows of one import for provenance / undo.
    importBatchId: text("import_batch_id"),
    /**
     * Stable per-order identity from a broker import (`sourceTag:account:ref`) —
     * the dedup anchor so a re-sync inserts only genuinely new orders. NULL on
     * manual / OCR / paste rows; the partial unique index below only constrains
     * non-null values, so those rows never collide. Immutable after insert.
     */
    externalId: text("external_id"),
    /**
     * The broker account this row came from (account_code) — remembers the
     * "real structure" so a later sync can keep the user's chosen portfolio.
     * Immutable after insert; survives a re-bucketing. NULL on non-broker rows.
     */
    externalAccount: text("external_account"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    /**
     * The Balance's stated current ฿ VALUE, when the source shows value not units
     * (the Thai-app case). The FACT we store; `units` is then DERIVED from
     * `value ÷ NAV(tradeDate)` at the projection fold, so it self-corrects when that
     * date's NAV lands or is corrected — never frozen here. Null on a unit-anchored
     * Balance or any trade; only a value-only anchor carries it. (Facts-only ledger
     * rule — see AGENTS.md § Ledger and ADR 0004.)
     */
    value: real("value"),
    /**
     * "No money moved" override on a `cash_balance` (Set balance) row (#149). NULL/false
     * = the change vs the prior asserted balance is treated as money in/out (a
     * contribution/withdrawal); true = a pure reconciliation (interest, a correction, or
     * asserting parked sale proceeds) — no contribution flow, and it clears that bucket's
     * in-transit settlement lots. Only meaningful for `cash_balance`. See
     * lib/portfolio/settlement-cash.ts.
     */
    reconcile: integer("reconcile", { mode: "boolean" }),
  },
  (table) => [
    index("idx_transactions_bucket").on(table.bucketId, table.tradeDate),
    // Idempotent broker re-sync: one row per external_id. Partial (only non-null)
    // so existing/manual rows (external_id NULL) are unconstrained — SQLite would
    // otherwise treat multiple NULLs as distinct anyway, but the partial index is
    // explicit and skips indexing every non-broker row.
    uniqueIndex("idx_transactions_external_id")
      .on(table.externalId)
      .where(isNotNull(table.externalId)),
  ],
);

// Broker-import connections — maps one broker account (account_code) to the
// Macrotide portfolio (bucket) its orders route into, plus last-sync status.
// The account→bucket mapping is what the user manages (rename / remap / merge)
// in Settings → Connections; the importer routes each account's rows by it. Two
// connections pointing at the same bucketId is a MERGE. Scoped per user like
// buckets (the uniqueness invariant is enforced in the query layer, not the
// index, since NULL user_id rows are distinct in a SQLite unique index).
export const brokerConnections = sqliteTable(
  "broker_connections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => user.id),
    // Connector tag (the broker source label) — disambiguates multi-broker.
    source: text("source").notNull().default("broker"),
    // The broker's own account identifier (== transactions.external_account).
    accountCode: text("account_code").notNull(),
    // Human label from the broker (the plan name), for display.
    displayName: text("display_name"),
    // The portfolio this account's orders route to. onDelete:set null so deleting
    // a bucket doesn't drop the connection (next sync re-creates a portfolio).
    bucketId: text("bucket_id").references(() => buckets.id, { onDelete: "set null" }),
    lastSyncedAt: text("last_synced_at"),
    lastInserted: integer("last_inserted").notNull().default(0),
    lastSkipped: integer("last_skipped").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    uniqueIndex("idx_broker_connections_acct").on(table.userId, table.source, table.accountCode),
  ],
);

// Investment plan — one row per user. `id` autoincrements; a UNIQUE index on
// `user_id` enforces a single plan per owner. SQLite treats multiple NULLs as
// distinct in a UNIQUE index, which is fine: single-owner mode has exactly one
// NULL-owned row.
export const plans = sqliteTable(
  "plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL pre-backfill / single-owner mode.
    userId: text("user_id").references(() => user.id),
    markdown: text("markdown").notNull(),
    selectedModelId: text("selected_model_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_plans_user").on(table.userId)],
);

// Journal entries — notes, decisions, questions, reading.
export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL pre-backfill / single-owner mode → visible to everyone.
    userId: text("user_id").references(() => user.id),
    kind: text("kind").notNull(),
    title: text("title"),
    body: text("body"),
    url: text("url"),
    source: text("source"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (table) => [
    index("idx_journal_kind").on(table.kind),
    index("idx_journal_created").on(table.createdAt),
  ],
);

// Model portfolios — built-ins shipped with the app + user customizations.
export type ModelMixSlice = { label: string; pct: number; ticker?: string; color: string };

export const modelPortfolios = sqliteTable("model_portfolios", {
  id: text("id").primaryKey(),
  // Owner. NULL = built-in / single-owner → visible to everyone.
  userId: text("user_id").references(() => user.id),
  name: text("name").notNull(),
  tagline: text("tagline"),
  blurb: text("blurb"),
  builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
  allocation: text("allocation", { mode: "json" }).$type<ModelMixSlice[]>().notNull(),
  expectedReturn: real("expected_return"),
  expectedVolatility: real("expected_volatility"),
  ter: real("ter"),
  horizon: text("horizon"),
  risk: text("risk"),
  pros: text("pros", { mode: "json" }).$type<string[]>(),
  cons: text("cons", { mode: "json" }).$type<string[]>(),
  createdAt: text("created_at").notNull(),
});

// Chat threads — one per conversation.
export const chatThreads = sqliteTable("chat_threads", {
  id: text("id").primaryKey(),
  // Owner. NULL pre-backfill / single-owner mode → visible to everyone.
  userId: text("user_id").references(() => user.id),
  title: text("title"),
  // Lifecycle state machine: 'active' on creation; the idle-archive
  // job promotes 'active' → 'idle' → 'archived' based on `updatedAt` age.
  // Deletion is orthogonal — it stays on `deletedAt` (30-day trash), so there
  // is deliberately no 'deleted' status here.
  status: text("status", { enum: ["active", "idle", "archived"] })
    .notNull()
    .default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Set when the archive job moves a thread to 'archived'; ISO-8601 UTC.
  archivedAt: text("archived_at"),
  // Watermark for incremental backstop extraction: the highest
  // chat_messages.id already folded into a `source='extracted'` pass. On
  // session close we extract only turns newer than this (plus the running
  // summary as context), then advance it — so re-extracting a resumed chat
  // never re-processes old turns. NULL = nothing extracted yet.
  extractedThroughId: integer("extracted_through_id"),
  // Soft-delete: NULL = active, ISO-8601 UTC = trashed at that moment.
  // 30-day grace period for restore; UI hides past that. Hard purge is manual.
  deletedAt: text("deleted_at"),
});

// Chat messages — user/assistant/tool turns within a thread.
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolCallId: text("tool_call_id"),
    feedback: text("feedback"),
    // The OpenRouter / provider model id that served this response.
    // NULL for user/tool/summary rows and for messages predating this column.
    model: text("model"),
    // JSON-encoded per-message attachment metadata for image turns:
    // [{name, mime, capturedAt, capturedAtSource}]. NULL for non-image / legacy
    // rows. Holds NO bytes (images aren't stored server-side; see SECURITY.md).
    // The model-facing "(Attached files: …)" note is composed from this at
    // model-build time and never persisted — `content` holds only raw user text.
    attachments: text("attachments"),
    // JSON-encoded propose_* tool payloads generated by an assistant turn
    // ({ holdingsImport?, transactionsImport?, holdings?, proposal? }), so the
    // in-chat import tables / proposals survive reload and follow the user across
    // devices (previously browser-only, in localStorage). NULL for turns with no
    // cards and for rows predating this column. Doubles as a durable diagnostic
    // record of exactly what the Advisor extracted.
    cards: text("cards"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_chat_messages_thread").on(table.threadId, table.createdAt)],
);

// Per-user Markets-screen indicator list — which indicators a user shows and in
// what order. No rows for a user → the app falls back to the curated default
// set (DEFAULT_INDICATOR_SYMBOLS in lib/market/indicators.ts). Writes replace a
// user's whole list, so order is authoritative.
//
// Despite the `market_` name this is a user PREFERENCE (which symbols a user
// pins), so it lives in app.db — not the regenerable market.db.
export const userMarketIndicators = sqliteTable(
  "user_market_indicators",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL in single-owner / AUTH_DISABLED mode (matches other tables).
    userId: text("user_id").references(() => user.id),
    // Canonical ticker from the indicator catalog (lib/market/indicators.ts).
    symbol: text("symbol").notNull(),
    // Display order, ascending.
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("idx_user_market_indicator").on(table.userId, table.symbol),
    index("idx_user_market_indicator_order").on(table.userId, table.position),
  ],
);

// User-scoped suppression state for generated Portfolio action items (fee-creep
// flags today; headline / rebalance later). Those items are recomputed every
// render and carry no DB row of their own, so we key state by a deterministic
// item_key (see lib/portfolio/action-item-key.ts). Idempotent: one row per
// (user, item_key); re-acting upserts the same row.
//
// Two honest states (#74): 'archived' (filed) and 'not_for_me' (rejected, with
// an optional reason). Both resurface only on a MATERIAL, worse change — the
// reason selects the bar (see lib/portfolio/action-item-resurface.ts). The
// state string is validated at the Zod/route boundary; the DB column is plain
// TEXT so a future state needs no migration.
export const actionItemStates = sqliteTable(
  "action_item_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL in single-owner / AUTH_DISABLED / demo (matches other tables).
    userId: text("user_id").references(() => user.id),
    // 'headline' | 'rebalance' | 'fee_creep' — which generator produced the item.
    itemType: text("item_type").notNull(),
    // Deterministic identity string (see action-item-key.ts recipe table).
    itemKey: text("item_key").notNull(),
    // 'archived'   — acknowledged ("I've seen it, file it").
    // 'not_for_me' — rejected (optionally with a `reason`).
    // Plain TEXT, not a drizzle enum: state is validated at the route boundary,
    // and a new state must not force a migration.
    state: text("state").notNull(),
    // Optional reason on a 'not_for_me' (a REASON_CHIPS key or free text); the
    // chip selects the deterministic resurface policy. NULL = archive / no-reason
    // reject. See lib/portfolio/action-item-resurface.ts.
    reason: text("reason"),
    // Magnitude snapshot at suppression time — the finding's annual saving
    // (pp/yr). The resurface check compares the CURRENT saving against this; the
    // ratchet re-snapshots the new value on re-suppression. NULL = no snapshot
    // (e.g. headline/rebalance items with no magnitude).
    snapshotSavingsPp: real("snapshot_savings_pp"),
    // Legacy Snooze column — UNUSED in the new model (Snooze dropped, #74). Kept
    // nullable to keep the migration forward-only/non-destructive; do not write it.
    snoozeUntil: text("snooze_until"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    // One state per (user, item) — upsert target.
    uniqueIndex("idx_action_item_user_key").on(table.userId, table.itemKey),
  ],
);

// Generic key-value settings.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

// Long-term memory. Bitemporal: updates add a new row + supersede; rows are
// never mutated in place. `valid_until IS NULL` is the active set.
// `source = 'advisor_tool'` = a memory the Advisor saved in-chat; `'extracted'`
// = session-close auto-extraction. See docs/explanation/memory.md.
export const userPreferences = sqliteTable(
  "user_preferences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL pre-backfill / single-owner mode. Scoped via ownedBy().
    userId: text("user_id").references(() => user.id),
    // Two-party taxonomy: `user` = facts about the person & their money;
    // `advisor` = how the Advisor should respond. Split on which party the memory
    // describes (the foolproof test).
    category: text("category", {
      enum: ["user", "advisor"],
    }).notNull(),
    // The injected hook — a short one-line fact (the memory itself).
    content: text("content").notNull(),
    // Optional longer elaboration, recall-only (never injected). Written from the
    // tool's `detail` arg; the hook/detail split keeps injection cheap.
    detail: text("detail"),
    source: text("source", { enum: ["advisor_tool", "extracted"] }).notNull(),
    sourceSessionId: text("source_session_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    sourceTurnIds: text("source_turn_ids", { mode: "json" }).$type<number[]>(),
    confidence: real("confidence"), // NULL for explicit; 0..1 for extracted
    // Self-FK to the row that superseded this one (set on update/consolidation
    // merge, never on a plain forget) — distinguishes edit-history from a
    // deliberate forget so the former never surfaces in "Recently forgotten".
    supersededBy: integer("superseded_by").references((): AnySQLiteColumn => userPreferences.id),
    // Bumped only when the user affirms the fact (never on recall/inject) — the
    // anti-stale reinforcement signal that exempts a row from decay. NULL = never
    // explicitly confirmed. (Sparse — not a ranking key; see inject.ts comparator.)
    lastConfirmedAt: text("last_confirmed_at"),
    validFrom: text("valid_from").notNull(),
    validUntil: text("valid_until"), // NULL = active
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_user_pref_active").on(table.userId, table.validUntil),
    index("idx_user_pref_category").on(table.userId, table.category, table.validUntil),
  ],
);

// Typed links between memory rows (e.g. a hard constraint ↔ the correction that
// set it). The FK guarantees a link can't point at a nonexistent row; "target
// still valid" (not superseded / soft-deleted) is enforced at READ time by
// joining the target on `valid_until IS NULL`. On a bitemporal update the
// supersede transaction re-points links to the new row so an edit can't orphan
// them. The model proposes links (meaning); the schema guarantees integrity.
export const memoryLinks = sqliteTable(
  "memory_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Owner. NULL pre-backfill / single-owner mode. Scoped via ownedBy().
    userId: text("user_id").references(() => user.id),
    fromId: integer("from_id")
      .notNull()
      .references(() => userPreferences.id),
    toId: integer("to_id")
      .notNull()
      .references(() => userPreferences.id),
    // Free TEXT (validated at the boundary): 'relates_to' | 'supersedes' |
    // 'contradicts' | … — a new relation needs no migration.
    relation: text("relation").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_links_from").on(table.userId, table.fromId),
    index("idx_memory_links_to").on(table.userId, table.toId),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// better-auth tables. Names match better-auth's defaults so the drizzle
// adapter resolves them without a `schema` mapping. All timestamps are stored
// as integer epoch-ms — better-auth's drizzle adapter handles the conversion.
// ───────────────────────────────────────────────────────────────────────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

// Passkey plugin table.
export const passkey = sqliteTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_i_d").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
  transports: text("transports"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  aaguid: text("aaguid"),
});

// ───────────────────────────────────────────────────────────────────────────
// Multi-user: per-user token accounting + tier gating.
// ───────────────────────────────────────────────────────────────────────────

// Per-user daily token usage. One row per (user, UTC date).
export const usage = sqliteTable(
  "usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    date: text("date").notNull(), // 'YYYY-MM-DD' UTC
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // Accumulated estimated cost in micro-dollars (millionths of a USD).
    // 1 cent = 10_000 micro-dollars. Stays 0 for free/zero-cost models (only
    // priced models in MODEL_PRICES contribute), so it's additive and never
    // regresses the token-only accounting. Enables the optional cents-based cap.
    costMicros: integer("cost_micros").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.date] })],
);

// Tier gating: which OpenRouter model chain a user can hit.
//   'public'  = the public-tier model chain only (zero cost to owner by default)
//   'trusted' = full owner model chain (TRUSTED_TIER_MODELS env)
// Owner promotes via SQL: UPDATE account_tier SET tier='trusted' WHERE user_id=?
export const accountTier = sqliteTable("account_tier", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id),
  tier: text("tier", { enum: ["public", "trusted"] })
    .notNull()
    .default("public"),
  grantedAt: text("granted_at").notNull(), // ISO-8601 UTC
});
