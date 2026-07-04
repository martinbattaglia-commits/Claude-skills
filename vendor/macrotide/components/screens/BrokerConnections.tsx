"use client";

// Settings → Connections: one card per connected broker (its accounts nested
// inside), in configured order. Broker-level Sync + Disconnect; per-portfolio you
// only remap (merge = point two accounts at one portfolio). One login syncs all
// of a broker's accounts. Setup (installing a userscript) is the "Connect
// another broker" / "Install connector" link, the Add-sheet banner, or the
// empty-state CTA — all open the Connect wizard (which picks the broker).
// Disconnecting a broker drops its accounts; the shared import token is only
// rotated (killing every installed script) when nothing is left connected.

import { useState } from "react";
import { Modal } from "@/components/Modal";
import {
  type BrokerConnectorInfo,
  type Bucket,
  useBrokerConnectors,
  useBuckets,
} from "@/lib/fetchers/portfolio";
import { invalidate, useResource } from "@/lib/fetchers/swr";
import { fmtRelativeDate } from "@/lib/format";

interface ConnectionRow {
  source: string;
  accountCode: string;
  displayName: string | null;
  bucketId: string | null;
  bucketName: string | null;
  lastSyncedAt: string | null;
  lastInserted: number;
  lastSkipped: number;
  /** Per-account held count (server-computed). */
  holdings: number;
}

const CONNECTIONS_KEY = "/api/import/broker/connections";

async function refresh() {
  await Promise.all([
    invalidate(CONNECTIONS_KEY),
    invalidate("/api/import/broker/connectors"),
    invalidate("/api/buckets"),
    invalidate(/^\/api\/holdings/),
    invalidate(/^\/api\/transactions/),
  ]);
}

interface BrokerGroup {
  source: string;
  info?: BrokerConnectorInfo;
  rows: ConnectionRow[];
}

export function BrokerConnections({ onConnect }: { onConnect: () => void }) {
  const { data: connectors } = useBrokerConnectors();
  const { data: conns } = useResource<ConnectionRow[]>(CONNECTIONS_KEY);
  const { data: buckets } = useBuckets();
  const [disconnecting, setDisconnecting] = useState<{ source: string; name: string } | null>(null);

  // Configured connectors loaded but none → not set up for this deployment.
  if (connectors && connectors.length === 0) return <Placeholder />;

  const rows = conns ?? [];
  const multi = (connectors?.length ?? 0) > 1;

  // Empty state: nothing synced yet. One connect brings every account of a broker.
  if (rows.length === 0) {
    const only = connectors?.length === 1 ? connectors[0] : null;
    // Names of the brokers this deployment supports (from the configured
    // connectors — never hardcoded).
    const supportedText = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
      (connectors ?? []).map((c) => c.displayName),
    );
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          Sync {only ? only.displayName : "your brokers"} automatically
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Import your full order history and keep it up to date — no manual entry. One connect
          brings every account.
          {supportedText && (
            <>
              <br />
              Supported brokers: {supportedText}.
            </>
          )}
        </div>
        <button
          type="button"
          className="btn ghost sm"
          style={{ alignSelf: "flex-start" }}
          onClick={onConnect}
        >
          {only ? `Connect ${only.displayName}` : "Connect a broker"}
        </button>
      </div>
    );
  }

  // Group synced accounts by broker (source), in configured order; any source
  // without a matching connector (e.g. one since removed) trails behind.
  const bySource = new Map<string, ConnectionRow[]>();
  for (const r of rows) {
    const g = bySource.get(r.source);
    if (g) g.push(r);
    else bySource.set(r.source, [r]);
  }
  const groups: BrokerGroup[] = [];
  const seen = new Set<string>();
  for (const c of connectors ?? []) {
    const rs = bySource.get(c.source);
    if (rs) {
      groups.push({ source: c.source, info: c, rows: rs });
      seen.add(c.source);
    }
  }
  for (const [source, rs] of bySource) {
    if (!seen.has(source)) groups.push({ source, rows: rs });
  }

  return (
    <>
      {groups.map((g) => (
        <BrokerCard
          key={g.source}
          group={g}
          buckets={buckets ?? []}
          onDisconnect={() =>
            setDisconnecting({ source: g.source, name: g.info?.displayName ?? g.source })
          }
        />
      ))}

      <div style={{ marginTop: 8, padding: "0 4px" }}>
        <button type="button" className="btn ghost sm" onClick={onConnect}>
          {multi ? "Connect another broker" : "Install connector"}
        </button>
      </div>

      {disconnecting && (
        <DisconnectModal
          broker={disconnecting.name}
          source={disconnecting.source}
          onClose={() => setDisconnecting(null)}
          onDone={async () => {
            await refresh();
            setDisconnecting(null);
          }}
        />
      )}
    </>
  );
}

function BrokerCard({
  group,
  buckets,
  onDisconnect,
}: {
  group: BrokerGroup;
  buckets: Bucket[];
  onDisconnect: () => void;
}) {
  const { info, rows } = group;
  const name = info?.displayName ?? group.source;
  const lastSynced =
    rows
      .map((r) => r.lastSyncedAt)
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null;
  const syncHref =
    info?.openUrl && rows[0]
      ? `${info.openUrl}?account_code=${encodeURIComponent(rows[0].accountCode)}`
      : (info?.openUrl ?? undefined);

  return (
    <div className="card" style={{ padding: 0, marginTop: 8 }}>
      {/* Login (broker) header — mirrors the Account → Passkeys list */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
          padding: "12px 14px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em" }}>{name}</div>
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {lastSynced ? `Synced ${fmtRelativeDate(lastSynced)}` : "Not synced yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {syncHref && (
            <a className="btn ghost sm" href={syncHref} target="_blank" rel="noreferrer">
              Sync
            </a>
          )}
          <button
            type="button"
            className="btn ghost sm"
            style={{ color: "var(--loss)", borderColor: "var(--loss)" }}
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Portfolios (per broker account) */}
      {rows.map((c) => (
        <PortfolioRow
          key={`${c.source}:${c.accountCode}`}
          conn={c}
          buckets={buckets}
          holdings={c.holdings}
        />
      ))}
    </div>
  );
}

function PortfolioRow({
  conn,
  buckets,
  holdings,
}: {
  conn: ConnectionRow;
  buckets: Bucket[];
  holdings: number;
}) {
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(CONNECTIONS_KEY, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: conn.source, accountCode: conn.accountCode, ...body }),
      });
      if (!res.ok) throw new Error();
      await refresh();
      setNewName(null);
    } catch {
      window.alert("Failed to update the mapping.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderTop: "1px solid var(--line-soft)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {conn.displayName || `Account ${conn.accountCode}`}
          </span>
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 11,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {holdings} holding{holdings === 1 ? "" : "s"}
        </div>
      </div>
      {newName === null ? (
        <select
          className="mt-select"
          style={{ flexShrink: 0 }}
          value={conn.bucketId ?? ""}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === "__new__") setNewName("");
            else patch({ bucketId: e.target.value });
          }}
        >
          {buckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="__new__">＋ New portfolio…</option>
        </select>
      ) : (
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <input
            className="mt-select"
            style={{ maxWidth: 130 }}
            placeholder="Portfolio name"
            value={newName}
            disabled={busy}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy || !newName.trim()}
            onClick={() => patch({ newName: newName.trim() })}
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setNewName(null)}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 12.5,
              padding: "4px 6px",
            }}
          >
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

function DisconnectModal({
  broker,
  source,
  onClose,
  onDone,
}: {
  broker: string;
  source: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (mode: "leave" | "purge") => {
    setBusy(true);
    try {
      const res = await fetch(CONNECTIONS_KEY, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true, source, mode }),
      });
      if (!res.ok) throw new Error();
      await onDone();
      setBusy(false);
    } catch {
      window.alert("Failed to disconnect.");
      setBusy(false);
    }
  };

  return (
    <Modal open variant="confirm" onClose={onClose} labelledBy="disconnect-title">
      <Modal.Header title={`Disconnect ${broker}?`} />
      <Modal.Body gap={8}>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
          Syncing stops and the installed userscript is deactivated. You can reconnect any time.
          Choose what to do with the holdings already imported — keep them as manual entries you can
          edit, or remove them:
        </p>
      </Modal.Body>
      <Modal.Footer
        className="modal-footer--stack"
        start={
          <>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => run("leave")}
            >
              Keep history
            </button>
            <button
              type="button"
              className="btn sm"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--loss)",
                fontWeight: 600,
              }}
              disabled={busy}
              onClick={() => run("purge")}
            >
              Remove all history
            </button>
          </>
        }
      >
        <button type="button" className="btn primary sm" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </Modal.Footer>
    </Modal>
  );
}

function Placeholder() {
  return (
    <div className="card">
      <div className="row between">
        <div className="row">
          <div className="broker-logo" style={{ width: 36, height: 36 }}>
            +
          </div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em" }}>
              No brokerage connected
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
              Add holdings manually · broker sync not configured
            </div>
          </div>
        </div>
        <span className="tag">off</span>
      </div>
    </div>
  );
}
