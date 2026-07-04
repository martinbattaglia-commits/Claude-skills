/**
 * AAGUID → authenticator name lookup.
 *
 * The map is a static snapshot (no runtime network calls) sourced from the
 * community-maintained list at:
 *   https://github.com/passkeydeveloper/passkey-authenticator-aaguids
 * Icon data has been stripped; only the "name" field is retained.
 */
import AAGUID_NAMES from "./aaguid-names.json";

const ALL_ZEROS = "00000000-0000-0000-0000-000000000000";

/**
 * Return the human-readable authenticator name for a given AAGUID, or `null`
 * when the AAGUID is absent, the all-zeros sentinel (meaning "not disclosed"),
 * or simply not present in the bundled map.
 */
export function aaguidName(aaguid: string | null | undefined): string | null {
  if (!aaguid || aaguid === ALL_ZEROS) return null;
  // The JSON keys are typed as string by TS; cast via index access.
  const map = AAGUID_NAMES as Record<string, string>;
  return map[aaguid] ?? null;
}
