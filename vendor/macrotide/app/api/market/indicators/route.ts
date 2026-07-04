import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import {
  getUserIndicatorSymbols,
  setUserIndicatorSymbols,
} from "@/lib/db/queries/market-indicators";
import { INDICATOR_CATALOG } from "@/lib/market/indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → the user's current indicator selection + the full addable catalog.
// The catalog is static metadata (label/group/tier), safe to ship to the client
// for the "manage indicators" picker.
export async function GET() {
  return withDb(() =>
    NextResponse.json({ selected: getUserIndicatorSymbols(), catalog: INDICATOR_CATALOG }),
  );
}

// PUT { symbols: string[] } → replace the user's list (order preserved).
// Unknown symbols are dropped server-side; an empty list resets to defaults.
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { symbols?: unknown } | null;
  if (!body || !Array.isArray(body.symbols) || !body.symbols.every((s) => typeof s === "string")) {
    return NextResponse.json({ error: "Expected { symbols: string[] }" }, { status: 400 });
  }
  return withDb(() =>
    NextResponse.json({ selected: setUserIndicatorSymbols(body.symbols as string[]) }),
  );
}
