"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PasskeyIcon, ProviderIcon } from "@/components/ProviderIcon";
import { aaguidName } from "@/lib/auth/aaguid";
import { clearDemoSession } from "@/lib/auth/clear-demo";
import { authClient } from "@/lib/auth/client";
import { isPlaceholderEmail } from "@/lib/auth/placeholder-email";
import { useResource } from "@/lib/fetchers/swr";
import { fmtTokens } from "@/lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UsageData {
  inputTokens: number;
  outputTokens: number;
}

// Shape returned by better-auth's /list-accounts endpoint.
interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
}

// Subset of /api/auth-config we need: which OAuth providers are configured.
interface AuthConfigData {
  providers: { google: boolean };
}

export interface AccountScreenProps {
  isDemo: boolean;
  onBack: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OAUTH_PROVIDERS: { id: string; label: string }[] = [{ id: "google", label: "Google" }];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Local on purpose: takes a Date (a passkey-creation TIMESTAMP, rendered in the
// device's locale + timezone), unlike lib/format's fmtDate for ISO calendar dates.
function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  try {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return String(d);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AccountScreen({ isDemo, onBack }: AccountScreenProps) {
  // Session (name + email)
  const session = authClient.useSession();
  // Passkeys (reactive — refetches after add/delete)
  const passkeyState = authClient.useListPasskeys();
  // Today's token usage
  const { data: usageData, isLoading: usageLoading } = useResource<UsageData>("/api/account/usage");
  // Which OAuth providers the operator has configured (so we only offer "Link"
  // for ones that actually work).
  const { data: authConfig } = useResource<AuthConfigData>("/api/auth-config");

  // Linked OAuth providers (refetched after link/unlink).
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[] | null>(null);
  const [linkedLoading, setLinkedLoading] = useState(true);

  // Action state
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Pending destructive action awaiting confirmation.
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    run: () => Promise<void>;
  } | null>(null);
  // Inline name edit. `demoName` holds an edited name for demo / AUTH_DISABLED
  // sessions (no backend user to persist to) — session-local, like demo itself.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [demoName, setDemoName] = useState<string | null>(null);

  const refreshLinkedAccounts = useCallback(async () => {
    try {
      const { data } = await authClient.listAccounts();
      setLinkedAccounts((data as LinkedAccount[]) ?? []);
    } catch {
      setLinkedAccounts([]);
    } finally {
      setLinkedLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshLinkedAccounts();
  }, [refreshLinkedAccounts]);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const user = session.data?.user;
  // No better-auth user in demo / AUTH_DISABLED mode. Distinguish them like the
  // rail (App.tsx): a real demo session shows "Demo user"; AUTH_DISABLED single-
  // owner shows "Macrotide". Real accounts always have a name (signup collects it).
  const displayName = user?.name?.trim() || demoName || (isDemo ? "Demo user" : "Macrotide");
  // The account's real email, if it has adopted one (placeholder = none yet).
  const realEmail = user?.email && !isPlaceholderEmail(user.email) ? user.email : null;
  const googleEnabled = authConfig?.providers?.google ?? false;
  const passkeyList = passkeyState.data ?? [];
  // Lockout guard: a user's only sign-in path is their passkey(s) unless they've
  // linked an OAuth provider (the email/password record is a hidden bootstrap,
  // not a usable login). So forbid revoking the last passkey in that case.
  const linkedOAuthCount = OAUTH_PROVIDERS.filter(
    (p) => linkedAccounts?.some((a) => a.providerId === p.id) ?? false,
  ).length;
  const hasLinkedOAuth = linkedOAuthCount > 0;
  // Whether the OAuth provider row renders (it leads the card when present, so
  // the Passkeys group below it gets the divider instead).
  const googleRowVisible = googleEnabled || hasLinkedOAuth;
  const cannotRevokeLast = passkeyList.length <= 1 && !hasLinkedOAuth;
  // Symmetric lockout guard for unlinking an OAuth provider. The phantom
  // `credential` bootstrap row (random password, no sign-in UI) is NOT a usable
  // method, so better-auth's own `allowUnlinkingAll` guard — which counts it —
  // can't be trusted to prevent lockout. We enforce it ourselves: you can't
  // remove your only OAuth provider when you have no passkeys.
  const cannotUnlinkLastOAuth = passkeyList.length === 0 && linkedOAuthCount <= 1;
  const inputTokens = usageData?.inputTokens ?? 0;
  const outputTokens = usageData?.outputTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleAddPasskey() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await authClient.passkey.addPasskey({
        // This becomes the WebAuthn user name shown in the OS / password
        // manager — use the person's name (matching the /login signup), not a
        // device/date string. The in-app passkey list labels by authenticator
        // (aaguid), so it doesn't rely on this value.
        name: user?.name ?? user?.email ?? "Passkey",
      });
      if (res?.error) {
        throw new Error(res.error.message ?? "Passkey registration failed");
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Passkey registration failed");
    } finally {
      setBusy(false);
    }
  }

  function startEditName() {
    setNameDraft(displayName);
    setActionError(null);
    setEditingName(true);
  }

  async function handleSaveName() {
    const next = nameDraft.trim();
    if (!next) {
      setActionError("Name can't be empty.");
      return;
    }
    // Demo / AUTH_DISABLED: no backend user — keep the edit session-local.
    if (!user) {
      setDemoName(next);
      setEditingName(false);
      return;
    }
    if (next === user.name) {
      setEditingName(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await authClient.updateUser({ name: next });
      if ((res as { error?: { message?: string } })?.error) {
        throw new Error(
          (res as { error?: { message?: string } }).error?.message ?? "Couldn't update name",
        );
      }
      setEditingName(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't update name");
    } finally {
      setBusy(false);
    }
  }

  // Link an OAuth provider to THIS account. Redirects to the provider and back;
  // on return the account row exists (and, for a placeholder-email account, the
  // verified provider email is adopted server-side). callbackURL returns to the
  // app — the user reopens Account to see the new "linked" state.
  async function handleLinkProvider(provider: string) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await authClient.linkSocial({ provider, callbackURL: "/" });
      if (res?.error) throw new Error(res.error.message ?? "Couldn't start linking");
      // Success triggers a full-page redirect to the provider; nothing else to do.
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't start linking");
      setBusy(false);
    }
  }

  function handleUnlinkProvider(provider: string, label: string) {
    if (cannotUnlinkLastOAuth) {
      setActionError(
        `${label} is your only way to sign in. Register a passkey before unlinking it.`,
      );
      return;
    }
    setConfirm({
      title: `Unlink ${label}?`,
      message: `You'll no longer be able to sign in with ${label}. You can link it again later.`,
      confirmLabel: `Unlink ${label}`,
      run: async () => {
        setBusy(true);
        setActionError(null);
        try {
          const res = await authClient.unlinkAccount({ providerId: provider });
          if ((res as { error?: { message?: string } })?.error) {
            throw new Error(
              (res as { error?: { message?: string } }).error?.message ?? "Unlink failed",
            );
          }
          await refreshLinkedAccounts();
        } catch (e) {
          setActionError(e instanceof Error ? e.message : "Unlink failed");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function handleDeletePasskey(id: string, name: string | undefined) {
    if (cannotRevokeLast) {
      setActionError(
        "This is your only way to sign in. Register another passkey before removing this one.",
      );
      return;
    }
    const label = name ?? "this passkey";
    setConfirm({
      title: "Remove passkey?",
      message: `"${label}" will be removed and can no longer be used to sign in.`,
      confirmLabel: "Remove passkey",
      run: async () => {
        setBusy(true);
        setActionError(null);
        try {
          // Dynamic proxy routes this to POST /api/auth/passkey/delete-passkey
          const res = await authClient.passkey.deletePasskey({ id });
          if (res?.error) {
            throw new Error(res.error.message ?? "Delete failed");
          }
        } catch (e) {
          setActionError(e instanceof Error ? e.message : "Delete failed");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function handleSignOutEverywhere() {
    setConfirm({
      title: "Sign out everywhere?",
      message: "You'll be signed out of all devices and need to authenticate again on each one.",
      confirmLabel: "Sign out everywhere",
      run: async () => {
        setBusy(true);
        setActionError(null);
        try {
          // Clear the demo cookie alongside the real session — see comment in
          // App.tsx::signOut.
          await clearDemoSession();
          // POST /revoke-sessions (revoke all sessions = sign out everywhere).
          // Pass an explicit empty body so better-fetch sends the required
          // `Content-Type: application/json` — without a body it omits the header
          // and the endpoint rejects with "Content-Type is required".
          const res = await authClient.$fetch("/revoke-sessions", {
            method: "POST",
            body: {},
          });
          if ((res as { error?: { message?: string } })?.error) {
            throw new Error(
              (res as { error?: { message?: string } }).error?.message ?? "Sign-out failed",
            );
          }
          window.location.href = "/login";
        } catch (e) {
          setActionError(e instanceof Error ? e.message : "Sign-out failed");
          setBusy(false);
        }
      },
    });
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
          <span>Account</span>
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

      {/* ── Profile ── */}
      <div className="section" style={{ marginTop: 6 }}>
        <div className="section-header">
          <h3>Profile</h3>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 14px",
              // Fixed height so the row doesn't grow when the edit input appears.
              height: 50,
              boxSizing: "border-box",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 500 }}>Name</span>
            {editingName ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  className="sheet-input"
                  type="text"
                  autoComplete="name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  // biome-ignore lint/a11y/noAutofocus: focusing the field the user just chose to edit
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  // Use the app's input class for the accent focus border; override
                  // only size to fit inline next to the buttons. (Don't set `border`
                  // inline — it would beat the class's :focus rule.)
                  style={{
                    width: 150,
                    height: 32,
                    padding: "0 10px",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={handleSaveName}
                  disabled={busy}
                  style={{ height: 32, boxSizing: "border-box", opacity: busy ? 0.6 : 1 }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  disabled={busy}
                  aria-label="Cancel"
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
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink)",
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {displayName}
                </span>
                <button
                  type="button"
                  onClick={startEditName}
                  disabled={busy}
                  aria-label="Edit name"
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--muted)",
                    cursor: "pointer",
                    fontSize: 12.5,
                    padding: "2px 6px",
                    borderRadius: "var(--r-sm)",
                  }}
                >
                  Edit
                </button>
              </div>
            )}
          </div>
          {/* Email row. The account's email is its verified identity (adopted
              from a linked provider), shown only when there's a real one. With a
              placeholder (passkey-only) account we don't show a bare "—": if
              Google is configured we offer to link it (which adopts an email),
              otherwise the row is hidden. Demo has no row. */}
          {(realEmail || (user && googleEnabled)) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 14px",
                height: 50,
                boxSizing: "border-box",
                borderTop: "1px solid var(--line-soft)",
              }}
            >
              <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 500 }}>Email</span>
              {realEmail ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--ink-soft, var(--muted))",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {realEmail}
                  </span>
                  <span className="tag green">verified</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => handleLinkProvider("google")}
                  style={{ opacity: busy ? 0.6 : 1 }}
                >
                  Link Google
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Sign in (methods + registered passkeys) ── */}
      <div className="section">
        <div className="section-header">
          <h3>Sign in</h3>
        </div>

        {/* Methods linked to this account */}
        <div className="card" style={{ padding: 0 }}>
          {/* OAuth providers lead the card. A row shows only when configured or
              already linked; fixed height so the linked and unlinked states are
              the same height. */}
          {OAUTH_PROVIDERS.map((provider) => {
            const linked = linkedAccounts?.some((a) => a.providerId === provider.id) ?? false;
            const enabled = authConfig?.providers?.[provider.id as "google"] ?? false;
            if (!linked && !enabled) return null;
            return (
              <div
                key={provider.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 14px",
                  height: 48,
                  boxSizing: "border-box",
                  opacity: linkedLoading ? 0.5 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <ProviderIcon id={provider.id} />
                  <span style={{ fontSize: 13, color: "var(--ink)" }}>{provider.label}</span>
                </div>
                {linked ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="tag green">linked</span>
                    <button
                      type="button"
                      disabled={busy || cannotUnlinkLastOAuth}
                      onClick={() => handleUnlinkProvider(provider.id, provider.label)}
                      aria-label={`Unlink ${provider.label}`}
                      title={
                        cannotUnlinkLastOAuth
                          ? "Register a passkey before unlinking your only sign-in method"
                          : "Unlink"
                      }
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "var(--muted)",
                        cursor: busy || cannotUnlinkLastOAuth ? "not-allowed" : "pointer",
                        padding: "4px 8px",
                        fontSize: 12.5,
                        borderRadius: "var(--r-sm)",
                        opacity: busy || cannotUnlinkLastOAuth ? 0.5 : 1,
                      }}
                    >
                      Unlink
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => handleLinkProvider(provider.id)}
                    style={{ opacity: busy ? 0.6 : 1 }}
                  >
                    Link
                  </button>
                )}
              </div>
            );
          })}
          {/* Passkeys group — header (with Add) over each registered credential.
              Divider above only when the Google row leads. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "11px 14px",
              borderTop: googleRowVisible ? "1px solid var(--line-soft)" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PasskeyIcon size={16} color="var(--muted)" />
              <span style={{ fontSize: 13, color: "var(--ink)" }}>Passkeys</span>
            </div>
            <button
              type="button"
              className="btn ghost sm"
              onClick={handleAddPasskey}
              disabled={busy}
              style={{ display: "flex", alignItems: "center", gap: 5, opacity: busy ? 0.6 : 1 }}
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
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add
            </button>
          </div>

          {/* Each registered passkey, indented under the Passkeys header. */}
          {passkeyState.isPending && (
            <div
              style={{
                padding: "10px 14px 10px 40px",
                borderTop: "1px solid var(--line-soft)",
                fontSize: 12.5,
                color: "var(--muted)",
              }}
            >
              Loading…
            </div>
          )}
          {!passkeyState.isPending && passkeyList.length === 0 && (
            <div
              style={{
                padding: "10px 14px 10px 40px",
                borderTop: "1px solid var(--line-soft)",
                fontSize: 12.5,
                color: "var(--muted)",
                lineHeight: 1.5,
              }}
            >
              No passkeys yet — add one for faster sign-in.
            </div>
          )}
          {!passkeyState.isPending &&
            passkeyList.map((pk) => {
              const resolvedName = aaguidName(pk.aaguid);
              const label =
                resolvedName ??
                (pk.deviceType === "multiDevice" ? "Synced passkey" : "This device");
              const showSyncedBadge = resolvedName != null && pk.backedUp === true;
              return (
                <div
                  key={pk.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 14px 10px 40px",
                    borderTop: "1px solid var(--line-soft)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          letterSpacing: "-0.01em",
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {label}
                      </span>
                      {showSyncedBadge && (
                        <span className="tag" style={{ flexShrink: 0 }}>
                          Synced
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 11,
                        color: "var(--muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      Created on {fmtDate(pk.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy || cannotRevokeLast}
                    onClick={() => handleDeletePasskey(pk.id, label)}
                    aria-label={`Remove passkey ${label}`}
                    title={
                      cannotRevokeLast
                        ? "Register another passkey before removing your last sign-in method"
                        : "Revoke"
                    }
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "var(--muted)",
                      cursor: busy || cannotRevokeLast ? "not-allowed" : "pointer",
                      padding: "4px 8px",
                      fontSize: 12.5,
                      borderRadius: "var(--r-sm)",
                      flexShrink: 0,
                      opacity: busy || cannotRevokeLast ? 0.5 : 1,
                    }}
                  >
                    Revoke
                  </button>
                </div>
              );
            })}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "8px 4px 0",
            lineHeight: 1.5,
          }}
        >
          Passkeys use this device's biometrics or PIN; register one on each device you use.
        </div>
      </div>

      {/* ── Today's usage ── */}
      <div className="section">
        <div className="section-header">
          <h3>Today's usage</h3>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 500 }}>
              Input tokens
            </span>
            <span
              style={{
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                color: "var(--ink)",
              }}
            >
              {usageLoading ? "…" : fmtTokens(inputTokens)}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              borderTop: "1px solid var(--line-soft)",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 500 }}>
              Output tokens
            </span>
            <span
              style={{
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                color: "var(--ink)",
              }}
            >
              {usageLoading ? "…" : fmtTokens(outputTokens)}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              borderTop: "1px solid var(--line-soft)",
              background: "var(--card-soft, var(--paper))",
              borderRadius: "0 0 var(--r-lg) var(--r-lg)",
            }}
          >
            <span
              style={{ fontSize: 12.5, color: "var(--ink-soft, var(--muted))", fontWeight: 500 }}
            >
              Total
            </span>
            <span
              style={{
                fontSize: 14,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: "var(--ink)",
                letterSpacing: "-0.01em",
              }}
            >
              {usageLoading ? "…" : fmtTokens(totalTokens)}
            </span>
          </div>
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "8px 4px 0",
            lineHeight: 1.5,
          }}
        >
          Resets at UTC midnight. Your tier determines which models you can access.
        </div>
      </div>

      {/* ── Sign out everywhere ── */}
      <div className="section" style={{ marginBottom: 32 }}>
        <div className="section-header">
          <h3>Sessions</h3>
        </div>
        <button
          type="button"
          className="btn ghost full"
          onClick={handleSignOutEverywhere}
          disabled={busy}
          style={{
            color: "var(--loss, #dc2626)",
            borderColor: "var(--loss-line, #fecaca)",
            opacity: busy ? 0.6 : 1,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          Sign out everywhere
        </button>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--muted)",
            padding: "8px 4px 0",
            lineHeight: 1.5,
          }}
        >
          Revokes all active sessions across all devices. You'll be redirected to sign in.
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        busy={busy}
        onConfirm={async () => {
          const action = confirm;
          setConfirm(null);
          await action?.run();
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
