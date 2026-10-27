import writeActions from "../../../data/treg/treg_write_actions.json";
import catalogIndex from "../../../data/treg/treg_catalog_index.json";

/**
 * The hard block list for the data gateway. Enforced in code at the one place every gateway call passes (`executeTregCall`), whatever the plan, the model or a
 * stored quote says. A blocked endpoint is never sent a request.
 *
 *  - `write_action`: one of the 276 endpoints that create, edit, delete, post, reply, send… (data/treg/treg_write_actions.json). Never callable.
 *  - `own_account`: an endpoint that acts on an account of ours, when the caller knows its scope (the live describe says so).
 *  - `paused_provider`: any endpoint whose PROVIDER is paused, by provider name («apollo», «datagma», owner decision), whatever the catalog says.
 *  - `not_sellable`: an endpoint of a KNOWN provider that is not in the sellable catalog snapshot (data/treg/treg_catalog_index.json, built from
 *    treg_catalog_sellable.json, whose own-account, write and paused endpoints were removed). This covers the 652 own-account endpoints and the 12 paused ones
 *    without listing them, and an id a model made up inside a real provider.
 *
 * An id whose provider is not in the catalog at all (a placeholder such as «x.y.z», a product slug) is not matched by the `not_sellable` rule: the gateway answers it
 * with «not found» at no cost. Paused providers are blocked by name (`PAUSED_PROVIDERS`), because the snapshot cannot list their endpoints.
 */
export type EndpointBlockReason = "write_action" | "own_account" | "paused_provider" | "not_sellable";

/** Providers that are paused: every endpoint of these providers is blocked by NAME (the snapshot carries only a count of paused endpoints, not their ids). */
export const PAUSED_PROVIDERS: readonly string[] = ["apollo", "datagma"];
const PAUSED_SET: ReadonlySet<string> = new Set(PAUSED_PROVIDERS);

const WRITE_IDS: ReadonlySet<string> = new Set((writeActions as Array<{ id: string }>).map((e) => e.id));
const SELLABLE_IDS: ReadonlySet<string> = new Set(catalogIndex.ids);
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([...catalogIndex.providers, ...[...WRITE_IDS].map(providerOf)]);

/** The provider part of an endpoint id: everything before the first dot. */
export function providerOf(endpointId: string): string {
  const id = String(endpointId ?? "").trim();
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : "";
}

/** Why an endpoint may never be called, or null when it may. `scope` is the catalog's own scope of the endpoint when the caller has it. */
export function blockedEndpointReason(endpointId: string, scope?: string | null): EndpointBlockReason | null {
  const id = String(endpointId ?? "").trim();
  if (!id) return null;
  if (WRITE_IDS.has(id)) return "write_action";
  if (String(scope ?? "").toLowerCase() === "own_account") return "own_account";
  const provider = providerOf(id);
  if (provider && PAUSED_SET.has(provider.toLowerCase())) return "paused_provider";
  if (provider && KNOWN_PROVIDERS.has(provider) && !SELLABLE_IDS.has(id)) return "not_sellable";
  return null;
}

export const isEndpointBlocked = (endpointId: string, scope?: string | null): boolean => blockedEndpointReason(endpointId, scope) !== null;

/** Sizes of the lists in force (for the admin trace and the tests). */
export const BLOCK_LIST_SIZES = { writeActions: WRITE_IDS.size, sellable: SELLABLE_IDS.size, providers: KNOWN_PROVIDERS.size } as const;
export const CATALOG_SNAPSHOT = catalogIndex.source;
