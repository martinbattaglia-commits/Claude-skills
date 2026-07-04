import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BrokerExport,
  buildUserscript,
  buildUserscriptHeader,
  COLLECTOR_PROTOCOL_VERSION,
  type ConnectorShape,
  looksLikeBrokerExport,
  parseBrokerExport,
  resolveCollectorShape,
  SCRIPT_REVISION,
} from "./index";

// Synthetic fixture mirroring the SDK's DEFAULT wire shape (no real account
// data): one multi-account export covering every order_type + status we handle.
// Parsing it with NO shape exercises the built-in defaults.
const EXPORT: BrokerExport = {
  source: "broker",
  exportedAt: "2026-06-07T00:00:00.000Z",
  accounts: [
    {
      account_code: "000000000001",
      name: "Growth",
      type: "guruport",
      history: [
        {
          ref: "r1",
          order_type: "buy",
          fund_name: "AAA-EQ",
          status: "SUCCESS",
          trade_date: "2024-01-10",
          net_transaction_amount: 10000,
          net_transaction_unit: 500,
          unit_type: "baht",
        } as never,
        {
          ref: "r2",
          order_type: "sell",
          fund_name: "AAA-EQ",
          status: "SUCCESS",
          trade_date: "2024-03-15",
          net_transaction_amount: 6000,
          net_transaction_unit: 250,
        },
        {
          // A switch → expands to a sell of BBB-BOND + a buy of CCC-GOLD.
          ref: "r3",
          order_type: "switch",
          fund_name: "BBB-BOND",
          status: "SUCCESS",
          trade_date: "2024-02-20",
          net_transaction_amount: 8000,
          unit: 800,
          net_transaction_unit: 800,
          sw_to_fund: "CCC-GOLD",
          sw_in_net_transaction_amount: 8000,
          sw_in_net_transaction_unit: 400,
        },
        {
          ref: "r4",
          order_type: "dividend",
          fund_name: "AAA-EQ",
          status: "SUCCESS",
          trade_date: "2024-04-01",
          amount: 123.45,
          unit: 500, // units held — must NOT become a unit delta
        },
        {
          // Cancelled — dropped.
          order_type: "sell",
          fund_name: "AAA-EQ",
          status: "CANCEL",
          trade_date: "2024-05-01",
          net_transaction_amount: 999,
          net_transaction_unit: 40,
        },
        {
          // Unknown type — counted, not imported.
          order_type: "fee_rebate",
          fund_name: "AAA-EQ",
          status: "SUCCESS",
          trade_date: "2024-06-01",
          net_transaction_amount: 5,
        } as never,
      ],
      pending: [
        { order_type: "sell", fund_name: "AAA-EQ", status: "PENDING", trade_date: "2026-06-05" },
      ],
    },
    {
      account_code: "000000000002",
      name: "Tax",
      type: "tax-saving-fund",
      history: [
        {
          ref: "r7",
          order_type: "buy",
          fund_name: "DDD-IDX",
          status: "SUCCESS",
          trade_date: "2023-12-01",
          net_transaction_amount: 50000,
          net_transaction_unit: 1000,
        },
      ],
    },
  ],
};

describe("parseBrokerExport (default shape)", () => {
  const res = parseBrokerExport(EXPORT);

  it("imports buy/sell/dividend and expands switch into two rows", () => {
    // 2 plain (buy, sell) + 2 from switch + 1 dividend + 1 other-account buy = 6
    expect(res.stats.imported).toBe(6);
    expect(res.rows).toHaveLength(6);
    expect(res.stats.accounts).toBe(2);
    expect(res.stats.switches).toBe(1);
    expect(res.stats.dividends).toBe(1);
  });

  it("drops cancelled and pending, counts unknown", () => {
    expect(res.stats.skippedCancel).toBe(1);
    expect(res.stats.skippedUnknown).toBe(1); // fee_rebate
    // PENDING lives only in `pending` (not imported) — never counted as history.
    expect(res.rows.find((r) => r.amount === 999)).toBeUndefined();
  });

  it("maps a switch to sell(out) + buy(in) on the same date", () => {
    const sell = res.rows.find((r) => r.ticker === "BBB-BOND");
    const buy = res.rows.find((r) => r.ticker === "CCC-GOLD");
    expect(sell).toMatchObject({ kind: "sell", units: 800, amount: 8000, tradeDate: "2024-02-20" });
    expect(buy).toMatchObject({ kind: "buy", units: 400, amount: 8000, tradeDate: "2024-02-20" });
  });

  it("records a dividend as cash with no unit delta", () => {
    const div = res.rows.find((r) => r.kind === "dividend");
    expect(div).toMatchObject({ ticker: "AAA-EQ", amount: 123.45 });
    expect(div?.units).toBeUndefined();
  });

  it("trims a full ISO datetime trade_date to its local calendar day", () => {
    // Brokers commonly send "2017-04-07T00:00:00+07:00"; the ledger stores a
    // date-only local day — a stored datetime breaks date-only folds downstream.
    const r = parseBrokerExport({
      history: [
        {
          ref: "dt1",
          order_type: "buy",
          fund_name: "AAA-EQ",
          status: "SUCCESS",
          trade_date: "2017-04-07T00:00:00+07:00",
          net_transaction_amount: 100,
          net_transaction_unit: 10,
        },
      ],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].tradeDate).toBe("2017-04-07");
  });

  it("returns rows oldest-first", () => {
    const dates = res.rows.map((r) => r.tradeDate);
    expect(dates).toEqual([...dates].sort((a, b) => (a ?? "").localeCompare(b ?? "")));
  });

  it("accepts a single-portfolio {history} shape", () => {
    const r = parseBrokerExport({ history: EXPORT.accounts?.[1].history });
    expect(r.stats.imported).toBe(1);
    expect(r.rows[0]).toMatchObject({ ticker: "DDD-IDX", kind: "buy" });
  });

  it("accepts a raw API page {data}", () => {
    const r = parseBrokerExport({
      status: true,
      data: EXPORT.accounts?.[1].history,
      pagination: {},
    });
    expect(r.stats.imported).toBe(1);
  });

  it("accepts a bare order array", () => {
    const r = parseBrokerExport(EXPORT.accounts?.[1].history);
    expect(r.stats.imported).toBe(1);
  });

  it("parses a JSON string too", () => {
    const r = parseBrokerExport(JSON.stringify(EXPORT));
    expect(r.stats.imported).toBe(6);
  });

  it("returns a friendly warning on garbage", () => {
    const r = parseBrokerExport("not json");
    expect(r.rows).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/broker data/i);
  });

  it("stamps a stable externalId + externalAccount from sourceTag:account:ref", () => {
    const buy = res.rows.find((r) => r.ticker === "AAA-EQ" && r.kind === "buy");
    expect(buy?.externalId).toBe("broker:000000000001:r1");
    expect(buy?.externalAccount).toBe("000000000001");
    // A second account's row carries that account_code.
    const other = res.rows.find((r) => r.ticker === "DDD-IDX");
    expect(other?.externalId).toBe("broker:000000000002:r7");
    expect(other?.externalAccount).toBe("000000000002");
  });

  it("gives a switch's two legs distinct :out / :in ids on the same ref", () => {
    const sell = res.rows.find((r) => r.ticker === "BBB-BOND");
    const buy = res.rows.find((r) => r.ticker === "CCC-GOLD");
    expect(sell?.externalId).toBe("broker:000000000001:r3:out");
    expect(buy?.externalId).toBe("broker:000000000001:r3:in");
  });

  it("falls back to a content id + warns when an order has no ref", () => {
    const r = parseBrokerExport([
      {
        order_type: "buy",
        fund_name: "NOREF-FUND",
        status: "SUCCESS",
        trade_date: "2024-07-01",
        net_transaction_amount: 1000,
        net_transaction_unit: 10,
      },
    ]);
    expect(r.rows[0].externalId).toMatch(/^broker::c:/);
    expect(r.warnings.some((w) => /no stable id/i.test(w))).toBe(true);
  });
});

// ── Genericity: a synthetic broker with COMPLETELY different field names. ──────
// Nothing here matches the built-in defaults; parsing/emitting it correctly is
// what proves the SDK is shape-driven (a new broker = a manifest, not new code).
const ALT_SHAPE: ConnectorShape = {
  order: {
    type: "txnKind",
    ticker: "symbol",
    status: "state",
    tradeDate: "dealDate",
    amount: "cashValue",
    units: "shares",
    dividendAmount: "cashValue",
    ref: "dealId",
    switch: { toTicker: "intoSymbol", inAmount: "intoCash", inUnits: "intoShares" },
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
  plan: {
    accountsPath: "result.portfolios",
    accountCode: "portfolioRef",
    accountName: "label",
    accountType: "kind",
    labelPaths: ["result.owner.fullName"],
  },
  history: {
    accountParam: "pf",
    cursorParam: "page",
    itemsPath: "items",
    nextCursorPath: "paging.next",
    hasNextPath: "paging.more",
    maxPages: 50,
  },
  pending: { accountParam: "pf", itemsPath: "items" },
};

const ALT_EXPORT = {
  source: "altbroker",
  accounts: [
    {
      account_code: "PF1",
      history: [
        {
          dealId: "a1",
          txnKind: "BOT",
          symbol: "ZZZ-EQ",
          state: "DONE",
          dealDate: "2024-01-05",
          cashValue: 2000,
          shares: 100,
        },
        {
          dealId: "a2",
          txnKind: "SWAP",
          symbol: "ZZZ-EQ",
          state: "DONE",
          dealDate: "2024-02-05",
          cashValue: 1500,
          shares: 75,
          intoSymbol: "YYY-BOND",
          intoCash: 1500,
          intoShares: 150,
        },
        {
          dealId: "a3",
          txnKind: "DIV",
          symbol: "ZZZ-EQ",
          state: "DONE",
          dealDate: "2024-03-05",
          cashValue: 50,
        },
        {
          dealId: "a4",
          txnKind: "SLD",
          symbol: "ZZZ-EQ",
          state: "VOID", // cancelled → dropped
          dealDate: "2024-04-05",
          cashValue: 999,
          shares: 10,
        },
      ],
    },
  ],
};

describe("parseBrokerExport (custom shape — genericity)", () => {
  const res = parseBrokerExport(ALT_EXPORT, ALT_SHAPE);

  it("reads renamed order fields/values: buy + switch(2) + dividend = 4, void dropped", () => {
    expect(res.stats.imported).toBe(4);
    expect(res.stats.switches).toBe(1);
    expect(res.stats.dividends).toBe(1);
    expect(res.stats.skippedCancel).toBe(1);
  });

  it("maps a renamed switch to sell(out) + buy(in)", () => {
    const sell = res.rows.find((r) => r.ticker === "ZZZ-EQ" && r.kind === "sell");
    const buy = res.rows.find((r) => r.ticker === "YYY-BOND");
    expect(sell).toMatchObject({ kind: "sell", units: 75, amount: 1500, tradeDate: "2024-02-05" });
    expect(buy).toMatchObject({ kind: "buy", units: 150, amount: 1500, tradeDate: "2024-02-05" });
  });

  it("records the renamed dividend as cash with no unit delta", () => {
    const div = res.rows.find((r) => r.kind === "dividend");
    expect(div).toMatchObject({ ticker: "ZZZ-EQ", amount: 50 });
    expect(div?.units).toBeUndefined();
  });

  it("stamps externalId from the renamed ref field", () => {
    const buy = res.rows.find((r) => r.ticker === "ZZZ-EQ" && r.kind === "buy");
    expect(buy?.externalId).toBe("altbroker:PF1:a1");
    expect(buy?.externalAccount).toBe("PF1");
  });
});

// ── Header-auth broker: nested fields + dateRange history + fee. ──────────────
// Models a broker with a cross-origin, header-authenticated API whose order
// objects nest the ticker under `fund.code` / `toFund.code` and code the
// type/status as single letters. Synthetic data only (placeholder fund codes +
// account numbers). Proves dot-path field refs, fee passthrough, and that
// single-letter type/status maps drive buy/sell + cancel correctly.
const NESTED_SHAPE: ConnectorShape = {
  transport: {
    apiBase: "https://api.example-broker.com",
    credentials: "omit",
    captureHeaders: ["authorization", "x-api-key"],
  },
  plan: {
    accountsPath: "data.accountList",
    accountCode: "accountNumber",
    accountName: "name",
    labelPaths: ["data.accountList.0.name"],
  },
  history: {
    mode: "dateRange",
    accountParam: "accountNumbers[]",
    startParam: "startedAt",
    endParam: "endedAt",
    startValue: "2010-01-01T00:00:00+07:00",
    extraQuery: "sortType=d&status=&isRemarkExists=",
    itemsPath: "data",
  },
  order: {
    type: "tradeType",
    ticker: "fund.code",
    status: "status",
    tradeDate: "tradeDate",
    amount: "amount",
    units: "unit",
    fee: "fee",
    ref: "orderNumber",
    switch: { toTicker: "toFund.code" },
  },
  values: { success: ["C"], cancel: ["X"], buy: ["B"], sell: ["S"], switch: ["SW"] },
};

const NESTED_EXPORT = {
  source: "examplebroker",
  accounts: [
    {
      account_code: "ACC111",
      name: "Main",
      history: [
        {
          orderNumber: "2106036271",
          tradeType: "B",
          fund: { code: "EXAMPLE-FUND-A" },
          status: "C",
          tradeDate: "2021-04-30",
          amount: 400.07,
          unit: 29.9962,
          fee: 0,
        },
        {
          orderNumber: "2106036272",
          tradeType: "S",
          fund: { code: "EXAMPLE-FUND-A" },
          status: "C",
          tradeDate: "2021-06-29",
          amount: 200,
          unit: 15,
          fee: 1.5,
        },
        {
          // Cancelled (status X) → dropped.
          orderNumber: "2106036273",
          tradeType: "B",
          fund: { code: "EXAMPLE-FUND-B" },
          status: "X",
          tradeDate: "2021-07-01",
          amount: 999,
          unit: 50,
          fee: 0,
        },
        {
          // Switch (best-effort) → sell EXAMPLE-FUND-A + buy EXAMPLE-FUND-C.
          orderNumber: "2106036274",
          tradeType: "SW",
          fund: { code: "EXAMPLE-FUND-A" },
          toFund: { code: "EXAMPLE-FUND-C" },
          status: "C",
          tradeDate: "2021-08-01",
          amount: 100,
          unit: 8,
        },
      ],
    },
  ],
};

describe("parseBrokerExport (nested fields + single-letter codes)", () => {
  const res = parseBrokerExport(NESTED_EXPORT, NESTED_SHAPE);

  it("resolves a dot-path ticker (fund.code) and imports buy + sell", () => {
    const buy = res.rows.find((r) => r.kind === "buy" && r.ticker === "EXAMPLE-FUND-A");
    const sell = res.rows.find((r) => r.kind === "sell" && r.ticker === "EXAMPLE-FUND-A");
    expect(buy).toMatchObject({ ticker: "EXAMPLE-FUND-A", units: 29.9962, amount: 400.07 });
    expect(sell).toMatchObject({ ticker: "EXAMPLE-FUND-A", units: 15, amount: 200 });
  });

  it("threads fee through to the row", () => {
    const sell = res.rows.find((r) => r.kind === "sell" && r.ticker === "EXAMPLE-FUND-A");
    const buy = res.rows.find((r) => r.kind === "buy" && r.ticker === "EXAMPLE-FUND-A");
    expect(sell?.fee).toBe(1.5);
    expect(buy?.fee).toBe(0);
  });

  it("drops a status-X order as cancelled", () => {
    expect(res.stats.skippedCancel).toBe(1);
    expect(res.rows.find((r) => r.amount === 999)).toBeUndefined();
  });

  it("expands a switch via a dot-path toFund.code", () => {
    const out = res.rows.find((r) => r.ticker === "EXAMPLE-FUND-A" && r.amount === 100);
    const into = res.rows.find((r) => r.ticker === "EXAMPLE-FUND-C");
    expect(out).toMatchObject({ kind: "sell", units: 8 });
    expect(into).toMatchObject({ kind: "buy" });
    expect(res.stats.switches).toBe(1);
  });

  it("stamps externalId from sourceTag:account:orderNumber", () => {
    const buy = res.rows.find((r) => r.kind === "buy" && r.ticker === "EXAMPLE-FUND-A");
    expect(buy?.externalId).toBe("examplebroker:ACC111:2106036271");
    expect(buy?.externalAccount).toBe("ACC111");
  });
});

describe("looksLikeBrokerExport", () => {
  it("recognizes export shapes, rejects the line-paste format", () => {
    expect(looksLikeBrokerExport(JSON.stringify(EXPORT))).toBe(true);
    expect(looksLikeBrokerExport(JSON.stringify({ history: [] }))).toBe(true);
    expect(looksLikeBrokerExport(JSON.stringify([{ order_type: "buy" }]))).toBe(true);
    expect(looksLikeBrokerExport("AAA-FUND, 100, 25.00")).toBe(false);
    expect(looksLikeBrokerExport("")).toBe(false);
  });
});

describe("resolveCollectorShape", () => {
  it("fills the built-in field paths when no shape is given", () => {
    const s = resolveCollectorShape();
    expect(s.plan.accountsPath).toBe("data.accounts");
    expect(s.plan.accountCode).toBe("agent_account_id");
    expect(s.history.nextCursorPath).toBe("pagination.next_cursor");
    expect(s.pending.accountParam).toBe("account_code");
  });

  it("merges a custom shape over the defaults (genericity)", () => {
    const s = resolveCollectorShape(ALT_SHAPE);
    expect(s.plan.accountsPath).toBe("result.portfolios");
    expect(s.plan.accountCode).toBe("portfolioRef");
    expect(s.history.accountParam).toBe("pf");
    expect(s.history.nextCursorPath).toBe("paging.next");
  });

  it("defaults to same-origin cookie transport + cursor history", () => {
    const s = resolveCollectorShape();
    expect(s.transport).toMatchObject({ apiBase: "", credentials: "include", captureHeaders: [] });
    expect(s.history.mode).toBe("cursor");
  });

  it("surfaces a connector's transport + dateRange history to the loader", () => {
    const s = resolveCollectorShape(NESTED_SHAPE);
    expect(s.transport).toMatchObject({
      apiBase: "https://api.example-broker.com",
      credentials: "omit",
      captureHeaders: ["authorization", "x-api-key"],
    });
    expect(s.history.mode).toBe("dateRange");
    expect(s.history.accountParam).toBe("accountNumbers[]");
    expect(s.history.startParam).toBe("startedAt");
    expect(s.history.startValue).toBe("2010-01-01T00:00:00+07:00");
  });
});

describe("buildUserscript (self-updating loader)", () => {
  const endpoints = {
    host: "orders.example.com",
    planPath: "/api/plan",
    historyPath: "/api/history",
    pendingPath: "/api/pending",
    sourceTag: "broker",
  };

  it("emits a metadata header with @match host, @connect, @grant", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "deadbeef");
    expect(us.startsWith("// ==UserScript==")).toBe(true);
    expect(us).toContain("// @match        https://orders.example.com/*");
    expect(us).toContain("// @connect      macrotide.example");
    expect(us).toContain("// @grant        GM_xmlhttpRequest");
    // Top frame only — the gather must not fire inside broker iframes.
    expect(us).toContain("// @noframes");
  });

  it("bakes in only origin + token + loader version, no placeholders left", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "deadbeef");
    expect(us).toContain('"deadbeef"');
    expect(us).toContain('"https://macrotide.example"');
    expect(us).toContain("GM_xmlhttpRequest");
    expect(us).toContain(`LV=${COLLECTOR_PROTOCOL_VERSION}`);
    expect(us).not.toMatch(/__[A-Z]+__/);
  });

  it("fetches its config from /runtime at run time, then posts to /ingest", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "deadbeef");
    expect(us).toContain("/api/import/broker/runtime");
    expect(us).toContain("/api/import/broker/ingest");
    expect(us).toContain('"X-Import-Token"');
  });

  it("does NOT bake the endpoints or shape into the loader (they come from /runtime)", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    // Endpoint paths + shape are runtime config now, not baked into the script body.
    expect(us).not.toContain('"/api/plan"');
    expect(us).not.toContain('"data.accounts"');
    expect(us).not.toContain("agent_account_id");
  });

  it("a cookie broker runs at document-idle", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    expect(us).toContain("// @run-at       document-idle");
    // unsafeWindow is gone entirely — capture uses a DOM-injected page-world hook
    // instead, so the script installs on Safari's Userscripts (which lacks it).
    expect(us).not.toContain("unsafeWindow");
  });

  it("@connects the broker host (the gather reaches it over GM_xmlhttpRequest)", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    // Cookie brokers have no apiBase, so the broker host itself must be in
    // @connect for the manager to allow the GM_xmlhttpRequest gather calls.
    expect(us).toContain("// @connect      orders.example.com");
    // The broker gather no longer uses the page's fetch.
    expect(us).not.toContain("fetch(u,{credentials");
    // GM_xmlhttpRequest needs absolute URLs; a same-origin broker anchors to the
    // page origin (a relative "/api/plan" would otherwise break the gather).
    expect(us).toContain("location.origin");
  });

  it("resolves its connector by the page hostname at run time", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    expect(us).toContain("/api/import/broker/runtime?host=");
    expect(us).toContain("location.hostname");
  });

  it("a header-capture broker runs at document-start, captures via a DOM page-world hook (no unsafeWindow), and @connects the API host", () => {
    const us = buildUserscript(
      { ...endpoints, id: "examplebroker", shape: NESTED_SHAPE },
      "https://macrotide.example",
      "x",
    );
    expect(us).toContain("// @run-at       document-start");
    // Capture works without unsafeWindow — a <script> injected into the page world
    // hooks fetch/XHR and relays headers through a shared-DOM attribute.
    expect(us).not.toContain("unsafeWindow");
    expect(us).toContain("data-mt-caph");
    expect(us).toContain('createElement("script")');
    expect(us).toContain("// @connect      api.example-broker.com");
    expect(us).not.toMatch(/__[A-Z_]+__/);
  });

  it("@version is 1.<protocol>.<revision> — protocol in the minor slot, script revision in the patch slot", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    expect(us).toContain(`// @version      1.${COLLECTOR_PROTOCOL_VERSION}.${SCRIPT_REVISION}`);
  });

  // Tripwire: pins a hash of the generated script (token/origin are fixed here, so
  // only the BAKED content + @version vary). ANY edit to the installed userscript —
  // badge copy, UI, gather code, or the version line — changes this hash and fails
  // the test. The fix is a conscious version decision, NOT just re-pinning:
  //   • compatible/cosmetic change → bump SCRIPT_REVISION (collector.ts)
  //   • breaking gather-contract change → bump COLLECTOR_PROTOCOL_VERSION, reset
  //     SCRIPT_REVISION to 0
  // then update PINNED_SCRIPT_HASH to the value this test prints. This is what makes
  // it impossible to ship a baked-script change with a stale @version.
  it("the baked script matches its pinned hash (bump a version + re-pin on any change)", () => {
    const PINNED_SCRIPT_HASH = "7fb98fce554991fe782de50933735dd2c2ad1bd4be6095793b91a18eb51abd36";
    const us = buildUserscript(endpoints, "https://h", "TOKEN");
    const hash = createHash("sha256").update(us).digest("hex");
    expect(
      hash,
      `baked userscript changed — see the comment above this test, then set PINNED_SCRIPT_HASH = "${hash}"`,
    ).toBe(PINNED_SCRIPT_HASH);
  });

  it("uses one sticky status badge that ends in success or a failure state", () => {
    const us = buildUserscript(endpoints, "https://macrotide.example", "x");
    // statusToast is sticky (no auto-close) and transitions in place, so a long sync
    // never vanishes mid-run and a failure shows a clear state instead of a stuck
    // "Collecting…". It ends as st.ok (auto-close) or st.fail (sticky + Retry).
    expect(us).toContain("function statusToast(");
    expect(us).toContain('statusToast("Collecting your history');
    expect(us).toContain("st.ok(");
    expect(us).toContain("st.fail(");
    // The old auto-closing badge and its 6s-vanish behavior are gone.
    expect(us).not.toContain("busyToast");
  });

  it("emits @downloadURL/@updateURL only when update URLs are supplied", () => {
    const without = buildUserscript(endpoints, "https://macrotide.example", "x");
    expect(without).not.toContain("@downloadURL");
    expect(without).not.toContain("@updateURL");

    const withUrls = buildUserscript(endpoints, "https://macrotide.example", "tok", {
      downloadUrl: "https://macrotide.example/dl/tok/macrotide-connector.user.js",
      updateUrl: "https://macrotide.example/dl/tok/macrotide-connector.meta.js",
    });
    expect(withUrls).toContain(
      "// @downloadURL  https://macrotide.example/dl/tok/macrotide-connector.user.js",
    );
    expect(withUrls).toContain(
      "// @updateURL    https://macrotide.example/dl/tok/macrotide-connector.meta.js",
    );
  });

  it("buildUserscriptHeader is the metadata block alone, same @version as the full script", () => {
    const urls = {
      downloadUrl: "https://macrotide.example/dl/tok/macrotide-connector.user.js",
      updateUrl: "https://macrotide.example/dl/tok/macrotide-connector.meta.js",
    };
    const header = buildUserscriptHeader(endpoints, "https://macrotide.example", urls);
    expect(header.startsWith("// ==UserScript==")).toBe(true);
    expect(header.trimEnd().endsWith("// ==/UserScript==")).toBe(true);
    // Metadata only — no loader body.
    expect(header).not.toContain("GM_xmlhttpRequest(");
    expect(header).not.toContain("location.hostname");
    // Agrees with the full script's version so the manager's update check is sound.
    const full = buildUserscript(endpoints, "https://macrotide.example", "tok", urls);
    const version = `// @version      1.${COLLECTOR_PROTOCOL_VERSION}.${SCRIPT_REVISION}`;
    expect(full).toContain(version);
    expect(header).toContain(version);
  });

  it("ONE global script @matches every broker host + unions @connect across connectors", () => {
    const cookieBroker = { ...endpoints, host: "trade.cookie.com" };
    const headerBroker = {
      host: "app.header.com",
      planPath: "/p",
      historyPath: "/h",
      sourceTag: "header",
      shape: NESTED_SHAPE, // apiBase https://api.example-broker.com + capture
    };
    const us = buildUserscript([cookieBroker, headerBroker], "https://macrotide.example", "x");
    // Both hosts matched by the single script.
    expect(us).toContain("// @match        https://trade.cookie.com/*");
    expect(us).toContain("// @match        https://app.header.com/*");
    // @connect unions the app origin + the header broker's API host.
    expect(us).toContain("// @connect      macrotide.example");
    expect(us).toContain("// @connect      api.example-broker.com");
    // Capture needed by ANY connector → document-start for all (no unsafeWindow).
    expect(us).toContain("// @run-at       document-start");
    expect(us).not.toContain("unsafeWindow");
  });
});
