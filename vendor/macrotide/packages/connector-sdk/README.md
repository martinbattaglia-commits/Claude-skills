# @macrotide/connector-sdk

Broker-agnostic contract and generic, config-driven collector and parser for
Macrotide broker-import connectors.

---

## Table of contents

1. [What a connector is](#1-what-a-connector-is)
2. [Data flow](#2-data-flow)
3. [The `Connector` contract, field by field](#3-the-connector-contract-field-by-field)
4. [Worked example — a synthetic broker](#4-worked-example--a-synthetic-broker)
5. [Registering a connector in the host app](#5-registering-a-connector-in-the-host-app)
6. [Testing a new connector](#6-testing-a-new-connector)

---

## 1. What a connector is

A connector is **data** — a JSON manifest describing where a broker exposes its
order-history API, how its responses are structured, and what its status and
order-type strings look like. It contains no executable logic.

The SDK does all the work:

- `buildUserscript` turns a manifest into an install-ready Tampermonkey /
  Violentmonkey userscript that runs inside the broker's tab.
- `parseBrokerExport` turns the JSON the userscript collected into Macrotide's
  import format (`ExtractedTxnRow[]`).

Because the SDK is shape-driven, adding a new broker is a new manifest — not
new code. The manifest lives in deployment configuration (an env var pointing to
a JSON file), never in committed source, so the repository carries no broker
identity.

---

## 2. Data flow

```
Connector manifest (JSON file or env vars)
  │
  ▼
lib/portfolio/connector.ts — loads + validates the manifest at runtime
  │
  ├─► buildUserscript()        → .user.js installed in user's browser
  │       │
  │       │   (runs in the broker tab, same-origin)
  │       ▼
  │   Broker API  ──────────────────────────────────────────────┐
  │   /planPath   → list of broker accounts                     │
  │   /historyPath (paginated) → order objects                  │  BrokerExport
  │   /pendingPath (optional)  → pending orders                 │  (JSON blob)
  │       │                                                     │
  │       └── POST to /api/import/broker/ingest ◄───────────────┘
  │
  └─► parseBrokerExport()      → ExtractedTxnRow[]
          │
          ▼
      Ledger (transactions table) — deduplicated by externalId
```

The **collector** (the userscript) fetches config from `/api/import/broker/runtime`
on each run, so endpoint and shape changes take effect immediately — no reinstall
needed. Only a change to the gather *algorithm* requires a new script to reach
installed loaders; how that propagates is the versioning story below.

### Versioning — two axes, two jobs

The installed userscript carries one semver `@version` of the form
`1.<protocol>.<revision>`, built from **two** constants in `src/collector.ts`.
They exist because two independent things can change, and they call for opposite
update behaviors:

| Constant | Slot | Bump when… | Effect |
| --- | --- | --- | --- |
| `COLLECTOR_PROTOCOL_VERSION` | minor | the gather **contract** changes in a way an installed loader must take on (**breaking**) | `@version` rises → managers auto-update; **and** the runtime endpoint reports the higher `collectorVersion`, so any still-old loader fires the in-page **reinstall nudge** (the fallback for managers that don't honor `@updateURL`, e.g. Safari's Userscripts) |
| `SCRIPT_REVISION` | patch | **anything else** in the baked script changes — badge/UI copy, a cosmetic tweak, a backward-compatible fix | `@version` rises → managers auto-update **silently** on their next poll; **no** reinstall nudge (it keys off the protocol alone) |

Why not one number? A single version can't both *always* propagate *and* nudge
only on breaking changes — those are two separate signals (did the bytes change?
vs. is it breaking?). Splitting them lets a cosmetic fix ship via silent
auto-update without interrupting anyone, while a contract change still forces a
visible reinstall on managers that can't auto-update.

Endpoints and `shape` resolve at run time and **never** move `@version` — they
need no reinstall at all.

Reset `SCRIPT_REVISION` to `0` whenever you bump `COLLECTOR_PROTOCOL_VERSION`. A
test tripwire (`sdk.test.ts`) pins a hash of the generated script, so editing the
baked script without bumping one of the two versions fails CI — see § 6.3.

---

## 3. The `Connector` contract, field by field

`Connector` extends `BrokerEndpoints` and adds identity fields and an optional
`shape`. Types live in `src/types.ts`; the fully-annotated reference manifest is
`src/example.connector.ts`.

### 3.1 Identity fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Stable connector id used for deduplication when multiple connectors run side-by-side. Defaults to `sourceTag` when omitted from the manifest JSON. |
| `displayName` | Yes | Human broker name shown in the Macrotide UI ("Connect via …"). |
| `sourceTag` | Yes | Short tag stamped on every imported row's `source` column and used as the dedup prefix in `externalId`. Must be unique across all connectors in a deployment. |
| `openUrl` | No | The broker's order-history UI page — surfaced as an "Open broker" link. |
| `loginUrl` | No | Where a first-time user logs in. Defaults to `openUrl`. |

### 3.2 Endpoint fields (`BrokerEndpoints`)

These tell the collector *where* to read the broker's data.

| Field | Required | Description |
|---|---|---|
| `host` | Yes | Hostname the collector must run on (same-origin). The userscript `@match` directive covers `https://<host>/*`. |
| `planPath` | Yes | Path returning the customer's portfolio/plan list. |
| `historyPath` | Yes | Path returning one portfolio's order history (cursor- or date-range-paginated). |
| `pendingPath` | No | Path returning pending orders. Omit when the broker has no such endpoint. |
| `sourceTag` | Yes | See identity table above — shared between the two interfaces. |

### 3.3 `shape` — the response field-path map

`shape` is fully optional. Omitting it entirely uses the SDK's built-in defaults
(modelled on a cursor-paginated, cookie-authenticated broker). Supply only the
sub-fields that differ from those defaults.

#### `shape.transport`

Describes *how* the collector reaches the broker's API. The default is
same-origin, cookie-authenticated. Override only for brokers whose data API is
cross-origin or uses request-header authentication.

| Field | Default | Description |
|---|---|---|
| `apiBase` | `""` | Absolute origin of the broker's data API. Empty string = same-origin (requests are relative to the page). |
| `credentials` | `"include"` | Fetch credentials mode. `"include"` rides the page's cookies; `"omit"` is for header-authenticated APIs (sending cookies cross-origin would fail CORS). |
| `captureHeaders` | `[]` | Lower-cased request-header names to capture from the page's own outbound requests to `apiBase` and replay on collector calls. Set only for header-auth brokers. When non-empty, the userscript runs at `document-start` with `unsafeWindow` so it can intercept the page's first authenticated request before the app finishes loading. |

#### `shape.plan`

How to read the portfolio list from the `planPath` response.

| Field | Default | Description |
|---|---|---|
| `accountsPath` | `"data.accounts"` | Dot-path to the array of account objects. |
| `accountCode` | `"agent_account_id"` | Field on each account holding its id. |
| `accountName` | `"plan_name"` | Field on each account holding its display name. |
| `accountType` | `"plan_type"` | Field on each account holding its type. Optional. |
| `labelPaths` | (several candidates) | Dot-paths tried in order; first non-null string becomes the "Synced as…" label in Settings. |

#### `shape.history`

How to paginate the `historyPath` endpoint.

| Field | Default | Description |
|---|---|---|
| `mode` | `"cursor"` | `"cursor"`: paginate via a cursor token. `"dateRange"`: single request bounded by start/end params. |
| `accountParam` | `"account_code"` | Query-param name for the account id on each request. |
| `cursorParam` | `"current_cursor"` | Query-param name for the cursor token (cursor mode). |
| `itemsPath` | `"data"` | Dot-path to the array of order objects in the response. |
| `nextCursorPath` | `"pagination.next_cursor"` | Dot-path to the next cursor value (cursor mode). |
| `hasNextPath` | `"pagination.has_next"` | Dot-path to the boolean "has next page" flag (cursor mode). |
| `maxPages` | `200` | Safety cap on pages fetched per account. |
| `startParam` | — | Query-param name for the range start (dateRange mode). |
| `endParam` | — | Query-param name for the range end (dateRange mode). |
| `startValue` | — | ISO floor for the range start (dateRange mode). |
| `extraQuery` | — | Extra query-string fragment appended verbatim (dateRange mode). |

#### `shape.pending`

How to read pending orders from `pendingPath`.

| Field | Default | Description |
|---|---|---|
| `accountParam` | `"account_code"` | Query-param name for the account id. |
| `itemsPath` | `"data"` | Dot-path to the array of pending-order objects. |

#### `shape.order` — mapping broker order fields

Each field is a `FieldRef`: either a single dot-path string or an array of
candidates tried in order (first non-null wins). Dot-paths walk nested objects —
`"fund.code"` reads `order.fund.code`.

| Field | Default | What it reads |
|---|---|---|
| `type` | `"order_type"` | The order type string (buy / sell / switch / dividend / …). |
| `ticker` | `"fund_name"` | The fund or instrument code. Use a dot-path for nested objects. |
| `status` | `"status"` | The order status (success / cancel / pending). |
| `tradeDate` | `"trade_date"` | Trade date. Full ISO datetimes are trimmed to their calendar date ("2024-03-15T00:00:00+07:00" → "2024-03-15"). |
| `amount` | `"net_transaction_amount"` | Transaction amount in local currency (unsigned magnitude). |
| `units` | `["net_transaction_unit", "unit"]` | Units transacted. |
| `fee` | `"fee"` | Transaction fee. |
| `dividendAmount` | `["amount", "net_transaction_amount"]` | Dividend cash amount. |
| `ref` | `"ref"` | The broker's own stable order id — the dedup anchor. When absent, a content hash is used and a warning is emitted. |
| `switch.toTicker` | `"sw_to_fund"` | Destination fund code for a switch order. |
| `switch.inAmount` | `"sw_in_net_transaction_amount"` | Amount of the incoming (buy) leg of a switch. |
| `switch.inUnits` | `"sw_in_net_transaction_unit"` | Units of the incoming (buy) leg of a switch. |

A **switch order** expands to two `ExtractedTxnRow` entries: a `sell` of the
source fund and a `buy` of the destination. The two legs share the same
`tradeDate` and get distinct `externalId` suffixes (`:out` and `:in`).

#### `shape.values` — order-type and status strings

Maps the broker's literal strings to the SDK's normalized kinds. Comparison is
case-insensitive. Supply only the strings that differ from the defaults.

| Field | Default | Meaning |
|---|---|---|
| `success` | `["SUCCESS", "COMPLETE"]` | Status values that mark a completed order. Only these are imported. |
| `cancel` | `["CANCEL", "CANCELLED"]` | Status values that mark a cancelled order (skipped, counted). |
| `pending` | `["PENDING"]` | Status values that mark a pending order (skipped, counted). |
| `buy` | `["buy"]` | `type` values that mean "purchase". |
| `sell` | `["sell"]` | `type` values that mean "redemption". |
| `switch` | `["switch"]` | `type` values that mean "fund switch" (expands to sell + buy). |
| `dividend` | `["dividend"]` | `type` values that mean "dividend payment". |

### 3.4 `ExtractedTxnRow` — the parsed output

Each broker order produces one (or two, for a switch) of these:

| Field | Description |
|---|---|
| `ticker` | Fund or instrument code. |
| `kind` | `"buy"` / `"sell"` / `"dividend"` (normalized by the parser). |
| `tradeDate` | ISO calendar date (`YYYY-MM-DD`). |
| `units` | Units transacted. Undefined for dividends. |
| `amount` | Cash magnitude in local currency. |
| `fee` | Transaction fee, when exposed by the broker. |
| `externalId` | Stable dedup key: `<sourceTag>:<accountCode>:<ref>` (or a content hash as fallback). Switch legs append `:out` / `:in`. |
| `externalAccount` | The broker account code this row came from. |

---

## 4. Worked example — a synthetic broker

This section uses entirely fictional data: placeholder hosts, paths, field
names, and fund codes.

### 4.1 The manifest

The fully-annotated TypeScript version is
`src/example.connector.ts` (exported as `EXAMPLE_CONNECTOR`). The equivalent
JSON (suitable for a `.connectors/` file) is `.connectors/example.json` at the
repo root.

A minimal connector — only the required fields, accepting all SDK defaults:

```json
{
  "id": "example-broker",
  "displayName": "Example Broker",
  "host": "app.example-broker.test",
  "planPath": "/api/v1/portfolios",
  "historyPath": "/api/v1/orders/history",
  "sourceTag": "example-broker"
}
```

A connector with a custom shape (different field names and status strings):

```json
{
  "id": "example-broker",
  "displayName": "Example Broker",
  "host": "app.example-broker.test",
  "planPath": "/api/v1/portfolios",
  "historyPath": "/api/v1/orders/history",
  "pendingPath": "/api/v1/orders/pending",
  "openUrl": "https://app.example-broker.test/orders",
  "loginUrl": "https://www.example-broker.test/login",
  "sourceTag": "example-broker",
  "shape": {
    "plan": {
      "accountsPath": "data.accounts",
      "accountCode": "account_id",
      "accountName": "account_name",
      "labelPaths": ["data.customer_name", "data.email"]
    },
    "history": {
      "accountParam": "account_code",
      "cursorParam": "cursor",
      "itemsPath": "data",
      "nextCursorPath": "pagination.next_cursor",
      "hasNextPath": "pagination.has_next"
    },
    "pending": {
      "accountParam": "account_code",
      "itemsPath": "data"
    },
    "order": {
      "type": "order_type",
      "ticker": "fund_name",
      "status": "status",
      "tradeDate": "trade_date",
      "amount": "net_transaction_amount",
      "units": ["net_transaction_unit", "unit"],
      "dividendAmount": ["amount", "net_transaction_amount"],
      "ref": "ref",
      "switch": {
        "toTicker": "sw_to_fund",
        "inAmount": "sw_in_net_transaction_amount",
        "inUnits": "sw_in_net_transaction_unit"
      }
    },
    "values": {
      "success": ["SUCCESS", "COMPLETE"],
      "cancel": ["CANCEL", "CANCELLED"],
      "pending": ["PENDING"],
      "buy": ["buy"],
      "sell": ["sell"],
      "switch": ["switch"],
      "dividend": ["dividend"]
    }
  }
}
```

### 4.2 What a broker response looks like

Given the shape above, a `planPath` response might look like:

```json
{
  "data": {
    "customer_name": "Jane Investor",
    "accounts": [
      { "account_id": "ACC001", "account_name": "Growth", "account_type": "standard" },
      { "account_id": "ACC002", "account_name": "Tax Saving", "account_type": "rmf" }
    ]
  }
}
```

A single page from `historyPath?account_code=ACC001`:

```json
{
  "data": [
    {
      "ref": "ORD-10001",
      "order_type": "buy",
      "fund_name": "EXAMPLE-FUND-A",
      "status": "SUCCESS",
      "trade_date": "2024-01-10",
      "net_transaction_amount": 10000,
      "net_transaction_unit": 500,
      "fee": 0
    },
    {
      "ref": "ORD-10002",
      "order_type": "switch",
      "fund_name": "EXAMPLE-FUND-A",
      "status": "SUCCESS",
      "trade_date": "2024-03-15",
      "net_transaction_amount": 5000,
      "net_transaction_unit": 250,
      "sw_to_fund": "EXAMPLE-FUND-B",
      "sw_in_net_transaction_amount": 5000,
      "sw_in_net_transaction_unit": 200
    },
    {
      "ref": "ORD-10003",
      "order_type": "dividend",
      "fund_name": "EXAMPLE-FUND-A",
      "status": "SUCCESS",
      "trade_date": "2024-04-01",
      "amount": 123.45
    },
    {
      "order_type": "sell",
      "fund_name": "EXAMPLE-FUND-A",
      "status": "CANCEL",
      "trade_date": "2024-05-01",
      "net_transaction_amount": 999
    }
  ],
  "pagination": { "next_cursor": null, "has_next": false }
}
```

### 4.3 What `parseBrokerExport` returns

After the collector wraps the above into a `BrokerExport` and posts it to
`/ingest`, the server calls `parseBrokerExport(exportData, connector.shape)`.
The parsed rows, sorted oldest-first, are:

```typescript
[
  {
    ticker: "EXAMPLE-FUND-A",
    kind: "buy",
    tradeDate: "2024-01-10",
    units: 500,
    amount: 10000,
    fee: 0,
    externalId: "example-broker:ACC001:ORD-10001",
    externalAccount: "ACC001",
  },
  {
    // Switch sell leg
    ticker: "EXAMPLE-FUND-A",
    kind: "sell",
    tradeDate: "2024-03-15",
    units: 250,
    amount: 5000,
    externalId: "example-broker:ACC001:ORD-10002:out",
    externalAccount: "ACC001",
  },
  {
    // Switch buy leg
    ticker: "EXAMPLE-FUND-B",
    kind: "buy",
    tradeDate: "2024-03-15",
    units: 200,
    amount: 5000,
    externalId: "example-broker:ACC001:ORD-10002:in",
    externalAccount: "ACC001",
  },
  {
    ticker: "EXAMPLE-FUND-A",
    kind: "dividend",
    tradeDate: "2024-04-01",
    amount: 123.45,
    externalId: "example-broker:ACC001:ORD-10003",
    externalAccount: "ACC001",
  },
  // The cancelled order was dropped (stats.skippedCancel: 1).
]
```

Stats: `{ accounts: 1, imported: 4, switches: 1, dividends: 1, skippedCancel: 1 }`.

### 4.4 A broker with nested fields and header auth

Some brokers nest the fund code inside an object and authenticate via request
headers rather than cookies. Model that with `transport` and dot-path `FieldRef`
values:

```json
{
  "shape": {
    "transport": {
      "apiBase": "https://api.example-broker.test",
      "credentials": "omit",
      "captureHeaders": ["authorization", "x-api-key"]
    },
    "history": {
      "mode": "dateRange",
      "accountParam": "accountNumbers[]",
      "startParam": "startedAt",
      "endParam": "endedAt",
      "startValue": "2010-01-01T00:00:00+07:00",
      "itemsPath": "data"
    },
    "order": {
      "type": "tradeType",
      "ticker": "fund.code",
      "status": "status",
      "tradeDate": "tradeDate",
      "amount": "amount",
      "units": "unit",
      "ref": "orderNumber",
      "switch": { "toTicker": "toFund.code" }
    },
    "values": {
      "success": ["C"],
      "cancel": ["X"],
      "buy": ["B"],
      "sell": ["S"],
      "switch": ["SW"]
    }
  }
}
```

Here `"fund.code"` reads `order.fund.code` from a response like:

```json
{ "orderNumber": "ORD-999", "tradeType": "B", "fund": { "code": "EXAMPLE-FUND-A" }, "status": "C", ... }
```

With `captureHeaders` set, the installed userscript runs at `document-start`
and intercepts the page's own requests to `api.example-broker.test` to capture
the `authorization` and `x-api-key` headers, then replays them on the
collector's own API calls.

---

## 5. Registering a connector in the host app

The host app reads connector manifests exclusively from deployment configuration
— never from committed code. Three sources are checked in order:

### Option A — local JSON file (recommended for self-hosting)

Set `BROKER_CONNECTOR_PATH` to the path of a JSON manifest:

```
BROKER_CONNECTOR_PATH=/path/to/your-broker.json
```

Multiple brokers: a comma-separated list of paths.

JSON manifests are gitignored under `.connectors/` (real ones carry broker
identity). The file `.connectors/example.json` is committed as a copy-from
template and is explicitly not gitignored.

### Option B — remote URL

Set `BROKER_CONNECTOR_URL` to a URL the app fetches the JSON from (cached for
5 minutes). Useful for shared or published manifests.

```
BROKER_CONNECTOR_URL=https://config.example.com/my-broker.json
```

Multiple brokers: a comma-separated list of URLs.

### Option C — legacy env vars (back-compat)

The original per-field env vars still work:

```
BROKER_IMPORT_SOURCE_TAG=example-broker
BROKER_IMPORT_DISPLAY_NAME=Example Broker
BROKER_IMPORT_HOST=app.example-broker.test
BROKER_IMPORT_PLAN_PATH=/api/v1/portfolios
BROKER_IMPORT_HISTORY_PATH=/api/v1/orders/history
BROKER_IMPORT_PENDING_PATH=/api/v1/orders/pending
BROKER_IMPORT_OPEN_URL=https://app.example-broker.test/orders
BROKER_IMPORT_LOGIN_URL=https://www.example-broker.test/login
```

These do not support a `shape` — use `BROKER_CONNECTOR_PATH` for brokers that
need custom field mapping.

### What the host does with the manifest

`lib/portfolio/connector.ts` loads and validates the manifest at runtime. The
relevant app routes are:

| Route | What it does |
|---|---|
| `GET /api/import/broker/connectors` | Lists every configured connector for the Connect-a-broker picker. |
| `GET /api/import/broker/userscript/macrotide-connector.user.js` | Serves the install-ready userscript (one script covers all connectors). |
| `GET /api/import/broker/runtime?host=<hostname>` | Returns the live config (endpoints + resolved shape) to the installed loader on each run. |
| `POST /api/import/broker/ingest` | Receives the raw `BrokerExport`, calls `parseBrokerExport` with the matched connector's shape, and writes to the ledger. |

No changes to application code are needed when adding or switching a connector —
update the env var and restart the app.

---

## 6. Testing a new connector

Mirror the patterns in `src/sdk.test.ts`.

### 6.1 Test `parseBrokerExport` with your shape

Construct a minimal `BrokerExport` that exercises every order kind your broker
supports. Use synthetic fund codes (`EXAMPLE-FUND-A` style) and account numbers.

```typescript
import { parseBrokerExport } from "@macrotide/connector-sdk";
import type { BrokerExport, ConnectorShape } from "@macrotide/connector-sdk";

const MY_SHAPE: ConnectorShape = {
  order: {
    type: "txnKind",
    ticker: "symbol",
    status: "state",
    tradeDate: "dealDate",
    amount: "cashValue",
    units: "shares",
    ref: "dealId",
  },
  values: {
    success: ["DONE"],
    cancel: ["VOID"],
    pending: ["WAITING"],
    buy: ["BOT"],
    sell: ["SLD"],
    switch: ["SWAP"],
    dividend: ["DIV"],
  },
};

const MY_EXPORT: BrokerExport = {
  source: "my-broker",
  accounts: [
    {
      account_code: "ACC001",
      history: [
        {
          dealId: "d1",
          txnKind: "BOT",
          symbol: "EXAMPLE-FUND-A",
          state: "DONE",
          dealDate: "2024-01-05",
          cashValue: 10000,
          shares: 500,
        },
        {
          dealId: "d2",
          txnKind: "SLD",
          symbol: "EXAMPLE-FUND-A",
          state: "VOID", // cancelled → should be dropped
          dealDate: "2024-02-01",
          cashValue: 999,
          shares: 10,
        },
      ],
    },
  ],
};

const result = parseBrokerExport(MY_EXPORT, MY_SHAPE);

// One imported row (the buy); the cancelled sell is dropped.
expect(result.stats.imported).toBe(1);
expect(result.stats.skippedCancel).toBe(1);

// Fields are mapped correctly from the custom shape.
expect(result.rows[0]).toMatchObject({
  ticker: "EXAMPLE-FUND-A",
  kind: "buy",
  tradeDate: "2024-01-05",
  units: 500,
  amount: 10000,
  externalId: "my-broker:ACC001:d1",
  externalAccount: "ACC001",
});
```

### 6.2 Test `resolveCollectorShape`

Verify that your shape merges correctly over the built-in defaults:

```typescript
import { resolveCollectorShape } from "@macrotide/connector-sdk";

const resolved = resolveCollectorShape(MY_SHAPE);

// Your overrides are present.
expect(resolved.history.accountParam).toBe("pf");

// SDK defaults fill in anything you didn't override.
expect(resolved.transport).toMatchObject({ apiBase: "", credentials: "include" });
expect(resolved.history.maxPages).toBe(200);
```

### 6.3 Test the userscript output

Check that `buildUserscript` produces valid metadata for your connector's host:

```typescript
import { buildUserscript } from "@macrotide/connector-sdk";
import { EXAMPLE_CONNECTOR } from "@macrotide/connector-sdk";

const script = buildUserscript(
  EXAMPLE_CONNECTOR,
  "https://macrotide.example",
  "test-token",
);

expect(script).toContain(`// @match        https://${EXAMPLE_CONNECTOR.host}/*`);
expect(script).toContain('"test-token"');
expect(script).not.toMatch(/__[A-Z]+__/); // no unfilled template slots
```

A **hash tripwire** (`the baked script matches its pinned hash`) guards the SDK's
own loader: it pins a SHA-256 of the generated script, so any edit to the baked
userscript — gather code, badge copy, the `@version` line — fails the test until
you make a deliberate version decision (bump `SCRIPT_REVISION` for a compatible
change, or `COLLECTOR_PROTOCOL_VERSION` for a breaking one — see § Versioning) and
re-pin the printed hash. This is what keeps `@version` from going stale.

### 6.4 Coverage checklist

Before shipping a new connector manifest:

- [ ] Buy order imports correctly (ticker, kind, date, units, amount, fee).
- [ ] Sell order imports correctly.
- [ ] Cancelled order is dropped (`stats.skippedCancel` increments).
- [ ] Pending order is dropped (`stats.skippedPending` increments).
- [ ] Switch order expands to two rows with `:out` / `:in` id suffixes.
- [ ] Dividend order records cash with no `units` field.
- [ ] `externalId` is `<sourceTag>:<accountCode>:<ref>` for every row.
- [ ] A full ISO datetime `tradeDate` is trimmed to its calendar date.
- [ ] `resolveCollectorShape` fills gaps from the SDK defaults.
- [ ] `buildUserscript` emits `@match` for the connector's host with no unfilled placeholders.
- [ ] All fund codes in tests are synthetic (`EXAMPLE-FUND-A` style), not real tickers.
