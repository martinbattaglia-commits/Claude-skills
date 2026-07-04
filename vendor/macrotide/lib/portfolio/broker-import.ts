// Re-exports the broker import-format types + parser/collector from
// `@macrotide/connector-sdk`, so `@/lib/portfolio/broker-import` is a stable
// in-app import path for them. New code can import from the SDK directly.

export type {
  BrokerAccount,
  BrokerEndpoints,
  BrokerExport,
  BrokerImportResult,
  BrokerImportStats,
  BrokerOrder,
  ExtractedTxnRow,
  UserscriptUpdateUrls,
} from "@macrotide/connector-sdk";
export {
  buildUserscript,
  buildUserscriptHeader,
  looksLikeBrokerExport,
  parseBrokerExport,
} from "@macrotide/connector-sdk";
