import { catalogSearch, isSellable, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import { blockedEndpointReason } from "../treg/blockList";
import { policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { rankEndpoints, sameCapability, type Ranking, type StatsMap } from "./sourceRanking";

const stem = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/s$/, "");
const tokensOfCapability = (c: string): string[] => c.toLowerCase().split(/[.\-_\s]+/).map(stem).filter(Boolean);

/**
 * THE JOB THE WORDS DESCRIBE: of the capabilities of the most relevant matches, the ones whose own name carries the most of the request's words («youtube.video.comments» for «youtube video comments»; «companies.search» for
 * «companies search»); a tie keeps the first two by relevance. Their endpoints are the candidates, so a source for another job that merely mentions the platform does not lead the list.
 */
export function jobSeeds(words: string[], relevant: CatalogEndpoint[]): CatalogEndpoint[] {
  const wanted = new Set(words.flatMap((w) => w.split(/\s+/)).map(stem).filter(Boolean));
  const top = relevant.slice(0, 50);
  const caps: string[] = [];
  for (const e of top) if (e.capability && !caps.includes(e.capability)) caps.push(e.capability);
  const scored = caps.map((c, i) => ({ c, i, score: tokensOfCapability(c).filter((t) => wanted.has(t)).length }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  const chosen = scored.filter((x) => x.score === best).sort((a, b) => a.i - b.i).slice(0, 2).map((x) => x.c);
  const seeds = top.filter((e) => e.capability && chosen.includes(e.capability));
  return seeds.length > 0 ? seeds : top.slice(0, 3);
}

/**
 * THE CANDIDATES OF A JOB, ranked by code: the catalog sources that do the job the words describe (the same capability as the three most relevant allowed matches, plus the matches themselves), ranked by expected cost per
 * delivered item with the measurement and the health of the recorded calls. One function for the planner's `catalog_search` and for the offline re-plan of the report.
 */
export function rankedCandidates(input: { catalog: TregCatalog; access: AccountAccess; words: string[]; platform?: string | null; stats: StatsMap; now: number; matched?: CatalogEndpoint[] }): Ranking & { endpoints: Map<string, CatalogEndpoint> } {
  const { catalog, access } = input;
  const allowed = (id: string): boolean => policyVerdict(id, access).allowed && !blockedEndpointReason(id) && isSellable(id, catalog);
  const seeds = jobSeeds(input.words, catalogSearch({ platform: input.platform ?? null, words: input.words, limit: 50 }, catalog).filter((h) => allowed(h.id)).map((h) => catalog.byId.get(h.id)).filter((e): e is CatalogEndpoint => Boolean(e)));
  const group = sameCapability(seeds, catalog, allowed);
  // the job's own endpoints; the words' direct matches stand in only when the job could not be named
  const pool = group.length > 0 ? group : [...(input.matched ?? [])];
  const ranking = rankEndpoints(pool, catalog, input.stats, input.now);
  return { ...ranking, endpoints: new Map(pool.map((e) => [e.id, e])) };
}
