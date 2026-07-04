// A 100% synthetic reference connector — copy this as your starting point.
// Every host, path, field name, and fund code here is fictional. Replace all
// values with what your broker's API actually returns.
//
// This file is exported from the SDK so README examples can import it directly.
// It intentionally exercises every field so the annotations are complete.

import type { Connector } from "./types";

/**
 * Synthetic "Example Broker" connector — a worked, copy-from reference.
 *
 * The fields below are annotated in detail. Only `host`, `planPath`,
 * `historyPath`, and `sourceTag` are strictly required; everything else
 * falls back to SDK defaults when omitted.
 */
export const EXAMPLE_CONNECTOR: Connector = {
  // ── Identity ──────────────────────────────────────────────────────────────

  /** Stable connector id — used for deduplication when multiple connectors
   *  are configured. Defaults to `sourceTag` if omitted. */
  id: "example-broker",

  /** Human broker name shown in the Macrotide UI ("Connect via …"). */
  displayName: "Example Broker",

  /** Stamped on every imported row's `source` column — the dedup anchor.
   *  Must be unique across all connectors in your deployment. */
  sourceTag: "example-broker",

  // ── Endpoints ─────────────────────────────────────────────────────────────
  // These fields come from `BrokerEndpoints`. They tell the collector WHERE
  // to read the broker's data. All are broker-specific; none are hardcoded
  // in the SDK. Real values belong in env (BROKER_CONNECTOR_PATH or
  // BROKER_CONNECTOR_URL), never in committed code.

  /** Host the collector must run on (same-origin). The userscript's
   *  @match directive covers `https://<host>/*`. */
  host: "app.example-broker.test",

  /** Path returning the customer's portfolio/plan list. */
  planPath: "/api/v1/portfolios",

  /** Path returning one portfolio's order history (paginated). */
  historyPath: "/api/v1/orders/history",

  /** Path returning pending orders. Omit when the broker has no such
   *  endpoint — the collector skips that fetch. */
  pendingPath: "/api/v1/orders/pending",

  /** The broker's UI page to link to from the Macrotide "Open broker" button. */
  openUrl: "https://app.example-broker.test/orders",

  /** Where a first-time user logs in. Defaults to `openUrl` when omitted. */
  loginUrl: "https://www.example-broker.test/login",

  // ── Shape ─────────────────────────────────────────────────────────────────
  // `shape` maps the broker's response field paths onto the SDK's generic
  // collector (plan/history/pending/transport) and parser (order/values).
  // Every sub-field is optional; omit any that match the SDK's built-in
  // defaults (see types.ts ConnectorShape for the full table of defaults).

  shape: {
    // transport — how the collector reaches the broker's API.
    // Default: same-origin, cookie-authenticated.
    // Only set this block if the broker's data API is cross-origin or uses
    // request-header authentication (e.g. a Bearer token the SPA holds in
    // memory). For a standard cookie broker, omit `transport` entirely.
    transport: {
      /** Absolute origin of the broker's data API. Empty string (default) =
       *  same-origin; requests are relative to the page's own origin. */
      apiBase: "",

      /** Fetch credentials mode: `"include"` (default, rides the page's
       *  cookies) or `"omit"` (for header-auth; sending cookies cross-origin
       *  would fail CORS). */
      credentials: "include",

      /** Request header names to capture from the page's own outbound
       *  requests to `apiBase` and replay on the collector's calls.
       *  Lower-cased. Set only for header-auth brokers; leave empty for
       *  cookie brokers (the default). */
      captureHeaders: [],
    },

    // plan — how to read the portfolio list from the planPath response.
    plan: {
      /** Dot-path to the array of account objects in the plan response. */
      accountsPath: "data.accounts",

      /** Field name on each account object that holds the account's id. */
      accountCode: "account_id",

      /** Field name on each account object that holds the account's display name. */
      accountName: "account_name",

      /** Field name on each account object that holds the account type. Optional. */
      accountType: "account_type",

      /** Dot-paths tried in order; first non-null string becomes the label
       *  shown in the "Synced as…" header (the user's name or email). */
      labelPaths: ["data.customer_name", "data.email"],
    },

    // history — how to paginate the historyPath endpoint.
    history: {
      /** Pagination mode:
       *  - `"cursor"` (default): each response carries a cursor token to
       *    fetch the next page; stops when `hasNextPath` is false.
       *  - `"dateRange"`: one request bounded by startParam + endParam
       *    (no cursor loop). Use when the broker exposes a date-range query. */
      mode: "cursor",

      /** Query param name for the account id on each paginated request. */
      accountParam: "account_code",

      /** Query param name for the cursor token (cursor mode only). */
      cursorParam: "cursor",

      /** Dot-path in the response to the array of order objects. */
      itemsPath: "data",

      /** Dot-path in the response to the next cursor value (cursor mode). */
      nextCursorPath: "pagination.next_cursor",

      /** Dot-path in the response to a boolean "has next page" flag. */
      hasNextPath: "pagination.has_next",

      /** Safety cap on pages fetched per account (default 200). */
      maxPages: 200,

      // dateRange mode only (omit for cursor mode):
      // startParam: "startedAt",
      // endParam:   "endedAt",
      // startValue: "2010-01-01T00:00:00+07:00",
      // extraQuery: "sortType=d",
    },

    // pending — how to read pending orders from pendingPath.
    pending: {
      /** Query param name for the account id. */
      accountParam: "account_code",

      /** Dot-path to the array of pending-order objects in the response. */
      itemsPath: "data",
    },

    // order — field-path map from the broker's order object to the SDK's
    // parsed fields. A FieldRef is either a single dot-path string or an
    // array of candidates (first non-null wins). Dot-paths walk nested
    // objects (e.g. "fund.code" reads `order.fund.code`).
    order: {
      /** The order type string field (buy / sell / switch / dividend / …). */
      type: "order_type",

      /** The fund or instrument code. Use a dot-path for nested objects,
       *  e.g. `"fund.code"` when the response has `{ fund: { code: "…" } }`. */
      ticker: "fund_name",

      /** The order status field (success / cancel / pending). */
      status: "status",

      /** Trade date field. Full ISO datetimes are trimmed to their date part
       *  ("2024-03-15T00:00:00+07:00" → "2024-03-15"). */
      tradeDate: "trade_date",

      /** Transaction amount in local currency (baht magnitude, unsigned). */
      amount: "net_transaction_amount",

      /** Units transacted. An array tries each candidate in order — useful
       *  when the broker sometimes uses different field names. */
      units: ["net_transaction_unit", "unit"],

      /** Transaction fee. Omit if the broker doesn't expose fees. */
      fee: "fee",

      /** Dividend cash amount. Often shares a field with `amount`; an array
       *  lets you try an amount-specific field first. */
      dividendAmount: ["amount", "net_transaction_amount"],

      /** The broker's own stable order id — the dedup anchor. When present,
       *  `externalId = <sourceTag>:<account>:<ref>`. When absent, the SDK
       *  falls back to a content hash + emits a warning. */
      ref: "ref",

      // switch — field paths used to build the synthetic "buy into" leg of
      // a fund switch. A switch order expands to two rows: a sell of the
      // source fund and a buy of the destination fund.
      switch: {
        /** Destination fund code (the fund being switched INTO). */
        toTicker: "sw_to_fund",

        /** Amount of the incoming (buy) leg of the switch. */
        inAmount: "sw_in_net_transaction_amount",

        /** Units of the incoming (buy) leg of the switch. */
        inUnits: "sw_in_net_transaction_unit",
      },
    },

    // values — the broker's status and order-type string values, lower-cased
    // for comparison. Override only the strings that differ from the defaults.
    values: {
      /** Status strings that mean "this order completed" — only these are
       *  imported; everything else is skipped. */
      success: ["SUCCESS", "COMPLETE"],

      /** Status strings that mean "this order was cancelled". */
      cancel: ["CANCEL", "CANCELLED"],

      /** Status strings that mean "this order is still pending". */
      pending: ["PENDING"],

      /** order_type values that mean "buy". */
      buy: ["buy"],

      /** order_type values that mean "sell". */
      sell: ["sell"],

      /** order_type values that mean "fund switch" (expands to sell + buy). */
      switch: ["switch"],

      /** order_type values that mean "dividend payment". */
      dividend: ["dividend"],
    },
  },
};
