import "server-only";

/**
 * Operator-supplied values shown on the legal pages. Macrotide is self-hostable,
 * so none of this is hardcoded — each deployment sets its own via env. Unset
 * values fall back to neutral wording (and the governing-law clause is omitted
 * entirely), so the repo ships nothing operator-specific.
 */

/**
 * Date shown on the legal pages and referenced by their "changes" clauses. Bump
 * it whenever you edit the Terms or Privacy copy — the legal text lives in code
 * alongside this constant, so the date does too.
 */
export const LEGAL_LAST_UPDATED = "2026-05-24";

/** Name of the person/entity operating this instance, or null when unset. */
export function operatorName(): string | null {
  return process.env.OPERATOR_NAME?.trim() || null;
}

/**
 * Contact email for legal/privacy questions, or null when unset. Intentionally
 * has no fallback to OWNER_EMAIL — that var identifies the owner account and
 * shouldn't be published on a public page unless the operator opts in here.
 */
export function contactEmail(): string | null {
  return process.env.CONTACT_EMAIL?.trim() || null;
}

/** Governing-law jurisdiction, or null to omit the clause entirely. */
export function jurisdiction(): string | null {
  return process.env.LEGAL_JURISDICTION?.trim() || null;
}
