# Getting started

This tutorial takes you from a fresh clone to a running app, a quick tour of
the demo, your first holding, and your first chat with the Advisor. It should
take about ten minutes. No prior knowledge of the codebase is assumed.

## Prerequisites

- **Node.js ≥ 20** (the deploy target uses Node 24; any ≥ 20 works for dev).
  Check with `node --version`.
- **git**, and a terminal.
- Optional, for real AI chat: an [OpenRouter](https://openrouter.ai/) API key.
  Without one, chat still works but returns a friendly stub message.

## 1. Clone and install

```bash
git clone <repo-url> macrotide
cd macrotide
npm install
```

## 2. Run it

```bash
npm run dev
```

Open <http://localhost:3000>. A fresh boot bounces you to `/login` — auth is
**required by default** (this is deliberate; see
[design principles](../explanation/design-principles.md)).

You now have two ways forward.

## 3a. The fastest tour — try the demo

On `/login`, click **Try the demo**. This spins up a private, in-memory SQLite
seeded with realistic mock data — its own isolated world that vanishes when the
session ends. Nothing you do in the demo touches real data.

Take a moment to click through the screens in the navigation:

| Screen | What it shows |
|---|---|
| **Portfolio** | Your holdings, allocation, fees, and plain-language health checks |
| **Markets** | SET and global index movements, market news |
| **Explore** | The fund finder — search the SEC catalog by name, index, theme, or fee |
| **Advisor** | Chat with structured access to your portfolio, plan, and journal |
| **Journal** | Notes, decisions, and reading you've logged |
| **Models** | Built-in model portfolios you can compare against |
| **Connect** | Importing holdings (CSV / image / manual) |
| **Settings** | Theme, memory, account |

Demo chat is capped at 10 turns, so it can't run up an AI bill.

## 3b. Run as the owner (your own persistent data)

For solo local development you usually want your own data to persist in
`data/app.db` and to skip the login screen. Copy the env template and set the
dev opt-out:

```bash
cp .env.example .env.local
```

In `.env.local`, set:

```sh
AUTH_DISABLED=1            # skip the passkey gate — trusted local dev only
# OPENROUTER_API_KEY=sk-or-...   # optional, for real AI chat
```

> ⚠️ Only set `AUTH_DISABLED` when you control the bind address. `next dev`
> listens on `0.0.0.0`, so anyone on your LAN could reach it. Use
> `next dev -H 127.0.0.1` on an untrusted network. See [auth-and-providers.md](../reference/auth-and-providers.md).

Restart `npm run dev`. You'll land straight on the dashboard. To start from
realistic data instead of an empty app, seed it:

```bash
npm run db:seed
```

## 4. Add your first holding

Use the Portfolio screen's add button to open the **Add** modal — one surface for
everything you record. Add a row, set its **Type** to **Balance**, and enter a
ticker, the number of units, and your average cost. The Portfolio screen updates
immediately: allocation, blended fees, and the health checks all recompute from
your real numbers. The same modal logs a buy/sell history instead — just set a
row's Type to a trade — and the **History** view (from a holding's **⋮** menu)
lets you edit any entry later. Your holdings are just a projection of that ledger;
see [Balances and History](../explanation/balances-and-history.md) for how the two
fit together.

> Use placeholder fund codes while learning — never commit real ones. See the
> personal-data rule in [AGENTS.md](../../AGENTS.md#personal-data--never-commit).

## 5. Chat with the Advisor

Open **Advisor** and ask something like *"How concentrated is my portfolio?"* The
Advisor can read your portfolio, plan, and journal, propose plan edits as cards
you accept or reject, and remember durable facts you tell it across chats.

- With `OPENROUTER_API_KEY` set, you get real model responses.
- Without it, you get a clearly-labeled stub so the UI is still explorable.

Tell it something durable — *"remember I only invest in funds, not individual
stocks"* — and it saves that to memory, visible under **Journal → Memory**.
See the [memory feature guide](../explanation/memory.md) for how that works.

## Where to go next

- **Build on it:** [Local development](../how-to/local-development.md) — scripts,
  seeding, tests, and the pre-commit hook.
- **Load real data:** [Import a portfolio](../how-to/import-a-portfolio.md).
- **Understand it:** [Architecture](../explanation/architecture.md).
- **Ship it:** [deploy.md](../how-to/deploy.md).
