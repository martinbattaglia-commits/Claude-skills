// Server-side accept path for an advisor plan-edit proposal. Reads the user's
// current plan, applies the (additive) edit with the pure `applyPlanEdit`
// helper, and persists it back through the per-user-scoped plan query.
//
// This is the trusted side of the propose→card→accept loop: the advisor's
// `propose_plan_edit` tool only EMITS a proposal (it never mutates), and the
// mutation happens here, only when the user clicks Accept on the card. Reads
// and writes resolve through the request's DB context (ownedBy/ownerId), so
// it's automatically per-user scoped — never bypass that.
import { getPlan, type Plan, upsertPlan } from "@/lib/db/queries/plan";
import { applyPlanEdit } from "./plan-edit";

export interface PersistPlanEditInput {
  section: string;
  add: string | null;
  rm: string | null;
  /**
   * Preserve the user's selected target model across the edit. When omitted we
   * keep whatever the persisted plan already has, so the accept path never
   * silently clears it.
   */
  selectedModelId?: string | null;
}

/**
 * Apply a proposal to the persisted plan and return the saved row. Pure
 * `applyPlanEdit` does the markdown surgery; this wrapper supplies the
 * read-modify-write around it.
 */
export function persistPlanEdit(input: PersistPlanEditInput): Plan {
  const current = getPlan();
  const nextMarkdown = applyPlanEdit(current?.markdown ?? "", {
    section: input.section,
    add: input.add,
    rm: input.rm,
  });
  const selectedModelId =
    input.selectedModelId !== undefined
      ? input.selectedModelId
      : (current?.selectedModelId ?? null);
  return upsertPlan({ markdown: nextMarkdown, selectedModelId });
}
