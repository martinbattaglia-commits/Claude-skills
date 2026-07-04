# Import a portfolio

Use the **Add** modal — one surface that records everything in your portfolio.
There is no holdings-vs-history mode toggle: every row carries its own **Type**,
and both balances and trades write to the same ledger, so they can never
contradict each other — your holdings *are* the replay of these events
([ADR 0004](../explanation/decisions/0004-unified-ledger-positions-derived.md)).

## Row types: Balance vs trade

Each row's **Type** is set per row and auto-detected from what you paste or
import:

- **Balance** — an absolute statement of what you hold *now* (units, optionally an
  average cost, and a current price). The first Balance you record for a fund is
  its **starting balance**; any later Balance for the same fund is a
  **restatement** that re-bases your units. You don't pick which — it's decided by
  what came before, so the labels stay correct even if you delete one. A Balance
  is the natural fit for a broker app that shows your current positions but not
  your trade history.
- **A trade** — a dated buy, sell, dividend, fee, split, or reinvest. Trades are
  the raw material for realized gains, your money-weighted return, and the
  contribution timeline. A buy and a later sell of the same fund are two separate
  events, never merged.

A Balance contributes only the **change** in cost basis (units × average cost)
since your last Balance for that fund — so recording a fresh Balance every few
months captures money you added in between, while a pure price move adds nothing
to your invested total. Average cost is **what you paid**, not today's value;
today's value comes from the live NAV (or, for a custom asset, the current price
you record — see below). For the full model with worked examples and every case,
see [Balances and History](../explanation/balances-and-history.md).

## Intake: paste, screenshot, CSV, or a row

Every intake path feeds the same editable review list. Open a row to edit it
inline before saving:

- **Paste / CSV** — paste rows or drop a CSV/text file. Columns map to date, type,
  symbol, units, price, amount, and fee (by header when present, else
  positionally). Best for a spreadsheet or brokerage export you already have in
  tabular form.
- **Screenshot (image OCR)** — drop one or more screenshots/photos. Each image is
  sent to a vision model via OpenRouter
  ([POST /api/import/image](../reference/api.md)), which returns **structured
  rows** for you to review and edit before anything saves. Best for a statement
  you only have as an image.
- **Add a row** — type a row directly. Best for a handful of positions, or
  correcting an import.

As you type a symbol, the field autocompletes against the **real fund catalog**
(plus the funds you already hold). The catalog is the single authority for
known-fund names, asset class, region, category, TER, and the row's **price
source** badge: a symbol the catalog knows reads as a Thai fund; anything it
doesn't is a **custom** (self-priced) asset. There's no shape guessing and no
hard-coded list — when stocks/ETFs join the catalog they resolve the same way.
Duplicate symbols are de-duped into the existing row for review rather than
creating a second row. To save a Balance you give it **either a unit count or a
฿ value** (the app derives units from the value — see below); average cost stays
optional. For the exact input shapes a Balance or a trade accepts and how each
resolves, see
[What each row accepts](../explanation/balances-and-history.md#what-each-row-accepts--the-input-combinations).

### Units or ฿ Total

The quantity field has a **Units ↔ ฿ Total** switcher. You hold the canonical
**units**, but you can instead type a **฿ total** and the app derives units from
the price on the row's own date — a trade's execution price, a Balance's current
price, or the fund's NAV on that date. This works for a Balance (the ฿ value your
broker app shows) *and* a buy/sell (the ฿ amount you spent or received), so you
never have to hunt down a unit count. The divisor is always a *current* price,
never your average cost (average cost is what you paid; it sets the cost basis,
not the unit count). If there's no price on the row and no NAV on file for its
date, the app keeps the ฿ total: a Balance asks you for a unit count, a
feed-priced fund saves and flags that units are pending (they fill in once its
NAV lands), and a **custom** (self-priced) asset asks for a price — it has no NAV
to derive units from. Cash-only entries are exempt: a dividend or fee needs only
its ฿ amount, and a split needs only its ratio.

### Image OCR details

Most Thai broker apps show a holding's market **value**, not its unit count. When
the value is all the source gives, the importer records a **value-only Balance**:
the row opens showing the ฿ value you recognise, and units are derived from
`value ÷ NAV(date)` at the fold — so you're never shown a long unit count nobody typed.
Average cost is **optional** on these rows (it steps back, muted). If the source also
shows an **invested total** (ยอดเงินลงทุน / มูลค่าต้นทุน) — or a current value plus a
P/L you can subtract — the importer keeps that ฿ total as the **cost fact**; the
per-unit average cost is then *derived* from `cost total ÷ units` at the fold, never
frozen on the row (so it self-corrects with NAV, like units do). It never invents a
per-unit cost by dividing by a NAV-derived unit count. When the source *does* print
the unit count and a per-unit cost (a detail view, say), those are read and shown as
plain facts. It prices each row off the NAV on the snapshot's **own date**
(falling back to the latest NAV), so a statement you import for a past date doesn't
drift against today's price. Upload several screenshots and the rows merge (a later
detail-view shot backfills exact figures over an earlier summary).

Requirements and behavior:

- Needs `OPENROUTER_API_KEY`. Without it the endpoint returns **503** with a
  message pointing you at the key. See [auth-and-providers.md](../reference/auth-and-providers.md).
- Uses a vision model by default (`OCR_MODELS`, `google/gemini-2.5-flash-lite`) with an
  automatic fallback on provider/rate-limit errors. The same model serves every
  user, but the spend is metered: a signed-in non-owner's calls count against the
  same daily usage cap as chat (a `429` when over), and the process-wide OCR
  breaker counts each model call (a detect-then-route import is two). The owner is
  uncapped. Both models are configurable — see the
  [env-var table](../reference/configuration.md#ai--model-selection).
- The screenshot is read once and never stored.

> **A note on data hygiene.** This is a personal investing app. When testing or
> contributing, use placeholder fund codes (`EXAMPLE-FUND-A`), never real ones —
> see [AGENTS.md § Personal data](../../AGENTS.md#personal-data--never-commit).

## Custom assets (no live price)

A holding with no live NAV provider — crypto, a private fund, anything
off-catalog — is a **custom** asset. An unrecognized symbol defaults to custom
rather than assuming a market feed that returns nothing. On a custom asset's
Balance, fill in its **current price**; the app values the holding from the
latest price recorded in its own ledger (a Balance's current price, or a trade's
execution price). If you later edit a custom holding's symbol to one the catalog
tracks, it offers to adopt the official fund details and switch to the live NAV,
keeping your units and cost.

For a holding the catalog *does* recognize, its name, asset class, category,
region, tax wrapper, and TER come from `market.db` at read time and are locked —
only its Portfolio, free-text Source, color, and ledger facts stay editable. If a
custom symbol later appears in the catalog after a refresh, the next read switches
to catalog metadata without copying those facts into `app.db`. If a catalog fund
stops resolving, the holding becomes custom/unresolved again and its stored
metadata is editable.

## History, Position, and editing

The full-screen **History** view reads the whole ledger: recent activity, your
balances grouped under their own header, and KPI cards (Return · Invested ·
Realized · Income). Every row is editable inline with the same grid the Add modal
uses. From a holding's **⋮** menu you can open its **Position** page — that fund's
own analytics, scoped to its events alone — or its **Edit** form. Deleting a fund
lives inside its Edit form, where its destructive effect (removing that fund's
whole ledger) is explicit.

From the ledger, History and Position show:

- **Invested** — the **cost basis of the units you still hold** (what you paid for
  them), so it reflects capital actually still at work, not gross buys. Selling
  removes the sold units' cost, never their proceeds, so realized profit isn't
  double-counted here — it shows separately in **Realized**.
- **Realized gains** on your sells, using **average cost** (FIFO is available);
  the cost basis of sold units is removed proportionally, never by the sale
  proceeds.
- **Money-weighted return (XIRR)** — the rate that accounts for *when* you added
  cash, shown in THB. It appears once there's enough history and a current price
  for everything you still hold; until then you'll see a short "waiting on a
  current price" note rather than a misleading number.
- **A cost-basis-over-time timeline** of what you've put in.

A position with no average cost shows a quiet "add to see gains & return" nudge
rather than a misleading figure.

> Realized-gain and holding-period figures are **for information only — not
> investment advice, and not a tax statement.** Capital gains on Thai mutual-fund
> units are generally tax-exempt for individuals; tax-wrapper holding-period
> rules (SSF / RMF) are policy-dependent.

Why one ledger with positions derived from it? See
[ADR 0004 — unified ledger, positions derived](../explanation/decisions/0004-unified-ledger-positions-derived.md).

## How quotes get attached

Each holding stores a `quote_source` that routes NAV/price lookups to the right
provider: the Thai SEC Open API for Thai mutual funds, the index/FX/stock chain
for stocks/ETFs/indices, and `manual` for a custom asset (priced from the latest
price in its own ledger, not a provider). The user-visible ticker stays bare;
routing lives in a separate column. Details:
[AGENTS.md § Provider routing](../../AGENTS.md#provider-routing-via-holdingsquote_source).
