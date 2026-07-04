// The raw native-currency figures a user typed for a non-THB transaction, kept
// verbatim as provenance. The ledger's money columns stay in THB (the fold's
// single currency); these are the un-converted facts so a reopen shows the exact
// number entered ($500), never a `THB ÷ fxToThb` reconstruction (514.28571…).
//
// Set only when `tradeCurrency !== "THB"`; all magnitudes, in `tradeCurrency`.
// NEVER read by the projection fold or analytics — display/audit only. Pure and
// client-safe so the Add sheet, the API routes, and the DB schema share one
// contract (the `.$type<NativeInputs>()` on the `native_inputs` column).

import { z } from "zod";

export const nativeInputsSchema = z
  .object({
    amount: z.number().finite().nonnegative().optional(), // primary total (trade / cash)
    value: z.number().finite().nonnegative().optional(), // value-only Balance total
    price: z.number().finite().nonnegative().optional(), // pricePerUnit (avg cost)
    marketPrice: z.number().finite().nonnegative().optional(), // entered current price
    fee: z.number().finite().nonnegative().optional(),
  })
  .strict();

export type NativeInputs = z.infer<typeof nativeInputsSchema>;
