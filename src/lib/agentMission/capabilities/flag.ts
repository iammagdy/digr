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

/**
 * PHASE 4: the switch of the intelligent tool router (router.ts): discovery ranks and filters with the reviewed registry's verification levels, Diger's measured yield and runtime health, and includes the hand ToolCards. Same reader and
 * scopes; OFF by default and set by nothing in the repository or the database. It acts only where capability discovery itself is on.
 */
export const REGISTRY_ROUTER_FLAG_KEY = "registry_router";

export function readRegistryRouterFlag(settings: Record<string, unknown> | null | undefined, userId: string | null | undefined): boolean {
  return scopedFlagOn(settings?.[REGISTRY_ROUTER_FLAG_KEY], userId ?? null);
}

/**
 * PHASE 5: the switch of multi-provider, per-stage execution (agent/src/engine/sourceGateway.ts): every engine page goes through the provider-neutral SourceGateway (the stage's stored scope, then the TREG or the
 * web gateway), the engine carries out the stages that have an approved recipe even when another stage has none (that one is left to the model path), and saved rows carry their source and call as internal marks.
 * Same reader and scopes (`true` / `"on"`, `{ "user_ids": [...] }`); OFF by default and set by nothing in the repository or the database. Off: execution is exactly what it was.
 */
export const MULTI_STAGE_ENGINE_FLAG_KEY = "multi_stage_engine";

export function readMultiStageEngineFlag(settings: Record<string, unknown> | null | undefined, userId: string | null | undefined): boolean {
  return scopedFlagOn(settings?.[MULTI_STAGE_ENGINE_FLAG_KEY], userId ?? null);
}
