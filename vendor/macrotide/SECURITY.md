# Security policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/Sitthinut/macrotide/security/advisories/new) — do not file a public issue for security bugs. You should hear back within 72 hours.

## Supported versions

The `main` branch receives all fixes. No semver-versioned releases yet — the project is pre-1.0 and changes are rolling.

## Design principle: secure by default

Macrotide follows the **secure-by-default** principle, one of [Saltzer & Schroeder's 1975 design principles](https://en.wikipedia.org/wiki/Saltzer_and_Schroeder%27s_design_principles): the safe configuration is the default, and you opt *in* to riskier behavior. A fresh checkout with no env vars set should never expose data.

| Setting | Default | Why |
| --- | --- | --- |
| Passkey auth | required | Dashboard refuses to render until a passkey login. Set `AUTH_DISABLED=1` to opt out (local dev only). |
| Demo session | not started | Per-visit opt-in. Each session gets its own in-memory SQLite, swept after 1h idle. |
| OpenRouter key | unset | Chat returns a stub message. A fresh checkout has no API credentials to leak. |
| In-chat image upload (demo) | off | Demo sessions can't attach chat images unless `DEMO_VISION` is set. Owner/free use `VISION_CHAT_MODELS`; set it to `off` to disable inline chat vision entirely. |
| Bind address | `0.0.0.0:3000` (Next.js dev default) | ⚠ Anyone on your LAN can hit dev. Use `next dev -H 127.0.0.1` for solo dev. |
| Owner DB | `data/app.db`, unencrypted | SQLite file. Use disk encryption + filesystem permissions on a shared host. |

## Threat model

### We defend against

- **Anonymous network visitors reading the owner's portfolio.** Passkey auth blocks the dashboard. Unauthenticated requests get bounced to `/login`.
- **Anonymous access to the JSON API (deny-by-default).** The API layer is fail-closed, not just the UI: every data route runs inside `withDb` (`lib/api/with-db.ts`), which rejects an anonymous request (no session, no demo cookie) with `401` instead of serving the shared `user_id IS NULL` row set. The few intentionally-public routes are the explicit, in-code allowlist — they don't go through `withDb` (`/api/auth/*`, `/api/auth-config`, `/api/demo`, `/api/chat/capabilities`) or opt in with `withDb(fn, { public: true })`. Routes with no DB access that still spend resources can gate with `requireApiSession()`. Admin/operator routes are stricter still — owner-only via `requireOwner()` / `getOwnerStatus()` (e.g. `/api/admin/*`). `AUTH_DISABLED=1` (single-owner local dev) bypasses all of this.
- **Cross-session leakage in demo mode.** Each demo session is its own in-memory SQLite, keyed by cookie, swept after 1h idle.
- **Brute-force on `/api/chat`.** IP-based rate limit, 20 req/min (per-IP, in-memory).
- **Demo abuse.** 10 chat turns per session cap, separate AI provider key supported so demo can't burn owner quota.
- **Common web vulns at framework level.** Next.js handles CSRF for App Router server actions, React escapes output by default, biome-lint flags `dangerouslySetInnerHTML` usage.
- **Untrusted model output rendered as Markdown.** Advisor replies are rendered with `react-markdown` (+ `remark-gfm`) with no raw-HTML passthrough (no `rehype-raw`, no `dangerouslySetInnerHTML`) and react-markdown's `urlTransform` strips unsafe link protocols (`javascript:`, `data:`, …). So a model (or an image a user pastes that contains adversarial text) can't inject active content into the chat. User-typed text stays plain (never parsed as Markup).
- **Pre-registration account-takeover (and email-squatting) via OAuth linking.** An attacker can't get a victim's Google sign-in merged into an account the attacker pre-created at the victim's email — because **no signup path lets anyone claim an email they haven't proven.** Passkey signup is emailless (the account gets a synthetic, non-deliverable `@passkey.invalid` placeholder), and OAuth signup must prove the address with the provider. So there is no attacker-controllable, email-bearing account for the victim's identity to merge into; the takeover *and* the squat are structurally impossible. Linking is explicit and session-scoped (`linkSocial` links into the caller's own account); implicit sign-in linking only merges onto an already-verified account from a provider asserting a verified email (no `trustedProviders` bypass; better-auth's `requireLocalEmailVerified` blocks merges onto unverified rows). A refused sign-in dead-ends with friendly copy — never a shared account. Rationale and the rules that keep it true: [ADR 0001](./docs/explanation/decisions/0001-account-model-passkey-and-oauth.md).

### We do NOT defend against

- **Shell access to the host.** Anyone who can read `data/app.db` can read all portfolios. SQLite is unencrypted. Mitigate with disk encryption and filesystem permissions (`chmod 600`).
- **Compromised passkey device.** Possessing a passkey === being the user. Lose your laptop without a screen lock, lose access. Register passkeys on multiple devices as a recovery path.
- **OpenRouter side.** Portfolio context is sent to OpenRouter for chat. If their infra is compromised, that data is exposed. Don't chat about info you wouldn't share with a cloud LLM. **This includes images you attach in chat** — they're sent to the configured vision provider (`VISION_CHAT_MODELS`) to answer the turn. Macrotide does **not** store attached images on the server: the saved chat message keeps only the raw text you typed plus structured **filename/timestamp metadata** (no bytes), and the images themselves are cached **only in your browser** (localStorage, size-bounded, evicted oldest-first) so you can still see them within the session. Clearing site data removes them; they never reach `data/app.db`.
- **Multi-tenant isolation at the DB level.** There is no row-level security — multi-user mode trusts the auth layer to attribute writes correctly. Audit before deploying to >10 users; consider a dedicated DB per user instead.
- **Side-channel attacks on auth.** No timing-attack hardening on top of better-auth's internals. We don't add a custom layer.
- **Supply-chain attacks on dependencies.** No SBOM, no signed releases yet. `npm audit` is your friend; Dependabot is on the roadmap.
- **Sophisticated brute-force on `/api/auth/*`.** Auth POSTs are now IP-rate-limited at the app layer (`AUTH_RATE_LIMIT`, 10/min/IP, wired in `app/api/auth/[...all]/route.ts`), but the limiter is in-memory and per-instance. Still front the app with Caddy/Cloudflare/fail2ban for distributed attacks and multi-instance deploys.

## Reporting near-misses

If you tried something that *almost* worked — a misconfiguration that nearly exposed data, a path that *should* have been auth-gated — please report it the same way. Near-misses are how we tighten the defaults further.
