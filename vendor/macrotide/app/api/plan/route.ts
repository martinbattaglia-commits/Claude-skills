import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { getPlan, upsertPlan } from "@/lib/db/queries/plan";

export async function GET() {
  return withDb(() => {
    const plan = getPlan();
    if (!plan) return NextResponse.json({ markdown: "", selectedModelId: null, updatedAt: null });
    return NextResponse.json(plan);
  });
}

export async function PUT(req: Request) {
  const body = await req.json();
  return withDb(() => NextResponse.json(upsertPlan(body)));
}
