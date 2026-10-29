import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { rankEndpoints } from "./sourceRanking";

/**
 * SOURCES THAT TAKE THE SOURCE ITSELF. A customer who names a channel, a page or an account («من قنوات العربية واليوم السابع وبي بي سي نيوز») wants the items of THOSE sources. A keyword search over a whole platform finds them only by luck: the live YouTube
 * retest of 2026-10-29 searched «اليوم السابع حرب إيران» and «BBC News Iran Israel war» and the card said that none of the three channels was found in what was sampled, although the catalog has «a channel's videos» sources that take the channel itself.
 *
 * The catalog names its sources by capability: `youtube.search.videos` (a keyword search) and `youtube.channel.videos` (the videos of one channel), `x.search.posts` and `x.user.posts`, `tiktok.search.videos` and `tiktok.user.videos`, `facebook.search.posts` and
 * `facebook.user.posts`. `namedSourceRoutes` lists, for the endpoint of a stage, the endpoints of the same platform and of the same kind of item that take the source itself (cheapest first): the planner is asked to sample one before it plans on a keyword search
 * for sources that no sample shows. Nothing is invented: only endpoints of the catalog, by their own capability. Pure.
 */
const SEARCH_CAPABILITY = /^([a-z0-9-]+)\.search\.([a-z_]+)$/;
const OWN_CAPABILITY = /^([a-z0-9-]+)\.(?:channel|user|page|profile|account)\.([a-z_]+)$/;
/** The items of these kinds are interchangeable between a platform's keyword search and its account listing (a post search and an account's posts), except on YouTube, where a channel's «posts» are community posts, not videos. */
const POST_LIKE = new Set(["posts", "videos", "reels"]);
/** The inputs that take the source itself: a channel, a handle, a user name, an account, a page. */
const SOURCE_INPUT = /^(?:channel|channel_?id|channel_?name|channel_?url|handle|user_?name|screen_?name|user|user_?id|sec_?uid|unique_?id|account|profile|profile_?url|page|page_?id|page_?url|url)$/i;

const sameKind = (platform: string, search: string, own: string): boolean => search === own || (platform !== "youtube" && POST_LIKE.has(search) && POST_LIKE.has(own));

/** The input of an endpoint that takes the source (channel, handle, user, page), or null. */
export const sourceInputOf = (e: CatalogEndpoint): string | null => e.inputs.find((i) => SOURCE_INPUT.test(i.name) && (i.type === "string" || i.type === "str" || i.type === "integer"))?.name ?? null;

/** True when an endpoint lists the items of ONE source named by its own input (a channel's videos, an account's posts): its items carry no author of their own to match, they belong to the source asked for. */
export const isListingEndpoint = (e: Pick<CatalogEndpoint, "capability" | "inputs"> | undefined | null): boolean => Boolean(e && e.capability && OWN_CAPABILITY.test(e.capability) && e.inputs.some((i) => SOURCE_INPUT.test(i.name) && (i.type === "string" || i.type === "str" || i.type === "integer")));

export interface NamedRoute { id: string; input: string; usdPerItem: number }

/**
 * The sources of the catalog that list the items of ONE named source (a channel, an account, a page), for a stage whose own endpoint is a keyword search of the same platform and the same kind of item. Empty when the stage's endpoint is not such a search (nothing
 * is claimed about it) or the catalog has none. Cheapest first.
 */
export function namedSourceRoutes(stageEndpointId: string, catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): NamedRoute[] {
  const stage = catalog.byId.get(stageEndpointId);
  const m = stage?.capability ? SEARCH_CAPABILITY.exec(stage.capability) : null;
  if (!stage || !m) return [];
  const [, platform, kind] = m;
  const group = catalog.endpoints.filter((e) => {
    const o = e.capability ? OWN_CAPABILITY.exec(e.capability) : null;
    return o !== null && o[1] === platform && sameKind(platform, kind, o[2]) && isAllowed(e.id) && sourceInputOf(e) !== null;
  });
  return rankEndpoints(group, catalog, new Map(), now).ranked.map((r) => ({ id: r.id, input: sourceInputOf(catalog.byId.get(r.id)!)!, usdPerItem: r.usdPerItem }));
}
