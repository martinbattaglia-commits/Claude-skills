import { NextResponse } from "next/server";
import { withDb } from "@/lib/api/with-db";
import { persistPlanEdit } from "@/lib/portfolio/apply-plan-edit";

// Accept side of the advisor plan-edit proposal loop. The advisor's
// `propose_plan_edit` tool only emits a proposal (rendered as a card in the
// chat); nothing is written until the user clicks Accept, which POSTs here.
// We apply the additive edit server-side via persistPlanEdit (read → applyPlanEdit
// → upsert), per-user scoped through the DB context. Rejecting just dismisses
// the card client-side and never reaches this route.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    section?: unknown;
    add?: unknown;
    rm?: unknown;
    selectedModelId?: unknown;
  };
  const section = typeof body.section === "string" ? body.section.trim() : "";
  if (!section) {
    return NextResponse.json({ error: "section_required" }, { status: 400 });
  }
  const add = typeof body.add === "string" ? body.add : null;
  const rm = typeof body.rm === "string" ? body.rm : null;
  if (!add && !rm) {
    return NextResponse.json({ error: "nothing_to_apply" }, { status: 400 });
  }
  const selectedModelId =
    body.selectedModelId === undefined
      ? undefined
      : typeof body.selectedModelId === "string"
        ? body.selectedModelId
        : null;

  return withDb(() => NextResponse.json(persistPlanEdit({ section, add, rm, selectedModelId })));
}
