# Authentication & AI providers

Reference for how sign-in and the AI provider work. For the *why*
(secure-by-default), see [design principles](../explanation/design-principles.md)
and [SECURITY.md](../../SECURITY.md). To *set it up*, see
[local development](../how-to/local-development.md) (dev) and
[deploy](../how-to/deploy.md) (shared deployment). Every env var named below is
defined in the canonical
[configuration.md § Environment variables](./configuration.md#environment-variables) table.

## Defaults

| Toggle | Env var | Default | Effect |
| --- | --- | --- | --- |
| Passkey auth | `AUTH_DISABLED=1` to opt out | required | Bounces visitors to `/login` until a passkey login. |
| Demo button | (always on) | available | Anyone can spin up an isolated in-memory SQLite, capped at 10 chat turns. |
| AI key | `OPENROUTER_API_KEY` | unset | Without it, chat returns a friendly stub message; rest of the app works. |

## Sign-in methods

Passkeys and OAuth are **peer** methods — a user signs up with either and can add
the other later. The `/login` screen shows:

- **Continue with Google** — env-gated (hidden unless its keys are set). Creates
  a verified account for new users, or signs in returning ones.
- **Continue with passkey** — sign in with a passkey on this device.
- **Create account** (a quiet text link) — registers a passkey. Collects **only a
  name** (no email), guarded by a **Turnstile** gate when configured.
- **Try the demo** — spins an isolated, in-memory SQLite with capped chat.

Setup commands live in [local development](../how-to/local-development.md) and
[deploy](../how-to/deploy.md).

### Emailless passkey accounts

A passkey signup claims **no email**. Because better-auth's `user` row needs a
unique address, the account is minted with a synthetic, non-deliverable
placeholder (`<uuid>@passkey.invalid`) that is never shown in the UI. If the
account later links an OAuth provider, the provider's verified email is **adopted**
onto the row (and `emailVerified` set), so it becomes a fully-identified account.
This is what makes account-takeover and email-squatting impossible: no signup
path ever lets someone claim an address they haven't proven. Full rationale:
[ADR 0001](../explanation/decisions/0001-account-model-passkey-and-oauth.md).

### Adding / changing methods (Account settings)

- **Edit your name** inline from the Profile card.
- **passkey → add OAuth:** Account → **Link** a provider. The account email then
  mirrors that provider's verified address.
- **OAuth → add passkey:** the post-sign-in prompt (shown once, only if you have
  no passkey yet), or Account → register a passkey.
- **Unlink / revoke:** providers and passkeys can be removed, but at least one
  *usable* sign-in method is always kept (you can't revoke your last passkey or
  unlink your last provider if it would lock you out — enforced in the UI *and*
  server-side). Unlinking your **last** provider clears the account email back to
  emailless. A removed passkey can't sign in again — its server credential is gone.
- **Ended up with two accounts** (signed up separately with each method)? They
  don't auto-merge; add a passkey to the OAuth account and abandon the spare.
  (Deleting the spare account is [planned](https://github.com/Sitthinut/macrotide/issues/105).)

### Linking & takeover hardening

- Linking is **explicit and session-scoped**: `authClient.linkSocial()` links a
  provider into the *caller's own* account — never a match-by-email merge into a
  stranger's.
- Implicit (sign-in) linking is guarded so it only ever merges onto an
  **already-verified** account, and only from a provider that asserts a verified
  email — no `trustedProviders` bypass, and better-auth's
  `requireLocalEmailVerified` blocks any merge onto an unverified row. Passkey
  accounts, with their placeholder email, match nothing and can't be touched
  implicitly. (With Google the only provider, this is the takeover guard on a
  Google sign-in that matches an existing account.)
- A social sign-in that *can't* be linked dead-ends to `/login?error=…` with
  friendly copy, never a shared account.

### How passkeys work here

- Created via `@better-auth/passkey` plugin (WebAuthn / Web Credentials API).
- One device = one passkey. To use the app on phone + laptop, register from each device (or sync via iCloud Keychain / 1Password).
- Stored as a `passkey` row in the same SQLite as app data, with `publicKey` + `credentialID` + `counter` columns. We never see the private key — it lives on the device's secure enclave.
- Email/password exists only as a hidden bootstrap: passkey signup creates the `user` row via it with a random, unknowable password and no password sign-in UI, then registers the passkey. It's never a usable login. Magic-link email is on the roadmap (needs a transactional sender).

## AI provider — OpenRouter

`/api/chat` resolves the model based on whether the request carries a demo cookie:

```text
                    demo cookie?
                  /              \
                yes               no
                 |                 |
   resolveDemoProvider()   resolveOwnerProvider()
   DEMO_OPENROUTER_API_KEY OPENROUTER_API_KEY
   defaults: openrouter/free   defaults: openrouter/auto
   capped at 10 turns      no cap, IP-rate-limited
```

### Why one provider

OpenRouter proxies every major model behind one API:

- Anthropic Claude · OpenAI GPT · Google Gemini · Meta Llama · Mistral · DeepSeek · Qwen · ...
- One key, one billing surface, one set of telemetry.
- Zero-cost router (`openrouter/free`) covers demo use without billing.
- Pay per-token credit; load up via the OpenRouter dashboard.

If you want a specific model, set `TRUSTED_TIER_MODELS` to any id from [openrouter.ai/models](https://openrouter.ai/models). It's a comma-separated fallback chain — the first model is tried first, and the next one is used if the previous fails. The default `openrouter/auto` lets OpenRouter pick the best model per prompt. `TRUSTED_TIER_MODELS` also serves `tier='trusted'` users.

### Tier model selection + spend caps

A `tier='public'` user's chat model comes from its **own** `PUBLIC_TIER_MODELS` var
(default `openrouter/free`), never from `TRUSTED_TIER_MODELS` — so a trusted-chain change
can't widen public access. To lift public-tier quality, point it at a cheap paid
model:

```sh
PUBLIC_TIER_MODELS=google/gemini-2.5-flash
```

Public-tier spend is bounded by two caps, checked before each request (either
tripping blocks the turn, both reset at UTC midnight):

- **Token cap** — `DAILY_TOKEN_BUDGET_PUBLIC` (default 20k tokens/day). Always on.
- **Cost cap** — `DAILY_CENTS_BUDGET_PUBLIC` (US cents/day). **Off unless set**; the
  right bound for a paid model with asymmetric in/out pricing. The per-turn cost
  estimate reads `MODEL_PRICES` (USD/Mtok), so set that to match `PUBLIC_TIER_MODELS`.

Owner / `AUTH_DISABLED` mode is never metered. Full var table:
[configuration.md § Quotas + tier gating](./configuration.md#quotas--tier-gating).

### Account-level spend guard

The per-user caps above bound a single user. A separate, server-run probe
([`scripts/check-openrouter-budget.ts`](../../scripts/check-openrouter-budget.ts))
watches the **whole account's** OpenRouter spend against the key's monthly limit —
read live from `GET /api/v1/key`, so the cap lives only in the OpenRouter dashboard
and never drifts into the repo. It warns as spend nears the limit, before the 403
that would otherwise break all chat with no warning. Set the key's monthly limit in
the OpenRouter dashboard; spend thresholds are CLI flags on the server job. The
read is retried on a transient hiccup so a momentary blip doesn't false-alarm. An
optional `OPENROUTER_BUDGET_HEARTBEAT_URL` does double duty: on a warn or critical
reading the probe POSTs a one-line spend summary to the URL's `/fail` sub-path so
the monitor raises a threshold alert, and on healthy/warn it pings the base URL as
a dead-man liveness signal. It withholds the ping on critical and indeterminate, so
a critical alert stays a sustained incident and a persistently unreadable API
surfaces via the dead-man. The job unit + monitor wiring are server-side ops.

### In-chat vision

On an image-bearing chat turn the chat driver stays on the turn (it can't see
pixels) and reads the image by calling the Advisor's `examine_image` tool, which
runs its **own** `VISION_CHAT_MODELS` (default
`google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite`), not the text
chains — for the same reason `PUBLIC_TIER_MODELS` is separate: public-tier vision
derives from a dedicated var and can't widen `TRUSTED_TIER_MODELS`/`PUBLIC_TIER_MODELS`.
Owner, trusted, and public all use it; public-tier image turns stay bounded by the
same daily token + optional cents caps above. A chart/factsheet the user is
reasoning about can escalate to a stronger `VISION_CHAT_ESCALATE_MODELS` (owner/
trusted only, unset by default). Set `VISION_CHAT_MODELS=off` to
disable inline chat vision entirely (image turns then get a stub pointing at the
Add-holdings importer). Demo image upload is **off** unless `DEMO_VISION` is set,
and when on uses the demo key, bounded by the 10-turn demo cap. Attached images
are sent to the vision provider to answer the turn and cached only in the user's
browser for the session — never stored on the server (see [SECURITY.md](../../SECURITY.md)).

The public, demo, and ancillary (title/extract) paths also send
`reasoning: { effort: "none" }` so a reasoning-capable model the router picks
doesn't spend hidden chain-of-thought (billed at the output rate, ~8–29s/turn
vs ~2s) on a turn that doesn't need it. Owner/trusted keep their model-default
reasoning. Rationale + the when-to-reason policy:
[inference-strategy.md § Reasoning-token policy](../explanation/inference-strategy.md).

### Demo provider isolation

Demo chat is routed through `DEMO_OPENROUTER_API_KEY`. If unset, it falls back to `OPENROUTER_API_KEY` — that's fine when paired with the `openrouter/free` default model (zero-cost, no billing impact). For stricter isolation, create a second OpenRouter account with prepaid limits and use a separate key.

The `openrouter/free` router picks among ~25 free-tier models per request (volunteer GPUs; subject to OpenRouter's rate limits). For a pinned free model:

```sh
DEMO_TIER_MODELS=meta-llama/llama-3.3-70b-instruct:free
```

## Market data providers (indices / FX / stocks)

Markets-screen indicators and any `market`-sourced holding resolve through a
provider chain, tried preferred → fallback. Each provider only matches the
symbols it actually serves, and the keyed ones **drop out of the chain entirely
when their env var is unset** — so the app degrades gracefully from real index
levels → ETF proxy → keyless Yahoo with no config:

```text
FMP (keyed, REAL US indices)
  → EODHD (keyed, REAL global indices + Thai SET)
    → Twelve Data (keyed, ETF proxies)
      → Frankfurter (keyless, FX only)
        → Yahoo (keyless)
```

| Provider | Env var | Free tier | Serves |
| --- | --- | --- | --- |
| FMP (Financial Modeling Prep) | `FMP_API_KEY` | ≈ 250 req/day | REAL US index levels — `^GSPC` (S&P 500), `^NDX` (Nasdaq-100), `^DJI` (Dow) |
| EODHD (EOD Historical Data) | `EODHD_API_KEY` | ≈ 20 req/day | REAL global index levels via `{CODE}.INDX` — incl. Nikkei (`N225.INDX`) and the Thai SET (`SET.INDX`) that FMP's free tier lacks |
| Twelve Data | `TWELVE_DATA_API_KEY` | ≈ 800 req/day | ETF proxies (SPY/QQQ/DIA/THD/…) for index symbols not on a free real-index plan, **and** arbitrary US stocks/ETFs (AAPL, VOO) |
| Alpaca | `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | ≈ 200 req/min | keyed fallback for arbitrary US stocks/ETFs (IEX daily bars, 7+ yr); datacenter-safe, no card/KYC, no personal-use clause; used after Twelve Data. Equity-shaped tickers only (skips caret indices + FX pairs) |
| OpenFIGI | `OPENFIGI_API_KEY` (optional) | 25/min anon, 25/6s keyed | ticker → composite **FIGI** (rename-persistent US security id, MIT-licensed). Anchors a US holding so a renamed ticker still resolves; enriches `us_securities.figi` nightly. Works keyless |
| Frankfurter | (none) | unmetered | FX only (USD/THB), ECB-backed; works with no key and no datacenter-IP block |
| Yahoo | (none) | — | keyless fallback; hard-429s datacenter IPs, hence the keyed providers above |

With **no keys** the chain is exactly Frankfurter (FX) → Yahoo; with **only**
Twelve Data set you get the prior ETF-proxy behaviour. MSCI ACWI has no free
real-index source and intentionally stays an ETF proxy (`ACWI`); gold stays the
`XAU/USD` spot commodity, not an index. Every var above is defined in the
canonical [configuration.md § Environment variables](./configuration.md#environment-variables)
table.

The same Frankfurter FX series doubles as the conversion source for the
portfolio value/return chart: a holding's native currency is inferred from its
routing key ([lib/market/currency.ts](../../lib/market/currency.ts)) and its
value is converted to the base currency (THB) at each date's USD/THB — or cross
— rate ([lib/market/fx.ts](../../lib/market/fx.ts)) before holdings in different
currencies are summed.

### Benchmark total-return series (`benchmark_tr`)

Portfolio-vs-benchmark comparison reads a separate **total-return** chain under
its own source value, `benchmark_tr` — deliberately *not* in `QUOTE_SOURCES`, so
it can never become a holdable asset class. It only namespaces the cache rows
(`benchmark_tr:ACWI`) and routes one provider:

| Provider | Env var | Free tier | Serves |
| --- | --- | --- | --- |
| Twelve Data (adjusted) | `TWELVE_DATA_API_KEY` | ≈ 800 req/day | Tracking-ETF **adjusted close** via `adjust=all` (dividends + splits) — the total-return proxy, ~20y deep (5000 daily points back to ~2006) |

It is the **sole** `benchmark_tr` provider: EODHD's `adjusted_close` works but its
free tier caps history at ~1 year (a shallow series the depth-aware cache would
wrongly record as `max`), and keyless Yahoo 429s the datacenter IP — neither is a
usable fallback for a *deep* backfill. With no Twelve Data key the chain is empty
and `getCachedSeries` fails cleanly rather than caching a shallow series. The
curated proxy set (global / US / developed-ex-US / EM, plus a Thai proxy) lives in
[lib/market/benchmark-options.ts](../../lib/market/benchmark-options.ts) and is
warmed by `jobs:prewarm-benchmark`. All proxies are USD ETFs, so consumers compare
on **% return** (rebased), never absolute level.

### Cache freshness

`getCachedSeries` ([lib/market/cache.ts](../../lib/market/cache.ts)) serves a
symbol's daily series and its latest quote from `data/market.db` for a 24h TTL
(`CACHE_TTL_MS`), refetching at most once a day.

The daily window follows from the provider quotas above rather than from how
often prices move. EODHD allows ~20 calls/day and FMP ~250/day, and the keyless
Yahoo fallback returns 429 from the datacenter prod IP. At ~1 fetch/day per symbol
the 24h window stays within quota; a 5-minute TTL (~288/day per symbol) would
exceed EODHD's and FMP's limits and fall back to the rate-limited Yahoo. So a
shorter quote TTL — and SWR `refreshInterval` polling on top of it — depends on a
higher-quota or unblocked provider, not on the TTL alone. (An earlier 5-minute
`QUOTE_TTL_MS` sat `void`-suppressed in the cache and read like dead code; it was
removed and its intent folded into the comment on `CACHE_TTL_MS`.)

A failed upstream is negatively cached for 3 min (`FAIL_BACKOFF_MS`) and the last
good value is served stale rather than blanked.

## Rate limiting

`/api/chat` is IP-rate-limited at **20 requests/minute** regardless of demo / owner status. Demo sessions add a **10-turn-per-session** cap on top. Both are in-memory; replace with Upstash/Redis when you go multi-instance.

## Where the data lives

| Item | Storage |
| --- | --- |
| Owner user/session/passkey | `data/app.db` (better-auth tables) |
| Owner portfolio/journal/etc | `data/app.db` (app tables) |
| Fund catalog/fees + NAV/quote cache | `data/market.db` (regenerable; not backed up) |
| Demo session data | In-memory app.db, keyed by demo cookie, swept after 1h idle; reads the shared real market.db |
| AI / provider keys | `.env.local` (never committed; gitignored) |

To wipe demo state across the whole server, restart the process. To wipe the owner DB, delete `data/app.db` (back it up first — there's a daily auto-backup at `data/backups/`).
