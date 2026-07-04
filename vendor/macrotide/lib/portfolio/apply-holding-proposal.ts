// Server-side accept path for an advisor holding proposal. The advisor's
// `propose_holding` tool only EMITS a proposal (rendered as a HoldingProposalCard
// in the chat); nothing is written until the user clicks Accept, which POSTs to
// /api/holdings/propose. This is the trusted side of the propose→card→accept
// loop — the mutation happens here, only on Accept.
//
// Holdings have no `user_id` column of their own: they're scoped through their
// parent bucket (which IS user-scoped via ownedBy). So the only safe way to
// write a holding for the current user is to FIRST resolve the target bucket
// through the per-user-scoped `getBucket`/`listBuckets` (which return only the
// caller's own rows), and reject anything that doesn't belong to them. Never
// insert against a bucketId we haven't confirmed the user owns.
import { getBucket, listBuckets } from "@/lib/db/queries/buckets";
import type { Holding } from "@/lib/db/queries/holdings";
import { createHoldingViaLedger, syncedBrokerForTicker } from "@/lib/db/queries/project-holdings";
import { QUOTE_SOURCES, type QuoteSource } from "@/lib/market/sources";

export interface HoldingProposalInput {
  /**
   * Target bucket. When omitted we fall back to the user's first bucket — the
   * advisor often doesn't know bucket ids, and the OCR handoff just wants the
   * rows landed somewhere sensible the user can re-file.
   */
  bucketId?: string | null;
  ticker: string;
  englishName: string;
  thaiName?: string | null;
  category?: string | null;
  assetClass?: string | null;
  region?: string | null;
  units: number;
  avgCost?: number | null;
  ter?: number | null;
  quoteSource?: string | null;
  source?: string | null;
}

export type HoldingProposalError =
  | "no_bucket" // user has no buckets at all — nothing to attach to
  | "bucket_not_found" // bucketId given but not owned by / known to the user
  | "synced_duplicate" // a broker connection already syncs this ticker into the bucket
  | "invalid"; // payload failed validation

export interface HoldingProposalResult {
  ok: boolean;
  holding?: Holding;
  error?: HoldingProposalError;
  /** Broker label when `error === "synced_duplicate"`. */
  broker?: string;
}

function normalizeQuoteSource(value: string | null | undefined): QuoteSource {
  return value && (QUOTE_SOURCES as readonly string[]).includes(value)
    ? (value as QuoteSource)
    : "market";
}

/**
 * Resolve the target bucket (user-scoped) and persist the holding. Returns a
 * tagged error rather than throwing so the route can map it to a status code.
 */
export function applyHoldingProposal(input: HoldingProposalInput): HoldingProposalResult {
  // Keep the typed case (#235); createHoldingViaLedger canonicalizes a cataloged
  // fund to the official catalog case and leaves a custom asset's case alone.
  const ticker = input.ticker.trim();
  const units = Number(input.units);
  if (!ticker || !Number.isFinite(units) || units <= 0) {
    return { ok: false, error: "invalid" };
  }

  // Resolve the bucket THROUGH the scoped queries: getBucket only returns the
  // caller's own rows, listBuckets only lists the caller's. A bucketId from
  // another user resolves to undefined → bucket_not_found.
  let bucketId = input.bucketId?.trim() || null;
  if (bucketId) {
    const owned = getBucket(bucketId);
    if (!owned) return { ok: false, error: "bucket_not_found" };
  } else {
    const buckets = listBuckets();
    if (buckets.length === 0) return { ok: false, error: "no_bucket" };
    bucketId = buckets[0].id;
  }

  // A broker connection already syncs this ticker into the bucket — accepting
  // would fold on top of the synced lots and silently double-count. Reject.
  const broker = syncedBrokerForTicker(bucketId, ticker);
  if (broker) return { ok: false, error: "synced_duplicate", broker };

  const avgCost =
    input.avgCost != null && Number.isFinite(Number(input.avgCost)) ? Number(input.avgCost) : null;
  const ter = input.ter != null && Number.isFinite(Number(input.ter)) ? Number(input.ter) : null;

  // Routes through the ledger: writes an `opening` anchor, then the holding is
  // the projection of it (ADR 0004).
  const holding = createHoldingViaLedger({
    bucketId,
    ticker,
    englishName: input.englishName.trim() || ticker,
    thaiName: input.thaiName?.trim() || null,
    category: input.category?.trim() || null,
    assetClass: input.assetClass?.trim() || null,
    region: input.region?.trim() || null,
    units,
    avgCost,
    ter,
    source: input.source?.trim() || "Advisor (OCR)",
    quoteSource: normalizeQuoteSource(input.quoteSource),
  });

  return holding ? { ok: true, holding } : { ok: false, error: "invalid" };
}
