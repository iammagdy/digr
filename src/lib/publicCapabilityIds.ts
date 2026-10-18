/**
 * Ids that appear in page markup (keys, option values, query strings) must not carry a provider name. The stored
 * capability slug is unchanged (it is data in the registry and in saved quotes); only what the browser sees is mapped,
 * and the server maps it back before any lookup or price.
 */
const PUBLIC_ID_BY_SLUG: Record<string, string> = {
  "icypeas-companies-search": "companies-search",
  "icypeas-people-search": "people-search-legacy",
};

const SLUG_BY_PUBLIC_ID = Object.fromEntries(Object.entries(PUBLIC_ID_BY_SLUG).map(([slug, id]) => [id, slug]));

export function publicCapabilityId(slug: string): string {
  return PUBLIC_ID_BY_SLUG[slug] ?? slug;
}

export function capabilitySlugFromPublicId(id: string): string {
  return SLUG_BY_PUBLIC_ID[id] ?? id;
}

/** Provider names that must never appear in a public page or its markup. */
export const PROVIDER_NAME_PATTERN = /icypeas|tikhub|scrapecreators|anyapi|crawl4ai|treg|apify|serpapi|openai|anthropic/i;
