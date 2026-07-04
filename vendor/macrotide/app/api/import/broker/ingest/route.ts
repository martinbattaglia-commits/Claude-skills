import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { withImportToken } from "@/lib/api/broker-token-auth";
import { withDb } from "@/lib/api/with-db";
import { resolveAccountBucket, upsertBrokerConnection } from "@/lib/db/queries/broker-connections";
import { listBuckets } from "@/lib/db/queries/buckets";
import { canonicalTickerMap, catalogQuoteSource } from "@/lib/db/queries/funds";
import { setSetting } from "@/lib/db/queries/settings";
import {
  insertTransactionsDeduped,
  remapExternalAccountToBucket,
  type TransactionInsert,
} from "@/lib/db/queries/transactions";
import { tickerKey } from "@/lib/market/sources";
import { parseBrokerExport } from "@/lib/portfolio/broker-import";
import { getConnectors } from "@/lib/portfolio/connector";
import type { ExtractedTxnRow } from "@/lib/portfolio/ocr";
import { LEDGER_KINDS, signedAmount } from "@/lib/portfolio/txn-import";

// Confirm-and-commit endpoint for a broker import. Authenticates with EITHER a
// logged-in session OR a broker import token (the userscript path, no cookies);
// accepts the RAW broker export and parses it server-side; routes each broker
// account's orders to its own portfolio (created plan-named on first sight,
// thereafter the user's mapping in Settings → Connections); inserts idempotently
// (re-sync skips orders already in the ledger by external_id) and consolidates
// any earlier rows of that account into the mapped portfolio.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEDGER_KIND_SET = new Set<string>(LEDGER_KINDS);

type ValidRow = ExtractedTxnRow & { kind: string; tradeDate: string };

/** Plan name per account_code, read from the raw export's account list. */
function accountNames(exportData: unknown): Map<string, string> {
  const m = new Map<string, string>();
  if (
    exportData &&
    typeof exportData === "object" &&
    Array.isArray((exportData as { accounts?: unknown }).accounts)
  ) {
    for (const a of (exportData as { accounts: unknown[] }).accounts) {
      if (a && typeof a === "object") {
        const code = (a as { account_code?: unknown }).account_code;
        const name = (a as { name?: unknown }).name;
        if (typeof code === "string") m.set(code, typeof name === "string" ? name : "");
      }
    }
  }
  return m;
}

/** Map parsed broker rows for ONE bucket into ledger inserts. */
function toInsertRows(
  rows: ValidRow[],
  bucketId: string,
  sourceLabel: string,
  catalogSources: Map<string, string>,
  canon: Map<string, string>,
  importBatchId: string,
): TransactionInsert[] {
  return rows.map((r) => {
    // Store the official catalog case (#235); a custom symbol keeps the typed case.
    const ticker = canon.get(tickerKey(r.ticker)) ?? r.ticker.trim();
    const catalogSource = catalogSources.get(tickerKey(ticker));
    const quoteSource = catalogSource === "thai_mutual_fund" ? catalogSource : "market";
    // r.kind is gated by LEDGER_KIND_SET in commit(), so it's a valid ledger kind.
    const kind = r.kind as (typeof LEDGER_KINDS)[number];
    return {
      bucketId,
      ticker,
      englishName: r.englishName ?? null,
      quoteSource,
      // Broker history is real trades (buy/sell/dividend) — never balance anchors.
      kind,
      tradeDate: r.tradeDate,
      units: r.units ?? null,
      value: null,
      pricePerUnit: r.pricePerUnit ?? null,
      marketPrice: r.pricePerUnit ?? null,
      amount: signedAmount(kind, r.amount ?? 0),
      fee: r.fee ?? null,
      tradeCurrency: "THB",
      fxToThb: 1,
      note: null,
      // Human-readable provenance shown on holdings (the broker's display name),
      // not the internal sourceTag.
      source: sourceLabel,
      importBatchId,
      externalId: r.externalId ?? null,
      externalAccount: r.externalAccount ?? null,
    };
  });
}

interface AccountResult {
  account: string | null;
  bucketId: string;
  inserted: number;
  skipped: number;
}

/** Route + insert per broker account. Runs inside a DB context. */
function commit(
  rows: ExtractedTxnRow[],
  sourceTag: string,
  sourceLabel: string,
  names: Map<string, string>,
  fallbackBucketId: string | undefined,
  accountLabel: string,
): NextResponse {
  // Remember the broker-login identifier (name/email) for the Settings header.
  if (accountLabel) setSetting(`broker_login_label:${sourceTag}`, accountLabel);
  // Remember the broker's account order (as the export listed them) so the
  // Connections list sorts the same way as the source, not by account code.
  if (names.size) setSetting(`broker_account_order:${sourceTag}`, Array.from(names.keys()));

  // Keep only rows with a recognized ledger kind + a DATE-ONLY ISO day (parser
  // already dropped cancel/pending/unknown and trims datetimes to their date
  // part; guard the kind→column and date-only contracts — this route bypasses
  // the /api/transactions Zod boundary, and a stored datetime breaks every
  // date-only fold downstream).
  const valid = rows.filter(
    (r): r is ValidRow =>
      !!r.tradeDate &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.tradeDate) &&
      !!r.kind &&
      LEDGER_KIND_SET.has(r.kind),
  );

  // Group by broker account; rows with no account (bare-array shape) share `""`.
  const groups = new Map<string, ValidRow[]>();
  for (const r of valid) {
    const key = r.externalAccount ?? "";
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const owned = listBuckets();
  let ownedIds = owned.map((b) => b.id);
  const catalogSources = catalogQuoteSource(valid.map((r) => r.ticker));
  const canon = canonicalTickerMap(valid.map((r) => r.ticker));
  const importBatchId = randomUUID();
  const now = new Date().toISOString();

  let totalInserted = 0;
  let totalSkipped = 0;
  const results: AccountResult[] = [];

  for (const [account, groupRows] of groups) {
    let bucketId: string;
    if (account) {
      // Real broker account → its mapped portfolio (created plan-named if new).
      bucketId = resolveAccountBucket(sourceTag, account, names.get(account) ?? "").bucketId;
      if (!ownedIds.includes(bucketId)) ownedIds = [...ownedIds, bucketId];
      // Pull any earlier rows of this account into the mapped portfolio.
      remapExternalAccountToBucket(account, bucketId, ownedIds);
    } else {
      // No account context (bare array) → a chosen/first portfolio.
      const fallback =
        (fallbackBucketId && owned.find((b) => b.id === fallbackBucketId)?.id) || owned[0]?.id;
      if (!fallback) continue; // no portfolio at all → nothing to route to
      bucketId = fallback;
    }

    const insertRows = toInsertRows(
      groupRows,
      bucketId,
      sourceLabel,
      catalogSources,
      canon,
      importBatchId,
    );
    const { inserted, skipped } = insertTransactionsDeduped(insertRows);
    totalInserted += inserted.length;
    totalSkipped += skipped;
    results.push({ account: account || null, bucketId, inserted: inserted.length, skipped });

    if (account) {
      upsertBrokerConnection({
        source: sourceTag,
        accountCode: account,
        displayName: names.get(account) ?? null,
        bucketId,
        lastSyncedAt: now,
        lastInserted: inserted.length,
        lastSkipped: skipped,
      });
    }
  }

  if (results.length === 0) {
    return NextResponse.json(
      { error: "no_bucket", message: "No importable orders, or no portfolio to route to." },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { inserted: totalInserted, skipped: totalSkipped, importBatchId, accounts: results },
    { status: 201 },
  );
}

export async function POST(req: Request) {
  const headerToken = req.headers.get("x-import-token")?.trim() ?? "";

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Expected a JSON body." },
      { status: 400 },
    );
  }

  // Body is the raw broker export; a thin optional envelope can carry an explicit
  // fallback bucket / token: { payload, bucketId, token }.
  const env = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const exportData = env && "payload" in env ? env.payload : raw;
  const fallbackBucketId = typeof env?.bucketId === "string" ? env.bucketId : undefined;
  const bodyToken = typeof env?.token === "string" ? env.token : "";
  const token = headerToken || bodyToken;

  // The export names its broker via `source` (the connector's sourceTag) — match
  // it to the right connector so the correct response-shape drives parsing (with
  // several connectors configured). Falls back to the first, then SDK defaults.
  const exportSource =
    exportData &&
    typeof exportData === "object" &&
    typeof (exportData as { source?: unknown }).source === "string"
      ? (exportData as { source: string }).source
      : undefined;
  const connectors = await getConnectors();
  const connector =
    (exportSource && connectors.find((c) => c.sourceTag === exportSource)) || connectors[0] || null;
  const { rows } = parseBrokerExport(exportData, connector?.shape);
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "no_rows", message: "No importable orders in that export." },
      { status: 400 },
    );
  }
  const sourceTag = exportSource ?? "broker";
  // Human-readable provenance for the holdings' source label (the broker's
  // display name); the sourceTag stays the routing/dedup key.
  const sourceLabel = connector?.displayName?.trim() || sourceTag;
  const names = accountNames(exportData);
  const accountLabel =
    exportData &&
    typeof exportData === "object" &&
    typeof (exportData as { accountLabel?: unknown }).accountLabel === "string"
      ? (exportData as { accountLabel: string }).accountLabel
      : "";

  // Token path (the userscript): no cookies; the token authenticates + resolves
  // the owner. Falls through to session auth when no token is supplied.
  if (token) {
    const res = await withImportToken(token, () =>
      commit(rows, sourceTag, sourceLabel, names, fallbackBucketId, accountLabel),
    );
    if (!res.ok) return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    return res.value;
  }

  return withDb(() => commit(rows, sourceTag, sourceLabel, names, fallbackBucketId, accountLabel));
}
