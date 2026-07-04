// Parse a broker export into Macrotide's import format. Pure + isomorphic, and
// SHAPE-DRIVEN: the broker's per-order field names + status/type strings come
// from the connector's `shape` (defaulting to the built-in shape), so a new broker is a
// manifest, not new code. The export WRAPPER ({source, accounts:[{history}]}) is
// Macrotide's own normalized shape (the collector produces it), so only the raw
// order objects need shape mapping.

import type {
  BrokerAccount,
  BrokerImportResult,
  BrokerImportStats,
  BrokerOrder,
  ConnectorShape,
  ExtractedTxnRow,
  FieldRef,
} from "./types";

type OrderMap = Required<{
  type: FieldRef;
  ticker: FieldRef;
  status: FieldRef;
  tradeDate: FieldRef;
  amount: FieldRef;
  units: FieldRef;
  fee: FieldRef;
  dividendAmount: FieldRef;
  ref: FieldRef;
  switch: { toTicker: FieldRef; inAmount: FieldRef; inUnits: FieldRef };
}>;
type ValuesMap = Required<NonNullable<ConnectorShape["values"]>>;

const DEFAULT_ORDER: OrderMap = {
  type: "order_type",
  ticker: "fund_name",
  status: "status",
  tradeDate: "trade_date",
  amount: "net_transaction_amount",
  units: ["net_transaction_unit", "unit"],
  fee: "fee",
  dividendAmount: ["amount", "net_transaction_amount"],
  ref: "ref",
  switch: {
    toTicker: "sw_to_fund",
    inAmount: "sw_in_net_transaction_amount",
    inUnits: "sw_in_net_transaction_unit",
  },
};
const DEFAULT_VALUES: ValuesMap = {
  success: ["SUCCESS", "COMPLETE"],
  cancel: ["CANCEL", "CANCELLED"],
  pending: ["PENDING"],
  buy: ["buy"],
  sell: ["sell"],
  switch: ["switch"],
  dividend: ["dividend"],
};

/** Walk a dot-path (`fund.code`) off an object; a key with no dots is a plain
 *  lookup. Mirrors the collector's `GP` so client + server resolve paths alike. */
function getPath(obj: unknown, path: string): unknown {
  if (path.indexOf(".") === -1) return (obj as Record<string, unknown>)?.[path];
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** First-present value for a field ref (a key/dot-path, or candidates tried in
 *  order — first non-null wins). */
function get(o: BrokerOrder, ref: FieldRef): unknown {
  if (Array.isArray(ref)) {
    for (const k of ref) {
      const v = getPath(o, k);
      if (v != null) return v;
    }
    return undefined;
  }
  return getPath(o, ref);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function text(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
/** The ledger stores a DATE-ONLY local calendar day, but brokers commonly send
 *  a full ISO datetime with a UTC offset ("2017-04-07T00:00:00+07:00"). The
 *  date part of such a value IS the broker's local day — take it, drop the
 *  time. Non-ISO shapes pass through untouched for the caller to validate. */
function isoDay(v: unknown): string | undefined {
  const s = text(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  return m ? m[1] : s || undefined;
}
function lc(list: string[]): string[] {
  return list.map((s) => s.toLowerCase());
}

/** Map ONE order to the trade rows it represents (switch → two rows). */
function orderToRows(
  o: BrokerOrder,
  ord: OrderMap,
  vals: ValuesMap,
): { rows: ExtractedTxnRow[]; kind: string | "unknown" } {
  const ticker = text(get(o, ord.ticker)).trim();
  const date = isoDay(get(o, ord.tradeDate));
  const raw = text(get(o, ord.type)).trim().toLowerCase();
  const units = () => num(get(o, ord.units));
  const amount = () => num(get(o, ord.amount));
  const fee = () => num(get(o, ord.fee));

  if (lc(vals.buy).includes(raw) || lc(vals.sell).includes(raw)) {
    if (!ticker) return { rows: [], kind: "unknown" };
    const kind = lc(vals.buy).includes(raw) ? "buy" : "sell";
    return {
      kind,
      rows: [{ ticker, kind, tradeDate: date, units: units(), amount: amount(), fee: fee() }],
    };
  }

  if (lc(vals.dividend).includes(raw)) {
    if (!ticker) return { rows: [], kind: "unknown" };
    return {
      kind: "dividend",
      rows: [
        { ticker, kind: "dividend", tradeDate: date, amount: num(get(o, ord.dividendAmount)) },
      ],
    };
  }

  if (lc(vals.switch).includes(raw)) {
    const toFund = text(get(o, ord.switch.toTicker)).trim();
    const rows: ExtractedTxnRow[] = [];
    if (ticker)
      rows.push({
        ticker,
        kind: "sell",
        tradeDate: date,
        units: units(),
        amount: amount(),
        fee: fee(),
      });
    if (toFund)
      rows.push({
        ticker: toFund,
        kind: "buy",
        tradeDate: date,
        units: num(get(o, ord.switch.inUnits)),
        amount: num(get(o, ord.switch.inAmount)),
      });
    return { rows, kind: rows.length ? "switch" : "unknown" };
  }

  return { rows: [], kind: "unknown" };
}

interface OrderWithAccount {
  order: BrokerOrder;
  accountCode?: string;
}

/** Navigate the (Macrotide-normalized) export wrapper into a flat order worklist. */
function collectOrders(payload: unknown): {
  orders: OrderWithAccount[];
  accounts: number;
  sourceTag: string;
} {
  if (Array.isArray(payload))
    return {
      orders: (payload as BrokerOrder[]).map((order) => ({ order })),
      accounts: 1,
      sourceTag: "broker",
    };

  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const sourceTag = typeof p.source === "string" && p.source.trim() ? p.source.trim() : "broker";

    if (Array.isArray(p.accounts)) {
      const accts = p.accounts as BrokerAccount[];
      const orders: OrderWithAccount[] = [];
      for (const a of accts)
        if (Array.isArray(a.history))
          for (const order of a.history) orders.push({ order, accountCode: a.account_code });
      return { orders, accounts: accts.length, sourceTag };
    }
    if (Array.isArray(p.history))
      return {
        orders: (p.history as BrokerOrder[]).map((order) => ({ order })),
        accounts: 1,
        sourceTag,
      };
    if (Array.isArray(p.data))
      return {
        orders: (p.data as BrokerOrder[]).map((order) => ({ order })),
        accounts: 1,
        sourceTag,
      };
  }
  return { orders: [], accounts: 0, sourceTag: "broker" };
}

/** Stable dedup key: `sourceTag:accountCode:ref`, else a content hash + warning. */
function externalIdBase(
  o: BrokerOrder,
  ord: OrderMap,
  sourceTag: string,
  accountCode: string | undefined,
): { base: string; fallback: boolean } {
  const acct = accountCode ?? "";
  const ref = text(get(o, ord.ref)).trim();
  if (ref) return { base: `${sourceTag}:${acct}:${ref}`, fallback: false };
  const content = [
    text(get(o, ord.tradeDate)),
    text(get(o, ord.ticker)),
    text(get(o, ord.type)),
    num(get(o, ord.amount)) ?? num(get(o, ord.dividendAmount)) ?? "",
  ].join("|");
  return { base: `${sourceTag}:${acct}:c:${content}`, fallback: true };
}

function emptyStats(): BrokerImportStats {
  return {
    accounts: 0,
    imported: 0,
    switches: 0,
    dividends: 0,
    skippedCancel: 0,
    skippedPending: 0,
    skippedUnknown: 0,
  };
}

/**
 * Parse a broker export into editable rows + a summary. `shape` maps the broker's
 * order fields/status strings; omitted/partial → built-in defaults. Only success
 * orders import; cancel/pending and unknown kinds are counted. Rows oldest-first.
 */
export function parseBrokerExport(
  input: string | unknown,
  shape?: ConnectorShape,
): BrokerImportResult {
  const ord: OrderMap = {
    ...DEFAULT_ORDER,
    ...shape?.order,
    switch: { ...DEFAULT_ORDER.switch, ...shape?.order?.switch },
  };
  const vals: ValuesMap = { ...DEFAULT_VALUES, ...shape?.values };

  const warnings: string[] = [];
  let payload: unknown = input;
  if (typeof input === "string") {
    try {
      payload = JSON.parse(input);
    } catch {
      return {
        rows: [],
        stats: emptyStats(),
        warnings: ["Couldn't read that as broker data — expected the JSON your importer copied."],
      };
    }
  }

  const { orders, accounts, sourceTag } = collectOrders(payload);
  if (orders.length === 0) {
    return {
      rows: [],
      stats: { ...emptyStats(), accounts },
      warnings: ["No orders found in that export."],
    };
  }

  const success = vals.success.map((s) => s.toUpperCase());
  const cancel = vals.cancel.map((s) => s.toUpperCase());
  const pending = vals.pending.map((s) => s.toUpperCase());

  const stats: BrokerImportStats = { ...emptyStats(), accounts };
  const rows: ExtractedTxnRow[] = [];
  let fallbackIds = 0;

  for (const { order: o, accountCode } of orders) {
    const status = (text(get(o, ord.status)) || "SUCCESS").trim().toUpperCase();
    if (cancel.includes(status)) {
      stats.skippedCancel++;
      continue;
    }
    if (pending.includes(status)) {
      stats.skippedPending++;
      continue;
    }
    if (!success.includes(status)) {
      stats.skippedUnknown++;
      continue;
    }

    const { rows: mapped, kind } = orderToRows(o, ord, vals);
    if (mapped.length === 0) {
      stats.skippedUnknown++;
      continue;
    }
    if (kind === "switch") stats.switches++;
    if (kind === "dividend") stats.dividends++;

    const { base, fallback } = externalIdBase(o, ord, sourceTag, accountCode);
    if (fallback) fallbackIds++;
    mapped.forEach((row, i) => {
      row.externalId = mapped.length > 1 ? `${base}:${i === 0 ? "out" : "in"}` : base;
      if (accountCode) row.externalAccount = accountCode;
    });
    rows.push(...mapped);
  }

  stats.imported = rows.length;
  rows.sort((a, b) => (a.tradeDate ?? "").localeCompare(b.tradeDate ?? ""));

  if (stats.skippedUnknown > 0)
    warnings.push(`Skipped ${stats.skippedUnknown} order(s) with an unrecognized type.`);
  if (fallbackIds > 0)
    warnings.push(
      `${fallbackIds} order(s) had no stable id; re-importing may duplicate them if their amounts change.`,
    );

  return { rows, stats, warnings };
}

/**
 * True when pasted text looks like a broker export rather than the line-based
 * paste format. Cheap structural check.
 */
export function looksLikeBrokerExport(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) return p.some((o) => o && typeof o === "object" && "order_type" in o);
    if (p && typeof p === "object") {
      const r = p as Record<string, unknown>;
      return (
        Array.isArray(r.accounts) ||
        Array.isArray(r.history) ||
        (Array.isArray(r.data) &&
          (r.data as unknown[]).some(
            (o) => o && typeof o === "object" && "order_type" in (o as object),
          ))
      );
    }
  } catch {
    return false;
  }
  return false;
}
