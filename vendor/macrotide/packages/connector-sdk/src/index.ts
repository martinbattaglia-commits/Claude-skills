// @macrotide/connector-sdk — the broker-agnostic contract + generic, config-driven
// collector/parser for Macrotide broker-import connectors.
//
// A connector is DATA (a manifest: host, endpoints, display name, and a `shape`
// describing the broker's response field paths). This SDK turns that manifest
// into an install-ready userscript and parses the broker's export into
// Macrotide's import format — with NO broker identity in the code.

export const CONNECTOR_SDK_VERSION = "0.1.0";

export type { UserscriptUpdateUrls } from "./collector";
export {
  buildUserscript,
  buildUserscriptHeader,
  COLLECTOR_PROTOCOL_VERSION,
  resolveCollectorShape,
  SCRIPT_REVISION,
} from "./collector";
export { EXAMPLE_CONNECTOR } from "./example.connector";
export { looksLikeBrokerExport, parseBrokerExport } from "./parser";
export type {
  BrokerAccount,
  BrokerEndpoints,
  BrokerExport,
  BrokerImportResult,
  BrokerImportStats,
  BrokerOrder,
  Connector,
  ConnectorShape,
  ExtractedTxnRow,
  FieldRef,
} from "./types";
