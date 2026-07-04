// Transaction-import parsing + normalization — pure, client-safe (no DB, no
// network, no "server-only"), so the Add-transactions sheet and the API route
// share one contract.
//
// A transaction is a buy/sell/dividend/fee/split/reinvest event. The confirmation
// table is the human gate, so parsing is tolerant: it reads what it can and
// flags what the user must fill in.

import type { QuoteSource } from "@/lib/market/sources";
import type { TxnKind } from "./lots";

// The DELTA kinds the Activity importer (paste / CSV / image) reads and offers in
// its kind dropdown. Anchors (`opening`/`snapshot`) are NOT here — they are
// created by the Snapshot flow, not typed into a transaction history.
export const TXN_KINDS: readonly TxnKind[] = [
  "buy",
  "sell",
  "dividend",
  "fee",
  "split",
  "reinvest",
] as const;

/** Position anchor kinds — absolute fund-position assertions (see ADR 0004). */
export const POSITION_ANCHOR_KINDS: readonly TxnKind[] = ["opening", "snapshot"] as const;

// Explicit cash kinds (issue #149), scoped to a named cash account. `deposit` /
// `withdraw` are cash DELTAS; `cash_balance` is a cash ANCHOR (absolute restatement
// of a bucket's cash, the cash analogue of a fund Balance).
export const CASH_DELTA_KINDS: readonly TxnKind[] = ["deposit", "withdraw"] as const;
export const CASH_ANCHOR_KINDS: readonly TxnKind[] = ["cash_balance"] as const;
export const CASH_KINDS: readonly TxnKind[] = [...CASH_DELTA_KINDS, ...CASH_ANCHOR_KINDS] as const;

/** Every anchor kind (fund position + cash). */
export const ANCHOR_KINDS: readonly TxnKind[] = [
  ...POSITION_ANCHOR_KINDS,
  ...CASH_ANCHOR_KINDS,
] as const;

/** Every valid ledger kind (fund deltas + anchors + cash kinds). */
export const LEDGER_KINDS: readonly TxnKind[] = [
  ...TXN_KINDS,
  ...POSITION_ANCHOR_KINDS,
  ...CASH_KINDS,
] as const;

/** True for any valid stored ledger kind. */
export function isTxnKind(v: unknown): v is TxnKind {
  return typeof v === "string" && (LEDGER_KINDS as readonly string[]).includes(v);
}

/** True for a FUND DELTA kind only (excludes anchors + cash) — what the Activity importer accepts. */
export function isDeltaKind(v: unknown): v is TxnKind {
  return typeof v === "string" && (TXN_KINDS as readonly string[]).includes(v);
}

/** True for an anchor kind (opening / snapshot / cash_balance). */
export function isAnchorKind(v: unknown): v is TxnKind {
  return typeof v === "string" && (ANCHOR_KINDS as readonly string[]).includes(v);
}

/** True for an explicit cash kind (deposit / withdraw / cash_balance). */
export function isCashKind(v: unknown): v is TxnKind {
  return typeof v === "string" && (CASH_KINDS as readonly string[]).includes(v);
}

/** True for a cash anchor (cash_balance). */
export function isCashAnchorKind(v: unknown): v is TxnKind {
  return typeof v === "string" && (CASH_ANCHOR_KINDS as readonly string[]).includes(v);
}

/**
 * Auto-promote repeat anchors (ADR 0004). The FIRST anchor for a fund is its
 * Starting balance (`opening`); any LATER anchor on the same fund — e.g. a user
 * re-pasting their current holdings every few months — is a Restatement
 * (`snapshot`), which re-bases units WITHOUT re-counting the money as a new
 * contribution. Given the tickers that already carry an anchor (DB state) and an
 * ORDERED batch of incoming rows, returns each row's effective kind. Ticker
 * matching is case-insensitive. Pure — callers do the DB read + write.
 */
export function promoteAnchorKinds(
  alreadyAnchored: Iterable<string>,
  incoming: readonly { kind: TxnKind; ticker: string }[],
): TxnKind[] {
  const anchored = new Set<string>();
  for (const t of alreadyAnchored) anchored.add(t.trim().toUpperCase());
  return incoming.map((row) => {
    const key = row.ticker.trim().toUpperCase();
    let kind = row.kind;
    if (kind === "opening" && anchored.has(key)) kind = "snapshot";
    if (isAnchorKind(kind)) anchored.add(key);
    return kind;
  });
}

/**
 * Canonical sign for the stored `amount` from a transaction kind. The API
 * receives a POSITIVE magnitude + a kind; the server derives the sign here so a
 * client can never send a sign that disagrees with the kind (which would invert
 * realized-gain / IRR). Cash out is negative, cash in is positive; a split and a
 * snapshot move no cash. A costed `opening` is cash out (the magnitude is the
 * cost put to work); an uncosted opening passes magnitude 0 → a 0 flow.
 */
export function signFor(kind: TxnKind): -1 | 0 | 1 {
  switch (kind) {
    case "buy":
    case "fee":
    case "reinvest":
    case "opening":
    // A deposit commits cash to the portfolio (money in, like a buy) → negative for XIRR.
    case "deposit":
      return -1;
    case "sell":
    case "dividend":
    // A withdraw returns cash to the user (money out, like a sell) → positive for XIRR.
    case "withdraw":
      return 1;
    case "split":
    case "snapshot":
    // A cash_balance is an absolute restatement — it moves no cash, like a snapshot.
    case "cash_balance":
      return 0;
  }
}

/** Apply {@link signFor} to a positive magnitude. */
export function signedAmount(kind: TxnKind, magnitude: number): number {
  return signFor(kind) * Math.abs(magnitude);
}

/** A draft row in the editable confirmation table (before save). */
export interface TxnDraftRow {
  /** ISO-8601 date, best-effort; empty string until the user supplies one. */
  tradeDate: string;
  kind: TxnKind;
  ticker: string;
  englishName?: string;
  units: number | null;
  pricePerUnit: number | null;
  /** POSITIVE THB magnitude the user sees; the server applies the sign. */
  amount: number | null;
  fee: number | null;
  quoteSource: QuoteSource;
  /** True when no usable amount could be derived — the user must enter one. */
  needsAmount: boolean;
  /** True when the trade's units can be resolved at the fold — a read count, an
   *  execution price (units = amount ÷ price), or a feed-priced fund (NAV bridges).
   *  False only for a CUSTOM asset given cash but no count and no price: it would
   *  fold to 0 units, so both inline editors reject it (split rows are exempt). */
  unitsResolvable: boolean;
  /** True when no trade date is present — the user must enter one. */
  needsDate: boolean;
}

/**
 * Loose input to {@link normalizeTxnDraft}: numeric fields accept the raw
 * strings the editable table holds (or numbers from a parser), normalized via
 * coercion. Kept separate from {@link TxnDraftRow} so the table can pass its
 * string state directly.
 */
export interface TxnDraftInput {
  tradeDate?: string;
  kind?: TxnKind | string;
  ticker?: string;
  englishName?: string;
  units?: number | string | null;
  pricePerUnit?: number | string | null;
  amount?: number | string | null;
  fee?: number | string | null;
  quoteSource?: QuoteSource;
}

/**
 * Fill derivable fields and recompute the validation flags for a draft row.
 *  - amount, when blank, is derived as units × price folded with the fee
 *    (buys add the fee to the cash out, sells net it from the cash in);
 *  - a split needs no amount (it moves no cash);
 *  - quoteSource is inferred from the ticker if not pinned.
 */
export function normalizeTxnDraft(row: TxnDraftInput): TxnDraftRow {
  // The Activity importer only deals in fund deltas; an anchor kind here falls back
  // to a buy (anchors are created by the Snapshot flow, not the transaction table).
  // Cash deltas (deposit/withdraw) are pure-฿ events that keep their kind.
  const kind: TxnKind =
    isDeltaKind(row.kind) || (isCashKind(row.kind) && !isCashAnchorKind(row.kind))
      ? (row.kind as TxnKind)
      : "buy";
  const ticker = (row.ticker ?? "").trim();
  const units = numOrNull(row.units);
  const price = numOrNull(row.pricePerUnit);
  const fee = numOrNull(row.fee);
  let amount = numOrNull(row.amount);

  if (amount === null && units !== null && price !== null && kind !== "split") {
    const gross = Math.abs(units * price);
    const f = fee ?? 0;
    // Cash out on a buy includes the fee; cash in on a sell nets it.
    amount = signFor(kind) < 0 ? gross + f : Math.max(0, gross - f);
  }

  const tradeDate = normalizeDate(row.tradeDate ?? "");
  // Default to custom; the catalog resolver (/api/quote-source) promotes a real fund.
  const quoteSource = row.quoteSource ?? "manual";
  const hasUnits = units !== null && units > 0;
  const feed = quoteSource !== "manual";

  return {
    tradeDate,
    kind,
    ticker,
    englishName: row.englishName?.trim() || undefined,
    units,
    pricePerUnit: price,
    amount,
    fee,
    quoteSource,
    // A units-only trade on a feed-priced fund (catalog / market) is NOT missing its
    // amount — it derives from units × NAV(date) at the fold. A custom asset has no
    // NAV, so units alone still needs a price (or the ฿ amount).
    needsAmount: kind !== "split" && (amount === null || amount <= 0) && !(hasUnits && feed),
    // The fold turns the ฿ amount into units via the execution price or NAV; a custom
    // asset has neither, so a count/price is the only bridge (else it folds to 0 units).
    unitsResolvable: kind === "split" || hasUnits || price !== null || feed,
    needsDate: tradeDate === "",
  };
}

/**
 * Why a draft row isn't ready to save — the single SEMANTIC source of truth both
 * inline editors map to their own copy (the Add modal's terse row nudge vs the
 * History editor's full-sentence error). One reason → one piece of guidance, so
 * the two surfaces can word it differently but never advise differently.
 */
export type RowInvalidReason =
  | "missing-ticker"
  | "missing-date"
  /** A trade with no figure at all — needs an amount (or units). */
  | "missing-amount"
  /** A split with no post:pre ratio (its `units`). */
  | "missing-ratio"
  /** A trade carries a figure but is a custom asset with no price to bridge
   *  units ↔ cash (units-only or amount-only): it needs a price. */
  | "needs-price"
  /** An anchor (Balance) with neither a unit count nor a ฿ value. */
  | "balance-needs-figure"
  /** A value-only custom Balance with no current price to value it. */
  | "custom-needs-price";

/**
 * Input to {@link rowValidity}: a draft's loose fields plus the two anchor-only
 * extras the editors hold separately — a Balance's stated ฿ `value` and a
 * custom asset's `currentPrice` (RecordSheet's `currentPrice` / History's
 * `marketPrice`) used to value a value-only custom Balance.
 */
export interface RowValidityInput extends TxnDraftInput {
  value?: number | string | null;
  currentPrice?: number | string | null;
}

/**
 * The SINGLE accept/reject gate shared by both inline editors (the Add modal's
 * `valid()` and the History editor's `save()`), so they accept and reject every
 * balance/trade combination identically. Anchors and deltas branch here once:
 *  - Anchor (Balance): needs a ticker, a date, and a figure (units OR ฿ value).
 *    A value-only CUSTOM Balance also needs a current price — it has no NAV, so
 *    without one its units can't be found and the position would vanish.
 *  - Delta (trade): needs a ticker and a date; a split is ready with a ratio
 *    (units); any other trade needs a usable amount AND units it can resolve at
 *    the fold (a count, an execution price, or a feed-priced fund) — a custom
 *    amount-only trade with no price folds to 0 units and is rejected.
 */
export function rowValidity(
  row: RowValidityInput,
): { ok: true } | { ok: false; reason: RowInvalidReason } {
  const ticker = (row.ticker ?? "").trim();
  if (!ticker) return { ok: false, reason: "missing-ticker" };

  if (isAnchorKind(row.kind)) {
    if (normalizeDate(row.tradeDate ?? "") === "") return { ok: false, reason: "missing-date" };
    const units = numOrNull(row.units);
    const value = numOrNull(row.value);
    const hasUnits = units !== null && units > 0;
    const hasValue = value !== null && value > 0;
    if (!hasUnits && !hasValue) return { ok: false, reason: "balance-needs-figure" };
    const custom = (row.quoteSource ?? "manual") === "manual";
    const hasPrice = numOrNull(row.currentPrice) !== null;
    if (hasValue && !hasUnits && custom && !hasPrice)
      return { ok: false, reason: "custom-needs-price" };
    return { ok: true };
  }

  const d = normalizeTxnDraft(row);
  if (d.needsDate) return { ok: false, reason: "missing-date" };
  // A split moves no cash but needs its ratio (units); a unit-less split is a no-op.
  if (d.kind === "split")
    return d.units != null ? { ok: true } : { ok: false, reason: "missing-ratio" };
  const hasUnits = d.units != null && d.units > 0;
  if (d.needsAmount) {
    // No resolvable cash. With units already typed, what's missing is a PRICE (a
    // custom asset has no NAV to value them); with nothing typed, a figure.
    return { ok: false, reason: hasUnits ? "needs-price" : "missing-amount" };
  }
  // Dividends, fees, and cash deposits/withdrawals are pure CASH events — no fund
  // position to resolve, so they're exempt from the units-resolvable gate (a ฿
  // amount alone is enough; they fold into a cash position at face value).
  if (d.kind === "dividend" || d.kind === "fee" || d.kind === "deposit" || d.kind === "withdraw")
    return { ok: true };
  // A figure is present but it's a custom asset with no price to turn ฿ ↔ units.
  if (!d.unitsResolvable) return { ok: false, reason: "needs-price" };
  return { ok: true };
}

/**
 * Parse pasted text / CSV into draft transaction rows. Tolerant of comma, tab,
 * or whitespace delimiters and an optional header row; columns map by header
 * name when a header is present, else positionally as
 * `date, type, ticker, units, price, amount, fee`. Lines it can't make sense of
 * are skipped — the confirmation table is the final gate.
 */
export function parseTxnPaste(text: string): TxnDraftRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const delim = pickDelimiter(lines[0]);
  const split = (line: string): string[] =>
    delim === "ws" ? line.split(/\s+/) : line.split(delim).map((c) => c.trim());

  // Header detection: first line has a known column word and no obvious numbers.
  const headerCells = split(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = headerCells.some((c) => HEADER_WORDS.has(c)) && !/\d/.test(lines[0]);
  const colMap = hasHeader ? buildColumnMap(headerCells) : null;

  const rows: TxnDraftRow[] = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cells = split(lines[i]);
    const draft = colMap ? rowFromColumns(cells, colMap) : rowPositional(cells);
    if (draft?.ticker) rows.push(normalizeTxnDraft(draft));
  }
  return rows;
}

/**
 * Light-touch heuristic for the snapshot-importer scope-guard: does this set of
 * rows look like a TRANSACTION history rather than a current-holdings snapshot?
 * Two signals — the same ticker repeated across rows (a holdings snapshot has
 * one row per fund), or per-row trade dates. Deliberately conservative: it only
 * nudges the user toward the transaction importer, never blocks.
 */
export function looksLikeTransactionHistory(
  rows: readonly { ticker?: string; tradeDate?: string }[],
): boolean {
  if (rows.length < 3) return false;
  const counts = new Map<string, number>();
  let withDate = 0;
  for (const r of rows) {
    const t = (r.ticker ?? "").trim().toUpperCase();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (r.tradeDate && normalizeDate(r.tradeDate)) withDate++;
  }
  const maxRepeat = Math.max(0, ...counts.values());
  const distinct = counts.size;
  // A ticker appearing 3+ times, OR most rows carrying a date, OR many more rows
  // than distinct funds (repeated trading in a few funds).
  return (
    maxRepeat >= 3 || withDate >= Math.ceil(rows.length / 2) || rows.length >= 2 * distinct + 1
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

const HEADER_WORDS = new Set([
  "date",
  "type",
  "kind",
  "action",
  "side",
  "ticker",
  "symbol",
  "fund",
  "code",
  "units",
  "shares",
  "qty",
  "quantity",
  "price",
  "nav",
  "amount",
  "value",
  "total",
  "fee",
  "commission",
]);

interface ColumnMap {
  date?: number;
  type?: number;
  ticker?: number;
  units?: number;
  price?: number;
  amount?: number;
  fee?: number;
}

function buildColumnMap(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((cell, i) => {
    if (/date/.test(cell)) map.date ??= i;
    else if (/type|kind|action|side/.test(cell)) map.type ??= i;
    else if (/ticker|symbol|fund|code/.test(cell)) map.ticker ??= i;
    else if (/units|shares|qty|quantity/.test(cell)) map.units ??= i;
    else if (/price|nav/.test(cell)) map.price ??= i;
    else if (/amount|value|total/.test(cell)) map.amount ??= i;
    else if (/fee|commission/.test(cell)) map.fee ??= i;
  });
  return map;
}

function rowFromColumns(cells: string[], map: ColumnMap): Partial<TxnDraftRow> | null {
  const at = (i?: number) => (i === undefined ? undefined : cells[i]);
  const ticker = at(map.ticker)?.trim();
  if (!ticker) return null;
  return {
    tradeDate: at(map.date) ?? "",
    kind: parseKind(at(map.type)),
    ticker,
    units: coerce(at(map.units)),
    pricePerUnit: coerce(at(map.price)),
    amount: coerce(at(map.amount)),
    fee: coerce(at(map.fee)),
  };
}

// Positional fallback: pull the date, a kind keyword, a ticker, and up to three
// numbers (units, price, amount) out of the line wherever they sit.
function rowPositional(cells: string[]): Partial<TxnDraftRow> | null {
  let tradeDate = "";
  let kind: TxnKind | undefined;
  let ticker = "";
  const numbers: number[] = [];
  for (const cell of cells) {
    if (!tradeDate && looksLikeDate(cell)) {
      tradeDate = cell;
      continue;
    }
    const k = parseKindLoose(cell);
    if (!kind && k) {
      kind = k;
      continue;
    }
    const n = coerce(cell);
    if (n !== null) {
      numbers.push(n);
      continue;
    }
    if (!ticker && /[A-Za-z]/.test(cell)) ticker = cell.trim();
  }
  if (!ticker) return null;
  const [units, price, amount] = numbers;
  return {
    tradeDate,
    kind: kind ?? "buy",
    ticker,
    units: units ?? null,
    pricePerUnit: price ?? null,
    amount: amount ?? null,
  };
}

function parseKind(v: string | undefined): TxnKind {
  return parseKindLoose(v) ?? "buy";
}

/** Map free-text (incl. Thai broker wording) to a TxnKind, defaulting to "buy". */
export function coerceKind(v: string | undefined): TxnKind {
  return parseKind(v);
}

function parseKindLoose(v: string | undefined): TxnKind | null {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return null;
  // Thai labels (no case) — a switch "สับเปลี่ยน" arrives as its legs: ออก (out) =
  // a sell, เข้า (in) = a buy.
  if (s.includes("ซื้อ") || s.includes("เข้า")) return "buy";
  if (s.includes("ขาย") || s.includes("ออก")) return "sell";
  if (s.includes("ปันผล")) return "dividend";
  if (s.includes("ค่าธรรมเนียม")) return "fee";
  if (/^(buy|bought|purchase|subscribe|subscription|add)/.test(s)) return "buy";
  if (/^(sell|sold|sale|redeem|redemption|withdraw)/.test(s)) return "sell";
  if (/^(reinvest|drip)/.test(s)) return "reinvest";
  if (/^(dividend|distribution|interest|coupon)/.test(s)) return "dividend";
  if (/^(fee|charge|commission|tax)/.test(s)) return "fee";
  if (/^split/.test(s)) return "split";
  return null;
}

function pickDelimiter(line: string): "," | "\t" | "ws" {
  if (line.includes("\t")) return "\t";
  if (line.includes(",")) return ",";
  return "ws";
}

function looksLikeDate(s: string): boolean {
  return /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s) || /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(s);
}

// Thai (Buddhist-era) calendar gap: 2569 พ.ศ. = 2026 ค.ศ.
const BE_OFFSET = 543;

const THAI_MONTHS: Record<string, number> = {
  มกราคม: 1,
  กุมภาพันธ์: 2,
  มีนาคม: 3,
  เมษายน: 4,
  พฤษภาคม: 5,
  มิถุนายน: 6,
  กรกฎาคม: 7,
  สิงหาคม: 8,
  กันยายน: 9,
  ตุลาคม: 10,
  พฤศจิกายน: 11,
  ธันวาคม: 12,
};

/** A year that is clearly Buddhist-era (≥ 2200) folded back to Gregorian. */
function gregorianYear(year: number): number {
  return year >= 2200 ? year - BE_OFFSET : year;
}

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Best-effort ISO-8601 date (YYYY-MM-DD), or "" if unparseable. Handles Thai
 * month names and Buddhist-era years (e.g. "16 มีนาคม 2569" → "2026-03-16"). */
export function normalizeDate(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";

  // Thai "D <month> YYYY" (e.g. "16 มีนาคม 2569"); year is usually Buddhist era.
  for (const [name, month] of Object.entries(THAI_MONTHS)) {
    if (!s.includes(name)) continue;
    const m = s.match(new RegExp(`(\\d{1,2})\\s*${name}\\s*(\\d{4})`));
    if (m) return iso(gregorianYear(Number(m[2])), month, Number(m[1]));
  }

  // Already ISO-ish (YYYY-MM-DD) — fold a Buddhist-era year if present.
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return iso(gregorianYear(Number(isoMatch[1])), Number(isoMatch[2]), Number(isoMatch[3]));
  }
  // D/M/Y — assume day-first (Thai/EU convention) for ambiguous values.
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (dmy[3].length === 2) year += 2000;
    return iso(gregorianYear(year), Number(dmy[2]), Number(dmy[1]));
  }
  return "";
}

function coerce(v: string | undefined): number | null {
  if (v === undefined) return null;
  const cleaned = v.replace(/[฿$,%\s]/g, "").replace(/^\+/, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return coerce(v);
  return null;
}
