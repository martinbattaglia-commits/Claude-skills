# Design system

A lookup catalog of the app's real CSS tokens, classes, and shared UI components —
the high-reuse subset of [`app/globals.css`](../../app/globals.css) and
[`components/`](../../components), so new UI matches what already ships.

[`app/globals.css`](../../app/globals.css) is **canonical**; this page mirrors the
parts you reach for most. When a value here disagrees with the stylesheet, trust the
stylesheet and fix this doc. Colors are **always tokens** (`var(--…)`), never raw hex
in components — the tokens are theme-aware (light/dark) and hardcoding a color breaks
dark mode.

## Color tokens

Defined in `:root` (light) and `[data-theme="dark"]` (dark).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f8f8f9` | `#0c0d0f` | Page background |
| `--paper` | `#ffffff` | `#16181b` | Card / modal background |
| `--card-soft` | `#f1f2f4` | `#101215` | Muted card, chip background |
| `--ink` | `#0a0a0b` | `#f4f5f7` | Primary text |
| `--ink-soft` | `#3a3d43` | `#c5c8cd` | Secondary text |
| `--muted` | `#7e828a` | `#7a7f87` | Tertiary text, disabled |
| `--muted-2` | `#a8acb2` | `#595d63` | Faintest text |
| `--line` | `#e6e7ea` | `#22252a` | Borders, dividers |
| `--line-soft` | `#eff0f2` | `#1b1e22` | Subtle lines |
| `--accent` | `#10a86b` | `#19c37d` | Primary action (green) |
| `--accent-ink` | `#076339` | `#19c37d` | Text on an accent background |
| `--accent-soft` | `#e3f6ec` | `rgba(25,195,125,0.14)` | Accent background tint |
| `--accent-2` | `#0aa694` | `#14c9af` | Secondary green |
| `--gain` | `#10a86b` | `#19c37d` | Positive / gain |
| `--loss` | `#d14545` | `#f46a6a` | Negative / loss |
| `--amber` | `#d89a1f` | `#e4b440` | Warning, fee, "cost not recorded" |
| `--info` | `#4c7ac9` | `#6e96e6` | Informational |
| `--chip-bg` | `#f1f2f4` | `#1b1e22` | Filter-chip / tab-track background |
| `--chip-active-bg` | `#ffffff` | `#262a30` | Active segmented-control background |

**Usage shorthand:** `--gain`/`--loss` for movement, `--amber` for warnings & fees,
`--accent` for primary CTAs, `--muted` for secondary text, `--paper`/`--card-soft` for
surfaces, `--ink`/`--ink-soft` for text.

## Shadows, radius, spacing

```css
/* Shadows — note the dark theme overrides these (not the same as light) */
--shadow-sm: 0 1px 2px rgba(10,10,11,0.04);                                    /* dark: none */
--shadow-md: 0 4px 24px -8px rgba(10,10,11,0.08), 0 1px 2px rgba(10,10,11,0.04); /* dark: 0 8px 24px -8px rgba(0,0,0,0.5) */
--shadow-lg: 0 24px 48px -16px rgba(10,10,11,0.16), 0 2px 4px rgba(10,10,11,0.04); /* dark: 0 24px 48px -16px rgba(0,0,0,0.6) */

/* Border radius */
--r-sm: 6px;  --r-md: 10px;  --r-lg: 14px;  --r-xl: 18px;  --r-2xl: 22px;  --r-full: 999px;

/* Spacing — compact density ([data-density="compact"]) tightens these */
--gap: 12px;       /* compact: 9px  */
--pad-card: 16px;  /* compact: 12px */
```

## Numbers, money & dates

Numeric values use the mono font and tabular figures so columns align.

- **`--font-mono`** = `"Geist Mono", ui-monospace, "SF Mono", monospace`.
- **`.num`** — `font-family: var(--font-mono); font-feature-settings: "tnum"; font-variant-numeric: tabular-nums`. Apply to any currency, percentage, date, or unit count.
- **Money** renders in baht (`฿`, U+0E3F).

Shared formatters live in [`lib/format.ts`](../../lib/format.ts) (exported, reusable):

| Helper | Signature | Output |
|---|---|---|
| `fmtTHBClean` | `(n, decimals = 0)` | `฿1,250,000` / `-฿320` (handles sign + decimals) |
| `fmtPct` | `(n, decimals = 1)` | `+12.5%` / `-3.2%` — **`n` is already in percent units, and the sign is always prefixed** (it does *not* multiply by 100) |
| `fmtNum` | `(n, d = 2)` | grouped fixed-decimal number |
| `fmtRelativeDate` | `(iso, now?)` | `today` / `1 day ago` / `3 weeks ago` |

> Some formatters are intentionally **local** to one component, not exported — e.g.
> `EventLine.tsx` has its own `baht`, `units`, `price`, and a `fmtDate` ("12 Mar 2026",
> UTC). Reuse the `lib/format.ts` exports; lift a component-local helper into
> `lib/format.ts` only when a second caller needs it.

## Screen shell

| Class | Purpose / key CSS |
|---|---|
| `.screen` | Full-screen view container (`opacity: 1`; flex column from parent). |
| `.topbar` | Sticky header. `position: sticky; top: var(--demo-banner-h,0px); z-index: 30; padding: 14px 16px 8px; height/min-height: var(--topbar-h)` (mobile 50px); `background: var(--bg)`. Hides on scroll via `useScrollHide` (`[data-topbar-hidden="true"]` on body). |
| `.brand` | Left title. `font-size: 16px; font-weight: 500; letter-spacing: -0.02em; display: flex; gap: 9px`. |
| `.brand-chip` | Badge by the title (e.g. "DEMO"). Mono `9px`, `padding: 2px 6px; border-radius: 4px; background: var(--card-soft); border: 1px solid var(--line-soft); color: var(--muted)`. |
| `.sub-tabs` | Sticky text-tab bar. `display: flex; gap: 4px; padding: 8px 16px; position: sticky; top: calc(var(--topbar-h) - 2px + var(--demo-banner-h,0px)); z-index: 20; background: var(--bg); overflow-x: auto; scrollbar-width: none`. Buttons: transparent, `color: var(--muted)`, `13px/500`, `border-radius: var(--r-full)`; active via `[data-active="true"]` → `background: var(--ink); color: var(--bg)`. |
| `.portfolio-switch` | Same sticky frame as `.sub-tabs` but pill buttons: `background: var(--card-soft); border: 1px solid var(--line-soft); color: var(--ink-soft); 12.5px/500; padding: 7px 12px; border-radius: 999px`; active → `background: var(--ink); color: var(--bg); border-color: transparent`. Subtext `.pf-sub`: mono `9.5px`, `var(--muted)`, left divider. |

```jsx
<div className="brand" style={{ flex: 1 }}>
  <span>Portfolio</span>
  {isDemo && <span className="brand-chip">DEMO</span>}
</div>
```

## Section headers

`.section` (`padding: 0 16px; margin-bottom: 14px`) wraps a `.section-header`
(`display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
margin-bottom: 6px; padding: 0 4px`). Inside: an `<h3>` (`14px/500; letter-spacing:
-0.01em; color: var(--ink); margin: 0`) and an optional right-side `.link` (`11px/400;
color: var(--muted); text-decoration: none; white-space: nowrap`).

```jsx
<div className="section">
  <div className="section-header">
    <h3>Holdings</h3>
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="link">View all</span>
      <button className="icon-btn" onClick={onAction}>
        <Icon name="settings" size={14} />
      </button>
    </span>
  </div>
  {/* content */}
</div>
```

## Cards & summary blocks

| Class | Key CSS |
|---|---|
| `.card` | `background: var(--paper); border-radius: var(--r-lg); padding: var(--pad-card); border: 1px solid var(--line-soft)`. |
| `.card-soft` | `background: var(--card-soft); border-radius: var(--r-lg); padding: var(--pad-card)`; no border. |
| `.hero-block` | Big headline number. Container `padding: 6px 16px 4px`. `.hero-label` (`10.5px; var(--muted); letter-spacing: 0.02em`), `.hero-value` (`36px/500; letter-spacing: -0.035em; line-height: 1; tabular-nums`) with `.cents` inside (`var(--muted); 400; 22px`), `.hero-sub` (`display: flex; gap: 6px; margin-top: 8px; 12.5px; flex-wrap: wrap`). |
| `.stat-cards` / `.stat-card` | Auto-fit KPI grid: `grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 10px 4px 4px`. Each `.stat-card`: `border: 1px solid var(--line-soft); border-radius: var(--r-md); padding: 10px 12px`, with `.stat-card__label` (mono `10px`, `var(--muted)`, `letter-spacing: 0.05em`), `.stat-card__value` (`18px/600; tabular-nums`), `.stat-card__caption` (`10px; var(--muted); line-height: 1.35`). |
| `.stats-strip` | Fixed 4-column KPI strip. `margin: 10px 16px 12px; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; background: var(--card-soft); border-radius: var(--r-md); padding: 10px 4px`; cells centered with `border-right: 1px solid var(--line)` (except last). `.lbl` mono `9.5px`, `.val` mono `12px/500`. |
| `.delta-pill` | Change badge. `background: var(--accent-soft); color: var(--accent-ink); 500; padding: 3px 8px; border-radius: var(--r-sm); display: inline-flex; gap: 4px; tabular-nums`. Loss variant `.down` → `background: color-mix(in oklab, var(--loss) 12%, transparent); color: var(--loss)`. |

```jsx
<div className="hero-block">
  <div className="hero-label">TOTAL VALUE</div>
  <div className="hero-value">฿1,250,000<span className="cents">50</span></div>
  <div className="hero-sub">
    <span className="delta up">+฿12,500</span>
    <span className="delta-pill">+2.4%</span>
  </div>
</div>
```

## Rows & list items

### Holdings row — `.holding`

The canonical dense row, and the grammar every list-like surface reuses.

- `.holdings-list` container: `padding: 0 8px`.
- `.holding`: `display: grid; grid-template-columns: 32px 1fr auto; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer`; hover `background: var(--card-soft)`.
- `.swatch` (col 1): `32×32; border-radius: 8px; display: grid; place-items: center; font-family: var(--font-mono); font-size: 9.5px; font-weight: 600; color: white`. Holds a short tag (e.g. a 3-char abbreviation) on a token-colored background.
- Middle column: `.name` (`13px/500; letter-spacing: -0.01em`, ellipsized) over `.sub` (`11px; var(--muted)`, ellipsized).
- Right column: `.value` (mono `12.5px; text-align: right; tabular-nums`) over `.pct` (mono `10.5px; text-align: right; tabular-nums`).

```jsx
<button className="holding" onClick={() => openDetail(h)}>
  <div className="swatch" style={{ background: h.color }}>SPY</div>
  <div style={{ minWidth: 0 }}>
    <div className="name">{h.name}</div>
    <div className="sub">{h.ticker}</div>
  </div>
  <div style={{ textAlign: "right" }}>
    <div className="value">฿{h.value.toLocaleString()}</div>
    <div className="pct">{(h.pctOfTotal * 100).toFixed(1)}%</div>
  </div>
</button>
```

### Transaction row — `EventLine`

A ledger event renders in **the same `.holding` grammar** (not a separate
`.evline` system) so an activity list reads as one list with Holdings below it.
Use the component directly — [`components/history/EventLine.tsx`](../../components/history/EventLine.tsx):

```jsx
import { EventLine } from "@/components/history/EventLine";

<EventLine txn={txn} realized={realizedGainOrUndefined} onOpen={() => onEdit(txn)} />
```

How it maps onto the row:

- **Swatch** = a kind abbreviation on a kind-tinted background. Abbreviations:
  `BUY · SELL · DIV · FEE · SPL · RE · BAL` (`opening`/`snapshot` both show **BAL**).
  Tones: buy → `--accent`, sell → `--loss`, dividend/reinvest → `--accent-2`,
  fee/split → `--muted-2`, balance anchors → `--amber`.
- **Name** = verb + ticker (`Bought EXAMPLE-FUND-A`, `Sold …`, `Dividend …`,
  `Balance · …`). `hideTicker` drops the ticker on a position page; `hideVerb`
  drops the verb under a "Starting balances" header.
- **Sub** = date, then a kind-specific detail (`100 @ ฿25.50`, `paid in cash`, `fee`,
  or `… units` for an anchor), then the source if present. A balance anchor with no
  recorded price appends a `var(--amber)` "· cost not recorded" note.
- **Right** = the amount (`.value`; fees prefixed `−`, splits show none), and on a
  sell the realized gain as `.pct.delta.up`/`.down`.

Props: `txn: Transaction`, `realized?: number` (THB, from analytics), `onOpen: () => void`,
`hideTicker?: boolean`, `hideVerb?: boolean`.

### Market index grid

A `.card` with `padding: 0` wrapping a `display: grid; grid-template-columns: 1fr 1fr`
of cells (`padding: 12px`, inner `1px solid var(--line-soft)` borders). Each cell: a mono
`10px var(--muted)` symbol label, a `16px/500` tabular value, and a `.delta up`/`.down`
change line. Layout is composed inline per usage rather than via dedicated classes.

## Change / delta treatment

- **`.delta`** — `font-family: var(--font-mono); tabular-nums`; `.up` → `color: var(--gain)`, `.down` → `color: var(--loss)`.
- **`.pct`** — mono `10.5px; text-align: right; tabular-nums` (often combined with `.delta`).
- Conditional inline color is the norm for one-off numbers: `style={{ color: n >= 0 ? "var(--gain)" : "var(--loss)" }}`.

```jsx
<span className={`delta ${change >= 0 ? "up" : "down"}`}>
  {change >= 0 ? "+" : "−"}฿{Math.abs(change).toFixed(2)}
</span>
```

## Chips, filters, tabs

| Class | Key CSS |
|---|---|
| `.filter-chips` / `.chip` | Scrolling toggle row: `display: flex; gap: 6px; padding: 4px 16px 8px; overflow-x: auto; scrollbar-width: none`. Chip: `padding: 4px 11px; border-radius: 999px; background: var(--chip-bg); color: var(--ink-soft); 11.5px/500; border: 1px solid var(--line-soft)`; active `[data-active="true"]` → `background: var(--ink); color: var(--bg); border-color: transparent`. |
| `.method-tabs` | Segmented control (2–3 options): `display: flex; gap: 4px; padding: 2px; background: var(--chip-bg); border-radius: 9px; margin-bottom: 14px`. Buttons `flex: 1; transparent; color: var(--muted); 12.5px/500; padding: 7px; border-radius: 7px`; active → `background: var(--chip-active-bg); color: var(--ink); box-shadow: var(--chip-shadow)`. |
| `.portfolio-switch` | See [Screen shell](#screen-shell). |

```jsx
<div className="method-tabs">
  <button data-active={method === "paste"} onClick={() => setMethod("paste")}>Paste</button>
  <button data-active={method === "image"} onClick={() => setMethod("image")}>Image</button>
</div>
```

## Buttons

`.btn` base: `font-family: var(--font-sans); 14px/500; border: 0; border-radius:
var(--r-md); padding: 11px 18px; display: inline-flex; align-items: center;
justify-content: center; gap: 6px; letter-spacing: -0.01em; transition: transform
0.06s ease, background 0.18s`; `:active` → `transform: scale(0.98)`.

| Variant | Effect |
|---|---|
| `.btn.primary` | `background: var(--ink); color: var(--bg)` — main CTA |
| `.btn.accent` | `background: var(--accent); color: white` — secondary CTA |
| `.btn.ghost` | `transparent; color: var(--ink); border: 1px solid var(--line)` |
| `.btn.danger` | `background: var(--loss); color: white` — destructive |
| `.btn.full` | `width: 100%; display: flex` — block |
| `.btn.sm` | `padding: 7px 12px; 12.5px; border-radius: var(--r-sm)` |
| `.btn.link` | `transparent; border: 0; color: var(--muted); padding: 4px 6px; 400` |

**`.icon-btn`** — square icon button: `28×28; border-radius: 8px; border: 1px solid
var(--line); background: var(--paper); color: var(--ink-soft); display: grid;
place-items: center`; hover → `background: var(--card-soft); color: var(--ink)`;
`:focus-visible` → `outline: 2px solid var(--accent); outline-offset: 2px`. The
`.quiet` modifier makes it borderless/transparent/`var(--muted)`. Inside
`.modal-footer` it grows to `40×40`.

## Modals & forms

Use the [`Modal`](../../components/Modal.tsx) component — it handles the portal,
focus trap, scroll-lock, `inert` backgrounding, Escape/Tab, and the footer scroll
shadow. Don't hand-roll the overlay.

```jsx
import { Modal } from "@/components/Modal";

<Modal open={open} onClose={onClose} variant="form" labelledBy="title-id">
  <Modal.Header
    title="Add holding"
    subtitle="Add a single holding. Use the import sheet for multiple at once."
    id="title-id"
  />
  <Modal.Body gap={14}>
    {/* form rows */}
    <div className="modal-body-sentinel" />
  </Modal.Body>
  <Modal.Footer>
    <div className="modal-footer-end">
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={onSave}>Save</button>
    </div>
  </Modal.Footer>
</Modal>
```

**API:**

- `Modal` props: `open`, `onClose`, `variant?: "confirm" | "form" | "detail"` (default `form`), `labelledBy?`, `role?`, `className?` (for a width modifier like `modal--txnwide`), `children`.
- `Modal.Header` takes **named props**, not header JSX: `title`, `subtitle?`, `id?`, `showClose?` (defaults on for `detail`), `action?` (right-side node, left of the ✕), `children?`. It renders the close ✕ itself (`<Icon name="close" size={16} />`).
- `Modal.Body` props: `gap?` (px between children), `children`. Drop a `<div className="modal-body-sentinel" />` at the bottom to drive the footer scroll-shadow.
- `Modal.Footer` slots: `.modal-footer-start` (left, destructive) and `.modal-footer-end` (right, primary; auto right-aligned).

**Variant widths** (CSS): `.modal` base `max-width: 560px; border-radius: 28px;
box-shadow: 0 10px 40px rgba(0,0,0,0.18); animation: dialogIn 0.25s`. `.modal--confirm`
→ `400px`, `.modal--detail` → `640px`. The `.modal--txnwide` **class modifier** (passed
via `className`, not a variant) → `880px` on `min-width: 600px`. Overlay
`.modal-overlay` is `rgba(0,0,0,0.32)` at `z-index: 100`; `.modal-overlay--confirm`
stacks at `z-index: 200`.

**Form inputs:**

- **`FormRow`** wraps a labeled field (label + optional hint) — the standard way to lay out a form line; see [`HoldingSheet.tsx`](../../components/HoldingSheet.tsx).
- **`.sheet-input`** — unified text/select/textarea: `width: 100%; background: var(--card-soft); border: 1px solid var(--line-soft); border-radius: 8px; padding: 10px 14px; font-family: var(--font-sans); 13.5px; color: var(--ink)`; focus → `border-color: var(--accent); background: var(--paper)`. Textarea variant switches to mono `12.5px` and `resize: vertical`.
- **`.manual-row`** — multi-holding entry grid: `grid-template-columns: minmax(0,2fr) 1fr 1fr 28px` (narrow: `minmax(0,1.4fr) minmax(66px,1fr) minmax(66px,1fr) 22px`), with a `.type-badge` (absolute, top-right of the symbol input; `[data-overridden="true"]` flips it to `var(--accent)`).
- **`.txn-row`** — bulk transaction importer grid: `border: 1px solid var(--line-soft); border-radius: 10px; padding: 8px 10px; background: var(--card-soft)`; wide columns `124px 98px minmax(110px,1.4fr) minmax(60px,0.8fr) minmax(60px,0.8fr) minmax(56px,0.7fr) minmax(82px,1fr) 28px`, collapsing to a 12-column grid under `760px`. Remove control `.txn-row__remove`.
- **`.source-seg`** — inline segmented control to bulk-set a price source across rows.
- **`.drop-zone`** — image upload target: `border: 1.5px dashed var(--line); border-radius: 14px; padding: 28px 16px; text-align: center; background: var(--card-soft)`; hover → `border-color: var(--accent)`. Title `.dz-title` (`13.5px/500`), subtitle `.dz-sub` (`11.5px; var(--muted)`).

## Empty states

A centered `.card` with an icon/emoji, a `16px/500` heading, a `13px var(--ink-soft)`
description (`max-width: 280px`), then `.btn` actions in a column. The
holdings-empty fallback on Portfolio is simpler: `color: var(--muted); font-size:
13px; padding: 24px; text-align: center`.

## Shared components — reuse, don't re-implement

| Component | Path | Gives you |
|---|---|---|
| `Modal` (+ `.Header`/`.Body`/`.Footer`) | [`components/Modal.tsx`](../../components/Modal.tsx) | Accessible dialog: portal, focus trap, scroll-lock, Escape/Tab, footer shadow |
| `Icon` | [`components/Icon.tsx`](../../components/Icon.tsx) | Inline SVG by `name` + `size` (e.g. `<Icon name="close" size={16} />`) |
| `EventLine` | [`components/history/EventLine.tsx`](../../components/history/EventLine.tsx) | A ledger event in the native `.holding` row |
| Format helpers | [`lib/format.ts`](../../lib/format.ts) | `fmtTHBClean`, `fmtPct`, `fmtNum`, `fmtRelativeDate` |

## High-reuse class summary

| Pattern | Classes / component | Use case |
|---|---|---|
| Screen frame | `.screen`, `.topbar`, `.brand`, `.sub-tabs` | Any full-screen view |
| Section + header | `.section`, `.section-header`, `<h3>`, `.link` | Grouping with a right-side action |
| Card container | `.card`, `.card-soft` | Any grouped block |
| Dense row | `.holding` (+ `.swatch`/`.name`/`.sub`/`.value`/`.pct`) | List of items with a swatch |
| Transaction row | `EventLine` component | Activity / ledger lists |
| KPI grid | `.stat-cards`/`.stat-card`, or `.stats-strip` | Summary metrics |
| Buttons | `.btn.primary`/`.ghost`/`.sm`, `.icon-btn` | Actions |
| Chips / tabs | `.filter-chips`+`.chip`, `.method-tabs` | Toggles, method selection |
| Modal + forms | `Modal`, `.sheet-input`, `FormRow` | Dialogs, add/edit/import sheets |
| Delta / change | `.delta.up`/`.down`, `.delta-pill` | Gain/loss indication |
| Mono numbers | `.num` + tabular-nums | Currency, percentages, dates |
