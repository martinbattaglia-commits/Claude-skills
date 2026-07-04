# Local development

A practical reference for the day-to-day dev loop. If you haven't run the app
yet, do the [Getting started tutorial](../tutorials/getting-started.md) first.

## Environment

```bash
cp .env.example .env.local
```

Minimum for a frictionless solo loop:

```sh
AUTH_DISABLED=1          # skip the passkey gate (trusted local dev only)
OPENROUTER_API_KEY=...   # optional — real AI chat instead of a stub
```

The authoritative list of every variable the app reads — defaults, behavior,
and the code that reads each one — is the env-var table in
[configuration.md](../reference/configuration.md#environment-variables).
`.env.example` is a thin template; that table is the single source of truth.

## npm scripts

| Script | Does |
|---|---|
| `npm run dev` | Dev server with hot reload at `:3000` |
| `npm run build` | Production build (also typechecks everything) |
| `npm run start` | Serve a production build |
| `npm run lint` | Biome check |
| `npm run format` | Biome check `--write` (auto-fix) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (run once) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run db:seed` | Seed `data/app.db` with mock data |
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:drop:app` / `db:drop:market` | Drop a migration (dev: prefer drop + reseed over editing past migrations) |
| `npm run db:studio:app` / `db:studio:market` | Drizzle Studio — browse app.db or market.db |
| `npm run jobs:close-stale` | Run the stale-session close job (e.g. `-- --dry-run`) |
| `npm run smoke:sec -- <FUND-CODE>` | Smoke-test the Thai SEC provider (needs `SEC_API_KEY`) |
| `npm run market:refresh` | POST the local admin market-refresh endpoint |

## Database

- SQLite via Drizzle ORM. The schema is [lib/db/schema/](../../lib/db/schema)
  (split into `app.ts` + `market.ts`); migrations run automatically on boot.
- App data lives in `data/app.db` (override with `DB_PATH`); regenerable market
  data lives in `data/market.db` (override with `MARKET_DB_PATH`). Both gitignored,
  along with the daily backups under `data/backups/`.
- To start clean: stop the server, delete `data/app.db`, restart, then
  `npm run db:seed`.
- Demo sessions use a separate per-session **in-memory** SQLite — never the file
  on disk. See [architecture](../explanation/architecture.md#owner-vs-demo-databases).

> Adding a column to an app table? Most app tables will gain a `user_id` as
> multi-user matures — design with that in mind (see
> [AGENTS.md § Migrations](../../AGENTS.md#migrations-drizzle)).

## Tests

[Vitest](https://vitest.dev/). Tests live next to the code they cover
(`*.test.ts`) plus a few integration tests under `tests/`. Run `npm test` (or
`npm run test:watch` while iterating). CI runs typecheck + lint + build on
every push.

## Pre-commit hook

`simple-git-hooks` + `lint-staged` run Biome on staged files before each commit.
**Never** commit with `--no-verify` — if the hook fails, fix the issue. The
hook is installed by `npm install` (via the `prepare` script).

## Where things live

For the "where do I put X?" question — editorial content, pure helpers, user
state, mock seeds, shared types — see the table in
[AGENTS.md § Where things live](../../AGENTS.md#where-things-live)
and the layer map in [architecture](../explanation/architecture.md#where-it-lives).

## Before you change code

If you're an AI agent, read [AGENTS.md](../../AGENTS.md) in full — it covers the
non-obvious rules: the `withDb` requirement on every route that queries, the
streaming-callback context re-entry, the `server-only` boundary, the
`quote_source` provider routing, and the product-copy vocabulary.
