import { PARSER_IDS, PARSERS, WEB_PROVIDERS, WEB_SOURCES, type WebProvider } from "./sources";

/**
 * A TOOL THE WORKER CANNOT USE IS NOT OFFERED.
 * Dynamic web provider availability: each provider key is resolved once;
 * a source whose provider has no key is not in the tool list, not in catalog_search,
 * and the prompt does not name it. Pure apart from the resolver it is given.
 */
export type { WebProvider };
export type WebAvailability = Readonly<Record<WebProvider, boolean>> & Record<string, boolean>;

export const NO_WEB: WebAvailability = Object.freeze(
  Object.fromEntries(WEB_PROVIDERS.map((p) => [p, false]))
) as WebAvailability;

/** Which providers have a key now. A resolver that throws or returns nothing means «no key»: nothing is ever assumed available. */
export async function resolveWebAvailability(
  providerKey: (provider: WebProvider) => Promise<string | null>
): Promise<WebAvailability> {
  const entries = await Promise.all(
    WEB_PROVIDERS.map(async (p) => {
      try {
        return [p, Boolean(await providerKey(p as WebProvider))] as const;
      } catch {
        return [p, false] as const;
      }
    })
  );
  return Object.freeze(Object.fromEntries(entries)) as WebAvailability;
}

export const anyWebAvailable = (a: WebAvailability): boolean => Object.values(a).some(Boolean);

/** The provider a web source id needs, or null for an id that is not a web source. */
export function providerOfWebSource(id: string): WebProvider | null {
  const parserName = PARSER_IDS[id];
  if (parserName) return (PARSERS[parserName]?.provider as WebProvider) ?? null;
  return (WEB_SOURCES.find((s) => s.id === id)?.provider as WebProvider) ?? null;
}

/** True when the id is a web source whose provider has a key. An id that is not a web source is never «available» here (the catalog decides those). */
export function webSourceAvailable(id: string, availability: WebAvailability): boolean {
  const provider = providerOfWebSource(id);
  return provider !== null && Boolean(availability[provider]);
}

/** The provider a search or scrape call should use: the one the planner asked for when it has a key, else the cheapest available one. */
export function usableSearchProvider(asked: unknown, availability: WebAvailability): WebProvider | null {
  if (typeof asked === "string" && availability[asked as WebProvider]) return asked as WebProvider;
  const searchSources = WEB_SOURCES.filter((s) => s.kind === "search").sort(
    (a, b) => a.usdPerCall - b.usdPerCall
  );
  for (const s of searchSources) {
    if (availability[s.provider as WebProvider]) return s.provider as WebProvider;
  }
  return null;
}
