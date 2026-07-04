# Configuration

How Macrotide reads configuration, and the canonical list of every variable.

## How it works

All runtime configuration comes from **environment variables**, read from
`.env.local` in development (gitignored) and from the process environment in
production (e.g. a systemd `EnvironmentFile`; see [deploy.md](../how-to/deploy.md)).

- `.env.example` is a **thin template** — copy it to `.env.local` and fill in.
- The app is **secure by default**: a fresh checkout with no vars set refuses to
  render the dashboard (auth required) and returns AI chat stubs (no key). You
  opt *in* to riskier or richer behavior. See
  [design principles](../explanation/design-principles.md).

## Environment variables

The canonical reference for every `process.env.*` the app reads — default, the
code that reads it, and its behavior. This table is the single source of truth;
keep it in sync with [.env.example](../../.env.example) when adding/renaming vars
(see [When you change a variable](#when-you-change-a-variable)).

### AI / model selection

This table is the SSOT for each var's **default** + behavior. For the **suggested**
model per surface (with fallback) and the reasoning policy at a glance, see
[inference-strategy.md § Routing at a glance](../explanation/inference-strategy.md#routing-at-a-glance).

> **Every `*_MODELS` fallback chain is capped at 3.** OpenRouter's `models[]` array
> rejects more than 3 entries (a longer chain 400s and dead-fails *every* request), so
> `openrouter()` trims to the first 3 (best-by-order); a 4th+ slug is silently dropped.
> Keep recommended chains ≤ 3.

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | — (required for live AI) | [lib/ai/provider.ts](../../lib/ai/provider.ts), [lib/portfolio/ocr.ts](../../lib/portfolio/ocr.ts) | Chat returns a stub response without it; OCR returns 503. |
| `TRUSTED_TIER_MODELS` | `openrouter/free,openrouter/auto` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Comma-separated owner-chat fallback chain (also used by `tier='trusted'`). First model is primary. |
| `PUBLIC_TIER_MODELS` | `openrouter/free` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Model chain for `tier='public'` chat. Read from its OWN var, never from `TRUSTED_TIER_MODELS` (the invariant below). Defaults to the zero-cost free router; point it at a cheap PAID model (e.g. `google/gemini-2.5-flash`) to lift public-tier quality — bounded by the daily token + optional cents caps. |
| `REASONING_GATE` | `on` | [lib/advisor/intent.ts](../../lib/advisor/intent.ts), [app/api/chat/route.ts](../../app/api/chat/route.ts) | Owner/trusted only: a deterministic classifier raises reasoning `effort` to `medium` on genuine multi-step turns (rebalance, SSF-vs-RMF, plan-anchored tilt); otherwise trusted runs at its floor (`TRUSTED_REASONING_FLOOR`). Set `off` to inherit each model's default reasoning instead. Tune the trigger set against the eval (`EVAL_TIER=complex EVAL_REASONING=medium`). |
| `TRUSTED_REASONING_FLOOR` | `low` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Minimum reasoning `effort` for owner/trusted chat; the intent gate may raise above it but never below. Eval-backed: the trusted primary (grok-4.3) saves explicit memory requests ~41% at `none` vs ~100% at `low`. One of `none\|minimal\|low\|medium\|high`. |
| `PUBLIC_REASONING_EFFORT` | `none` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Fixed reasoning `effort` for `tier='public'` chat (not intent-gated — cost-protected). Default `none` keeps cheap models fast; set `low` if you point `PUBLIC_TIER_MODELS` at a reasoning model (e.g. grok) so its tool-calling lands. One of `none\|minimal\|low\|medium\|high`. |
| `DEMO_REASONING_EFFORT` | `none` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Fixed reasoning `effort` for demo chat — parity with `PUBLIC_REASONING_EFFORT`. Default `none`. |
| `DEMO_OPENROUTER_API_KEY` | falls back to `OPENROUTER_API_KEY` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Separate key for demo traffic so demo can't burn owner quota. |
| `DEMO_TIER_MODELS` | `openrouter/free` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Demo-chat model chain. Free-only by default. |
| `TITLE_MODELS` | `openrouter/free` | [lib/ai/provider.ts](../../lib/ai/provider.ts) | Cheap model for auto-titling a chat after its first turn pair (`POST /api/chat/threads/[id]/title`). **Never pin a Claude or GPT model here** — titling is a 3–5-word task and any non-mainstream free model (DeepSeek V3, Qwen3 small, etc.) is more than enough. Comma-separated chain accepted; first model is primary. |
| `EXTRACT_MODELS` | →`TITLE_MODELS`→`openrouter/free` | [lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveExtractorProvider` | Model chain for session-close durable-fact extraction (strict JSON). Comma-separated; first is primary. **Suggested `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite,openai/gpt-4.1-mini`** (paid primary + cross-provider tail): a probe found free extraction is a quality lottery (1–6 facts, empty/unparseable JSON at default reasoning) vs 9/9 clean facts on flash-lite at ~$0.0005/run. Runs reasoning-`none` — a summarize-extract pass doesn't need chain-of-thought; it would only spend the output budget (the bad JSON above is the weak free models, not reasoning, which rides its own channel). |
| `CONSOLIDATE_MODELS` | `openai/gpt-oss-20b:free,cohere/north-mini-code:free,openrouter/free` | [lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveConsolidateProvider` | Model chain for the **offline memory-consolidation sweep** (`jobs:consolidate-memory`). UNLIKE extraction this runs a true **reasoning** model — the sweep is offline + infrequent, so chain-of-thought to judge near-duplicates is affordable. Defaults to a **free reasoning chain** ending in `openrouter/free` as an availability fallback (it too forces reasoning — verified — but is a model-quality lottery, so it sits last; does NOT fall back to `EXTRACT_MODELS`/`TITLE_MODELS` — an unset value keeps reasoning). Comma-separated; first is primary. The two free pins are on different providers (so one provider's free-tier throttle can't kill both); all four slugs were probed on the real prompt 2026-06-24. For a reliable paid backstop if a sweep must never skip, swap the trailing `openrouter/free` for `google/gemini-3.1-flash-lite` → `openai/gpt-oss-20b:free,cohere/north-mini-code:free,google/gemini-3.1-flash-lite` (~$0.10–0.40/M, bounded reasoning — NOT a thinking-only model, which truncates the JSON). |
| `CONSOLIDATE_REASONING_EFFORT` | `low` | [lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveConsolidateProvider` | Reasoning `effort` for the consolidation sweep. Reasoning is **ON** here (the pinned models return CoT in their own channel, so JSON stays clean). One of `none\|minimal\|low\|medium\|high`; `low` is plenty for dedup judgment. |
| `OCR_MODELS` | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` | [lib/portfolio/ocr.ts](../../lib/portfolio/ocr.ts) | Add-holdings image extraction (vision), as a comma-separated `primary,fallback` chain. NOT tier-gated — same model for all users (bounded, rate-limited one-shot). Each must be vision-capable. Auto-retries on the primary's provider error / rate-limit against the chain's second model; a single-model value pins one model with no fallback. |
| `OCR_GLOBAL_LIMIT_PER_MIN` | `60` | [lib/api/rate-limit.ts](../../lib/api/rate-limit.ts) (`OCR_GLOBAL_RATE_LIMIT`) | Process-wide ceiling on total vision/OCR **model calls** per minute across ALL callers — an IP-independent circuit breaker on top of the per-IP limit, bounding owner-key spend even if the per-IP key is bypassed or spread across demo sessions. Charged per model call: a detect-then-route image import counts as two (classify + extract). |
| `VISION_CHAT_MODELS` | `google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` | [lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveVisionProvider`, [lib/advisor/vision-tool.ts](../../lib/advisor/vision-tool.ts), [app/api/chat/route.ts](../../app/api/chat/route.ts) | Vision model the Advisor's `examine_image` tool runs to READ an image on an **image-bearing chat turn** (the chat driver stays on the turn and can't see pixels — it calls the tool). Across owner/trusted/public. Must be vision-capable; comma-separated fallback chain accepted. Read from its OWN var, never from `TRUSTED_TIER_MODELS`/`PUBLIC_TIER_MODELS` — so public-tier vision can't widen the text chains (and stays bounded by the daily token + optional cents caps). Set to `off` (or `none`/`false`/empty) to disable inline chat vision entirely → image turns get a stub pointing at the Add-holdings importer. |
| `VISION_CHAT_ESCALATE_MODELS` | unset | [lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveVisionEscalateProvider`, [app/api/chat/route.ts](../../app/api/chat/route.ts) | OPTIONAL stronger vision chain the `examine_image` tool escalates to for a chart/factsheet the user is reasoning ABOUT. **Owner/trusted only** — public/demo never escalate (cost invariant). Unset → no escalation; the cheap `VISION_CHAT_MODELS` serves charts too. Escalated turns count against the daily caps. |
| `DEMO_VISION` | `off` | [lib/advisor/image-turn.ts](../../lib/advisor/image-turn.ts), [app/api/chat/route.ts](../../app/api/chat/route.ts), [app/api/chat/capabilities/route.ts](../../app/api/chat/capabilities/route.ts) | Opt-in (`on`/`1`/`true`/`yes`) to allow **demo** chat sessions to upload images. Off by default — demo hides the attach button and stubs image turns. When on, demo image turns use `VISION_CHAT_MODELS` with the demo key (`DEMO_OPENROUTER_API_KEY`), bounded by the 10-turn demo cap. |
| `DEBUG_ADVISOR` | unset | [lib/advisor/turn-persist.ts](../../lib/advisor/turn-persist.ts), [app/api/chat/route.ts](../../app/api/chat/route.ts) | Set to `1` to log one diagnostic line per chat turn to the server console — served model, the step/finish-reason chain, and each tool call's full input (the extracted rows). Local-dev debugging aid; leave unset in production. The durable per-turn record is the persisted `chat_messages.cards` column. |

The public tier chain derives ONLY from `PUBLIC_TIER_MODELS`
(default `openrouter/free`) in code
([lib/ai/provider.ts](../../lib/ai/provider.ts) `resolveTierProvider`) and is
deliberately NOT derived from `TRUSTED_TIER_MODELS` — so a slip in the trusted chain can
never widen public-tier access. Pointing public at a cheap paid model is a separate,
conscious operator act (`PUBLIC_TIER_MODELS=…`), and public spend stays bounded by the
daily token cap plus the optional cents cost cap (see **Quotas + tier gating**).
`tier='trusted'` uses the `TRUSTED_TIER_MODELS` owner chain. Tier is stored in
`account_tier`; promote via SQL (`UPDATE account_tier SET tier='trusted' WHERE user_id=?`).

### Auth (better-auth)

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `AUTH_SECRET` | dev fallback (`macrotide-dev-secret-change-me`) | [lib/auth/index.ts](../../lib/auth/index.ts) | REQUIRED in production (boot throws if `NODE_ENV=production` and unset). |
| `AUTH_DISABLED` | unset | [app/page.tsx](../../app/page.tsx), [lib/auth/session.ts](../../lib/auth/session.ts), [lib/api/with-db.ts](../../lib/api/with-db.ts) | Set to `1` to skip the login gate on trusted local dev only. |
| `AUTH_RP_NAME` | `Macrotide` | [lib/auth/index.ts](../../lib/auth/index.ts) | Passkey relying-party display name. |
| `AUTH_RP_ID` | inferred from `PUBLIC_APP_URL` | [lib/auth/index.ts](../../lib/auth/index.ts) | Override only if you understand WebAuthn `rpID` rules. |
| `PUBLIC_APP_URL` | `http://localhost:3000` (implicit) | [lib/auth/index.ts](../../lib/auth/index.ts), [lib/portfolio/ocr.ts](../../lib/portfolio/ocr.ts) | Canonical URL. Used for OpenRouter `HTTP-Referer` and WebAuthn origin. Changing this in prod breaks existing passkeys. |
| `OWNER_EMAIL` | unset (no owner) | [scripts/backfill-owner.ts](../../scripts/backfill-owner.ts), [lib/auth/owner.ts](../../lib/auth/owner.ts) | Names the owner account. The backfill attaches `NULL`-owned rows to it + grants `trusted`; at runtime it identifies the owner for the admin UI (gate is **fail-closed** — unset → nobody is owner). **Must be in the running app's env, not just for the one-off script.** Run `npx tsx --env-file=.env.local scripts/backfill-owner.ts` once after migrating. Idempotent. |

### Auth — OAuth + signup gate

All optional and **env-gated**: with none set, the app runs passkey-only and the
`/login` page hides the OAuth buttons / Turnstile widget. A provider counts as
"enabled" only when BOTH its id and secret are present.

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | [lib/auth/providers.ts](../../lib/auth/providers.ts) | Enables "Continue with Google" (needs `GOOGLE_CLIENT_SECRET` too). |
| `GOOGLE_CLIENT_SECRET` | unset | [lib/auth/providers.ts](../../lib/auth/providers.ts) | Server-only. |
| `TURNSTILE_SITE_KEY` | unset | [lib/auth/turnstile.ts](../../lib/auth/turnstile.ts), [/api/auth-config](../../app/api/auth-config/route.ts) | **PUBLIC** — shipped to the browser to render the widget. |
| `TURNSTILE_SECRET_KEY` | unset | [lib/auth/turnstile.ts](../../lib/auth/turnstile.ts) | Server verifies the email-signup token here (OAuth sign-in is not gated — the provider authenticates the user). **When unset, verification is BYPASSED (dev pass).** The Google OAuth callback URI must point at `<PUBLIC_APP_URL>/api/auth/callback/google`. |

Rate limiting: `/api/auth/*` POSTs are IP-limited via `AUTH_RATE_LIMIT`
(10/min/IP — [lib/api/rate-limit.ts](../../lib/api/rate-limit.ts)), wired in
[app/api/auth/[...all]/route.ts](../../app/api/auth/[...all]/route.ts).

### Legal pages

All optional and operator-configurable so the repo ships nothing
operator-specific; `/legal/terms` + `/legal/privacy` read them at render.

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `OPERATOR_NAME` | unset → "a single individual" / "the operator" | [lib/legal/config.ts](../../lib/legal/config.ts) | Who runs this instance, shown on both legal pages. |
| `CONTACT_EMAIL` | unset → no email, just "contact the operator" | [lib/legal/config.ts](../../lib/legal/config.ts) | Contact shown (as a `mailto`) on both pages. **No fallback to `OWNER_EMAIL`** — set this only to publish a real address. |
| `LEGAL_JURISDICTION` | unset → governing-law clause omitted | [lib/legal/config.ts](../../lib/legal/config.ts) | Governing-law jurisdiction (e.g. `Thailand`). |

The "Last updated" date is the `LEGAL_LAST_UPDATED` constant in
[lib/legal/config.ts](../../lib/legal/config.ts) (bump it when editing the copy, not
an env var). Sign-up consent is an inline notice under the create-account button
("By continuing, you agree to the Terms and Privacy Policy"), not a checkbox.

### Database

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `DB_PATH` | `data/app.db` | [lib/db/client.ts](../../lib/db/client.ts), [lib/mock/seed.ts](../../lib/mock/seed.ts) | app.db (system of record) path. Relative paths resolved from CWD; parent dir auto-created. |
| `MARKET_DB_PATH` | `data/market.db` | [lib/db/client.ts](../../lib/db/client.ts) | market.db (regenerable market data) path. Same `data/` volume as app.db; not backed up. |

### Quotas + tier gating

Per-user metering only applies to **authenticated** requests. Single-owner /
`AUTH_DISABLED` mode (`getUserId()` === null) is never metered, and demo
sessions are bounded by the demo turn cap, not these budgets.

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `DAILY_TOKEN_BUDGET_PUBLIC` | `20000` | [lib/db/queries/usage.ts](../../lib/db/queries/usage.ts) | Daily input+output token cap per `tier='public'` user. Checked before forwarding to OpenRouter; resets at UTC midnight. Malformed/≤0 → default. Always on (the floor). |
| `DAILY_TOKEN_BUDGET_TRUSTED` | `200000` | [lib/db/queries/usage.ts](../../lib/db/queries/usage.ts) | Same, for `tier='trusted'` users. |
| `DAILY_CENTS_BUDGET_PUBLIC` | unset → **cost cap OFF** | [lib/db/queries/usage.ts](../../lib/db/queries/usage.ts) | Optional daily **cost** ceiling in US cents per `tier='public'` user — the right bound when `PUBLIC_TIER_MODELS` is a paid model with asymmetric in/out pricing. Checked alongside the token cap (either tripping blocks the turn). Unset or malformed/≤0 → disabled (no invented money cap; the token cap still applies). |
| `DAILY_CENTS_BUDGET_TRUSTED` | unset → **cost cap OFF** | [lib/db/queries/usage.ts](../../lib/db/queries/usage.ts) | Same, for `tier='trusted'` users. |
| `MODEL_PRICES` | built-in table | [lib/db/queries/usage.ts](../../lib/db/queries/usage.ts) | JSON map `{"<model-id>":{"in":<USD/Mtok>,"out":<USD/Mtok>}}` keyed by the model id OpenRouter reports back, merged OVER the built-in prices. Drives the per-turn cost estimate that feeds `DAILY_CENTS_BUDGET_*`. Set it to match whatever `PUBLIC_TIER_MODELS` resolves to. Unpriced (zero-cost) models contribute 0 cost. Malformed JSON → built-ins. |

The cost cap is **off by default** — until you both set a `DAILY_CENTS_BUDGET_*`
and run a priced model, only the token cap bites. Cost is an *estimate*
(`served tokens × MODEL_PRICES`), not a provider-reported charge.

#### Account-level spend probe

A separate guard from the per-user caps above: a server-run probe
([scripts/check-openrouter-budget.ts](../../scripts/check-openrouter-budget.ts))
that watches the **whole account's** OpenRouter spend against the key's monthly
limit — read live from `GET /api/v1/key`, so the cap lives only in the OpenRouter
dashboard and can't drift into the repo — and signals when spend nears it, before
the 403 that would break all chat.

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_BUDGET_HEARTBEAT_URL` | unset → no ping | [scripts/check-openrouter-budget.ts](../../scripts/check-openrouter-budget.ts) | Optional heartbeat URL the probe uses two ways. On a **warn or critical** reading it **POSTs a one-line spend summary to the URL's `/fail` sub-path** (the standard dead-man convention) to raise a threshold alert. And on **healthy/warn** it **GETs the base URL** as a dead-man liveness ping. It deliberately **withholds the ping on critical and indeterminate** — so a critical `/fail` stays a sustained incident, and a *persistently* unreadable API (the `/key` read is retried on a transient hiccup first) stops the heartbeat and surfaces via the dead-man. Size the monitor's grace to **≥ ~1.5× the run cadence** so a single non-pinging run is tolerated but two-plus in a row fire. Spend thresholds are CLI flags on the job unit (`--warn-pct` / `--crit-pct`, default 80 / 95), not env — the dollar cap itself is read from OpenRouter, never declared here. The systemd unit + monitor wiring are server-side ops. |

### External data sources

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `SEC_API_KEY` | — (Thai funds render as "—" without it) | [lib/market/providers/sec-thailand.ts](../../lib/market/providers/sec-thailand.ts) | Thai SEC Open API subscription key (Primary or Secondary — both valid). Header: `Ocp-Apim-Subscription-Key`. Covers all 6 product groups under one subscription. |
| `SEC_V1_API_KEY` | — (AIMC snapshot script exits with an error) | [lib/market/providers/sec-thailand.ts](../../lib/market/providers/sec-thailand.ts) | Legacy v1 FundFactsheet subscription key (a SEPARATE product from `SEC_API_KEY`). Used only by the one-shot [scripts/backfill-aimc-v1.ts](../../scripts/backfill-aimc-v1.ts) AIMC peer-group snapshot — never by the nightly crawl. The v1 portal retires 2026-06-30. |
| `SEC_INGEST_DIVIDENDS` | off | [lib/jobs/refresh-fund-catalog.ts](../../lib/jobs/refresh-fund-catalog.ts) | `1` adds the full dividend-payment-history bulk sweep to the catalog crawl (the endpoint has no date filter, so each pass re-reads all payments — small in practice, ~40 pages). Lands in `fund_dividend_history`. |
| `FMP_API_KEY` | — (chain falls through to EODHD → ETF proxy → Yahoo) | [lib/market/providers/fmp.ts](../../lib/market/providers/fmp.ts) | Financial Modeling Prep. REAL US index levels for `^GSPC`/`^NDX`/`^DJI` via `/api/v3/historical-price-full`. Free tier ≈ 250 req/day — first in the `market` chain for the US indices it covers. Matches only those symbols + only when set. |
| `EODHD_API_KEY` | — (chain falls through to ETF proxy → Yahoo) | [lib/market/providers/eodhd.ts](../../lib/market/providers/eodhd.ts) | EOD Historical Data. REAL global index levels via `{CODE}.INDX` (e.g. `GSPC.INDX`, `NDX.INDX`, `N225.INDX`, **`SET.INDX`** for Thailand). Free tier ≈ 20 req/day — second in the chain; covers Nikkei + SET that FMP's free tier lacks. Matches only mapped index symbols + only when set. |
| `TWELVE_DATA_API_KEY` | — (falls back to keyless Yahoo, which 429s from datacenter IPs) | [lib/market/providers/twelvedata.ts](../../lib/market/providers/twelvedata.ts) | ETF-proxy layer for `market`-sourced series (Markets indicators, FX, stocks). When set, used after FMP/EODHD; maps index symbols to tracking ETFs (SPY/QQQ/DIA/THD/…) since raw index symbols aren't on the free plan, and serves arbitrary US stocks/ETFs (AAPL, VOO). Free tier ≈ 800 req/day, 8 req/min. ACWI stays an ETF; Gold stays XAU/USD. |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | — (chain falls through to keyless Yahoo) | [lib/market/providers/alpaca.ts](../../lib/market/providers/alpaca.ts) | Alpaca daily bars (IEX feed). Keyed fallback for arbitrary US stocks & ETFs, used after Twelve Data and — unlike Yahoo — answers from datacenter IPs. Free tier ≈ 200 req/min, 7+ yr history, no card/KYC (a paper account suffices), and **no "personal use only" clause** (cleanest free terms for a multi-user server). Both vars required; matches only equity-shaped `market` tickers (skips caret indices + FX pairs). Credentials ride the `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers. Note: the free IEX close is exchange-sourced, not the official consolidated print — fine for a rarely-hit fallback on liquid names. Also powers the **most-actives screener** ([lib/market/screener.ts](../../lib/market/screener.ts)) that seeds the US popular-prewarm warm set. |
| `OPENFIGI_API_KEY` | — (anonymous tier: 25 req/min, 10/batch) | [lib/market/figi.ts](../../lib/market/figi.ts) | OpenFIGI key (free, no card — [openfigi.com](https://www.openfigi.com)). Maps a US ticker → its composite **FIGI**, the rename-persistent, MIT-licensed anchor stored on a US holding (`holdings.catalog_figi`) so a renamed ticker (FB→META) still resolves to its current symbol + NAV. Optional: a key lifts the limit to 25 req/6s + 100 symbols/batch, speeding the nightly `us_securities.figi` backfill. Unset ⇒ enrichment still runs (slower); a US holding then anchors on its bare ticker until enriched. Header `X-OPENFIGI-APIKEY`; never logged. |

### One-click broker import

Points the "Connect your broker" feature at a broker. The broker's identity and
API shape live in a **connector manifest** (DATA only — the collector/parser code
stays broker-agnostic in `@macrotide/connector-sdk`), supplied one of three ways below
(checked in order). All unset → the feature hides itself (paste / screenshot
import still work). Authoring guide: [add-a-broker-connector.md](../how-to/add-a-broker-connector.md).

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `BROKER_CONNECTOR_PATH` | unset | [lib/portfolio/connector.ts](../../lib/portfolio/connector.ts) | Path to a local manifest JSON (recommended for self-host), or a **comma-separated list** to run several brokers side by side. Real manifests live gitignored under `.connectors/`; see [.connectors/example.json](../../.connectors/example.json) for the full shape. |
| `BROKER_CONNECTOR_URL` | unset (used only if `…PATH` unset) | [lib/portfolio/connector.ts](../../lib/portfolio/connector.ts) | URL the app fetches the manifest from (shared / published connectors), or a comma-separated list. Cached ~5 min in-memory; data-only, so low-risk. |
| `BROKER_IMPORT_*` | unset (used only if neither above set) | [lib/portfolio/connector.ts](../../lib/portfolio/connector.ts) | Legacy individual vars (`_HOST`, `_PLAN_PATH`, `_HISTORY_PATH`, `_PENDING_PATH`, `_SOURCE_TAG`, `_DISPLAY_NAME`, `_OPEN_URL`, `_LOGIN_URL`) — back-compat for the manifest's endpoint fields; superseded by `BROKER_CONNECTOR_PATH`/`URL`. No `shape` support (defaults only). |

The per-user import token the userscript carries is a stored secret (months of
broker read access), not an env var — it lives in `settings` and rotates on
Disconnect ([lib/db/queries/broker-token.ts](../../lib/db/queries/broker-token.ts)).

### Dev-only

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `CODEX_AUTH_FILE` | OS-default Codex auth path | [lib/ai/codex.local.ts](../../lib/ai/codex.local.ts) | Path to a Codex CLI auth JSON file, used by the local-codex integration during development. Test-only outside of dev. |
| `DEV_ALLOWED_ORIGIN` | unset (localhost only) | [next.config.ts](../../next.config.ts) | One extra origin added to Next's `allowedDevOrigins` so the dev server trusts a non-localhost host (reverse proxy, Codespaces, LAN IP, tunnel). Hostname only, no scheme. No effect on prod builds. |
| `MEMORY_USER_CAP` | `150` | [lib/memory/inject.ts](../../lib/memory/inject.ts) | Max **About you** memories injected into a chat (the hot-set bound). Past it, lowest-priority memories become recall-only. Co-primary with the char budget. |
| `MEMORY_USER_CHAR_BUDGET` | `24000` | [lib/memory/inject.ts](../../lib/memory/inject.ts) | Max characters of injected **About you** memories (cost ceiling). Must be ≥ 1000 (several × the ~600 per-row content cap) — boot throws otherwise. Whichever of cap/budget binds first stops selection. |
| `MEMORY_ADVISOR_CAP` | `30` | [lib/memory/inject.ts](../../lib/memory/inject.ts) | Max **About Advisor** memories injected (generous — these are few + high-value). |
| `MEMORY_CONSOLIDATE_MAX_CHARS` | `32000` | [lib/jobs/consolidate-memory.ts](../../lib/jobs/consolidate-memory.ts) | Char budget (content + detail) for the **holistic** consolidation pass: the sweep hands a whole category to the model at once for the best dedup/contradiction recall, but above this it falls back to lexical-cluster batching to bound the model payload (a genuinely large store). A normal store stays well under it. |

### Framework

| Var | Default | Read by | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` (set by Next.js / build tooling) | [lib/auth/index.ts](../../lib/auth/index.ts) | Gates the `AUTH_SECRET` requirement and cookie `secure` flag. |

## When you change a variable

Update these together, in the same commit — never one without the others:

1. The table above.
2. [.env.example](../../.env.example) (the template).
3. [auth-and-providers.md](./auth-and-providers.md) and/or [deploy.md](../how-to/deploy.md) where they
   reference the specific variable.

This rule is also recorded in the [AGENTS.md doc-stewardship table](../../AGENTS.md#sources-of-truth--what-to-update).
