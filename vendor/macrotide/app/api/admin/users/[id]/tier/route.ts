import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getOwnerStatus } from "@/lib/auth/owner";
import { setUserTier } from "@/lib/db/queries/admin";
import type { Tier } from "@/lib/db/queries/usage";

const VALID_TIERS: readonly Tier[] = ["public", "trusted"];

function isValidTier(v: unknown): v is Tier {
  return typeof v === "string" && (VALID_TIERS as readonly string[]).includes(v);
}

/**
 * POST /api/admin/users/[id]/tier — owner-only.
 *
 * Body: { tier: "public" | "trusted" }. Sets the target user's account tier.
 *
 * Authorization is enforced HERE on the server: a non-owner (including a
 * logged-in non-owner) gets 403 before any write.
 *
 * Lockout guard: the owner cannot demote THEMSELVES to `public`. The owner runs
 * on the `trusted` chain and is the only account that can administer tiers;
 * letting them flip their own tier to `public` would silently cripple their AI
 * access with no in-app way to recover (only the SQL backfill restores it).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, isOwner } = await getOwnerStatus();
  if (!isOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tier = (body as { tier?: unknown })?.tier;
  if (!isValidTier(tier)) {
    return NextResponse.json({ error: "tier must be 'public' or 'trusted'" }, { status: 400 });
  }

  // Self-demote lockout guard: owner cannot drop their own tier below trusted.
  if (user && id === user.id && tier === "public") {
    return NextResponse.json(
      { error: "You cannot demote your own (owner) account to public." },
      { status: 409 },
    );
  }

  return withDb(() => {
    const ok = setUserTier(id, tier);
    if (!ok) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json({ id, tier });
  });
}
