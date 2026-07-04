import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getOwnerStatus } from "@/lib/auth/owner";
import { listUsers } from "@/lib/db/queries/admin";

/**
 * GET /api/admin/users — owner-only.
 *
 * Lists every user with id, email, name, tier, createdAt, and today's token
 * usage. Authorization is enforced HERE on the server (not just hidden in the
 * UI): a non-owner — including a logged-in non-owner user — gets 403.
 */
export async function GET() {
  const { isOwner } = await getOwnerStatus();
  if (!isOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return withDb(() => {
    return NextResponse.json({ users: listUsers() });
  });
}
