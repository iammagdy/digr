import { scopedFlagOn } from "../scopedFlag";

/**
 * The server switch of unified capability discovery: `agent_settings` key below, `true` / `"on"` for everyone or `{ "user_ids": [...] }` for named test accounts (scopedFlag.ts, the same reader as the research brief). OFF by default;
 * nothing in the repository or the database sets it. Off: the chat, the planning and the execution are exactly what they were.
 */
export const CAPABILITY_DISCOVERY_FLAG_KEY = "capability_discovery_v1";

/** The switch for one mission's account, from the settings the worker already read once for its planning run. */
export function readCapabilityDiscoveryFlag(settings: Record<string, unknown> | null | undefined, userId: string | null | undefined): boolean {
  return scopedFlagOn(settings?.[CAPABILITY_DISCOVERY_FLAG_KEY], userId ?? null);
}

/**
 * PHASE 2 (docs/intelligence/PHASES-2-4-BASELINE.md): the switch of the official-website step of the companies chain through the TREG gateway (`company.enrich`, e.g. `branddev.brand.retrieve-by-name`). Same reader and same
 * scopes (`true` / `"on"`, `{ "user_ids": [...] }`); OFF by default and set by nothing in the repository or the database. It acts only where capability discovery itself is on.
 */
export const WEB_VIA_TREG_FLAG_KEY = "web_via_treg";

export function readWebViaTregFlag(settings: Record<string, unknown> | null | undefined, userId: string | null | undefined): boolean {
  return scopedFlagOn(settings?.[WEB_VIA_TREG_FLAG_KEY], userId ?? null);
}
