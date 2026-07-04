import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

// Authorization contract for the owner-only admin API:
//   - non-owner (no session, OR logged-in but not OWNER_EMAIL) -> 403
//   - owner -> 200 and the write goes through
//   - owner demoting THEMSELVES to public -> 409 (lockout guard)
//
// We mock the session resolver + the admin queries so the tests exercise ONLY
// the route's authorization branching, not real SQLite or headers.

const mockGetSessionUser = vi.fn<() => Promise<SessionUser | null>>();
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

// withDb just runs the fn with a dummy ctx — no real DB.
vi.mock("@/lib/api/with-db", () => ({
  withDb: <T>(fn: (ctx: unknown) => T | Promise<T>) => fn({}),
}));

const mockListUsers = vi.fn(() => [{ id: "u1", email: "u1@x.io", name: "u1", tier: "public" }]);
const mockSetUserTier = vi.fn((_id: string, _tier: string) => true);
vi.mock("@/lib/db/queries/admin", () => ({
  listUsers: () => mockListUsers(),
  setUserTier: (id: string, tier: string) => mockSetUserTier(id, tier),
}));

import { POST as setTierRoute } from "@/app/api/admin/users/[id]/tier/route";
import { GET as listUsersRoute } from "@/app/api/admin/users/route";

const OWNER: SessionUser = { id: "owner-id", email: "owner@example.com", name: "Owner" };
const NON_OWNER: SessionUser = { id: "u2", email: "stranger@example.com", name: "Stranger" };

function tierReq(tier: unknown): Request {
  return new Request("http://localhost/api/admin/users/u1/tier", {
    method: "POST",
    body: JSON.stringify({ tier }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OWNER_EMAIL = "owner@example.com";
  mockSetUserTier.mockReturnValue(true);
});

describe("GET /api/admin/users (list)", () => {
  it("rejects an unauthenticated request with 403", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await listUsersRoute();
    expect(res.status).toBe(403);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("rejects a logged-in NON-owner with 403", async () => {
    mockGetSessionUser.mockResolvedValue(NON_OWNER);
    const res = await listUsersRoute();
    expect(res.status).toBe(403);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("lets the owner list users", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await listUsersRoute();
    expect(res.status).toBe(200);
    expect(mockListUsers).toHaveBeenCalledOnce();
  });

  it("FAILS CLOSED: even the owner email is rejected when OWNER_EMAIL is unset", async () => {
    delete process.env.OWNER_EMAIL;
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await listUsersRoute();
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/users/[id]/tier (set tier)", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("rejects a non-owner with 403 and does not write", async () => {
    mockGetSessionUser.mockResolvedValue(NON_OWNER);
    const res = await setTierRoute(tierReq("trusted"), params("u1"));
    expect(res.status).toBe(403);
    expect(mockSetUserTier).not.toHaveBeenCalled();
  });

  it("lets the owner promote another user to trusted", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await setTierRoute(tierReq("trusted"), params("u1"));
    expect(res.status).toBe(200);
    expect(mockSetUserTier).toHaveBeenCalledWith("u1", "trusted");
  });

  it("lets the owner demote another user to public", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await setTierRoute(tierReq("public"), params("u1"));
    expect(res.status).toBe(200);
    expect(mockSetUserTier).toHaveBeenCalledWith("u1", "public");
  });

  it("rejects an invalid tier value with 400", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await setTierRoute(tierReq("superuser"), params("u1"));
    expect(res.status).toBe(400);
    expect(mockSetUserTier).not.toHaveBeenCalled();
  });

  it("SELF-DEMOTE GUARD: owner cannot demote their own account to public (409)", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await setTierRoute(tierReq("public"), params(OWNER.id));
    expect(res.status).toBe(409);
    expect(mockSetUserTier).not.toHaveBeenCalled();
  });

  it("owner CAN re-affirm their own trusted tier (not a demote)", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    const res = await setTierRoute(tierReq("trusted"), params(OWNER.id));
    expect(res.status).toBe(200);
    expect(mockSetUserTier).toHaveBeenCalledWith(OWNER.id, "trusted");
  });

  it("returns 404 when the target user does not exist", async () => {
    mockGetSessionUser.mockResolvedValue(OWNER);
    mockSetUserTier.mockReturnValue(false);
    const res = await setTierRoute(tierReq("trusted"), params("ghost"));
    expect(res.status).toBe(404);
  });
});
