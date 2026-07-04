export interface PlanEditProposal {
  section: string;
  add: string | null;
  rm: string | null;
}

/**
 * Apply a plan-edit proposal to a markdown plan. Pure function — no I/O.
 *
 * If the named section exists, the addition is inserted at the end of that
 * section. Otherwise a new section is appended to the end of the plan.
 * Removals are deferred (the current proposal flow only ever produces
 * additions); leaving the input untouched is safer than guessing what to delete.
 */
export function applyPlanEdit(markdown: string, proposal: PlanEditProposal): string {
  if (!proposal.add) return markdown;
  const sectionHeader = `## ${proposal.section}`;
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (markdown.includes(sectionHeader)) {
    return markdown.replace(new RegExp(`(${escaped}[\\s\\S]*?)(?=\\n##|$)`), `$1${proposal.add}\n`);
  }
  return `${markdown.trimEnd()}\n\n${sectionHeader}\n${proposal.add}\n`;
}
