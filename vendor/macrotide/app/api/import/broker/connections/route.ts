import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withDb } from "@/lib/api/with-db";
import {
  deleteBrokerConnection,
  listBrokerConnections,
  setBrokerConnectionBucket,
} from "@/lib/db/queries/broker-connections";
import { rotateBrokerImportToken } from "@/lib/db/queries/broker-token";
import { createBucket, listBuckets } from "@/lib/db/queries/buckets";
import { countHeldByExternalAccount } from "@/lib/db/queries/project-holdings";
import { getSetting } from "@/lib/db/queries/settings";
import {
  deleteTransactionsByExternalAccount,
  remapExternalAccountToBucket,
} from "@/lib/db/queries/transactions";

// Manage broker-import connections (Settings → Connections). Session-scoped via
// withDb. GET lists each account's mapped portfolio + last-sync status; PATCH
// remaps/merges an account to a portfolio (existing or new); DELETE unlinks
// (optionally removing that account's imported history).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return withDb(() => {
    const buckets = listBuckets();
    const ownedIds = buckets.map((b) => b.id);
    const nameById = new Map(buckets.map((b) => [b.id, b.name]));

    // Sort by the broker's own account order (captured at sync), unknown → end.
    const orderCache = new Map<string, string[]>();
    const orderIndex = (source: string, accountCode: string): number => {
      let order = orderCache.get(source);
      if (!order) {
        order = getSetting<string[]>(`broker_account_order:${source}`) ?? [];
        orderCache.set(source, order);
      }
      const i = order.indexOf(accountCode);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const sorted = [...listBrokerConnections()].sort(
      (a, b) =>
        orderIndex(a.source, a.accountCode) - orderIndex(b.source, b.accountCode) ||
        a.accountCode.localeCompare(b.accountCode),
    );

    const rows = sorted.map((c) => ({
      source: c.source,
      accountCode: c.accountCode,
      displayName: c.displayName,
      bucketId: c.bucketId,
      bucketName: c.bucketId ? (nameById.get(c.bucketId) ?? null) : null,
      lastSyncedAt: c.lastSyncedAt,
      lastInserted: c.lastInserted,
      lastSkipped: c.lastSkipped,
      // Per-ACCOUNT held count (folds this account's own ledger) — stable across
      // remap/merge, unlike a per-bucket count.
      holdings: countHeldByExternalAccount(c.accountCode, ownedIds),
    }));
    return NextResponse.json(rows);
  });
}

const patchBody = z
  .object({
    source: z.string().trim().min(1).default("broker"),
    accountCode: z.string().trim().min(1),
    // Remap to an existing portfolio …
    bucketId: z.string().trim().min(1).optional(),
    // … or create a new one with this name.
    newName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((b) => b.bucketId || b.newName, {
    message: "provide bucketId or newName",
    path: ["bucketId"],
  });

export async function PATCH(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = patchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { source, accountCode, bucketId, newName } = parsed.data;

  return withDb(() => {
    const owned = listBuckets();
    let targetId: string;
    if (newName) {
      targetId = createBucket({ id: randomUUID(), name: newName, brokerage: accountCode }).id;
    } else {
      const found = owned.find((b) => b.id === bucketId);
      if (!found) return NextResponse.json({ error: "bucket_not_found" }, { status: 404 });
      targetId = found.id;
    }
    const conn = setBrokerConnectionBucket(source, accountCode, targetId);
    if (!conn) return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
    // Move this account's existing rows into the chosen portfolio.
    const ownedIds = [...listBuckets().map((b) => b.id)];
    const { moved } = remapExternalAccountToBucket(accountCode, targetId, ownedIds);
    return NextResponse.json({ ok: true, bucketId: targetId, moved });
  });
}

const deleteBody = z
  .object({
    // The user-facing "Disconnect": `all:true` with a `source` drops that one
    // broker (all its accounts); `all:true` with no `source` drops every broker.
    // `accountCode` targets a single account (internal).
    all: z.boolean().optional(),
    source: z.string().trim().min(1).optional(),
    accountCode: z.string().trim().min(1).optional(),
    // "leave" keeps the imported transactions; "purge" deletes them too.
    mode: z.enum(["leave", "purge"]).default("leave"),
  })
  .refine((b) => b.all || b.accountCode, {
    message: "provide all:true or accountCode",
    path: ["accountCode"],
  });

export async function DELETE(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = deleteBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { all, source, accountCode, mode } = parsed.data;

  return withDb(() => {
    const ownedIds = listBuckets().map((b) => b.id);
    let removed = 0;

    if (all) {
      // Drop every account of the targeted broker (or all brokers when no
      // `source` is given), plus optionally its imported history.
      const connections = listBrokerConnections();
      const targets = source ? connections.filter((c) => c.source === source) : connections;
      for (const c of targets) {
        if (mode === "purge")
          removed += deleteTransactionsByExternalAccount(c.accountCode, ownedIds);
        deleteBrokerConnection(c.source, c.accountCode);
      }
      // The import token is shared across brokers, so only rotate it (killing
      // every installed userscript) when nothing is left connected.
      const tokenRotated = listBrokerConnections().length === 0;
      if (tokenRotated) rotateBrokerImportToken();
      return NextResponse.json({ ok: true, removed, tokenRotated });
    }

    // Single account (internal / fallback).
    if (accountCode) {
      if (mode === "purge") removed = deleteTransactionsByExternalAccount(accountCode, ownedIds);
      deleteBrokerConnection(source ?? "broker", accountCode);
    }
    return NextResponse.json({ ok: true, removed });
  });
}
