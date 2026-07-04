import "server-only";
import { NextResponse } from "next/server";
import { getOwnerStatus } from "@/lib/auth/owner";

/**
 * Owner-only gate for operator/admin routes (stricter than `requireApiSession`).
 * Returns a 403 NextResponse unless the request is the deployment owner, or
 * `null` when the caller may proceed. Under `AUTH_DISABLED=1` (single-owner dev)
 * there is no session to check, so the local operator is treated as the owner.
 *
 *     const denied = await requireOwner();
 *     if (denied) return denied;
 *
 * Kept in its own module (not in with-db.ts) so the lightweight `withDb` unit
 * test doesn't pull the better-auth/owner module graph.
 */
export async function requireOwner(): Promise<NextResponse | null> {
  if (process.env.AUTH_DISABLED === "1") return null;
  const { isOwner } = await getOwnerStatus();
  if (isOwner) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
