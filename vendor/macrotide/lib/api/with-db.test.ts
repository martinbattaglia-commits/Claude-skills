import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbContext } from "@/lib/db/context";

// Routing-precedence contract for withDb():
//   - authenticated user  -> owner context (isDemo:false, that userId), even
//     if a stale demo cookie is present. Session wins.
//   - no user + demo cookie -> isolated demo session (isDemo:true, userId:null).
//   - no user + no cookie   -> owner singleton, userId:null (single-owner /
//     AUTH_DISABLED behavior).
//
// We mock the collaborators so the test exercises only the branching logic and
// doesn't open real SQLite handles.

const mockCookieStore = { get: vi.fn() };
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(mockCookieStore),
}));

const mockRequireUser = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/auth/require-user", () => ({
  requireUser: () => mockRequireUser(),
}));

// Sentinel handles so we can assert which DB the context points at. After the
// app/market split, withDb populates four handles: the app pair (owner or demo
// in-memory) and the market pair (always the shared real market.db).
const appDb = { __which: "app-db" } as unknown;
const appSqlite = { __which: "app-sqlite" } as unknown;
const marketDb = { __which: "market-db" } as unknown;
const marketSqlite = { __which: "market-sqlite" } as unknown;
vi.mock("@/lib/db/client", () => ({
  get appDb() {
    return appDb;
  },
  get appSqlite() {
    return appSqlite;
  },
  get marketDb() {
    return marketDb;
  },
  get marketSqlite() {
    return marketSqlite;
  },
}));

const demoDb = { __which: "demo-db" } as unknown;
const demoSqlite = { __which: "demo-sqlite" } as unknown;
const mockGetOrCreateDemoSession = vi.fn((_id: string) => ({ db: demoDb, sqlite: demoSqlite }));
vi.mock("@/lib/db/demo", () => ({
  getOrCreateDemoSession: (id: string) => mockGetOrCreateDemoSession(id),
}));

// runWithDbContext just runs the fn; we capture the ctx it was handed.
vi.mock("@/lib/db/context", () => ({
  runWithDbContext: <T>(_ctx: DbContext, fn: () => T | Promise<T>) => fn(),
}));

import { requireApiSession, withDb } from "./with-db";

function setDemoCookie(value: string | undefined) {
  mockCookieStore.get.mockReturnValue(value ? { value } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  setDemoCookie(undefined);
  mockRequireUser.mockResolvedValue(null);
  // Auth is required by default; individual single-owner tests opt out.
  delete process.env.AUTH_DISABLED;
});

describe("withDb routing precedence", () => {
  it("authenticated user wins over a stale demo cookie -> owner context", async () => {
    mockRequireUser.mockResolvedValue("user-123");
    setDemoCookie("demo-abc"); // stale demo cookie present

    const ctx = await withDb((c) => c);

    expect(ctx.isDemo).toBe(false);
    expect(ctx.userId).toBe("user-123");
    expect(ctx.sessionId).toBe("owner");
    expect(ctx.appDb).toBe(appDb);
    expect(ctx.appSqlite).toBe(appSqlite);
    expect(ctx.marketDb).toBe(marketDb);
    // The demo session must never be materialized for a logged-in user.
    expect(mockGetOrCreateDemoSession).not.toHaveBeenCalled();
  });

  it("anonymous user + demo cookie -> isolated demo context", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie("demo-abc");

    const ctx = await withDb((c) => c);

    expect(ctx.isDemo).toBe(true);
    expect(ctx.userId).toBeNull();
    expect(ctx.sessionId).toBe("demo-abc");
    // Demo: app handle is the isolated in-memory session …
    expect(ctx.appDb).toBe(demoDb);
    expect(ctx.appSqlite).toBe(demoSqlite);
    // … but market data is the shared real market.db.
    expect(ctx.marketDb).toBe(marketDb);
    expect(ctx.marketSqlite).toBe(marketSqlite);
    expect(mockGetOrCreateDemoSession).toHaveBeenCalledWith("demo-abc");
  });

  it("AUTH_DISABLED + no user + no cookie -> owner singleton, userId null (single-owner dev)", async () => {
    process.env.AUTH_DISABLED = "1";
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie(undefined);

    const ctx = await withDb((c) => c);

    expect(ctx.isDemo).toBe(false);
    expect(ctx.userId).toBeNull();
    expect(ctx.sessionId).toBe("owner");
    expect(ctx.appDb).toBe(appDb);
    expect(ctx.marketDb).toBe(marketDb);
    expect(mockGetOrCreateDemoSession).not.toHaveBeenCalled();
  });
});

describe("withDb deny-by-default auth (#187)", () => {
  it("anonymous (no user, no cookie, auth required) -> 401, fn never runs", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie(undefined);

    const fn = vi.fn((c) => c);
    const res = (await withDb(fn)) as unknown as Response;

    expect(res.status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
    expect(mockGetOrCreateDemoSession).not.toHaveBeenCalled();
  });

  it("explicit public route serves the anonymous owner-null context (no 401)", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie(undefined);

    const ctx = await withDb((c) => c, { public: true });

    expect(ctx.isDemo).toBe(false);
    expect(ctx.userId).toBeNull();
    expect(ctx.sessionId).toBe("owner");
  });

  it("authenticated request is allowed through", async () => {
    mockRequireUser.mockResolvedValue("user-123");

    const ctx = await withDb((c) => c);

    expect(ctx.userId).toBe("user-123");
    expect(ctx.isDemo).toBe(false);
  });

  it("demo cookie is allowed through", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie("demo-abc");

    const ctx = await withDb((c) => c);

    expect(ctx.isDemo).toBe(true);
    expect(ctx.sessionId).toBe("demo-abc");
  });
});

describe("requireApiSession (gate for non-withDb routes)", () => {
  it("returns 401 for an anonymous request when auth is required", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie(undefined);

    const res = await requireApiSession();

    expect(res?.status).toBe(401);
  });

  it("returns null (allowed) for an authenticated request", async () => {
    mockRequireUser.mockResolvedValue("user-123");

    expect(await requireApiSession()).toBeNull();
  });

  it("returns null (allowed) for a demo session", async () => {
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie("demo-abc");

    expect(await requireApiSession()).toBeNull();
  });

  it("returns null (allowed) under AUTH_DISABLED", async () => {
    process.env.AUTH_DISABLED = "1";
    mockRequireUser.mockResolvedValue(null);
    setDemoCookie(undefined);

    expect(await requireApiSession()).toBeNull();
  });
});
