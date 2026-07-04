import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Connector } from "@macrotide/connector-sdk";

// The server-only LOADER for a connector manifest — DATA only (no executable
// code; the generic collector/parser live in @macrotide/connector-sdk and stay
// broker-agnostic). Broker specifics never live in committed code: they come from a
// connector manifest supplied at deploy time, so this repo carries no broker
// identity and a different broker is a config change.
//
// Provide the manifest one of three ways (checked in order):
//   1. BROKER_CONNECTOR_PATH — path to a local JSON manifest (recommended for
//      self-host; gitignored under .connectors/).
//   2. BROKER_CONNECTOR_URL  — a URL the app fetches the JSON from (for shared /
//      published connectors). Cached briefly. Data-only, so low-risk.
//   3. Legacy BROKER_IMPORT_* env vars (back-compat).
// Unset → no broker configured; the importer UI hides itself.

export type { Connector };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Validate a parsed manifest into a Connector (or null if it lacks essentials). */
function toConnector(raw: unknown): Connector | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const host = str(o.host);
  const planPath = str(o.planPath);
  const historyPath = str(o.historyPath);
  // Pending orders are optional — a broker with no pending endpoint omits it.
  const pendingPath = str(o.pendingPath);
  if (!host || !planPath || !historyPath) return null;
  const sourceTag = str(o.sourceTag) || "broker";
  return {
    id: str(o.id) || sourceTag,
    displayName: str(o.displayName) || "your broker",
    host,
    planPath,
    historyPath,
    pendingPath: pendingPath || undefined,
    sourceTag,
    openUrl: str(o.openUrl) || undefined,
    loginUrl: str(o.loginUrl) || undefined,
    // Response-shape map (data-only); the SDK fills any gaps with its built-in
    // defaults. Passed through verbatim — validated structurally by the SDK.
    shape: o.shape && typeof o.shape === "object" ? (o.shape as Connector["shape"]) : undefined,
  };
}

function fromFile(path: string): Connector | null {
  try {
    return toConnector(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch {
    return null;
  }
}

// Brief in-memory cache per URL so we don't refetch on every request.
const urlCache = new Map<string, { at: number; data: Connector | null }>();
const URL_TTL_MS = 5 * 60_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Reject hostnames that are (or obviously map to) private, loopback, or
 * link-local addresses — the SSRF danger zone (cloud metadata at
 * 169.254.169.254, localhost, RFC1918, CGNAT). `BROKER_CONNECTOR_URL` is
 * operator-set, so this is defense-in-depth: a misconfigured or redirecting
 * endpoint must not be able to reach internal services. (Host-string check; not
 * a DNS-rebind defense, but the URL isn't user-supplied.)
 */
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  ) {
    return true;
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback/link-local/ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true; // loopback, RFC1918 /8, this-host
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 /12
    if (a === 192 && b === 168) return true; // RFC1918 /16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

async function fromUrl(url: string): Promise<Connector | null> {
  const now = Date.now();
  const cached = urlCache.get(url);
  if (cached && now - cached.at < URL_TTL_MS) return cached.data;

  // SSRF defense-in-depth: https only, to a public host, no redirects, bounded
  // time + size.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return cached?.data ?? null;
  }
  if (parsed.protocol !== "https:" || isDisallowedHost(parsed.hostname)) {
    return cached?.data ?? null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_MANIFEST_BYTES) {
      throw new Error("connector manifest too large");
    }
    const data = toConnector(await res.json());
    urlCache.set(url, { at: now, data });
    return data;
  } catch {
    // On failure keep serving the last good value (if any), else null.
    return cached?.data ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Split a comma-separated env list into trimmed, non-empty entries. */
function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** De-dupe connectors by id (first wins), so a doubled-up env can't yield two. */
function uniqueById(list: Connector[]): Connector[] {
  const seen = new Set<string>();
  const out: Connector[] = [];
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function fromLegacyEnv(): Connector | null {
  return toConnector({
    id: process.env.BROKER_IMPORT_SOURCE_TAG,
    displayName: process.env.BROKER_IMPORT_DISPLAY_NAME,
    host: process.env.BROKER_IMPORT_HOST,
    planPath: process.env.BROKER_IMPORT_PLAN_PATH,
    historyPath: process.env.BROKER_IMPORT_HISTORY_PATH,
    pendingPath: process.env.BROKER_IMPORT_PENDING_PATH,
    sourceTag: process.env.BROKER_IMPORT_SOURCE_TAG,
    openUrl: process.env.BROKER_IMPORT_OPEN_URL,
    loginUrl: process.env.BROKER_IMPORT_LOGIN_URL,
  });
}

/**
 * Resolve every configured connector. `BROKER_CONNECTOR_PATH` and
 * `BROKER_CONNECTOR_URL` each accept a comma-separated list, so several brokers
 * (e.g. two fund platforms) can run side by side. Checked in order
 * (paths → URLs → legacy env); the first source that yields any connector wins.
 */
export async function getConnectors(): Promise<Connector[]> {
  const path = process.env.BROKER_CONNECTOR_PATH?.trim();
  if (path) {
    const fromPaths = splitList(path)
      .map(fromFile)
      .filter((c): c is Connector => c !== null);
    if (fromPaths.length) return uniqueById(fromPaths);
  }
  const url = process.env.BROKER_CONNECTOR_URL?.trim();
  if (url) {
    const fetched = await Promise.all(splitList(url).map(fromUrl));
    const fromUrls = fetched.filter((c): c is Connector => c !== null);
    if (fromUrls.length) return uniqueById(fromUrls);
  }
  const legacy = fromLegacyEnv();
  return legacy ? [legacy] : [];
}

/**
 * Resolve a single connector: the one matching `id`, or the first configured
 * (back-compat for callers that assume one broker). Null when none is set up.
 */
export async function getConnector(id?: string): Promise<Connector | null> {
  const all = await getConnectors();
  if (!all.length) return null;
  if (id) return all.find((c) => c.id === id) ?? null;
  return all[0];
}
