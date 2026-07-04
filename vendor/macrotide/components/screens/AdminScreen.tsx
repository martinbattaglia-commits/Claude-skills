"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { authClient } from "@/lib/auth/client";
import { useResource } from "@/lib/fetchers/swr";
import { fmtDate, fmtTokens } from "@/lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tier = "public" | "trusted";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  tier: Tier;
  createdAt: string;
  usageToday: number;
}

interface UsersResponse {
  users: AdminUser[];
}

export interface AdminScreenProps {
  onBack: () => void;
}

const USERS_KEY = "/api/admin/users";

// ─── Component ────────────────────────────────────────────────────────────────

export function AdminScreen({ onBack }: AdminScreenProps) {
  const { mutate } = useSWRConfig();
  const sessionUserId = authClient.useSession().data?.user?.id;
  const { data, error, isLoading } = useResource<UsersResponse>(USERS_KEY);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const users = data?.users ?? [];
  const forbidden = (error as (Error & { status?: number }) | undefined)?.status === 403;

  async function setTier(target: AdminUser, next: Tier) {
    if (target.tier === next || busyId) return;
    setActionError(null);
    setBusyId(target.id);

    // Optimistic update: flip the row locally without revalidating yet.
    await mutate(
      USERS_KEY,
      (cur: UsersResponse | undefined) =>
        cur
          ? { users: cur.users.map((u) => (u.id === target.id ? { ...u, tier: next } : u)) }
          : cur,
      { revalidate: false },
    );

    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(target.id)}/tier`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Update failed (${res.status})`);
      }
      // Confirm with the server's truth.
      await mutate(USERS_KEY);
    } catch (e) {
      // Rollback by revalidating from the server.
      setActionError(e instanceof Error ? e.message : "Update failed");
      await mutate(USERS_KEY);
    } finally {
      setBusyId(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="screen">
      {/* ── Topbar ── */}
      <div className="topbar">
        <button
          className="icon-btn"
          type="button"
          onClick={onBack}
          aria-label="Back"
          style={{ marginRight: 8 }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="brand" style={{ flex: 1 }}>
          <span>Admin · Users</span>
        </div>
      </div>

      {/* ── Error banner ── */}
      {actionError && (
        <div
          style={{
            margin: "0 16px 10px",
            padding: "10px 14px",
            borderRadius: "var(--r-md)",
            background: "var(--loss-soft, #fef2f2)",
            border: "1px solid var(--loss-line, #fecaca)",
            fontSize: 13,
            color: "var(--loss, #dc2626)",
            lineHeight: 1.4,
          }}
        >
          {actionError}
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="Dismiss"
            style={{
              float: "right",
              background: "none",
              border: 0,
              cursor: "pointer",
              color: "inherit",
              padding: "0 2px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="section" style={{ marginTop: 6 }}>
        <div className="section-header">
          <h3>Users</h3>
        </div>

        {forbidden && (
          <div className="card" style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
            You don't have access to this area.
          </div>
        )}

        {!forbidden && error && (
          <div className="card" style={{ fontSize: 12.5, color: "var(--loss, #dc2626)" }}>
            Failed to load users.
          </div>
        )}

        {!forbidden && !error && isLoading && (
          <div className="card" style={{ fontSize: 12.5, color: "var(--muted)" }}>
            Loading users…
          </div>
        )}

        {!forbidden && !error && !isLoading && users.length === 0 && (
          <div className="card" style={{ fontSize: 12.5, color: "var(--muted)" }}>
            No users yet.
          </div>
        )}

        {!forbidden && !error && users.length > 0 && (
          <div className="card" style={{ padding: 0 }}>
            {users.map((u, idx) => {
              const isSelf = u.id === sessionUserId;
              const rowBusy = busyId === u.id;
              return (
                <div
                  key={u.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "11px 14px",
                    borderTop: idx === 0 ? "none" : "1px solid var(--line-soft)",
                    opacity: rowBusy ? 0.6 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          letterSpacing: "-0.01em",
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.name || "—"}
                      </span>
                      {isSelf && (
                        <span className="tag" style={{ flexShrink: 0 }}>
                          you
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 11,
                        color: "var(--muted)",
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {u.email}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--muted)" }}>
                      Joined {fmtDate(u.createdAt)} · {fmtTokens(u.usageToday)} tok today
                    </div>
                  </div>

                  {/* Tier toggle */}
                  <fieldset
                    aria-label={`Tier for ${u.email}`}
                    style={{
                      display: "inline-flex",
                      flexShrink: 0,
                      margin: 0,
                      padding: 0,
                      minWidth: 0,
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r-sm)",
                      overflow: "hidden",
                    }}
                  >
                    {(["public", "trusted"] as Tier[]).map((t) => {
                      const active = u.tier === t;
                      // Guard the UI mirror of the server-side self-demote rule.
                      const blocked = isSelf && t === "public";
                      return (
                        <button
                          key={t}
                          type="button"
                          aria-pressed={active}
                          disabled={rowBusy || active || blocked}
                          onClick={() => setTier(u, t)}
                          title={blocked ? "You can't demote your own owner account" : `Set ${t}`}
                          style={{
                            border: 0,
                            padding: "5px 10px",
                            fontSize: 12,
                            fontWeight: 500,
                            cursor: rowBusy || active || blocked ? "default" : "pointer",
                            background: active ? "var(--accent, #2563eb)" : "transparent",
                            color: active ? "#fff" : blocked ? "var(--muted)" : "var(--ink)",
                            opacity: blocked && !active ? 0.4 : 1,
                          }}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </fieldset>
                </div>
              );
            })}
          </div>
        )}

        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "8px 4px 0",
            lineHeight: 1.5,
          }}
        >
          <strong>public</strong> = the public-tier model chain only (zero cost by default).{" "}
          <strong>trusted</strong> = full owner model chain. Changes take effect on the user's next
          chat turn.
        </div>
      </div>
    </div>
  );
}
