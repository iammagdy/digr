import platformFacts from "../../../data/treg/platform_facts.json";

/**
 * WHAT EACH SERVED SOCIAL PLATFORM IS, AS DATA (DT-20261126-wordlist-wave4, UP2, D-0240). The platforms the product serves, their order, the words of their tool ids, the hosts of their links, how a link of theirs names ONE item, and
 * whether a post search and an account's posts are the same kind of item are FACTS of the platform, written once in data/treg/platform_facts.json. Code reads these facts; it never branches on a platform's name. The identity of the
 * platform set is the file's own keys; the light list in redesignFlagTypes.ts (the admin screen bundles it, so it cannot read the file) is pinned equal to those keys, in order, by tests/wl4-up2-platform-facts.test.ts.
 */
export interface LinkIdentityRule { host?: string; query?: string; path?: string; key: string }
export interface PlatformFact {
  /** The order in which the words of a tool id are tried (the first platform whose marker is in the id wins). */
  idPrecedence: number;
  /** Regular-expression sources matched against a lower-cased endpoint id. */
  idMarkers: ReadonlyArray<string>;
  /** Regular-expression sources matched against a link's host (www/m/mobile/web removed, lower case). */
  hosts: ReadonlyArray<string>;
  /** Ordered rules: the first that finds a value names the item (`$1` in `key` is the value). A `query` rule reads that query parameter, a `path` rule a pattern on the path (and a `host` rule only applies to that host). */
  linkIdentity: ReadonlyArray<LinkIdentityRule>;
  /** True when a platform's post search and its account listing give the same kind of item; false where the account's «posts» are something else (YouTube: community posts, not videos). */
  postKindsInterchangeable: boolean;
}

export const PLATFORM_FACTS: Readonly<Record<keyof typeof platformFacts, PlatformFact>> = platformFacts as unknown as Record<keyof typeof platformFacts, PlatformFact>;
const FACTS_BY_NAME: Readonly<Record<string, PlatformFact | undefined>> = PLATFORM_FACTS;

const compiled = new Map<string, RegExp>();
const rx = (source: string): RegExp => { let r = compiled.get(source); if (!r) { r = new RegExp(source); compiled.set(source, r); } return r; };

export const platformFactOf = (platform: string): PlatformFact | undefined => FACTS_BY_NAME[platform];
/** Whether a post search and an account's posts are interchangeable on this platform (true for any platform the facts do not know). */
export const postKindsInterchangeableOn = (platform: string): boolean => platformFactOf(platform)?.postKindsInterchangeable !== false;

/** The platform whose words are in a (lower-cased) tool id, trying platforms in `idPrecedence` order; null when none is. */
export function platformOfEndpointId(id: string): keyof typeof platformFacts | null {
  const ordered = (Object.keys(PLATFORM_FACTS) as Array<keyof typeof platformFacts>).sort((a, b) => PLATFORM_FACTS[a].idPrecedence - PLATFORM_FACTS[b].idPrecedence);
  for (const name of ordered) if (PLATFORM_FACTS[name].idMarkers.some((m) => rx(m).test(id))) return name;
  return null;
}

/** The platform a link's host belongs to, or null. */
export function platformOfHost(host: string): keyof typeof platformFacts | null {
  for (const name of Object.keys(PLATFORM_FACTS) as Array<keyof typeof platformFacts>) if (PLATFORM_FACTS[name].hosts.some((h) => rx(h).test(host))) return name;
  return null;
}

/** The identity of the item a link names on its platform (`x:status:123`), or null when no rule of the platform finds one. An empty value found by a rule ends the search (as «?v=» alone always did). */
export function linkIdentityOf(platform: string, u: URL, host: string, path: string): string | null {
  for (const rule of platformFactOf(platform)?.linkIdentity ?? []) {
    if (rule.host !== undefined && !rx(rule.host).test(host)) continue;
    let value: string | null = null;
    if (rule.query !== undefined) value = u.searchParams.get(rule.query);
    else if (rule.path !== undefined) value = rx(rule.path).exec(path)?.[1] ?? null;
    if (value === null) continue;
    return value === "" ? null : rule.key.replace("$1", () => value as string);
  }
  return null;
}
