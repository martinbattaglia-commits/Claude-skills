# Balances and History

*Last updated: 2026-06-06*

How the two ways of recording a portfolio — stating a **Balance** and logging a
**trade** — fit together, and exactly what the app does with each. This is the
mental model behind the **Add** modal, the **History** view, and a fund's
**Position** page. For *why* it's built as one ledger with positions derived, see
[ADR 0004](./decisions/0004-unified-ledger-positions-derived.md); for the
click-by-click task, see [Import a portfolio](../how-to/import-a-portfolio.md).

## Vocabulary

One set of words, used everywhere:

| Term | Means |
|---|---|
| **History** | The chronological log of everything you've recorded. |
| **entry** | One row in History — either a Balance or a trade. |
| **Balance** | An *absolute* statement: "as of this date I hold N units, at this average cost." |
| **trade** | A *relative* event: a dated buy, sell, dividend, fee, split, or reinvest. |
| **Position** | A single fund's rollup — its units, cost, gains, and return, derived from its own entries. |

Internally the ledger table is `transactions`, but that word stays out of the UI:
a Balance is a position assertion, not a transaction.

## The model in one breath

There is **one ledger**. Every entry — balances and trades alike — is an event in
it. Your holdings are not stored; they are the **replay** of that ledger. Because
both kinds of entry write to the same place, they can never contradict each other,
and there is no holdings-vs-history toggle to keep in sync. Delete an entry and the
position recomputes from what's left. (The why, and the alternatives rejected, are
in [ADR 0004](./decisions/0004-unified-ledger-positions-derived.md).)

## The rules that hold everywhere

A few rules fall out of "one ledger, positions derived" and hold for every fund,
balance and trade alike. (Why the model is built this way, and the alternatives
rejected, are in [ADR 0004](./decisions/0004-unified-ledger-positions-derived.md);
these are how it *behaves* — kept current here.)

- **The ledger stores only facts; the missing unit count is derived at the fold.**
  Each entry keeps the **money fact** you actually gave — a *unit count*, a
  Balance's *value*, or a trade's *amount* — and nothing else:

  | You gave | Stored fact | Derived at the fold |
  |---|---|---|
  | a unit count | `units` | — |
  | a value-only Balance | `value` | `units = value ÷ NAV(date)` |
  | an amount-only trade | `amount` | `units = amount ÷ NAV(date)` |
  | a units-only trade | `units` | `amount = units × NAV(date)` |
  | a Balance's invested ฿ total | `amount` (the cost) | `average cost = cost total ÷ units` |

  A derived unit count is **never frozen into the record** — it's derived afresh
  from the stored fact ÷ the NAV on that date every time your position is read (the
  *fold*: replaying the ledger into positions). So if that date's NAV arrives late
  or is later corrected, your units — and the value, gains, and return that flow
  from them — recompute to match, with no re-entry. The same holds for **cost**: a
  value-only Balance stores the invested ฿ *total* you gave (a fact); the *per-unit*
  average cost is derived from that total ÷ the derived units at the fold — we never
  invent a per-unit cost by dividing by a NAV-derived unit count and freezing it. The
  source of truth never holds a number that regenerable market data could change out
  from under it.
- **Holdings are derived on read, never a second source you edit.** Your position
  is folded from the ledger **every time it's read** — the holdings list, the
  History and Position analytics, the Advisor's view all re-derive units and cost
  from the live NAV, so every surface is fresh to the latest price and they can't
  disagree. You never type a holding's units or average cost directly; you record a
  ledger entry and the position recomputes. (A holdings row still exists for
  portfolio/source/color and custom-asset metadata; it stores **no** units or
  average cost at all, so there's nothing derived to go stale.)
- **Catalog facts come from the catalog.** When a ticker resolves in
  `market.db`'s fund catalog, the app reads its name, asset class, region,
  category, and TER from that catalog on every read. Those fields are locked in
  the holding editor and stale values in `app.db.holdings` are ignored. If the
  symbol is not in the catalog, it is a custom/unresolved holding: its metadata is
  editable and missing asset class stays unknown rather than being guessed as
  stocks.
- **Cost and market value stay orthogonal.** Average cost only moves when you buy
  or sell; current value comes from the live NAV (or a custom asset's recorded
  price). Because the market can't touch your average cost, a value-only
  restatement and graceful degradation (held, but cost unknown) both fall out for
  free — neither can corrupt the other.
- **Money-weighted return counts only real cash flows.** Whether an entry enters
  the return is decided by its kind: a buy, a sell, a cash dividend, and a *costed*
  starting balance are external cash flows; a restatement, a split, a reinvested
  dividend, and an uncosted balance / transfer-in move no outside money and are
  excluded. Letting a restatement count would corrupt the return.

## Two ways to record — pick what your source gives you

People hold portfolios in different shapes, so the app accepts both and lets you
mix them per fund:

- **Track forward from a Balance.** Your broker app shows what you hold *right
  now* — units and an average cost — but not the trades that got you there. State
  that as a Balance and the app tracks forward from it. Record it again each
  quarter — a new Balance for the same fund — and the app keeps up. This is the
  common case for Thai broker/fund apps.
- **Log every trade.** You have the actual buy/sell history. Log the trades and
  the app builds the position up from zero — giving you realized gains, a
  money-weighted return, and a contribution timeline that the balance-only path
  can't fully reconstruct.
- **Mix.** State an opening Balance to start from where you are today, then log
  trades from here on. The Balance anchors the position; trades move it forward.

## What a Balance means

A Balance asserts three things on a date: **units**, an optional **average cost**,
and an optional **current price**. The distinction that trips people up:

> **Average cost is what you _paid_. It is not today's value.**

Today's value comes from the live NAV (or, for a custom asset, the current price
you record). Average cost only moves when you **buy or sell** — never when the
market moves. That single fact is the engine behind everything below: because the
market can't change your average cost, `units × average cost` (your **cost basis**)
is the money you actually put in, immune to price swings.

The first Balance you record for a fund is its **starting balance**; any later
Balance for the same fund is a **restatement**. You never choose which — it's
decided by what came before (see [Self-healing](#editing-and-deleting-self-healing)),
so the labels stay correct even if you delete one.

### State a value, not a unit count

Most broker apps show what a holding is *worth* — its **฿ value** — not how many
units you hold. So a Balance lets you state the value and **derives the units for
you**: `units = value ÷ NAV`. In the quantity field, tap **Total** and type the ฿
figure your app shows; you never have to hunt down a unit count. Average cost is
still what you paid (optional, entered separately) — the value only sets *how many
units* the money represents.

The NAV it divides by is the one on the **Balance's own date**, not today's. A
holding's unit count is fixed to its date, so a value you record for last quarter
divides by last quarter's NAV — pairing it with today's moving NAV would make the
unit count drift. A Balance dated *today* divides by the latest NAV, which is the
same rule. If a fund has no NAV on file for that date and you've given neither a
unit count nor a current price, the app asks you for a unit count rather than
guessing one.

## How a Balance is counted

A Balance contributes only the **change** in cost basis since your last Balance for
that fund — `new basis − prior basis` — to your invested total. A starting balance
has no prior, so it contributes its full basis. This one rule covers every case:

Recording a later Balance each quarter — the fields a broker app shows you:

| Period | Units | Avg cost | Value | Cost basis (units × avg) | What happened |
|---|---|---|---|---|---|
| Q1 | 100 | ฿10 | ฿1,000 | ฿1,000 | start → invested ฿1,000 |
| Q2 (market only) | 100 | ฿10 | ฿1,150 | ฿1,000 | Δbasis 0 → ฿0 added; gain = 1,150 − 1,000 = ฿150 |
| Q2 (added money) | 130 | ฿10.5 | ฿1,400 | ฿1,365 | Δbasis +365 → put in ฿365; gain = 1,400 − 1,365 = ฿35 |

The avg cost ticking ฿10 → ฿10.5 is the tell: the market can't do that — only a
purchase can. So the app reads the ฿365 as money you added, not a price move.

The math, every entry:

```
cost basis  = units × avg cost
invested   += (new basis − prior basis)    ← the period's net contribution
gain        = current value − cost basis    ← value comes from the live NAV
```

### Every case at a glance

| You record… | What the app does |
|---|---|
| **First Balance, with avg cost** | Starting balance; invested = units × avg cost |
| **First Balance, units only** | Held, but **cost unknown** — gains and return stay blank until you add a cost (the app won't invent one) |
| **Later Balance — more units / higher avg cost** | Counts only the **increase** in cost basis = the money you added |
| **Later Balance — price moved, avg cost unchanged** | Contributes **฿0** (a pure market move adds nothing to invested) |
| **Later Balance — value only, no avg cost given** | Carries the prior average cost forward; extra units assumed bought at that cost |
| **Later Balance — lower basis** | Read as an at-cost withdrawal (a Balance can't see sale proceeds, so realized gain isn't recoverable — log a Sell if you want to track it) |
| **Balance, then trades after it** | Trades move the position forward from the Balance's anchor |
| **A buy, then a Balance** | The Balance lands on the existing position, so its basis carries — no double-count |

Worked the long way, the two-balance case people ask about most:

> Balance A: 100 units @ ฿10 average → invested **฿1,000**.
> Later Balance B: 150 units @ ฿12 average → contributes **1,800 − 1,000 = ฿800**
> (the money you added), **not** ฿1,800.
> If between them the price rose but you bought nothing (still 150 units @ ฿12),
> that Balance contributes **฿0**.

## What each row accepts — the input combinations

You never have to compute units (or amounts) yourself: every row takes a few
**input shapes** and the app fills the rest. The rule of thumb is *give the money
facts your source shows; the app derives the unit count*. Two shapes of row, each
with its own accepted combinations.

### Balance — an absolute holding on a date

Give a date and **either a unit count or a ฿ value**. Everything else is optional
or derived:

| You provide | Units become | Avg cost | What you can see |
|---|---|---|---|
| **units** + avg cost | as entered | as entered | value, gains, and return |
| **units** only | as entered | — | held, but **cost-unknown** — gains & return blank until you add a cost |
| **value** only | `value ÷ NAV(date)` | — | held, cost-unknown |
| **value** + avg cost | `value ÷ NAV(date)` | as entered | cost basis = units × avg cost; gains work |
| **value** + invested ฿ total *(an import showing value & P/L, or a cost total)* | `value ÷ NAV(date)` | *derived at the fold* from `cost total ÷ units` | gains & return work — the invested total is the stored fact, the per-unit cost self-corrects |

Two rules hold across the table:

- **NAV is on the Balance's own date**, never today's — so a back-dated balance
  doesn't drift (see [The rules that hold everywhere](#the-rules-that-hold-everywhere)).
- **Avg cost is what you _paid_**, so it's only ever *entered* or *carried in by an
  import that knows your cost* — it is **never invented** from current value. A
  Balance with no cost is held at cost-unknown, not given a made-up one.

### Trade — a dated buy / sell / dividend / fee / split / reinvest

Give a date and **either side of the trade** — a unit count or a ฿ amount — and the
other derives at the fold (you transact at the fund's NAV). Whatever you typed is the
stored fact; the derived side self-corrects with NAV:

| Kind | You provide | Units become | Amount becomes |
|---|---|---|---|
| buy / sell / reinvest | units + price | as entered | `units × price` (± fee) |
| buy / sell / reinvest | units + ฿ amount | as entered | amount as entered |
| buy / sell / reinvest | ฿ amount + price | `amount ÷ price` | as entered |
| buy / sell / reinvest | **฿ amount** only | `amount ÷ NAV(date)` | as entered |
| buy / sell / reinvest | **units** only *(a feed-priced fund)* | as entered | `units × NAV(date)` (± fee) |
| dividend / fee | ฿ amount | — (a pure cash event) | as entered |
| split | the ratio (2 = 2-for-1) | scaled by the ratio | — (moves no cash) |

On a feed-priced fund the NAV bridges units and cash, so **either side alone** is
enough. A **custom** asset has no NAV, so neither side alone can find the other: a
custom trade needs a **price** (or both the unit count and the ฿ amount) to tie its
units and cash together — a ฿ amount on its own can't become units, and units on
their own can't become cash. A row that can't be completed — a Balance with neither
units nor value, or a custom-asset trade that gives only one side with no price —
isn't saved; the importer flags it so you can fill the missing fact rather than
invent one.

## Editing and deleting (self-healing)

Because a position is just the replay of its entries, editing or deleting one is
safe — the app rebuilds the fund's position from whatever entries remain. Two
consequences worth knowing:

- **Delete the starting balance and the next one becomes the start.** Say you
  recorded Balance A then Balance B and decide you don't care about the period
  between them. Delete A: B is now the only Balance, so it's treated as the
  starting balance, and units / average cost / invested all recompute from B. The
  labels self-heal — nothing stores "this was the opening." (One caveat: if B was
  value-only with no average cost, deleting A leaves it cost-unknown.)
- **You trade precision for simplicity.** Collapsing two balances into one loses
  the *timing* of the contribution — invested and value stay exact, but the
  money-weighted return treats B's whole basis as invested on B's date rather than
  spread across the period. Keep both balances (or log the trade between them) when
  you want the return to be precise.

Deleting a **whole holding** is different and heavier: it removes that fund's
*entire* ledger. That's why it isn't a one-tap action next to "Edit" — it lives
inside the fund's Edit form, where its effect is spelled out. To fix a single
wrong figure, edit that row in History instead.

## Custom assets (no live price)

A holding with no NAV provider — crypto, a private fund, anything off-catalog — is
a **custom** asset (`quote_source: "manual"`). An unrecognized symbol defaults to
custom rather than assuming a market feed that would return nothing and read as a
total loss. You supply its **current price** on a Balance, and the app values the
holding from the **latest price recorded in its own ledger** — a Balance's current
price, or a trade's execution price, whichever is most recent by date. Cost basis
still comes from what you paid; only the *current value* uses the price you set.
There's deliberately no separate one-price-per-asset field — the ledger already
holds that series.

For a holding the catalog *does* recognize, its name, asset class, category, tax
wrapper, and TER are locked to the catalog (only its Portfolio and price Source
stay editable), so catalog facts can't be overwritten by hand. Edit a custom
holding's symbol to one the catalog tracks and it offers to adopt the official
details and switch to the live NAV, keeping your units and cost.

## Where this lives

- **Add** modal — records entries (`components/RecordSheet.tsx`).
- **History** view + inline editing (`components/history/HistoryList.tsx`).
- The cost-basis math is a pure, DB-free fold of the ledger
  (`lib/portfolio/lots.ts`) — see its header comment for the invariants.
- Why one ledger, positions derived:
  [ADR 0004](./decisions/0004-unified-ledger-positions-derived.md).
- How the value-over-time chart replays this ledger (point-in-time units,
  settlement cash, the contribution line):
  [ADR 0005](./decisions/0005-value-over-time-ledger-replay.md).
