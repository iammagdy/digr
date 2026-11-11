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
