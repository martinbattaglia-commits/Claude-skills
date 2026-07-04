"use client";

// Connect-a-broker wizard — a dedicated full screen (not a modal) for the
// 3-step setup: install a userscript manager → install the Macrotide userscript
// (URL / QR, paste fallback) → open your broker(s) & sync. The final step holds a
// per-broker "Open" link for every configured broker plus an inline sync status
// that becomes a success banner — so the links stay visible to connect another.
// Opened from a banner in the Add sheet and from Settings → Connections; Back is
// contextual. Management of synced accounts lives in Settings → Connections.

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { fmtRelativeDate } from "@/lib/format";
import {
  type DeviceOS,
  detectOS,
  ENABLE_NOTE,
  OS_LABEL,
  USERSCRIPT_APPS,
} from "@/lib/portfolio/userscript-apps";

// Token + the one global install URL — broker-independent (one script covers
// every configured broker).
interface Config {
  token: string;
  installUrl: string;
}

interface ConnectionRow {
  source: string;
  lastSyncedAt: string | null;
  lastInserted: number;
}

interface ConnectorOption {
  id: string;
  source: string;
  displayName: string;
  host: string;
  openUrl: string | null;
  loginUrl: string | null;
}

const STEP_TITLES = [
  "Install a userscript manager",
  "Install the Macrotide userscript",
  "Open your broker and sync",
];

export interface ConnectBrokerScreenProps {
  onBack: () => void;
  onOrganize: () => void;
}

export function ConnectBrokerScreen({ onBack, onOrganize }: ConnectBrokerScreenProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  // The configured brokers — shown as "open" links in the last step (one install
  // covers them all, so there's nothing to pick).
  const [connectors, setConnectors] = useState<ConnectorOption[] | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [step, setStep] = useState(1);
  const [os, setOs] = useState<DeviceOS>("desktop");
  const [showAllApps, setShowAllApps] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Live broker connections (per source) + which brokers you've opened this
  // session, so each row shows its own status (synced / syncing / not yet).
  const [conns, setConns] = useState<ConnectionRow[] | null>(null);
  const [openedAt, setOpenedAt] = useState<Record<string, number>>({});
  // Polling gives up after a window; `pollDone` surfaces a manual "Check again",
  // and `recheck` restarts a fresh polling window on click.
  const [pollDone, setPollDone] = useState(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    if (typeof navigator !== "undefined")
      setOs(detectOS(navigator.userAgent, navigator.maxTouchPoints));
  }, []);

  // List the configured brokers (for the "open your broker" links). Empty → not
  // configured for this deployment.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/import/broker/connectors");
        if (!alive) return;
        if (res.status === 404) {
          setConfigured(false);
          return;
        }
        const list = (await res.json()) as ConnectorOption[];
        if (!Array.isArray(list) || list.length === 0) {
          setConfigured(false);
          return;
        }
        setConnectors(list);
        setConfigured(true);
      } catch {
        if (alive) setConfigured(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Already connected a broker? Skip straight to the "open your broker" step
  // (the manager + script are installed) so its per-broker links are right there.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/import/broker/connections");
        if (!alive || !res.ok) return;
        const rows = (await res.json()) as ConnectionRow[];
        if (Array.isArray(rows) && rows.some((r) => r.lastSyncedAt)) setStep(3);
      } catch {
        // stay on step 1
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load the token + the one global install URL (broker-independent).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/import/broker/token");
        if (!alive || res.status === 404) return;
        const body = (await res.json()) as Partial<Config>;
        if (body.token && body.installUrl) {
          setCfg({ token: body.token, installUrl: body.installUrl });
        }
      } catch {
        // leave cfg null; the install link still works once loaded
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (step !== 2 || !cfg || qr) return;
    QRCode.toDataURL(cfg.installUrl, { width: 168, margin: 1 })
      .then(setQr)
      .catch(() => {});
  }, [step, cfg, qr]);

  // Poll the connections while on the final step so each broker row reflects its
  // live sync state. Polls every 3s for a 5-min window, then stops with a manual
  // "Check again"; `recheck` restarts a fresh window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `recheck` is the manual restart trigger for a fresh polling window
  useEffect(() => {
    if (step !== 3) return;
    let alive = true;
    let timer: number;
    const start = Date.now();
    setPollDone(false);
    const tick = async () => {
      try {
        const res = await fetch("/api/import/broker/connections");
        if (res.ok && alive) setConns((await res.json()) as ConnectionRow[]);
      } catch {
        // transient — keep polling
      }
      if (!alive) return;
      if (Date.now() - start < 5 * 60_000) timer = window.setTimeout(tick, 3000);
      else setPollDone(true);
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [step, recheck]);

  // One-click: fetch the script (if not already) and copy it in a single action.
  const copyScript = async () => {
    if (!cfg) return;
    try {
      const text = scriptText ?? (await (await fetch(cfg.installUrl)).text());
      setScriptText(text);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked / fetch failed — the install link still works */
    }
  };

  const otherOses = (Object.keys(USERSCRIPT_APPS) as DeviceOS[]).filter((o) => o !== os);

  const apps = USERSCRIPT_APPS[os];

  // Brokers to offer "open" links for in the last step (one install covers all).
  const brokers = connectors ?? [];
  // The brokers this deployment supports, named for the intro line (derived from
  // the configured connectors — never hardcoded).
  const supportedText = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
    brokers.map((b) => b.displayName),
  );

  // Per-broker sync state for the status rows: "synced" once any of its accounts
  // has a sync time; "syncing" while you've opened it and are waiting for that
  // first sync; else "not yet". (Re-opening a synced broker stays "synced" — the
  // userscript throttles re-syncs, so it wouldn't reliably fire a new one.)
  const brokerStatus = (source: string) => {
    const lastSyncedAt =
      (conns ?? [])
        .filter((c) => c.source === source)
        .map((c) => c.lastSyncedAt)
        .filter((v): v is string => !!v)
        .sort()
        .at(-1) ?? null;
    const synced = !!lastSyncedAt;
    const syncing = !synced && !!openedAt[source];
    return { lastSyncedAt, synced, syncing } as const;
  };
  const anySynced = (conns ?? []).some((c) => c.lastSyncedAt);

  return (
    <div className="screen">
      <div className="topbar">
        <button
          type="button"
          className="icon-btn"
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
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="brand" style={{ flex: 1 }}>
          <span>Connect your broker</span>
        </div>
      </div>

      <div className="section" style={{ marginTop: 6 }}>
        {configured === false ? (
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 500 }}>Broker import isn't set up</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
              This deployment has no broker configured.
            </div>
          </div>
        ) : (
          <>
            {supportedText && (
              <p
                className="import-note"
                style={{ marginBottom: 10, fontSize: 11.5, color: "var(--muted)" }}
              >
                Supported brokers: {supportedText}.
              </p>
            )}
            <ol className="import-steps">
              {STEP_TITLES.map((title, i) => {
                const n = i + 1;
                const state =
                  anySynced && n === 3
                    ? "done"
                    : n < step
                      ? "done"
                      : n === step
                        ? "active"
                        : "todo";
                return (
                  <li key={title} className={`import-step import-step--${state}`}>
                    <div className="import-step__marker" aria-hidden>
                      {state === "done" ? <Icon name="check" size={12} /> : n}
                    </div>
                    <div className="import-step__main">
                      {/* Titles are navigable so you can jump straight to a step
                          (e.g. to reach the Open links) without clicking through. */}
                      <button
                        type="button"
                        className="import-step__title"
                        onClick={() => setStep(n)}
                        style={{
                          background: "transparent",
                          border: 0,
                          // Match the original title div: top nudge only, flush left,
                          // so the step body lines up with the title. Color is left to
                          // the CSS class so the todo-muted state still applies.
                          padding: "3px 0 0",
                          fontFamily: "inherit",
                          textAlign: "left",
                          width: "100%",
                          cursor: n === step ? "default" : "pointer",
                        }}
                      >
                        {title}
                      </button>

                      {n === step && n === 1 && (
                        <div className="import-step__body">
                          <p className="import-hint">For {OS_LABEL[os]}:</p>
                          {apps.map((a, ai) => (
                            <a
                              key={a.name}
                              className={`import-app${ai === 0 ? " import-app--rec" : ""}`}
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <strong>{a.name}</strong>
                              <span>{a.note}</span>
                            </a>
                          ))}
                          <p className="import-note">{ENABLE_NOTE}</p>
                          <button
                            type="button"
                            className="btn link"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              padding: "2px 0",
                              fontSize: 12,
                            }}
                            aria-expanded={showAllApps}
                            onClick={() => setShowAllApps((v) => !v)}
                          >
                            Other devices
                            <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
                              {showAllApps ? "▾" : "▸"}
                            </span>
                          </button>
                          {showAllApps &&
                            otherOses.map((o) => (
                              <div key={o} className="import-step__body" style={{ marginTop: 2 }}>
                                <p className="import-hint">For {OS_LABEL[o]}:</p>
                                {USERSCRIPT_APPS[o].map((a) => (
                                  <a
                                    key={a.name}
                                    className="import-app"
                                    href={a.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    <strong>{a.name}</strong>
                                    <span>{a.note}</span>
                                  </a>
                                ))}
                              </div>
                            ))}
                          <button
                            type="button"
                            className="btn primary sm"
                            onClick={() => setStep(2)}
                          >
                            I've installed one →
                          </button>
                        </div>
                      )}

                      {n === step && n === 2 && cfg && (
                        <div className="import-step__body">
                          <p className="import-hint">
                            Add the Macrotide userscript to your manager:
                          </p>
                          <div className="import-actions">
                            <a
                              className="btn ghost sm"
                              style={{
                                gap: 4,
                                borderColor: "var(--accent)",
                                color: "var(--accent)",
                              }}
                              href={cfg.installUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Icon name="download" size={12} /> Install userscript
                            </a>
                            <button type="button" className="btn ghost sm" onClick={copyScript}>
                              {copied ? "Copied ✓" : "Copy script"}
                            </button>
                          </div>
                          {qr && (
                            <div className="import-qr-block">
                              <span className="import-note">Or scan to install on your phone</span>
                              {/* biome-ignore lint/performance/noImgElement: data-URL QR, no Next loader */}
                              <img
                                className="import-qr"
                                src={qr}
                                alt="Install QR code"
                                width={132}
                                height={132}
                              />
                            </div>
                          )}
                          <button
                            type="button"
                            className="btn primary sm"
                            onClick={() => setStep(3)}
                          >
                            I've added the script →
                          </button>
                        </div>
                      )}

                      {n === step && n === 3 && (
                        <div className="import-step__body">
                          <p className="import-hint">
                            Open {brokers.length > 1 ? "a broker" : "your broker"}, log in if
                            needed, and it syncs in the background.
                          </p>
                          {/* One row per broker — its dot/sub-status is its own live sync
                              state, so there's no separate global "waiting" line. */}
                          <div className="broker-rows">
                            {brokers.map((b) => {
                              const { lastSyncedAt, synced, syncing } = brokerStatus(b.source);
                              return (
                                <div key={b.id} className="broker-row">
                                  <div className="broker-row__main">
                                    <div className="broker-row__name">{b.displayName}</div>
                                    {/* Status line: the dot/spinner sits with the words it
                                        describes (● Synced / ◐ Syncing / ○ Not synced). */}
                                    <div className="broker-row__status" aria-live="polite">
                                      {syncing ? (
                                        <Icon name="loader" size={11} className="mt-spin" />
                                      ) : (
                                        <span
                                          className={`broker-row__dot broker-row__dot--${
                                            synced ? "synced" : "idle"
                                          }`}
                                          aria-hidden
                                        />
                                      )}
                                      {syncing
                                        ? "Syncing…"
                                        : synced && lastSyncedAt
                                          ? `Synced ${fmtRelativeDate(lastSyncedAt)}`
                                          : "Not synced yet"}
                                    </div>
                                  </div>
                                  {b.openUrl && (
                                    <a
                                      className="btn ghost sm"
                                      href={b.openUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={() =>
                                        setOpenedAt((prev) => ({ ...prev, [b.source]: Date.now() }))
                                      }
                                    >
                                      Open ↗
                                    </a>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <p className="import-note">
                            You may briefly see an error page on the broker — that's fine, the sync
                            still runs underneath.
                          </p>
                          {anySynced && (
                            <button type="button" className="btn primary sm" onClick={onOrganize}>
                              Organize in Settings → Connections
                            </button>
                          )}
                          {pollDone && !anySynced && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => {
                                setPollDone(false);
                                setRecheck((r) => r + 1);
                              }}
                            >
                              Check again
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
