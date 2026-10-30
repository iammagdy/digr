import { PARSER_IDS, WEB_SOURCES } from "./sources";

/**
 * A TOOL THE WORKER CANNOT USE IS NOT OFFERED (live, 2026-10-30 evening, the two YouTube runs of the named channels). The web search, the page scrape, the page parsers and the people search each need a provider key. The worker reads it from the website's encrypted
 * key store (or the environment) and, in two days, never obtained one: every one of the 71 recorded calls of those tools was refused as «source unavailable» before reaching a provider. The planner kept choosing them (they were in its tool list, in `catalog_search`
 * results and in the system prompt), spent its whole run on refusals and ended with «a limit of ours», and the catalog's own YouTube channel sources were never called.
 *
 * ONE rule, decided by code before the planner starts: each provider key is resolved once (a read of the key store, no provider call); a source whose provider has no key is not in the tool list, not in `catalog_search`, not in `describe_endpoint`, not allowed in a plan,
 * and the prompt does not name it. The planner then goes to the catalog. Pure apart from the resolver it is given.
 */
export type WebProvider = "firecrawl" | "contextdev";
export type WebAvailability = Readonly<Record<WebProvider, boolean>>;

export const NO_WEB: WebAvailability = { firecrawl: false, contextdev: false };

/** Which providers have a key now. A resolver that throws or returns nothing means «no key»: nothing is ever assumed available. */
export async function resolveWebAvailability(providerKey: (provider: WebProvider) => Promise<string | null>): Promise<WebAvailability> {
  const has = async (p: WebProvider): Promise<boolean> => { try { return Boolean(await providerKey(p)); } catch { return false; } };
  const [firecrawl, contextdev] = await Promise.all([has("firecrawl"), has("contextdev")]);
  return { firecrawl, contextdev };
}

export const anyWebAvailable = (a: WebAvailability): boolean => a.firecrawl || a.contextdev;

/** The provider a web source id needs (the page parsers and the people search are Context.dev's), or null for an id that is not a web source. */
export function providerOfWebSource(id: string): WebProvider | null {
  if (Object.prototype.hasOwnProperty.call(PARSER_IDS, id)) return "contextdev";
  return WEB_SOURCES.find((s) => s.id === id)?.provider ?? null;
}

/** True when the id is a web source whose provider has a key. An id that is not a web source is never «available» here (the catalog decides those). */
export function webSourceAvailable(id: string, availability: WebAvailability): boolean {
  const provider = providerOfWebSource(id);
  return provider !== null && availability[provider];
}

/** The provider a search or scrape call should use: the one the planner asked for when it has a key, else the other when only that one has. */
export function usableSearchProvider(asked: unknown, availability: WebAvailability): WebProvider | null {
  const first: WebProvider = asked === "firecrawl" ? "firecrawl" : "contextdev";
  const other: WebProvider = first === "firecrawl" ? "contextdev" : "firecrawl";
  return availability[first] ? first : availability[other] ? other : null;
}
