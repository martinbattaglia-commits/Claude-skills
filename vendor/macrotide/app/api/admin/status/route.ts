import { NextResponse } from "next/server";
import { isRequestOwner } from "@/lib/auth/owner";

/**
 * GET /api/admin/status — returns whether the current session is the owner.
 *
 * The UI uses this only to decide whether to SHOW the Admin entry point. It is
 * NOT a security boundary: every admin action is independently authorized
 * server-side (see /api/admin/users). Always returns 200 so a non-owner just
 * sees `{ isOwner: false }` rather than an error.
 */
export async function GET() {
  return NextResponse.json({ isOwner: await isRequestOwner() });
}
