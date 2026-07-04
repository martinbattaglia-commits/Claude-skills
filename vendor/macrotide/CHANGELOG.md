# Changelog

All notable changes to Macrotide are recorded here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries describe
shipped **capability** (not phase numbers — those go stale). Forward-looking
plans live on the [GitHub Project board](https://github.com/users/Sitthinut/projects/2).

Macrotide has not cut a release yet, so everything to date sits under
`[Unreleased]` as **Added** — there's no prior released version to mark things
`Changed`/`Fixed`/`Removed` against. The first public launch will be the first
cut: this section is sliced into a dated/versioned heading and a fresh
`[Unreleased]` starts above it, at which point those categories come into play.

## [Unreleased]

### Added

- **Enter a cost basis in a foreign currency.** The Add/Record form now takes a
  non-THB cost basis for a cash account (currency picker) or a foreign-listed
  stock / ETF (currency inferred from the symbol — USD for a US ETF), auto-filling
  the **trade-date FX rate** (keyless Frankfurter cache, editable, with a "≈ ฿"
  preview). The rate is captured on the row, so contributed capital, P/L, and the
  money-weighted return for a foreign holding are computed on its real baht cost
  instead of assuming the entered figure was already baht. The same currency +
  FX-rate entry is available in the **History inline editor**, so an existing row's
  currency and rate can be edited (it shows and edits figures in the holding's own
  currency). The funded-from-cash nudge now offers **non-THB cash accounts** too,
  recording the matching withdraw in native units at the buy-date rate. A foreign
  holding's baht chart and cost-basis conversion are warmed nightly alongside its
  NAV, so they open instantly instead of paying a cold FX fetch. The **exact
  figures you typed** in a foreign currency are stored verbatim alongside the baht
  the ledger folds on, so reopening a foreign transaction shows your original
  numbers instead of a rounded back-conversion.
- **The holding editor's quantity and cost are now read-only, edited in History.**
  A position is derived from its transactions (the ledger), so the "Edit holding"
  sheet shows quantity and average cost as read-only and points to History to change
  them — where each trade keeps its own trade-date FX rate. The sheet's locked fields
  now carry a lock icon so they read clearly as locked rather than empty.
- **Keyboard navigation for the autocomplete dropdowns** (symbol, cash account,
  purpose): ↑/↓ move a highlighted option, Enter picks it, Escape closes — with a
  typed custom value left intact when nothing is highlighted.
- **US ETF holdings and look-through now fetch reliably on the server.** SEC's
  www.sec.gov enforces a "Fair Access" policy that 403s a plain browser
  User-Agent from datacenter IPs; the app now sends SEC's declared contact UA, so
  ETF holdings, the "held via" reverse lookup (which funds hold a stock), and the
  N-PORT-derived asset class / exposure region actually populate in production.

- **US ETFs now show an asset class and exposure region** on their holdings-list
  row, derived nightly from the fund's SEC N-PORT look-through — its asset
  category mix names the class (mostly bonds → Fixed Income, mostly equity →
  Equity), its country mix names the region (US / Intl / EM / Global). Covers
  ETFs beyond the curated starter map, and widens as holdings coverage grows.
- **US securities search is now typo-tolerant and relevance-ranked.** Explore's
  US stock/ETF search moved off the old `LIKE` substring scan onto the same
  in-memory MiniSearch index the Thai fund finder uses — so "vangard" finds
  Vanguard, "sp500" finds S&P 500 funds, exact tickers rank first, and searching
  ~13k securities no longer scans the table. Search now feels uniform across both
  catalogs.
- **Balanced funds now read as a "Mixed" asset class** instead of falling into
  Unclassified. Thai balanced funds (SEC policy ผสม) carry no catalog asset
  class, so they get one derived from their policy — surfaced as its own filter
  tab, allocation sleeve, and donut slice (an opaque bucket, not decomposed into
  equity/bond). Unclassified is now reserved for genuinely unclassified holdings.
- **Explore's US stock/ETF tabs auto-load the first 100 results** click-free,
  matching the Thai fund finder (they previously stopped at 50 and required a
  click); the long tail past 100 stays opt-in via "Load more".

- **"Funded from cash?" one-tap reconciliation.** After you save a buy that a
  tracked cash account could have covered, a dismissible card on History offers
  to record the matching withdrawal — one tap and the buy stops double-counting
  as new money (the buy and the withdrawal net to an internal transfer). Only
  the part of the buy that recent sale proceeds didn't already cover is offered,
  and Reserved accounts are never suggested.
- **Set balance sorts out sale proceeds by itself.** A balance raise now
  automatically recognises the part covered by a recent fund sale — the sale
  landing in your bank is the same money moving rooms, not new savings — and
  counts only the remainder as money you added, so a mixed update (salary plus
  proceeds) splits itself correctly with nothing to configure. The entry form
  narrates the split before you save ("฿20,000 of this is your recent fund sale
  landing; ฿30,000 is counted as money you added"), and a profitable sale you
  park in the bank now keeps its gain on the books instead of quietly inflating
  "money invested". Older balances saved with the "no money moved" override keep
  their meaning and show a tag in History.
- **The Advisor can now record cash for you from chat.** Tell it "set my SCB
  savings to ฿100,000", "I deposited ฿20,000", or "I withdrew ฿5,000" and it
  drafts the matching Set balance / deposit / withdrawal into the same review
  table it uses for holdings — open it to check and save, with the account's
  Purpose (Investable or Reserved) carried through. Previously the Advisor could
  import funds but not cash.
- **Broker-synced sources and manual holdings no longer collide.** A source
  label that belongs to a live broker connection is shown as managed in
  Settings → Sources — it takes its name from the connection and can't be
  renamed there, so a rename can never split one synced source into two. Adding a
  holding manually for a ticker a connection already syncs into the same
  portfolio is blocked, naming the broker, so synced and manual entries can't
  silently double-count. Disconnecting a broker spells out that kept holdings
  become editable manual entries.

- **The portfolio "as of" date now reflects when your holdings were last
  priced.** The date beside the total tracks the latest NAV date in the value
  chart (a plain calendar date), instead of the moment the portfolio was last
  edited — so it advances as fresh NAV lands and reads the same for everyone.
  Internally, forcing a quote refresh no longer strands a fund's cache timestamp
  when an upstream refetch comes back empty, so a fund's freshness stays honest.
- **US stocks & ETFs are first-class.** Explore now has a market toggle (Thai
  funds | US stocks & ETFs): browse, search by symbol or name, filter to stocks
  or ETFs, sort, and tap any row for a detail view with a daily price chart. The
  catalog covers the whole US-listed universe (~12.9k symbols), refreshed nightly
  from the official Nasdaq directory. Adding a US holding now recognizes the
  ticker and fills in its name and asset class for you, and the Advisor can search
  and describe US securities (steering toward diversified ETFs over single names).
  Prices come from a free, datacenter-safe chain (Twelve Data, with Alpaca as a
  fallback), end-of-day, converted to THB wherever a US security is held. Popular
  US charts open instantly: on-screen rows are prefetched, and a nightly job keeps
  a dynamically-derived popular set warm (most-traded by dollar value, blended with
  what users actually open) — no hardcoded ticker list, it self-updates daily. A
  held US security also survives a ticker rename (FB→META): it stays linked to its
  current symbol, name, and price history through a stable FIGI identifier, and a
  custom holding starts pricing automatically once its symbol lists.

- **Your holdings list labels each position's type and exposure.** Every row in the
  Portfolio holdings list carries a small chip — Fund, ETF, Stock, or Cash (set-aside
  cash gets a lock marker) — so a mixed Thai-fund, US-security and cash portfolio is
  scannable at a glance. The line beneath reads its asset class and, where we're
  confident, its exposure region — a Thai fund's SEC policy translated to English
  ("Equity", "Fixed Income", "Mixed") with its home/foreign region, and a US
  position by asset class plus geography for single stocks and the well-known index
  ETFs ("Equity · US", "Equity · Intl", "Fixed Income · US"). Geography is never
  guessed from the listing country, so an unrecognised ETF simply omits it. Cash
  shows its earmark purpose ("Emergency"); only custom self-priced assets stay
  unlabelled. One asset-class vocabulary throughout — the holdings filter, the
  allocation breakdown, and the Advisor all read Equity / Bonds / Cash / Unclassified.

- **See what's inside an index fund, and how to own a stock through one.** A US
  ETF's detail lists its holdings with tickers you can tap to open each one. A
  leveraged or inverse ETF reads honestly too: its swap holdings show the
  underlying they track (an "Apple, Inc." swap, not the dealer's name) with the
  counterparty labelled "via …", plus a note that the figures are notional and can
  exceed 100%. A
  stock's detail has an "Own the index" list of the low-cost index ETFs that
  give you that exposure — each showing both how much of the stock it holds ("holds
  6.6%") and its annual fee, cheapest first, so a fund that both tracks the index
  and holds the stock appears once instead of twice with two confusing percentages.
  The list is grouped so the routes stay distinct: the broad index funds (the cheap
  default), then the stock's own sector funds (a concentrated, usually higher-fee
  way to own it — surfaced in their own group so they aren't buried under the cheap
  broad ones), then any other fund that simply holds it; each group shows a few with
  a "show more".
  Thai index funds appear alongside the US ETFs and show the same look-through
  weight (how much of the stock they hold via their master fund), priced by the
  cheapest share class. Constituents are matched to tickers from public identifiers
  (ISIN/CUSIP), so it needs no licensed data. A Thai feeder fund's detail drills
  the other way too: its master fund, its portfolio's master-ETF line, and each
  look-through constituent open that US ETF or stock's detail — resolved from the
  security's own identifiers, so a feeder's master line lands on the right ETF even
  when its stored master ISIN is unreliable.

- **"Own the index" now knows which ETFs actually track an index.** The ETFs
  suggested for a stock or index ETF are derived from real holdings overlap instead
  of a hand-picked list, so the set is comprehensive (every ETF that tracks the S&P
  500 / Nasdaq-100 / Dow, plus the 11 S&P sector ETFs) and updates itself as
  holdings change — all from public data, no licensed feed. A single-sector fund is
  never mistaken for a broad index it happens to sit inside (a tech-only ETF holds
  only S&P 500 names, but it tracks a sector, not the S&P 500), so it resolves to
  its sector slice or to nothing rather than a wrong "S&P 500" label.

- **One Explore search across everything you can invest in.** The "All" view
  searches Thai funds, US ETFs, and US stocks from a single bar and ranks them
  together by relevance, so a Thai S&P 500 feeder fund and VOO sit side by side for
  comparison. With the bar empty it leads with curated low-cost shelves — Thai
  index funds, then index ETFs, then popular US stocks — as an index-investing
  starting point, each fund and ETF showing its annual fee (TER) inline.

- **Funds stay correct when their code or name changes over time.** Tickers are
  now stored in their official catalog case (custom assets and cash accounts keep
  the case you type) and matched case-insensitively everywhere, so a fund never
  shows up twice from a stray capital letter. When a Thai fund house renames a
  fund — its long name or its short code — your holding follows the change
  automatically: it keeps showing the current name and symbol, stays priced, and
  the value chart stays continuous across the rename, while your transaction
  history keeps the original code as its record. Funds you hold are also priced
  through their whole life: a brand-new fund starts pricing the moment data
  appears, a fund that's closed or delisted stays valued at its last known price
  instead of disappearing, and a custom asset you entered by hand starts pricing
  on its own once it's listed in the catalog.

- **History reads as one newest-first timeline.** Balances (opening and snapshot
  anchors) now interleave with trades in date order instead of collecting in a
  separate section at the bottom, so a balance dated after your latest trade sits
  at the top where you'd expect. Each row's swatch is recoloured to one hue per
  meaning — green for money in, red for money out, periwinkle for income, blue for
  a cash balance, amber for an asset balance, grey for fees and splits — so the
  kinds are easy to tell apart at a glance.

- **Advisor memory is bounded, two-category, and self-tidying.** Memory now groups
  into just **About you** and **About Advisor** (replacing four fuzzy buckets), and
  each chat loads a bounded hot-set of the most relevant memories instead of every
  one — so a growing store stays cheap and focused without the Advisor feeling
  forgetful; anything beyond the hot-set is found on demand by relevance (BM25
  search over the full memory). A background sweep merges near-duplicate memories
  ("be concise" / "keep it brief") to keep the Memory tab clean, and editing a
  memory no longer clutters "Recently forgotten" with old versions. Each memory
  keeps a short headline plus optional longer detail recalled when needed.

- **The Advisor acts on a memory you change mid-chat right away, and stops holding
  stale contradictions.** Saving, updating, or forgetting a memory during a
  conversation now takes effect for the rest of that chat (e.g. "I just retired —
  play it safe now" changes the advice immediately) instead of waiting for the next
  session. Behind the scenes, when two saved facts about the same thing conflict
  the background sweep retires the outdated one (the more recent wins; an explicitly
  stated fact is never overridden by something inferred), and a newly-learned detail
  folds into the note it extends instead of piling up a near-duplicate. And when you
  ask what it remembers, the Advisor speaks of its memories as its own notes —
  hedging the ones it inferred from conversation rather than quoting them back as
  your exact words.

- **Chart popovers no longer hide behind the side panel.** The tap-to-define term
  tooltip, the `Cash` first-use hint, and the `+ Compare` and `+ Add` menus now
  float above the open detail panel (rendered in a portal) instead of being clipped
  behind it, and all place adaptively (flip to stay on screen).

- **The time-weighted return no longer loses a realized gain you withdraw.**
  Selling a holding at a profit and taking the money out (or letting the proceeds
  expire) used to wipe the gain from the Return line and period figure — the
  realized gain was read as a market loss. The TWR now strips the full proceeds at
  such an exit, so the return you earned is preserved. The money-weighted figures
  (all-time P/L, contribution line) are unchanged.

- **The `Log` (log-scale) view is available on every range and never silently
  no-ops.** It used to appear only on 1Y and longer; it's now offered on all
  ranges (a volatile crypto/stock book can span a wide enough ratio for log to
  help even over a month). A stretch fully out of the market — value ฿0, which a
  log axis can't place — now draws as a gap (a line break, on both scales) instead
  of the toggle quietly falling back to linear; a break honestly reads as "not
  invested" rather than "held ฿0 of funds". The Mix (funds-vs-cash) chart gaps the
  same stretch (no composition to draw); Return stays continuous (its growth
  factor is defined and flat while you hold nothing).

- **Hover dots no longer clip at the chart's top and bottom edges.** The active
  dot at a peak or floor is fully drawn on the log Value/Return axes and on the
  Mix chart (both Share and Amount), matching the linear axes.

- **The portfolio chart's controls are one clean, worded toolbar.** Period, mode
  (Value / Return / Mix), `Log`, a `Cash` toggle, and `+ Compare` are all
  the same flat control in one row below the chart, separated by thin rules that
  fold away when the row wraps on a phone. The returns moved into a scorecard above
  the chart — total value, your all-time return (the bold headline), then the
  period figures (the ฿ you made in Value, the time-weighted % in Return, and the
  benchmark gap), each a row led by a ▲/▼ gain/loss caret. The short-horizon TODAY /
  7D / 30D / YTD stat strip was retired — it nudged the daily-return-chasing the app
  is built to avoid, and the windowed figure covers any window on demand.

- **The chart explains itself in one line, with tap-to-define terms.** A single
  caption under the chart says what the current view shows in plain language, and
  the jargon in it — *time-weighted*, *put in*, *funds and cash*, *log scale*,
  *dividends* — is a dotted-underline term you tap for a short definition. It
  replaces the old stack of disclaimer lines: one readable sentence, depth one tap
  away on the exact word.

- **Excluding cash from your return is a one-click toggle.** The return basis is a
  `Cash` toggle in the chart toolbar — by default your investable cash counts; one
  tap struck-throughs it (`Cash`) to exclude it, so you compare your investments
  against an index without the cash drag (reserved cash always sits out). A
  first-time note explains it, and the wording matches the "investable" / "reserved"
  cash types in Add-to-portfolio. Excluding cash removes only your held cash
  accounts — a fund switch's in-transit settlement proceeds stay counted, so a
  routine rebalance no longer draws a phantom dip in the cash-excluded view.

- **Chart view settings are remembered per device.** Period, mode, scale, and the
  cash basis now persist in your browser (localStorage) rather than your account, so
  the chart reopens however you last left it *on that device* — a quick phone glance
  and a desktop deep-dive can differ. The period is remembered now too (it used to
  reset to 1Y each visit). One-time note: any existing "exclude cash" preference
  resets to the default (include cash) once on upgrade.

- **A Breakdown view shows what your money is made of over time.** The chart's
  mode switch gains a Breakdown option: a stacked area of funds vs cash across the
  selected range, shown as share-of-100% (default) or absolute ฿. Cash drag and how
  quickly new deposits get put to work become visible at a glance.

- **More time ranges, and the chart opens on one year.** The range selector adds
  **Year-to-date** and (once your history is long enough to differ from "All") **5
  years**, and the default view is now 1Y instead of 6M. 6M was dropped — 1M, 3M,
  and YTD bracket it.

- **A Return view shows how your investments did, apart from how much you put
  in.** A Value / Return switch above the chart flips between your wealth over
  time and a time-weighted return curve (gains shaded green, losses red, fading out
  toward break-even). The return curve doesn't jump when you deposit or withdraw —
  it isolates how the holdings performed — and a benchmark you turn on is compared on
  the same from-zero footing. (How much you personally made,
  which depends on your timing, is the money-weighted figure in the returns
  breakdown.) Log scale works here too.

- **The portfolio chart can switch to a log scale on long ranges.** On the 1Y and
  All views a `Log` toggle sits by the chart; it draws the value line so that
  equal % moves are the same height, so years of compounding no longer crush the
  early part of the curve into a flat line. The value line now also shows your
  **actual wealth on every range** (it no longer resets to zero at the start of a
  shorter window) — "how did this window perform" is the job of the windowed
  time-weighted % in the scorecard above the chart. Default stays linear.

- **The period return now reflects how the window actually performed.** The
  windowed return in the chart scorecard (1M / 3M / 1Y …) is time-weighted: a
  deposit or withdrawal made *during* the period no longer distorts it — previously
  a large mid-period deposit onto a small starting balance could read as a wildly
  inflated return. It still follows the `Cash` basis. The lifetime "all-time"
  return and the chart tooltip's gain figure are unchanged (those answer "gain on
  what I put in", a different question).

- **The Advisor reliably remembers when you ask it to.** Explicit "remember
  this" requests now save on the first try and show the memory chip in the same
  reply, instead of the Advisor sometimes just acknowledging in words without
  saving. Asking it to remember something no longer produces a repetitive
  "already saved / nothing needs saving" reply. Replies also no longer
  occasionally cut out on the free tier — when a free model requires reasoning,
  the request transparently retries instead of dead-ending.

- **Advisor replies read as ordered steps, with per-reply actions.** A reply now
  renders its prose and "Memory saved/updated" indicators in the order they
  actually happened — said something, saved a memory, said more — under one
  header, and that ordering is saved so it looks the same on reload and on
  another device. Each finished reply carries a quiet action row at its foot:
  **Copy**, **Save** to your Notes, and **Retry** (re-runs the latest reply).

- **Feedback is memory, not a ratings bar.** The 👍/👎 row is gone. You shape the
  Advisor by correcting it in words, and the correction becomes a remembered
  memory: every write shows a quiet status line in the chat (click it to see what
  changed), and **Journal → Memory** is the browsable, reversible record of
  everything the Advisor has learned (review, forget/restore, or ask the Advisor
  to change a memory — Edit opens a fresh chat where the Advisor asks what to
  change, with the whole memory in view, not just its short headline). Memory
  writes are verified so a change the Advisor says it made actually lands.
  The store is self-maintaining — each write reconciles
  against what's already saved (add / update / skip) instead of piling up
  duplicates; inferred memories that go unreinforced decay to recall-only while
  explicit ones never do; and an extracted memory can never silently override
  something you said explicitly. Bookmarking an Advisor reply saves it as a
  journal note. Memories are scoped per user (fail-closed). See
  [ADR 0006](./docs/explanation/decisions/0006-feedback-by-memory.md).

- **Broker connector updates split into silent vs. reinstall.** The installed
  userscript now versions on two axes (`@version` = `1.<protocol>.<revision>`): a
  backward-compatible tweak (badge copy, a cosmetic fix) bumps the revision and
  reaches managers via silent auto-update with no prompt, while only a breaking
  change to the gather contract bumps the protocol and surfaces the reinstall
  nudge. A test tripwire pins a hash of the generated script, so the version can't
  silently go stale when the script changes.

- **The Explore screener separates browsing from searching by investor eligibility.**
  Browsing is now a buy list — retail funds by default, with an **"Access"** facet
  that filters to accredited or ultra (high-net-worth) investor funds. Searching, by contrast, finds any
  *active* fund — including accredited/ultra/provident/institutional and
  fixed-term funds a user might already hold — but deprioritizes the non-buyable
  ones so they surface only on a strong or exact match, never as noise in a
  generic query. Each restricted fund now carries an eligibility badge
  (Accredited / Ultra / Provident / Inst. / Fixed-term). Replaces the old blunt
  retail gate that hid ~110 individually-buyable accredited/ultra funds.

- **Cash is now a first-class part of the portfolio.** You can record explicit
  cash events against a named account — a **Deposit** or **Withdraw**, or a **Set
  balance** that simply states how much cash an account holds as of a date. Idle
  bank cash shows up alongside funds in allocation, net worth, and the value chart
  (priced 1.0, foreign cash converted to baht). Recording cash doesn't disturb your
  funds: a buy never silently debits a tracked cash account, so the two stay
  independent unless you say otherwise. Recorded cash also corrects the automatic
  in-transit estimate: asserting a balance stops deliberately-parked sale proceeds
  from being read as withdrawn, so lifetime contribution no longer double-counts
  money that was reinvested later. Deposits and withdrawals flow into the
  money-weighted return as real external cash.

- **Reserve cash for a purpose, and choose whether idle cash counts toward your
  return.** Each cash account carries a **Purpose** — a **Role** (Investable or
  Reserved) plus an optional free-text label like "Emergency" or "House". Reserved
  cash (an emergency fund, money saved for a goal) stays in your net worth and gets
  its own slice in the allocation donut, but is carved out of your return so it no
  longer drags performance. Investable dry powder is governed by a per-view
  **Return basis** toggle — *Include cash* (the default, the honest money-weighted
  number, so idle cash you haven't deployed visibly drags) or *Exclude cash* (judge
  only the funds you've actually bought) — flipped right at the return figure and
  remembered as your preference.

- **The Advisor reads chat images through a vision tool, keeping the conversation
  fast.** The chat model now stays on every turn and reads an attached screenshot
  by calling an `examine_image` tool (instead of swapping the whole turn onto a
  vision model), so its prompt cache stays warm across the image turn and it keeps
  reasoning. The tool returns a complete reading of the image, which is carried as
  text on later turns — so the Advisor can answer follow-ups about an earlier
  screenshot ("what was my other fund's value?") without you re-uploading it.
  Cache affinity is pinned per provider family (so switching the chat
  model keeps caching), the in-chat vision + holdings-OCR models moved to a
  `gemini-flash-lite` chain (cheapest, with a current-gen fallback that survives
  the `gemini-2.5` end-of-life), and a chart/factsheet can optionally escalate to
  a stronger vision model. Env: `VISION_CHAT_MODELS` / `OCR_MODELS` (renamed from
  the singular forms), new optional `VISION_CHAT_ESCALATE_MODELS`.

- **Image-import OCR spend is now metered and capped.** A signed-in non-owner's
  Add-holdings image imports count against the same daily usage limit as chat
  (the priciest paid path is no longer the one unbudgeted route), and the
  process-wide OCR breaker now counts each model call rather than each request
  (a detect-then-route import is two). The owner stays uncapped.

- **Holdings rows surface fee and weight at a glance.** Each holding now shows
  its total expense ratio inline — muted when the fee is low, flagged amber/red
  as it climbs — next to a labeled portfolio weight, so fee awareness no longer
  requires opening a detail sheet.

- **The portfolios manager is reachable on phone.** A menu button on the
  portfolio switcher opens the full portfolios list — switch, reorder, rename, or
  add — as the side panel on desktop/tablet and a dedicated full page on phone
  (which has no side panel); picking one returns to its portfolio. The "All" chip
  drops its decorative glyph and verbose count for a plain label.
- **The fund screener reaches the whole catalog.** Explore no longer silently
  caps at 30 results — funds auto-load as you scroll (the next page is prefetched,
  so there's no loading flash), then a "Load more" button takes over for the long
  tail. A running "Showing X of N" count surfaces the true match total, focus
  moves into newly loaded rows for keyboard and screen-reader users, and a
  refine-with-filters hint appears once the result window is exhausted.
- **Installable as a standalone app (PWA).** A web app manifest plus iOS
  home-screen metadata let the app be added to the home screen and launch
  standalone (no browser chrome), with proper home-screen icons on iOS and
  Android. The hardware/gesture Back button now behaves natively — it closes an
  open sheet or dialog first, then steps back out of a drilled-in screen, before
  ever leaving the app. The status bar tints to match the in-app light/dark
  theme (not just the OS preference). The shell is sized to the visible viewport
  (so an installed PWA on iOS/iPadOS no longer over-scrolls past the screen), and
  the bottom nav is lifted clear of the home indicator. Scrollbars now follow the
  input device, not the window width: a mouse gets the thin custom overlay
  everywhere (including a narrowed desktop window, which no longer shows a chunky
  native lane) while touch keeps native scrolling on every screen size.
- **The JSON API is fail-closed (deny-by-default auth).** Every data route now
  rejects an anonymous request with `401` instead of silently serving the
  shared owner row set; the few intentionally-public routes are an explicit,
  in-code allowlist, the demo sandbox stays open, and `AUTH_DISABLED=1` local
  dev is unchanged. Resource-spending routes with no DB access (OCR transcribe)
  and operator routes (market refresh) gained matching session/owner gates.
- **Hardening pass (defense-in-depth).** Image uploads are validated by their
  magic bytes (not the client-declared type); the broker import token is
  compared in constant time; the connector-manifest URL fetch has SSRF guards
  (https-only, no private hosts, no redirects, bounded time/size); and a test
  guards against a password-reset flow being added while the inert credential
  path is enabled.
- **Tighter abuse & cost defenses.** A process-wide OCR circuit breaker
  (`OCR_GLOBAL_LIMIT_PER_MIN`, default 60/min) caps total vision spend even if
  the per-IP limit is bypassed; demo-session creation is now rate-limited; and
  create routes stamp ownership server-side so a request body can't reassign a
  record's owner. Private files (broker connector manifests, scratch) no longer
  bake into the Docker image.
- **Curated model-portfolio templates ship as built-ins and seed reliably into
  any database.** The factory set (Bogleheads 3-Fund, All-Weather, Permanent
  Portfolio, Golden Butterfly, and more) now lives in a first-class presets
  module and lands via an idempotent, additive seed on boot — plus a
  `db:seed:presets` command for existing instances — so a database with real
  holdings gets the templates without the destructive full reseed that
  previously left the library empty.
- **The side panel can be resized and expanded to full width.** A drag handle on
  the panel's left edge resizes it freely (keyboard-accessible — Arrow/Home/End),
  and a maximize toggle in every panel header (Advisor, Portfolios, Plan, Notes)
  expands it to a full takeover and back. On desktop the main view keeps a usable
  minimum and drag stops at a comfortable maximum (maximize is the separate full
  takeover); on the tablet overlay, dragging all the way to the nav rail simply
  is the maximized state — drag-to-full and maximize are one and the same, and
  you can drag back out of it. The chosen width and maximized state persist
  across reloads; mobile is unchanged.
- **An early-warning probe guards against OpenRouter spend silently breaking
  chat.** A server-run job reads the account key's live monthly limit from
  OpenRouter and signals when spend nears it — before the cap trips a 403 that
  would break all chat — so the operator can act first. When a heartbeat URL is
  configured it self-notifies: a one-line spend summary POSTed to the heartbeat's
  `/fail` sub-path on a warn or critical reading, plus a liveness ping on
  healthy/warn. Warn recurs as a self-resolving nudge; critical withholds the ping
  so it stays a sustained incident; the read is retried on a transient hiccup, and
  a persistently unreadable API surfaces via the dead-man. The dollar cap is read
  live from OpenRouter (never copied into the repo), so there's nothing to drift;
  alert thresholds are job-unit flags.
- **The served model is shown to the operator, not to users.** Each assistant
  reply's served model id (e.g. `glm-4.6`) now appears in the message meta only
  for the owner (and in local dev) — kept from regular users so a raw model slug
  never breaks the "Advisor" persona. It streams live so it shows on the current
  turn without a reload, and the label drops the provider prefix and date stamp.

- **The Advisor can review each portfolio on its own, not just the whole book.**
  `read_portfolio` now returns a per-portfolio breakdown (each portfolio's value,
  asset mix, drift, blended fee, and money-weighted return) by default, and
  accepts a portfolio name (e.g. "Tax") to scope the full readout — allocation,
  drift, fees, concentration, lifetime returns — to a single portfolio, scored
  against *that* portfolio's own target model. `read_performance` takes the same
  name to report one portfolio's period return vs its index. So "what do you
  think of all my portfolios?" and "is my Tax portfolio lagging?" answer with
  real per-portfolio numbers.
- **The Advisor reasons like a real advisor on reviews and planning.** Instead of
  defaulting to short answers, it now matches depth to the question: quick facts
  stay a sentence, while a review or "what should I do next?" gets a structured
  pass over the aspects that decide whether you're doing well — return vs your
  index/plan, fees, allocation/concentration, tax wrappers/contributions — and
  ends with one or two concrete, prioritized next steps. It also adapts to the
  reader, defining terms for a beginner and staying concise for an expert. Those
  review and planning turns now get reasoning effort on the owner/trusted paths.
  It now leans into being genuinely helpful — giving the comprehensive, specific
  picture rather than deflecting to "a professional" — and weaves a brief "your
  decision" note into an answer naturally only when it adds value, instead of
  stamping a fixed disclaimer onto every message or every new chat.
- **The Advisor can find funds by precise region or sector.** `find_funds` now
  takes a `regionFocus` (e.g. "us", "china", "emerging") or `sectorFocus` (e.g.
  "gold", "technology") filter — finer than the broad foreign/domestic mandate —
  so "the cheapest US index fund" or "a gold fund" maps straight to the catalog's
  derived facets instead of a fuzzy text search.
- **Adding, editing, or deleting a holding is atomic.** Each write to the
  precious ledger now commits its ledger event, projection rebuild, and
  instrument metadata as one transaction (rolling back together on any error),
  so a mid-write failure can never leave a torn ledger/projection.
- **Explore can screen by tracked index, cheapest first.** A "Tracks" dropdown
  lists every index family with at least one active index-style tracker (live
  from the catalog, with tracker counts) and shows the funds tracking the
  chosen index ranked by fee — including feeder funds whose own name never
  mentions it (the index family is now also derived from the master fund's
  name, so e.g. all S&P 500 feeders classify correctly). Typing an index name
  into search offers the facet as a one-tap suggestion, and the list legend
  says how results are ordered (best match vs cheapest first). The Advisor's
  fund finder gained the same `trackingIndex` filter and now always names the
  true lowest-fee fund in a result set, even when results are relevance-ranked.
- **Explore's filters fit one row on a phone.** Every facet (asset class,
  index/active style, region, tax wrapper, tracked index) is now a compact
  dropdown pill instead of a row of chips — five pills replace ~14
  always-visible options, the pill shows the chosen value when set, and menus
  align to stay on-screen at the viewport edge. A ✕ button at the end of the
  row resets all filters and the search in one tap, facet menus keep their
  scrollbar visible so a long list never reads as cut off, and the panel keeps
  its height when a search finds nothing (no collapsing under an open menu).
  Tapping TER ⓘ in the legend expands a one-line fee explainer on demand,
  replacing the always-on footer note — so the explanation now works on touch,
  where the TER badges' hover tooltips never show.

- **Custom dropdowns are keyboard-navigable and stay on-screen.** The fund class
  switcher and the portfolio benchmark picker now support arrow keys, Home/End,
  Enter, and Esc, and flip open upward when there isn't room below — via one
  shared dropdown behavior (`useFlipUp` + `useListboxKeyboard`).
- **Portfolio benchmark comparison is now total-return.** The Portfolio chart's
  "VS" benchmark picker compares your return against a curated, global-first set
  of market benchmarks (global, US, US tech, developed-ex-US, emerging markets,
  Japan, Thai) measured as **total return** in ฿ — dividends reinvested,
  currency-matched — so the comparison is like-for-like instead of against a
  dividend-dropping price index that flatters the benchmark. The Advisor's
  performance answers use the same total-return benchmarks.
- **The benchmark overlay now matches your contributions.** Instead of a single
  lump invested at the window start and held, the "VS" line mirrors your own
  deposits and withdrawals into the index on the same dates — so adding money no
  longer makes the benchmark look flat, and the comparison answers "what if I'd
  put the same money into the index at the same times." The tooltip puts the
  benchmark's gain and % beside your own (same net-invested basis, so a deposit
  lifts both equally rather than reading as benchmark outperformance).
- **Deep total-return benchmark series.** Each benchmark is a tracking-ETF proxy
  cached as dividend-reinvested adjusted close (~20 years deep) under a dedicated
  `benchmark_tr` data source, warmed by a `prewarm-benchmark` job, labeled by the
  index it tracks (MSCI ACWI, S&P 500, Nasdaq-100, MSCI Japan, MSCI Thailand…).
- **Held foreign ETFs and gold are now deep on the "All" chart from first open.**
  The daily market refresh proactively warms held non-fund (`market`-sourced)
  positions to full depth, so the portfolio "All" chart no longer pays a cold
  one-time backfill the first time you open it with such a holding.
- **Accumulating vs dividend classification now uses the formal factsheet
  code.** The catalog and share classes previously parsed Thai class-detail
  text, which only caught explicit wording; the formal dividend-policy code
  (landed nightly) is now preferred with the text parse as fallback — coverage
  jumped from ~600 to ~3,900 funds, so far more rows carry correct ACC/DIV tags.
- **Fund catalog gains derived region, sector, and index-family facets.** Each
  fund now carries a geographic focus (thailand / us / japan / china / global…),
  a sector/theme focus (technology / gold / property…), and the index family it
  benchmarks ("SET50", "S&P 500", "MSCI ACWI"…). Fresh sources outrank frozen
  ones: the declared factsheet benchmark first (blend rows must agree before a
  region is claimed), the SEC domestic-mandate flag next, then the official
  **AIMC peer-group category** as a gap-filler (snapshotted from the legacy v1
  FundFactsheet API before its mid-2026 retirement — a one-shot script, not a
  recurring crawl; the raw code is kept on each fund, but a never-updating
  snapshot must not override living signals), and a fund-name gazetteer last —
  each value records its source, and nothing is guessed (unknown stays null). Region
  coverage on active funds: ~84%, up from ~38% by name keywords alone. Fee-creep
  cheaper-alternatives now respect the facets: a Japan fund is never offered as
  a cheaper version of a US fund, nor a gold fund for a diversified one.
- **Nightly crawl lands fund benchmarks and factsheet statistics.** Two new
  bulk sweeps (same cheap paginated pattern as risk-spectrum, no per-fund
  calls) land every fund's declared benchmark index — which names the index,
  geography, and hedging variant, covering ~94% of active funds — and per-class
  risk/return statistics (Sharpe, max drawdown, FX-hedging ratio, tracking
  error, turnover). Raw payloads land verbatim in `sec_raw`; the transform
  derives `fund_benchmarks` (blend rows kept) and `fund_statistics` (string
  figures parsed). Groundwork for region / index-family screener facets and
  honest like-for-like fund comparison.
- **Fund catalog carries FX-hedging policy, full policy text, and lifecycle
  dates.** The transform now maps profile fields that were already landed but
  unused: a normalized FX-hedging policy (full / discretionary / partial /
  none / per-class — hedged vs unhedged is a different product), the full
  investment-policy text (HTML stripped; feeds search and Advisor context),
  the master fund's domicile country for feeders, SEC registration and
  cancellation dates, and the maturity duration of fixed-term funds. No new
  API calls — a transform re-run over the landed raw data populates everything.

- **Each holding's page now charts its value over time, not just cost basis.**
  The Position screen replaces the cost-basis sparkline with an interactive
  value line — your actual position worth (`units × NAV × fx`) per date — with
  the cost-basis line beneath it, so the gap reads as unrealized gain, plus a
  range selector (1M/3M/6M/1Y/All). It's the per-position slice of the same
  ledger replay behind the portfolio chart: nothing before the holding's first
  trade, history before the fund's price cache valued from the prices you
  actually paid (flagged), and foreign holdings converted to baht.

- **Tapping a holding now opens your position, not the fund sheet.** A holding
  tap lands on the Position page (your value, return, and the chart above) —
  answering "how is my money doing" first; the instrument's catalog detail moves
  to a **"Fund details"** button there (and the holding row's menu). Fund facts
  stay one tap away rather than being the default. (Holding-detail IA, first
  step — see #159.)

- **Explore filters index vs active funds.** The screener's "Index funds only"
  toggle became an **Index / Active** chip pair, so actively-managed funds are
  now a first-class filter too. The facet derives on read from the SEC
  management style (PM passive, PN feeder-of-passive = index; everything else,
  including unpublished styles, = active) and filters in SQL on the indexed
  column. `/api/fund-classes` and `/api/funds` accept `indexType=index|active`
  (`indexOnly=1` still works), each share-class row carries `indexType`, and
  fee-creep cheaper-alternatives no longer cross the index/active boundary — an
  active fund is never offered as a cheaper version of an index fund or vice
  versa.
- **The app loads with an instant feel everywhere.** First paint no longer
  waits on an external fonts stylesheet (fonts are self-hosted with the build)
  or a blank page while the client bundle downloads (a boot spinner paints
  immediately). The charting library is code-split out of the initial bundle
  and loads on demand behind chart-shaped placeholders. Every screen shows a
  content-shaped loading skeleton instead of plain "Loading…" text (the
  statement no longer flashes its empty state while loading). Chart range
  switches and screener filter changes redraw from the previous data instead
  of blanking. The Explore screen warms the top rows' fund detail and NAV
  series in the background, so the first fund-detail open is instant. The
  portfolio's live quote refresh derives its tickers server-side
  (`/api/quotes?refresh=1&mine=1`) and fires in parallel with the holdings
  fetch instead of waiting behind it, and a tab refocus no longer refires
  every active data request at once. A tab left open across a deploy
  self-heals when its lazy chart chunk no longer exists (retry, then one
  guarded reload) instead of showing the error screen.

- **Broker-synced holdings are marked in the portfolio.** A holding imported
  from a connected broker now shows a small sync icon beside its ticker in the
  holdings list. The signal is reliable — it keys off the broker import's dedup
  marker on the ledger, so a manually-entered holding that merely names a broker
  in its free-text source is not flagged.
- **Broker connectors handle header-auth APIs and several brokers at once.** The
  connector SDK gained a `transport` block so a broker whose data API lives on a
  different origin and authenticates with request headers (an `Authorization`
  bearer / `x-api-key` the page holds in memory, not a cookie) can sync: the
  collector captures those headers from the broker app's own requests and replays
  them, reaching the API cross-origin. History can now page by **date range**
  (not just a cursor), order field paths resolve **nested keys** (e.g.
  `fund.code`), per-order **fees** carry through, and `pendingPath` is optional.
  `BROKER_CONNECTOR_PATH`/`URL` accept a **comma-separated list**, so multiple
  brokers run side by side — the Connect wizard shows a broker picker, Settings →
  Connections groups synced accounts per broker, and each syncs under its own tag.
  A **single global userscript** covers every configured broker: it matches all
  their hosts and resolves which connector applies at run time from the page's
  hostname, so you install once. (Installed userscripts get a one-time reinstall
  nudge for the collector bump.)

- **The portfolio value-over-time chart now tells an honest wealth story.** It
  replays your transaction ledger point-in-time instead of projecting today's
  position backward: a holding contributes nothing before its first event,
  exited positions still appear over the dates you held them, and history before
  a fund's price cache begins is valued from the prices you actually transacted
  at (flagged with a caption). Sale proceeds in transit during a fund switch stay
  in the line — no more fake drawdowns on every rebalance — and a second
  **net-invested** line draws your contributions, so the gap to the value line
  reads as gain (tinted green, or red when underwater). Short ranges rebase to
  the window start ("how did I do this month"); All keeps the absolute lifetime
  curve. Fixes false ~18% steps caused by NAV-coverage changes
  ([ADR 0005](./docs/explanation/decisions/0005-value-over-time-ledger-replay.md)).

- **The portfolio headline return now matches the chart, and explains itself.**
  The hero "all-time" figure is total return on the money you've contributed
  (value − net contributions), the same money-weighted number as the chart's
  "All" pill — they no longer disagree. Tapping it opens a **returns breakdown**:
  total value, money invested, total return and annualized (money-weighted)
  return, then where the gain comes from — cost basis, unrealized gain (the older
  return-on-current-holdings figure, now labeled), realized gain, dividends, and
  fees. Resolves the confusing case where a small "unrealized" headline sat above
  a much larger chart return because every fund switch banks realized gain into
  the new holding's cost basis.

- **Chat history is now a faithful, durable record.** The assistant's full reply
  is persisted (every generation step, not just the final one), so prose written
  before a tool call survives reload. Advisor-generated cards — import tables,
  single-holding and plan proposals — are now stored server-side on the message
  (a new `chat_messages.cards` column) instead of browser-only `localStorage`, so
  they reappear after a reload and follow you to another device. The stored
  payload doubles as a durable record of exactly what the Advisor extracted. A
  `DEBUG_ADVISOR=1` flag logs per-turn internals (served model, step/finish-reason
  chain, full tool inputs) to the server console for local debugging.

- **Advisor imports a single value-only holding without inventing units.** When
  you share a screenshot of one position that shows a ฿ value but no unit count,
  the Advisor no longer computes and freezes `units = value ÷ price` into a
  one-tap card. It now opens the same reviewable importer the multi-holding path
  uses: the ฿ value is kept as the fact, units are derived from the NAV on the
  snapshot date (shown as an estimate to verify), and they self-correct as NAV
  lands. A position you describe with a unit count still gets the one-tap card.
- **Advisor captures every figure on an import screenshot, and classifies a dated
  LOT as a transaction.** The import tool guidance now tells the Advisor to read
  all printed values into their fields — a dateless detail view with a unit count
  *and* a per-unit cost keeps its cost basis instead of importing units alone, and
  a summary view (value + invested + P/L, no units) passes value and P/L. It also
  classifies up front: a position view that shows a *purchase date* (วันที่ทำรายการ,
  a LOT view) is a BUY, so it's recorded as a transaction dated to the actual
  purchase — using the invested total as the trade amount, never the current value
  or unrealised P/L. Recording such a view as a current Balance would date the
  whole cost basis to today and distort the money-weighted return.
- **Import quantity toggle reveals the real ฿ amount.** On an imported row that
  carries both a unit count and a ฿ amount (broker statements that print both),
  flipping the Units ↔ ฿ switch now shows the stored amount instead of re-reading
  the unit figure as baht. Manually typing a single value and switching its type
  is unchanged.
- **Advisor transaction-import card shows price per unit.** The in-chat "Review
  transactions" table now has a Price column alongside Units and Total, so you
  can check the per-unit figure against the screenshot before importing. The
  holdings-import card's "needs units" / "estimated" badge moved onto the Units
  value it describes (clearer on narrow widths).
- **Privacy toggle for portfolio amounts.** An eye control in the balance
  header (Portfolios tab) masks every ฿ figure — total, all-time P&L amount,
  per-holding values, and the "Recently recorded" / History amounts — while all
  percentages stay visible, so allocation and return signal survive a shoulder-
  surf or screen share. Each amount is replaced by a constant-width frosted bar
  (same width for every value, so the digit count can't leak its magnitude); tap
  the masked total to reveal. The choice persists per browser (localStorage,
  default visible).
- **Advisor chat stores your raw message, not an internal note.** Image turns
  used to bake a model-facing `(Attached files: …)` note into the saved message,
  so it leaked into your own bubble on reload. The message now keeps only the
  text you typed; per-image filename and capture-time metadata are stored
  separately and the note is recomposed for the model at send time, never
  persisted. The capture time is read from the image's EXIF (`DateTimeOriginal`,
  with its UTC offset when present), converted to the Thai trading day and given
  to the Advisor as Asia/Bangkok ISO-8601 (`…+07:00`) — falling back to the
  file's saved time for screenshots with no EXIF. The Add → Image importer shares the same EXIF-derived capture
  time. A one-time script (`scripts/strip-legacy-attachment-notes.ts`) cleans the
  note out of messages written before this change.
- **History/Position "Invested" now shows the cost basis of money still invested**
  — the remaining cost of held units (deducting the cost of what you've sold, not
  its proceeds) — so the KPI card and the Advisor's spoken figure reflect capital
  actually still at work, without double-counting realized gains already in the
  "Realized" card.
- **Consistent Advisor header controls.** The hamburger, New-chat, and overflow
  (kebab) buttons now share one compact style across the mobile chat header, the
  Chats list, and the desktop panel; the desktop chat header gains a top-right
  New-chat button beside the close button, so a fresh conversation is one click
  from the chat view.
- **One-click import of your broker's full order history — now an ongoing sync.**
  The Add sheet can pull every buy / sell / switch / dividend across all of your
  broker portfolios with no file export or screenshots. Install a small userscript
  (one click from a `.user.js` link) and it runs on your broker's own (logged-in)
  page, collects the order history through the broker's API, and posts it straight
  back to Macrotide — so opening your broker keeps Macrotide in sync without even
  having Macrotide open. The installed script is a thin loader that fetches its
  broker settings from Macrotide on each run, so it **stays current without
  reinstalling** when the broker's API details change — only a change to the
  collection logic itself prompts a one-tap reinstall. Re-syncs are
  **idempotent**: each order carries a stable id, so importing again adds only
  genuinely new orders and never duplicates. A
  switch is recorded as a sell of the outgoing fund plus a buy of the incoming
  one; dividends become cash income; cancelled and pending orders are skipped.
  Which broker this targets is deployment config (env-only): a self-hoster points
  it at any broker by writing a **connector manifest** — a data-only JSON naming
  the broker's endpoints and (optionally) mapping its response field shape — with
  no code changes, so the feature is hidden unless configured and the repo carries
  no broker identity. A guided,
  platform-aware install stepper (with a QR for installing on your phone) walks
  you through it. Each of your broker accounts becomes its own portfolio, named
  after the plan — and in **Settings → Connections** you can remap an account to a
  different portfolio, merge several accounts into one, see each account's last
  sync, unlink (keeping or removing its history), and reset the import token.
- **Performance charts show the return for the selected period.** The portfolio
  performance chart and the fund-detail price/size chart now display a colored
  %-return for whatever range is selected (green up / red down) — derived from the
  first and last value in the visible window, so it updates as you switch
  1M/3M/6M/1Y/All. On the portfolio chart it replaces the old value-span readout;
  on the fund chart it reads as "{range} return" under the pills.
- **Performance-chart x-axis is readable across years.** The interactive chart's
  date labels no longer clip at the left/right edges, and the axis now groups by
  month: the first tick of each month shows a brighter `MMM 'yy` (e.g. `May '26`)
  while in-between ticks show a muted day number — so multi-year ranges (1Y / All)
  are unambiguous. The hover tooltip shows the full date with year.
- **Holdings get distinct, on-brand swatch colors automatically.** Each holding's
  dot is now derived from its **risk** along one ordered palette — cool/calm blue
  for the lowest-risk funds through to warm/hot red for the highest — so a glance
  across your holdings reads as a risk heat map. The color follows the SEC risk
  spectrum (RS1…RS8, with RS81 "8+" hottest of all) when known, and falls back to
  the holding's asset class otherwise; a ticker hash nudges lightness so same-risk
  holdings stay distinguishable. Colors are computed at render time and never
  stored, so they stay consistent and need no picker. (The SEC risk-spectrum code
  is now kept in the fund catalog to drive this, instead of being discarded after
  it's used to classify a fund's asset class.)
- **Portfolio chart cards align by row.** On desktop the charts grid sizes every
  card in a row to the tallest card in that row, while different rows size
  independently; on mobile (one column) each card sizes to its own content.
- **Known fund metadata now reads from the catalog source of truth.** Ledger
  imports still promote known catalog symbols to the Thai mutual-fund price
  source, but names, asset class, region, category, and TER are overlaid from
  `market.db` at read time instead of copied into `app.db.holdings`; custom
  holdings keep their user-entered metadata and unresolved asset classes stay
  unknown rather than defaulting to Stocks.
- **One Add surface records everything in your portfolio.** A single Add modal
  replaces the old separate holdings / activity / transaction sheets. Each row
  carries its own **Type**, auto-detected from what you paste or import: a
  **Balance** (a starting balance or a later restatement of what you hold now) or
  a trade (buy / sell / dividend / fee / split / reinvest). Intake is one calm
  surface — paste rows, drop a screenshot or CSV, or add a row by hand — feeding
  one editable review list of native-style rows you can open and edit inline
  before saving. A symbol field autocompletes against the known-fund catalog, and
  a quantity switcher lets you enter either **Units** or a **฿ Total** (units are
  derived from the price), matching Thai broker apps that show value rather than
  unit count. The Add modal and the History editor now share one validity gate, so
  they accept and reject every balance/trade combination identically — including
  cash-only dividends and fees on a self-priced custom asset, which can now be
  recorded with just a ฿ amount.
- **A full-screen History view and a per-fund Position page.** History reads the
  whole ledger as a money story — recent activity, balances grouped under their
  own header, and KPI cards (Return · Invested · Realized · Income) — and every
  ledger row is editable inline with the same grid the Add modal uses. Tapping a
  holding opens its Position page: that fund's own analytics (its return,
  invested, realized, and income), scoped to its events alone.
- **Advisor can speak to your realized P/L and money-weighted return.** The
  Advisor's portfolio read now includes the same lifetime ledger figures the
  History and Position screens show — money invested, realized gains, income, and
  money-weighted (annualized) return — and can scope them to a single fund, so it
  answers "what's my realized P/L?" or "my return on fund X?" from real numbers.
  It also knows which holdings are custom (self-priced) and treats that price as
  user-supplied rather than live market truth, nudging you to refresh it if stale.
- **Custom assets you price yourself.** A holding with no live NAV provider
  (crypto, a private fund, anything off-catalog) can be a **custom** asset:
  you record its current price, and the app values it from the latest price in
  its own ledger — a Balance's *current price* field or a trade's execution
  price. An unrecognized symbol now defaults to custom rather than assuming a
  market feed that returns nothing. If you later edit a custom holding's symbol
  to one the catalog tracks, it offers to adopt the official fund details and
  switch to the live NAV, keeping your units and cost.
- **Known funds keep their canonical details.** When a holding's symbol matches a
  fund in the catalog, its name, asset class, category, tax wrapper, and TER come
  from there and are locked — only its Portfolio and price Source stay editable —
  so catalog facts can't be overwritten by hand. Custom assets stay fully
  editable.
- **A clearer action menu on each holding.** A ⋮ menu (View history · Edit
  holding) replaces the ambiguous pencil on holding rows and the fund detail
  view, so each action is labelled. Deleting a fund lives inside its Edit form,
  where its destructive effect — removing the fund's whole ledger — is explicit.
- **Recording your holdings again doesn't double-count.** The first Balance you
  record for a fund is its starting balance; any later Balance for the same fund
  is treated as a restatement, which re-bases your units without re-counting the
  money as a fresh contribution. A Balance contributes only the **change** in cost
  basis since the last one — so it captures money you added between balances,
  reads a pure price move as zero new money, and never inflates your invested
  total. Whether a Balance is a starting balance or a restatement is decided by
  what came before it, so deleting one self-heals the rest.
- **The ledger keeps the figure you saw; unit counts and cost self-correct.** When
  you record a Balance by its ฿ value, or a buy/sell by its ฿ amount, that money
  figure is stored as the fact; the unit count is derived from the NAV on that date
  whenever your position is read, never frozen at save. A trade now works **from
  either side** — give a buy/sell its unit count *or* its ฿ amount and the other is
  filled from the NAV on its date (a unit-only trade needs a priceable fund), so you
  can record "bought 50 units" without hunting down what you paid. So if that date's NAV
  arrives late or is later corrected, your units — and the value, gains, and return
  that flow from them — recompute to match, with no re-entry. The same now holds for
  **cost**: a value-only Balance that carries an invested ฿ total (an import showing
  value & P/L, or a cost total) stores that *total* as the fact and derives the
  *per-unit* average cost at the fold — it no longer freezes a per-unit cost computed
  from a NAV-derived unit count. A costed Balance's invested cash also reaches your
  money-weighted return however you entered it (by units or by ฿ total). And a
  value-only Balance the app can't price yet (no NAV on file for its date) no longer
  blanks an existing position — it's held aside and appears when that date's NAV lands.
  This holds for **every fund regardless of how its fund code is capitalized**: the
  NAV lookup normalizes the fund-code case, so a fund cataloged in lowercase derives
  its units and value exactly like one in uppercase (previously such a fund's
  value-only Balance found no NAV and silently dropped from your holdings).
  Your **holdings list itself now folds the ledger on every read** (not just the
  analytics), so units, cost, value, and weight always reflect the latest NAV with no
  refresh — the holdings view and the return figures can never drift apart. The
  `holdings` table no longer stores units or average cost at all (those columns are
  dropped); a holding row now carries only the instrument metadata that isn't in the
  ledger, so there is no derived figure left to go stale.
- **One catalog drives both the symbol suggestions and the price-source badge.** The
  autocomplete and the source badge now resolve from a single authority — the real
  fund catalog (plus the funds you already hold) — so they can never disagree. A
  symbol the catalog knows reads as a Thai fund; anything it doesn't is a **custom**
  (self-priced) asset. There's no shape guessing (a hyphenated code is no longer
  assumed to be a fund) and no hard-coded ticker list; when stocks/ETFs join the
  catalog they'll resolve the same way. You can still flip the badge per row. (Fixed
  along the way: catalog tickers stored lowercase — e.g. some SSF funds — were wrongly
  read as custom; the lookup is now case-insensitive.)
- **Record by ฿ amount — no unit count needed.** Thai broker apps show what a
  holding is worth, not how many units you hold, so a **Balance** now accepts the ฿
  value and a **buy/sell** accepts the ฿ amount; the app derives the units. It
  prices off the price on the row's **own date** — the row's execution / current
  price, else the fund's NAV on that date, never today's moving NAV — so a past
  entry doesn't drift; an entry dated today uses the latest NAV. The divisor is
  always a current price, never your average cost, so value and cost can't be
  conflated. A ฿-total typed in the Add modal persists through collapse/expand. If
  a fund has no price on file for the date, the app keeps your figure rather than
  inventing units — a Balance asks for a unit count; a trade saves and flags it.
- **Explore's browse list ranks each share class on its own fee.** The default
  (no-search) screener now sorts by each priceable class's *own* TER — cheapest
  first — instead of grouping a fund's classes together under the family's cheapest
  class. Previously an expensive class (e.g. a 0.53% retail class) could ride into
  the top alongside a fee-waived sibling; now every row sits at the fee it shows.
  Equal TERs break by fund size then retail-before-restricted. Search is unchanged
  (still relevance-first, with the exact-ticker match floated to the top).
- **Explore's cheapest-first ordering no longer trusts a fee-waived class.** A
  multi-class fund publishes one total-expense figure per class; the screener's
  fund-level TER could latch onto a near-zero special class (e.g. a fee-waived
  `-X`) and brand the whole family with a fee no retail buyer pays, floating it to
  #1 while the row showed the real ~2% retail fee. The fund-level TER now follows
  the class the screener actually leads with — retail over restricted, never an
  institutional/insurance class — so the default list ranks on what you'd pay.
- **The Cash filter in Explore returns money-market funds.** Money-market funds
  were classified as bond because the SEC's coarse `policy_desc` has no
  money-market value, leaving the Cash filter permanently empty. They're now
  recognized from the SEC risk-spectrum code (RS1/RS2 = money market), with the
  fund-name match (Thai `ตลาดเงิน` / English "money market") as a fallback, and
  bucketed as cash-equivalents. (See the risk-spectrum classification note under
  *Changed*.)
- **Explore stops surfacing funds you can't buy.** Funds the SEC marks not-for-retail
  (`proj_retail_type` ≠ `R` — accredited / institutional-only private funds whose
  class detail describes hedging, not audience) are now hidden from the screener,
  and a zero TER is treated as "no published fee" (sorted last, not the cheapest) so
  those funds no longer top the default list.
- **Explore handles non-public share classes correctly.** Provident-fund /
  private-fund / special-group classes are now identified and **down-ranked**
  below retail classes (kept visible — they're investable in principle), while
  unit-linked **insurance** classes are hidden (bought through a policy, not
  directly). General-public availability takes precedence, so a class offered to
  both the public and an insurance channel stays retail. Previously these all fell
  through as unclassified and could top the rankings.
- **Explore search finds share-class tickers, and families rank by popularity.**
  Typing a specific class code (e.g. a multi-class fund's accumulating or dividend
  class) now finds its fund instead of returning nothing — the search index covers
  class tickers, not just parent names. Within a fund, classes are ordered
  most-popular-first by fund size (per-class AUM), an exact ticker match is floated
  to the top, and a deterministic flagship heuristic (retail → primary →
  accumulating) fills in until AUM is warmed.
- **Market data now refreshes on a schedule, and Explore reads deep history
  instantly.** Two background jobs ride the systemd-timer scheduler. A daily
  *freshness* refresh pulls NAV for held positions and tracked indicators, so
  charts (and the unattended digest) are current without anyone opening the app.
  An all-funds NAV + fund-size *pre-warm* crawler fills deep price history for the
  whole registered-fund catalog, so the screener's price / 1-year-return / size
  columns and a cold fund-detail open render immediately instead of fetching on
  first view. Both are idempotent `npm run jobs:*` scripts; the firing mechanism
  is systemd timers, not in-process cron (see the
  [decisions log](docs/explanation/decisions/README.md#picks) + deploy.md).
- **Refreshed sign-in & Account UI.** The login screen leads with "Continue with
  Google" / "Continue with passkey" (each with its provider icon), a quiet
  "Create account" link, and the demo below a divider. Account settings shows all
  sign-in methods in one section (passkeys with per-credential add/remove over
  the linked-provider row), an editable name, and an account email that appears
  only when verified. One shared input radius app-wide.
- **Passkey and Google are now peer sign-in methods, and accounts can't be
  pre-hijacked.** Creating an account with a passkey asks only for your name — no
  email — so no one can register an account at an address they don't control
  (closing both account-takeover and email-squatting). You can start with either
  method and add the other later from Account settings (Link/Unlink providers,
  add/remove passkeys, edit your name), with a guard that always keeps at least
  one working way to sign in — including when you signed up with a provider and
  added a passkey. Your account email mirrors your linked provider: linking
  adopts its verified address, and unlinking your last provider clears it back to
  emailless. The post-sign-in "add a passkey" offer appears only when you don't
  have one yet, and not again once dismissed. Rationale: ADR 0001.
- **Explore and fund detail now work at the share-class level.** A fund's
  priceable share classes are catalogued separately from the parent fund, so
  fees, tax wrapper, distribution policy, ISIN, and NAV are tracked per class.
  Explore lists priceable classes (hiding institutional/insurance classes by
  default), each showing its per-class fee and trailing 1-year return; the fund
  detail offers a class selector that defaults to the retail, accumulating class.
  The classes are gathered in the same SEC crawl as the catalog, with no extra
  API calls.
- **Fund detail now charts its history.** Opening a fund in Explore shows a
  history chart sourced from the cached daily series, with a range selector
  (1M / 3M / 6M / 1Y / All) and a Price / Fund-size (AUM) toggle — read how a
  fund has moved and grown before adding it; the price tooltip also reads the
  cumulative return since the window start. The fund's net assets ride along in
  the same SEC NAV row, so AUM costs no extra fetch. Funds with no cached history
  yet show a graceful empty state.
- **Charts now deepen their own history on demand.** Asking for a longer range
  than the cache holds (e.g. "All" on a fund only ever fetched at six months)
  now re-fetches the full series even while the quote is still fresh, instead of
  showing a truncated window. The market cache records the deepest range fetched
  per symbol and never prunes stored history by age.
- **The fund portfolio table now reads by security and groups by asset type.**
  Each holding leads with its own identifier — the ticker for listed securities
  (e.g. "EWT US"), the issuer for a bank deposit — instead of the SEC's generic
  category text, so distinct ETFs no longer look like duplicate rows. The
  holdings are grouped under a per-category subheader (with the category's summed
  weight) shown once, rather than repeating the category on every row; the
  biggest exposure leads. FX-forward ladders and bond tranches still collapse to
  an expandable net row within their group.
- **Advisor replies now render as Markdown.** The Advisor returns Markdown, and
  the chat now renders it — headings, bold, lists, inline code, code blocks, and
  GFM tables show as formatted text styled to the app's design tokens (tables
  match the in-chat holdings table) instead of raw `**markup**`. Rendering streams
  incrementally as the reply arrives. Only Advisor bubbles are rendered; what you
  type stays plain text. The renderer is sanitized — no raw HTML passes through
  and unsafe link protocols are stripped — so untrusted model output can't inject
  active content.
- **The chat now uses the app's overlay scrollbar.** The Advisor message stream
  scrolls with the same thin, auto-hiding overlay scrollbar as the rest of the
  app (main column, side panels, thread list) instead of the browser's native
  bar, on desktop/tablet; touch keeps the native scrollbar.
- **One unified ledger — your holdings are a projection of your transactions.**
  A single event ledger is the source of truth for positions; the holdings list
  is derived from it and rebuilt on every write, so "what you hold now" and "how
  you got here" can never contradict each other (there is nothing to reconcile).
  The ledger has DELTAS (buy/sell/dividend/fee/split/reinvest) and ANCHORS —
  `opening` (a starting balance) and `snapshot` (a point-in-time restatement) —
  supporting three flows: enter full history, start from an opening balance then
  track forward, or just periodically restate what you hold. One **Add** modal
  records all of it — anchors (shown as a "Balance") and trades sit on the same
  surface, each row's type set per row (see *One Add surface*, above). A
  full-screen **History** view and per-fund **Position** pages read the ledger
  back, and every row is inline-editable — edit, add, or delete in place, with
  balances grouped under their own header and a fund's delete guarded (it removes
  that fund's whole ledger). Editing a holding edits its backing event (or
  records a restatement). From the ledger, History and Position show realized
  gains (average-cost, FIFO available), money-weighted return (XIRR, in THB, once
  there's enough history and a current price), and a cost-basis timeline. A
  position entered without an average cost degrades gracefully — value and
  allocation still work; gains/return show a quiet "add cost" nudge rather than a
  fabricated figure. Design:
  docs/explanation/decisions/0004-unified-ledger-positions-derived.md.
- **The Portfolio screen leads with plain-language checks instead of a 0–100
  grade.** The single composite health score is gone from the screen — a
  chase-able grade nudges the checking-and-tinkering that measurably hurts
  passive index investors. In its place: the "one thing that matters now"
  headline, then four named checks (drift, fees, diversification, cash), each a
  certain value + a status (on track / watch / act) + a one-line reason; the
  charts are the drill-down. Drift with no target reads as a "set a target"
  prompt rather than a failing mark, and holdings whose fee isn't published read
  "not published" rather than a misleading 0%.
- **The diversification check now sees through your funds.** Instead of a
  fund-count diversification index — which punished a clean two-fund index book
  and was fooled by several funds tracking the same index — diversification
  measures *underlying* concentration: the largest single company across all
  your funds (a lower bound, shown as "at least …", since most funds publish
  only a top-5), plus detection of funds that are effectively the same exposure.
  It is coverage-gated and asymmetric — it can flag concentration where holdings
  data exists but never certifies diversification it can't see — and a large
  single *alternative* position is flagged while a large broad-index equity fund
  is not. The composite score is kept for the Advisor's internal use and
  /api/analysis. Rationale + sources: docs/explanation/portfolio-health.md.
- **The Advisor can now see images you attach in chat.** Drop or paste one or
  more screenshots into the chat composer and the Advisor reasons over them
  directly — reconciling a portfolio summary, a transaction history, and
  per-holding detail screens into one set of positions, deriving missing
  units/average cost where the data supports it and asking for anything it can't
  read. When it extracts two or more holdings it shows a compact in-chat table
  that opens the full importer pre-filled for bulk review and save; a single
  position still uses the one-tap add card. You can also ask about a chart or
  factsheet image and get a plain-language answer. Image turns route to a
  dedicated vision model (`VISION_CHAT_MODEL`, default `google/gemini-2.5-flash`;
  set it to `off` to disable); free-tier vision is bounded by the existing daily
  token/cost caps, and demo image upload is off unless an operator sets
  `DEMO_VISION`. Attached images are sent to the vision provider to answer the
  turn and cached only in your browser for the session — never stored on the
  server (the saved message keeps a "[N image(s) attached]" marker). A message
  carries up to 10 images; picking more keeps the first 10 and says how many were
  skipped (rather than dropping them silently), and the chat route enforces the
  same cap. For a larger batch, Add holdings → Image has no per-message limit.
- **The fund detail tables now cue when they scroll sideways.** The
  horizontally-scrollable tables (Performance & Risk, Portfolio, Look-Through)
  fade their content out at whichever edge still hides columns — a subtle
  "more to scroll" hint that reads identically in light and dark (a pure
  opacity mask, no theme tint), and clears at each end. The scroll regions are
  also keyboard-focusable now.
- **The Portfolio performance caveat now reflects which lines actually exclude
  dividends.** The note under the total-balance graph adapts to whether a
  benchmark is selected and whether the book holds a dividend-paying fund,
  explaining that the index, the user's balance, or both understate real total
  return — and showing nothing when neither applies.
- **The demo portfolio chart now shows about five years of realistic history at
  every zoom.** In demo mode the Portfolio chart plots a dense multi-year curve
  for both the portfolio line and the benchmark overlay — daily detail for recent
  months (so 1M/3M/6M/1Y look real) and weekly further back, instead of the few
  months the live price crawl had warmed. The history is self-contained and
  offline at runtime: a committed fixture is built from real public index data
  (S&P 500, Nasdaq, Nikkei, SET, global equity, gold; Thai bonds and cash
  modelled), then each demo fund's series is derived from the index it tracks by
  applying its fee as a compounding drag plus a small deterministic tracking
  wobble, so funds visibly trail their index and the blended portfolio diverges
  from any single benchmark. Owner mode is unchanged — it still reads live market
  data. Regenerate the fixture with `npm run refresh:demo-history`.
- **The Portfolio fee-check section is info-only, with management on a dedicated
  "See details" page.** On the Portfolio tab the section reads as plain
  information cards — each held fund, its cheaper comparable alternative(s), and
  the annual saving — with exactly one section-level "Ask advisor" (a single
  fee-focused prompt scoped to the most material finding and its cheapest
  alternative) and a primary "See details" beneath it. The tab shows only the
  top 3 findings by largest annual saving — when more exist, the "See details"
  button carries the true total ("See all N") — while "See details" still lists
  all of them.
  There are no per-card actions on the tab. "See details" opens a full-screen page (a sub-view of Portfolio, not a
  new tab) that houses all the management UI: each fee check with its own Archive
  ("I've seen this; file it") and "Not for me" (reject, with an optional reason —
  four chips plus a free-text "Other…"), plus a "Hidden checks (N)" list to
  restore anything filed or rejected. Both choices are recorded per fund, survive
  reloads, and resurface only when the finding materially worsens: the reason a
  rejection carries selects how stubborn that is (a magnitude reason can return on
  a bigger jump; a preference or structural reason stays hidden), and a ratchet
  means nothing nags more than once per material jump. A "Not for me" also writes
  a Journal ▸ Feedback entry so the rejection — and its reason — is reviewable and
  feeds the Advisor's "don't repeat rejected advice" context. Suppression is
  applied server-side and is per-user (ephemeral in the demo), built on a reusable
  action-item layer the headline and rebalance suggestions can adopt later.
- **Tapping a holding now opens a read-only detail view instead of the edit
  form.** The Portfolio screen's holding rows open a "Holding detail" sheet that
  reuses the fund detail view — performance, allocation, top holdings, and feeder
  look-through when the position is a catalog fund (matched by its ticker). A
  holding that isn't in the catalog (a stock, index, or cash position) degrades
  to showing its own stored details rather than an error. Editing is now an
  explicit affordance: a pencil button on each editable row, and an Edit button
  inside the detail view, both opening the existing holding edit flow.

### Changed

- **The Advisor's opening greeting is now a centered welcome, not a chat
  bubble.** Before the first message, the greeting sits centered in the empty
  chat (like ChatGPT/Claude) and disappears the moment you send — instead of
  lingering as the first message in every conversation. Reopening the Advisor
  resumes your last chat only if it was active in the last few hours; after a
  longer gap it opens a fresh chat (the previous one stays in your chat list).
  This is per-device.
- **The fund screener loads roughly an order of magnitude faster.** The Explore
  browse query dropped from ~0.8s to under 60ms by skipping the funds' long-form
  policy text in the list read and resolving each share class's latest fund size
  through a dedicated index instead of scanning the full NAV history — the same
  results and ordering, served well within the read-performance budget.
- **Portfolio, holdings, and the fee check load faster, and edits save faster.**
  Two internal loops that grew with portfolio size were batched: the ledger fold
  now resolves every trade date's NAV in a single pass (was one query per distinct
  date — ~70ms became ~6ms on a long history), and the fee check fetches one
  candidate pool per asset class instead of one per holding (~290ms became ~30ms
  for a fund-heavy portfolio). Same results, now within the responsiveness budget.
- **Custom templates are designed with the advisor (or duplicated), not "imported".**
  The Add-template dialog's URL / Text / Image methods were placeholders that
  returned a canned allocation for any input while claiming "AI parsed this
  model" — they're removed rather than shipped as false behavior. The dialog
  now hands off to the advisor conversation, and any template can still be
  duplicated into an editable copy. Real URL/image ingestion is tracked as
  future work.
- **Filter chips, template cards, and journal cards work from the keyboard.**
  Every clickable chip, card, and inline link is now focusable and operable
  with Enter/Space, with a visible focus ring; market-topic chips that never
  did anything no longer look clickable.
- **The plan editor and custom-template dialogs now behave like every other
  dialog.** The journal plan editor and the "Add a custom template" / "Review &
  confirm" model-import dialogs moved onto the standard dialog component, so they
  gain Escape-to-close, focus trapping, a focus-restoring close, scroll lock, and
  an inert background — the same accessibility the rest of the app's dialogs have.
- **Fund asset class (including Cash) is now driven by the SEC risk-spectrum, not
  name-matching.** Each fund's regulatory risk code from the SEC factsheet
  (RS1/RS2 → money market, RS3/RS4 → bond, RS6/RS7 → equity, RS8 → alternative)
  is the primary classification signal; the old `policy_desc` + money-market
  name-match is now only the fallback for the handful of funds without a risk
  code. This recovers money-market funds whose names omit "money market" (e.g.
  treasury / cash-management funds) and fills in asset classes the coarse
  `policy_desc` left blank — so the Cash filter and asset-class screening reflect
  what each fund actually is. Ambiguous risk codes (RS5, which mixes balanced and
  high-yield-bond funds; the complex RS8x codes) defer to the policy label.
- **The SEC fund crawl is now ELT (raw landing + a re-runnable transform).** The
  crawl lands verbatim SEC payloads in a new `sec_raw` table, then an API-free
  transform derives the `fund_catalog` + `fund_fees` columns from them. Re-deriving
  a field — a classification fix, a recovered column — is a seconds-long transform
  re-run (`npm run jobs:transform-catalog`) instead of an ~80-min re-crawl, and
  nothing fetched is discarded at land time. No change to the catalog data or any
  screen; this is the data-infrastructure foundation for SEC-native classification.

### Fixed

- **The demo's history always looks current.** The committed demo NAV/benchmark
  fixture is now re-dated on read so its latest point always lands on today —
  the demo stays recent and daily-dense at any date with no periodic refresh,
  instead of slowly going stale (and tripping date-relative tests) as time passes.

- **Allocation tooltips tint to their chart color and stay readable in dark
  mode.** The drift-from-target tooltip used to render near-black (the bars carry
  color only on their cells, so the chart library had none to apply), unreadable
  on the dark tooltip background. Both the drift and allocation-donut tooltips now
  tint each value to its own bar/slice color, with a theme-safe fallback for any
  element that lacks one.
- **Long chart tooltips no longer overflow the screen on mobile.** Tooltips with
  a long line — most visibly the drift-from-target rows — are now width-capped
  and wrap onto multiple lines instead of running off the chart and past the
  container edge on a narrow phone.
- **Switching between a phone and a desktop layout no longer drops the open
  Advisor chat.** The conversation — including an in-flight reply and unsent
  composer text — is held by a single chat instance that moves between the
  mobile full screen and the desktop dock, so crossing the layout breakpoint
  (rotate, resize, split-view) keeps it intact instead of needing a reload.
- **The date field no longer overflows its cell in the Add-to-portfolio editor
  on iPadOS.** Native date inputs in the record editor get an appearance reset
  so they match the height of the adjacent fields instead of overlapping the
  next one.
- **One account can no longer see another's holdings through shared surfaces.**
  Holdings reads are now bucket-ownership-scoped at the query layer, closing
  the places that read the whole table: fee-creep action items no longer
  include funds only another account holds, a quotes refresh spends provider
  quota only on the caller's own symbols (and stops returning everyone's
  held tickers), and the dividend-disclaimer flag derives from your funds only.
- **Background sweeps now cover every account.** The stale-session close,
  fact extraction, and the 30-day trash purge previously only saw the original
  single-owner rows; the sweep now runs once per registered user with per-user
  scoping intact.
- **A failed plan save no longer silently discards your edits.** The plan
  editor now reports "Couldn't save your plan" and stays open with the draft
  intact (previously it closed as if saved, even on a server error). The
  Templates screen likewise says when it couldn't load instead of showing a
  skeleton forever.
- **Deleted chats are now actually removed after their 30-day window.** The
  trash promised a 30-day restore window then hard removal, but nothing
  performed the removal; the stale-session sweep now does.
- **A broker sync can no longer blank the portfolio chart.** Broker order
  history carries full timestamps ("2017-04-07T00:00:00+07:00"); the importer
  stored them verbatim where the ledger expects a date-only day, which crashed
  the history fold and left the main chart showing "NO HISTORY YET". The
  connector parser now trims a datetime to its local calendar day, the broker
  ingest endpoint rejects anything that isn't date-only, and the transaction
  API's date validation is anchored so a datetime can't slip through as a
  prefix match.
- **Importing a transaction history no longer records every row as a Balance.**
  The image importer now auto-detects whether a screenshot is a holdings
  snapshot (current positions → Balances) or a transaction history (a dated
  buy/sell log → trades) and routes it to the right reader; when it's not sure it
  asks you which it is instead of guessing. Works in both the Add-to-portfolio
  modal and Advisor chat (the Advisor gained a dedicated transaction-import path),
  so a dated buy/sell/switch log lands as trades, not opening balances. Both the
  importer and chat now feed the model the same higher-resolution image, and an
  image you attach in chat is read once and remembered as text — so the Advisor
  can keep discussing it across follow-up turns without asking you to upload it
  again, and Shift+Enter adds a newline in the chat box.
- **A fund with no published fee no longer reads as "0.00%".** The SEC feed
  reports a `0` expense rate two ways that don't mean "free": a new/IPO fund
  carries a fee ceiling but a `0` *actualized* rate until a period elapses, and a
  multi-class fund emits an all-zero `main` placeholder row beside its real
  classes. The TER derivation took those zeros at face value, so a 4.49%-ceiling
  fund showed 0.00% and could top the fee finder's cheapest-first ranking — and
  surface as an absurd "0.00% cheaper alternative" in the portfolio fee check. The
  derivation now treats a `0` rate as "not actualized": an unactualized rate falls
  through to the ceiling, and a fully dataless fee resolves to *no published fee*
  (sorted and excluded like a null) rather than a fake free fund. There is no
  genuinely 0% Thai fund — the feed can't even express one — so this only removes
  false zeros. Applies everywhere TER is read: the screener, the advisor, and the
  fee check.
- **The login screen no longer shows a bot-check under the social sign-in
  buttons.** OAuth sign-in starts a redirect to the provider, which authenticates
  the user — so the Turnstile gate (which protects direct account creation) no
  longer sits on or blocks the "Continue with Google" button. It now appears only
  on the passkey Create-account form, where an account is minted without a
  third-party identity check.
- **The Account screen's "Passkeys" status now reflects reality.** The status tag
  was hardcoded to "active"; an account that signed in with a social provider and
  skipped passkey setup has none, so it now reads "none" until a passkey is
  registered (it previously contradicted the "No passkeys registered yet" list
  directly below it).

- **Fund portfolio holdings no longer duplicate across nightly crawls.** The SEC
  feed sends a holding's reporting `period` as a number, which the incremental
  ingest stored as `"202406.0"` and then compared, as a string, against the
  incoming number — so the de-duplication guard never matched and every crawl
  re-inserted the entire portfolio. On the fund detail view this showed the same
  holding repeated several times and, because the display collapses same-security
  rows and sums their weight, inflated a holding's %NAV (e.g. a 19% position
  summing past 100%). Periods are now normalized to a clean `YYYYMM` string on
  both sides of the guard, so re-crawls are idempotent. A one-time cleanup script
  (`scripts/dedupe-fund-portfolio.mjs`) normalizes existing periods and removes
  the accumulated duplicate rows.
- **A restated reporting period no longer shows its holdings twice.** When the
  SEC re-publishes a fund's factsheet for a period it already reported (a
  restatement, identifiable by a newer `last_upd_date`), the pre-fix ingest had
  appended the whole second snapshot — so the period held two copies of every
  holding and the detail view summed them (e.g. a single ~100%-NAV master fund
  shown twice). The cleanup script now keeps only the latest snapshot per
  reporting period, dropping superseded re-publications; the quarterly history
  across distinct periods is preserved untouched.
  range window (1M/3M/6M/1Y) opened on a non-trading day, holdings with no price
  exactly on that date were missing from the first plotted point, so the chart
  started at a fraction of the real total and snapped up a day or two later. The
  value series now carries in each holding's most recent price from before the
  window to seed the first in-window date (without plotting any date earlier than
  the window start), and the benchmark overlay does the same — so every range
  starts with the full book and a complete benchmark line. Applies to both real
  accounts and the demo.
- **Switching screens now remembers where you were on each one.** Screens are
  swapped in place inside one persistent scroll container, which previously kept
  a single shared scroll offset across the swap — so opening the Templates view
  from the Portfolio screen inherited the Portfolio scroll position and appeared
  partway down. Each screen now keeps its own scroll position for the session:
  returning to a screen restores where you left it, and a screen not yet visited
  opens at the top. The memory is per-session — a full page reload starts every
  screen back at the top. The leaving screen's position is now tracked live while
  you scroll rather than read at teardown, so it survives the in-pane viewport
  clamping its offset when shorter content swaps in — fixing tablet/desktop, where
  returning to a tab previously landed at the top. Works on both the mobile
  (window) and tablet/desktop (in-pane) scroll roots.
- **Performance-vs-index now converts foreign holdings to baht before summing.**
  The portfolio value/return series previously added each holding's `units × NAV`
  across currencies (THB funds, USD ETFs, JPY indices) without conversion, then
  compared the result to a THB index — so for any book holding a foreign asset
  the return reflected the foreign price move, not the baht experience. Each
  holding's native currency is now inferred from its routing key and its value
  is converted to THB at that date's USD/THB (or cross) rate, using the existing
  ECB-backed FX source. A holding whose rate is unavailable is dropped from the
  total and flagged rather than mis-summed.
- **The benchmark line on the performance chart no longer disappears across
  trading calendars.** It was only drawn when the portfolio and benchmark series
  had identical lengths, which Thai and foreign calendars almost never produce;
  the two are now aligned by date and rebased to their first common point, so the
  benchmark renders whenever the data overlaps.
- **Added a method note to the performance-vs-index view** stating that values
  are converted to baht, that the comparison assumes the current holdings were
  held throughout the window (purchases and sales within it are not yet
  accounted for), and that benchmarks use price-return indices, which exclude
  dividends.
- Fee-creep now only suggests cheaper funds with the same exposure (region + asset class), not just the same broad asset class — so a global-equity fund is no longer offered a Thai/domestic-equity "alternative".
- **The portfolio score and its "why this score" breakdown now show for any book
  with holdings, even without a target model.** The breakdown card was previously
  hidden unless a target model was selected, so users tracking no plan never saw
  their score at all; it now renders whenever there are holdings and a score.
- **A portfolio with no target model no longer has its score inflated by an
  auto-awarded drift component.** Previously the drift component silently scored
  full marks when no target was set, rewarding the absence of a plan. Drift is now
  excluded from the composite when there's no target and the remaining components
  (fees, diversification, cash) are rescaled onto 0–100; the breakdown shows the
  drift row as "Not scored — set a target model" rather than a full mark.
- **Holdings with an unpublished expense ratio no longer inflate the fee score.**
  The blended fee was computed with unknown TERs treated as 0% (perfect), making a
  book with missing fee data look cheaper than it is. The blended rate is now
  weighted over holdings with a known TER only, and the fee component notes "fee
  data incomplete for N holdings" when any are missing — missing data neither
  helps nor hurts the score.

- **Advisor eval harness — a committed benchmark for the chat loop.**
  `scripts/eval/` promotes the throwaway model-trial script into a repeatable
  eval: a hermetic synthetic tool surface (`EXAMPLE-FUND-*`, never the live DB),
  two question tiers (retrieve-then-explain + complex multi-step), and a
  deterministic grader scoring each answer on grounded facts, right tool calls,
  and no invented holdings — plus dead-end rate, latency, tokens, and est cost.
  Run `npm run eval:advisor` before flipping `FREE_TIER_MODEL`, editing the
  system prompt, or tuning the reasoning gate. A token-free vitest
  (`tests/eval/`) guards its structure; the prompt is shared with the route via
  `lib/advisor/system-prompt.ts` so the benchmark can't drift from production.
  Grounded in a new prior-art survey
  ([research/agent-evals.md](./docs/explanation/research/agent-evals.md)) and
  written up as [inference-strategy.md § 7 Evaluation](./docs/explanation/inference-strategy.md):
  reports the metrics separately (dead-end rate, quality, `pass^k` reliability,
  and grounded-facts / tool-trace / no-hallucination sub-signals), grades against
  pre-declared per-tier thresholds (PASS/FAIL; `EVAL_GATE=on` exits non-zero), and
  tests negative cases (`mustNotCallTools` over-call guards). An LLM-as-judge
  layer is deliberately deferred until the deterministic floor demands it.

- **Eval harness rigor — uncertainty, grounding, refusal, and run diffing.**
  Builds on the eval harness so before/after comparisons are statistically honest
  and mechanical: quality is now reported with a **95% confidence interval** (so a
  gap that's only run-variance is visible), and `npm run eval:diff -- <before>
  <after>` compares two result files — per-question score deltas, `pass^k` flips,
  and a **paired McNemar significance test** over the shared question set. Each
  result file is tagged with its git SHA. The grader gained **argument grounding**
  (`expectToolArgs` — asserts a tool was called with the right inputs, not just by
  name), a **trajectory bound** (`maxSteps`/`minSteps` — a lookup that takes five
  generations is thrashing), and a **negative control** (an empty-holdings turn
  where the right answer is "you have no holdings yet" and naming a fund is a
  hallucination), so refusing is rewarded alongside answering. Runs persist each
  turn's step count and tool calls with their arguments for after-the-fact audit.
  All token-free, guarded by `tests/eval/`.

- **Tool-result shaping — compact model-facing tool outputs.**
  The heavy reads (`read_portfolio`, `read_performance`, `find_funds`,
  `find_cheaper_alternatives`) now expose a lean text view to the model via
  `toModelOutput` while the UI still gets the full object (proposal cards and
  fund lists unchanged). Keeps the headline facts (largest holding, drift, fee,
  the benchmark gap, each fund's TER), drops JSON scaffolding/HHI/ids — measured
  54–73% smaller per result. In the eval the retrieve tier went to zero
  dead-ends with higher quality. Shapers are pure (`lib/advisor/shape.ts`).

- **Reasoning-intent gate — reason only when it earns its cost.**
  A cheap deterministic classifier (`lib/advisor/intent.ts`) raises reasoning
  `effort` to `medium` on the owner/trusted paths only for genuine multi-step
  turns (rebalance, SSF-vs-RMF, plan-anchored tilt) and `none` otherwise;
  free/demo stay pinned `none` (cost-protected). Measured on the complex tier,
  `medium` lifted answer quality 78%→88% at ~3.5× latency — so paying it only on
  the turns that earn it is the win. `REASONING_GATE=off` restores model-default
  reasoning. See [inference-strategy.md §3](./docs/explanation/inference-strategy.md).

- **Inference-strategy docs — how the Advisor stays smart/fast/token-efficient.**
  A new design doc ([inference-strategy.md](./docs/explanation/inference-strategy.md))
  records the cost/latency/quality decisions for the Advisor — model routing &
  tiers, prompt-cache strategy, reasoning-token policy (with a "when should the
  Advisor reason?" decision table), context loading, and tool-result shaping —
  the principle behind each lever. It's backed by two new fact-checked prior-art
  surveys:
  [llm-platform-primitives.md](./docs/explanation/research/llm-platform-primitives.md)
  (how Anthropic/OpenAI/Gemini/OpenRouter expose tool calling, system prompts,
  reasoning tokens, citations & structured output) and
  [context-and-caching.md](./docs/explanation/research/context-and-caching.md)
  (prompt-caching cost/latency math + context-window management / progressive
  loading). The existing context-engineering survey had its flagged-unverified
  claims (Anthropic metrics, Hermes internals, iteration caps, LangGraph
  specifics) re-checked against primary sources and reworded.

- **Context-aware Ask-Advisor handoff — fewer tool round-trips.** The
  Ask-Advisor buttons now hand the Advisor a small structured **context
  envelope** (the screen, the intent, the subject in focus, and the figures the
  screen already computed) alongside the visible prompt, instead of burying it
  all in a sentence. The two high-value dashboard findings — *Plan the rebalance*
  (carries the tracking gap + target) and the fee-creep *Ask advisor* (carries
  the held fund, its TER, the cheaper alternative + its TER) — let the Advisor
  answer from those facts without re-deriving them via `read_portfolio`; the fund
  and model-strategy buttons tag the subject. The envelope is injected as a
  per-turn message **after** the cached system/memory prefix (never into it), so
  it can't invalidate prompt caching, and it's defensively parsed server-side.
  Plain typed turns and open-ended prompts are unchanged (the field is additive).
  The envelope reserves an `image` slot as the future home for in-chat vision.

- **Free tier can run a cheap paid model, bounded by a daily cost cap.** The
  free-tier chat model is now its own operator knob (`FREE_TIER_MODEL`, default
  the zero-cost `openrouter/free`) — set it to a cheap paid model (e.g.
  `google/gemini-2.5-flash`) to lift answer quality without touching the owner
  chain. It reads its OWN var, never `AI_MODELS`, so the long-standing "a free
  user can't be widened to a paid model by an owner-chain slip" invariant holds
  by construction. Spend stays bounded by two pre-request caps: the always-on
  daily **token** cap and a new optional daily **cost** cap in cents
  (`DAILY_CENTS_BUDGET_FREE`/`_TRUSTED`) — the right bound for a paid model with
  asymmetric input/output pricing. Per-turn cost is estimated from a
  `MODEL_PRICES` table (USD/Mtok) keyed on the model OpenRouter actually served;
  free/unpriced models contribute zero, so the cap is a no-op until you opt in.
  Owner mode stays uncapped.

- **Reasoning disabled on the cost-sensitive paths.** Free-tier, demo, and the
  ancillary title/extract calls now send `reasoning: { effort: "none" }` to
  OpenRouter, so a reasoning-capable model the router lands on doesn't silently
  burn hidden chain-of-thought (billed at the output rate, and measured at 8–29s
  vs ~2s per turn) on a chat turn that doesn't need it. Owner and trusted tiers
  keep their model-default reasoning — selectively raising effort for genuinely
  analytical asks is a planned, intent-gated follow-up. Non-reasoning models
  ignore the flag, so it's a safe no-op for them.

- **Reliable Advisor replies — no more "I didn't have a reply."** Free-tier chat
  turns that read a tool but stopped before writing an answer — or that hit an
  upstream provider error mid-turn — now recover automatically: the Advisor
  re-runs the final answer step with the data it already gathered, or retries
  once on an error, so a tool-using question lands a real reply instead of a
  dead-end. The recovery is model-agnostic (it doesn't depend on any single free
  model behaving), and applies across demo, free, and owner chat.

- **Context-aware Advisor starter prompts.** The chat composer's suggestion
  chips now reflect the user's actual portfolio and the screen they're on
  instead of a fixed list — surfacing prompts about a concentrated top holding,
  a cash drag, drift from the selected target model, or a high blended fee, and
  biasing toward the active screen (Markets, Explore, Models, Journal,
  Portfolio). A fresh or empty portfolio gracefully falls back to evergreen
  learning prompts.

- **Add holdings from a screenshot — structured import.** The Add-holdings
  **Image** tab now reads one or more broker screenshots into an **editable
  review table** shared with Paste/CSV and manual table entry, instead of
  dumping raw transcription text. Most Thai broker apps show market value +
  allocation %, not units — so where a fund's NAV is on file the importer
  derives units (`value ÷ NAV`) and average cost, marks them estimated, and
  highlights rows that still need quantity (open the fund's detail view for
  exact figures). Upload several images and the rows merge. Powered by a vision
  model (`OCR_MODEL`, default `google/gemini-2.5-flash`), validated on real Thai
  statements for faithful ฿/decimal reading; the screenshot is read once and
  never stored.

- **Confirm-before-delete on destructive actions** — deleting a holding,
  portfolio, or custom model template, purging a chat thread, removing a passkey,
  or signing out everywhere now routes through a consistent confirmation dialog
  (replacing native `window.confirm` and one unguarded one-click delete), so no
  irreversible action happens on a single mis-tap. The reversible 30-day chat
  trash and an ordinary sign-out stay one-tap.
- **Legal links on the front door** — the landing footer now links the Terms of
  Service and Privacy Policy pages.
- **Instant fund search** — the fund finder typeahead is backed by an in-memory
  MiniSearch index (`lib/search/fund-index.ts`): fuzzy + prefix matching, field
  boosting, and curated index-nickname synonyms. It folds each feeder fund's
  **master** fund name into the index, so a search for "S&P500" surfaces feeder
  funds like KKP US500-UH. Replaces the old `LIKE '%q%'` scan that couldn't use
  an index or match by master fund; lookups are sub-50ms.
- **Real index levels** — new EODHD and FMP market providers return the **actual**
  index level (S&P 500, Nasdaq-100, Dow, Nikkei, Thai SET) where a free real
  source exists, instead of an ETF proxy. Provider chain is FMP → EODHD → Twelve
  Data (ETF proxy) → Frankfurter (FX) → Yahoo, degrading gracefully to the prior
  proxy/Yahoo behaviour when keys are unset. MSCI ACWI stays an ETF proxy (no
  free real index) and gold stays XAU/USD. New env vars `EODHD_API_KEY` and
  `FMP_API_KEY` (both free-tier). This is the "reliable index/FX source (Yahoo
  429 fix)" the README listed as planned — Yahoo hard-429s datacenter
  IPs and the keyed providers resolve it.
- **Database split into app.db + market.db** — the single SQLite is split along a
  lifecycle boundary: **app.db** is the system of record (accounts, buckets,
  holdings, plans, journal, models, chat, preferences, user market indicators)
  and **market.db** holds regenerable data (fund catalog/fees/performance/
  portfolio/feeder + the NAV/quote cache). A two-handle `DbContext` routes queries
  by domain; no join crosses the boundary. better-auth uses app.db; backups cover
  app.db only (market.db is regenerable and excluded from restic). Demo sessions
  get an isolated in-memory app.db but share the real market.db read-write, like a
  real user — demo reads from and warms the same NAV/quote cache (market data is
  global, so demo cache fills just cut redundant upstream fetches). New env var
  `MARKET_DB_PATH` (default `data/market.db`, same `data/` volume); the existing
  combined DB was migrated once into the split layout at rollout. Rationale: blast-radius
  isolation (the nightly SEC refresh can't endanger accounts), lean backups,
  credential-free dev clones, demo-with-real-data.
- **Denormalized `fund_catalog.current_ter`** — the finder sorts and annotates
  TER from a cached column on `fund_catalog` (maintained by `upsertFundFees`; the
  source of truth stays `fund_fees`), dropping the per-fund fee-history query.
  Browse-all and search are ~tens of ms. Composite `(proj_id, period)`
  performance/portfolio indexes round it out.
- **Drag-to-reorder** — **Manage Indicators** uses `@dnd-kit/react` (off the
  legacy `@dnd-kit/core` line); tier labels removed. The **Portfolios sidebar**
  reorders the portfolio list, persisted via a `buckets.position` column and
  `PATCH /api/portfolios/reorder`.
- **Navigation labels** — the **Funds** tab is **Explore** (catalog discovery,
  not a holdings list) and the **Chat** tab is **Advisor** (the AI investment
  advisor). Screen ids are unchanged, so routing is unaffected by the rename.
- **Login screen** — the sign-in screen matches the landing aesthetic: brand
  mark + wordmark (clickable home), pill buttons, and clearer copy (drops the
  "real DB" jargon; uses the **Advisor** / **Explore** names). A signed-in user
  hitting `/login` is redirected server-side rather than via a client-side
  bounce, so there's no flash of the login UI; the post-OAuth passkey prompt
  and the demo sign-in path are unaffected.
- **Fund detail dedupe** — duplicate portfolio rows are collapsed by identity
  (ISIN, or issuer + description) into one expandable net row.
- **Persistence layer** — SQLite + Drizzle (15 tables), daily rotating backups,
  full CRUD APIs, SWR fetchers; all seven screens read from the DB.
- **Passkey auth + demo mode** — better-auth + WebAuthn passkeys, secure-by-
  default gate (`AUTH_DISABLED=1` opt-out for local dev), per-session isolated
  in-memory demo databases routed via AsyncLocalStorage.
- **AI chat** — streaming `/api/chat` via the Vercel AI SDK + OpenRouter (one
  key, every major model), owner/demo provider routing, IP rate limit, security
  headers; chat history + thread-list sidebar with recency grouping and
  per-thread delete.
- **Advisor tool-calls** — read portfolio / **performance** / plan / journal,
  write journal, propose plan edit, propose holding; capped tool loop; per-user
  scoped. `read_performance` reports the portfolio's period return alongside the
  same-window SET + S&P 500 returns, so the advisor can answer "am I beating my
  index?" with real numbers. The advisor gives concrete, plan-anchored
  buy/sell/hold + rebalancing guidance (educational, with a standing disclaimer)
  and references only tickers its tools returned. **Proposal cards** (plan edits
  and holdings) that write through only on accept.
- **Portfolio analysis** — transparent 0–100 score (deterministic, from drift /
  fees / concentration / cash, with a per-component breakdown); the Plan &
  Health panel is driven by real signals (drift, blended TER, concentration,
  cash drag, rebalance hint).
- **Interactive charts** (recharts) with hover + tooltips, including a
  portfolio-vs-benchmark overlay (SET / S&P 500 / Nasdaq / Nikkei) drawn from
  real index series, aligned to the portfolio's dates and rebased to a common
  start.
- **Market data** — SET + global indices and FX (Yahoo); **Thai fund NAVs +
  NAV history** (Thai SEC Open API) behind a provider registry +
  `holdings.quote_source` taxonomy. Resilient to upstream rate-limits: a
  stale-on-error cache fallback and per-symbol backoff keep a warmed cache
  serving through Yahoo 429s, the Markets screen shows an honest "unavailable"
  state instead of fabricated numbers when nothing loads, and the demo cache is
  pre-warmed (indices + NAV history) so charts render instantly.
- **RSS news aggregator** — curated long-horizon editorial feeds on the markets
  screen (parallel fetch, dedupe, 30-min cache, partial-failure resilience);
  HTML entities in titles are decoded, including double-encoded ones.
- **Portfolio import** — Paste/CSV upload, editable table entry with symbol
  autocomplete (seed of known Thai funds + global indices, merged with the
  user's holdings), and **image OCR** (statement screenshot → structured rows via
  an OpenRouter vision model). The Add-holdings sheet validates rows before
  saving; quantity is required and average cost is optional.
- **Holding sources** — tag where each holding is held with a free-text source
  (suggestions from your past sources + common Thai fund platforms); rename a
  source across all your holdings from Settings → Sources.
- **Long-term memory** — bitemporal `user_preferences`, memory tools, always-on
  system-prompt injection, Settings → Memory, chat sidebar (auto-title, 30-day
  trash). Plus session lifecycle (active/idle/archived), real-time session-close
  extraction of durable facts (incremental, watermarked), chat summarization at
  ~80% context, `recall_preferences`, and sidebar full-text search (FTS5).
  Guide: [docs/explanation/memory.md](./docs/explanation/memory.md).
- **Multi-user with per-user data isolation** — `user_id` on app tables with
  **fail-closed scoping** (each account sees only its own rows; built-ins opt
  in explicitly), per-user investment plans, owner backfill from `OWNER_EMAIL`,
  `requireUser()` on API routes; holdings are scoped through their owning bucket
  (ownership validated on read + write).
- **Identity providers** — Google OAuth (env-gated; boots passkey-only with
  nothing set), post-OAuth passkey-registration prompt.
- **Quotas + tier gating** — `free` (free-model router only) vs `trusted`
  (owner model chain), daily token cap, per-user usage logging, limit UI.
- **Owner admin** — an owner-only screen (gated on `OWNER_EMAIL`, enforced
  server-side on every request) to list users and flip account tiers
  `free`↔`trusted`, replacing hand-written SQL; guarded against self-demote.
- **Sign-up gate** — Cloudflare Turnstile (dev-bypass when unset), wired auth
  rate limit, and an inline consent notice ("By continuing, you agree…") at
  account creation. `/legal/terms` + `/legal/privacy` are operator-configurable
  (name / contact / jurisdiction via env; nothing operator-specific committed).
- **Account page** — single "Sign in" section with passkeys (revoke, with a
  last-passkey lockout guard) named from their AAGUIDs, linked OAuth providers,
  usage, and sign-out everywhere.
- **Public signed-out landing page** for the shared link, with CTAs to sign in
  or try the demo. Real-app screenshots ride inside the iPhone bezel SVGs on
  the hero and Advisor sections (with a graceful fallback to the coded mocks);
  a "bigger canvas" section between the Advisor spotlight and the four-stage
  Loop shows the desktop screenshot inside a pure macOS-style window border —
  rounded rect, multi-layer shadow + hairline ring, image's natural aspect
  ratio drives the height.
- **Tooling baseline** — Biome (lint + format), GitHub Actions CI, Dependabot,
  git pre-commit hooks, Node 24.
