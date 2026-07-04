// Fee-type normalization for the SEC FundFactsheet fees endpoint.
//
// The SEC reports each fee as a free-text `fee_type_desc` carrying both a Thai
// label and an English label in parens, e.g.
//   "ค่าธรรมเนียมและค่าใช้จ่ายรวมทั้งหมด (Total Fee and Expense)"
// We normalize the known ones to a small enum so the fee finder can compare
// like-for-like, while preserving the raw string in the DB for anything new.
//
// This module is the shared contract between the ingestion side (the SEC
// provider + refresh job classify rows on the way in) and the read side (the
// db queries and the find_funds advisor tool reason over the enum).

/** Normalized fee categories. `other` is the catch-all for unmapped SEC labels. */
export const FEE_TYPES = ["front_end", "back_end", "management", "total_expense", "other"] as const;
export type FeeType = (typeof FEE_TYPES)[number];

/** The fee figure the fund finder ranks on — the all-in cost of holding the fund. */
export const TER_FEE_TYPE: FeeType = "total_expense";

// Match on the English label inside the parens (stable across funds), falling
// back to Thai keywords. Order matters: check "Total Fee" before "Fee" matches.
const MATCHERS: ReadonlyArray<readonly [RegExp, FeeType]> = [
  [/total fee and expense|ค่าธรรมเนียมและค่าใช้จ่ายรวม/i, "total_expense"],
  [/front-?end fee|ค่าธรรมเนียมการขาย/i, "front_end"],
  [/back-?end fee|ค่าธรรมเนียมการรับซื้อคืน/i, "back_end"],
  [/management fee|ค่าธรรมเนียมการจัดการ/i, "management"],
];

/**
 * Map a raw SEC `fee_type_desc` to our normalized enum. Unknown labels return
 * `'other'` (and are still persisted verbatim in `fund_fees.feeTypeRaw`).
 */
export function normalizeFeeType(rawDesc: string): FeeType {
  for (const [pattern, feeType] of MATCHERS) {
    if (pattern.test(rawDesc)) return feeType;
  }
  return "other";
}

/** Raw shape of one item in the SEC `/v2/fund/factsheet/fees` response. */
export type SecFundFeeItem = {
  proj_id: string;
  fund_class_name: string;
  start_date: string;
  end_date: string | null;
  prospectus_type?: string | null;
  fee_type_desc: string;
  rate?: number | null;
  actual_value?: number | null;
  /** Additional remarks / notes for this fee (if any). */
  fee_other_desc?: string | null;
  last_upd_date?: string | null;
};
