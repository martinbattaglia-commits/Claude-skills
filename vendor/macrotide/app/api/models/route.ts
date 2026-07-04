import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { createModelPortfolio, listModelPortfolios } from "@/lib/db/queries/models";

export async function GET() {
  return withDb(() => NextResponse.json(listModelPortfolios()));
}

export async function POST(req: Request) {
  const body = await req.json();
  // A user-created model is always a private customization: never let the
  // request promote it to a shared built-in (visible to everyone) or set an
  // owner. The preset seeder creates built-ins directly, bypassing this route.
  const { userId: _userId, builtIn: _builtIn, ...rest } = body ?? {};
  return withDb(() =>
    NextResponse.json(createModelPortfolio({ ...rest, builtIn: false }), { status: 201 }),
  );
}
