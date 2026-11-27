import type { TregCatalog } from "../treg/catalog";
import type { AccountAccess } from "../treg/dataPolicy";
import { blockedEndpointReason } from "../treg/blockList";
import { isSellable } from "../treg/catalog";
import { policyVerdict } from "../treg/dataPolicy";
import { rankedCandidates } from "./candidates";
import { isListingEndpoint, namedSourceRoutes, sourceInputOf } from "./namedRoutes";
import type { StatsMap } from "./sourceRanking";

/**
 * NO GIVE-UP BEFORE THE CATALOG WAS REALLY ASKED (live, 2026-10-30 evening, the three named YouTube channels). The planner ended with «cannot_serve» after ONE empty call (a channel search with an id it made up) and two web searches that were unavailable:
 * no sample had given rows, so the existing «do not end without a plan: you hold real rows» guard did not apply, and the customer was told that our sources do not serve the request; the run before it, which only tried unavailable web sources, was
 * told «a limit of ours». The catalog has the channel's own listing (the cheapest takes a handle), and it was never called.
 *
 * ONE rule for every platform, decided by code from the calls that were really made, and only for a request that NAMES channels, accounts or pages (a topic request keeps the behaviour it had): while NO planning call has given a row, a planning that gives up has to
 * have REACHED at least GIVE_UP_MIN_SOURCES sources of the request's job (a call that reached a provider and answered, empty or failed; a call refused as «unavailable», over budget or repeated reaches nothing), unless the catalog has no untried source left.
 * The sources that take the named source itself (a channel's videos, an account's posts) come first. Bounded by the caller (a few refusals), so the planner is never stuck. Pure: no I/O.
 */
export const GIVE_UP_MIN_SOURCES = 3;
/** The most times one planning run is sent back for it (the same kind of limit as FINISH_REFUSALS_MAX). */
export const GIVE_UP_NO_ROWS_REFUSALS_MAX = 3;

export interface PlanningCallFact { endpoint_id: string; status: string; rows_returned?: number | null; phase?: string }
export interface UntriedSource { id: string; /** The input that takes the named source, for a listing source. */ input?: string; listing: boolean }

export interface GiveUpUnderstandingInput {
  steps: ReadonlyArray<{ platform: string; capability: string; source?: { value?: string } | null }>;
}

export function untriedBeforeGiveUp(input: {
  understanding: GiveUpUnderstandingInput | null;
  catalog: TregCatalog;
  access: AccountAccess;
  stats: StatsMap;
  now: number;
  calls: ReadonlyArray<PlanningCallFact>;
}): { applies: boolean; reached: number; untried: UntriedSource[] } {
  const none = { applies: false, reached: 0, untried: [] as UntriedSource[] };
  const named = input.understanding?.steps.find((step) => step.source?.value?.trim());
  if (!named) return none;
  const planning = input.calls.filter((c) => (c.phase ?? "planning") === "planning");
  // a sample that gave rows is the other guard's business (it holds real rows and builds the plan from them)
  if (planning.some((c) => c.status === "ok" && Number(c.rows_returned ?? 0) > 0)) return none;
  const reached = new Set(planning.filter((c) => c.status === "ok" || c.status === "empty" || c.status === "failed").map((c) => c.endpoint_id)).size;
  const called = new Set(planning.map((c) => c.endpoint_id));
  const allowed = (id: string): boolean => isSellable(id, input.catalog) && !blockedEndpointReason(id) && policyVerdict(id, input.access).allowed;

  const words = named.capability.split(/[.\s_-]+/).filter((word) => word !== named.platform);
  const ranking = rankedCandidates({ catalog: input.catalog, access: input.access, words, platform: named.platform, stats: input.stats, now: input.now });
  const listings: UntriedSource[] = [];
  const searches: UntriedSource[] = [];
  for (const { id } of ranking.ranked) {
    const endpoint = input.catalog.byId.get(id);
    if (endpoint && isListingEndpoint(endpoint)) {
      listings.push({ id, input: sourceInputOf(endpoint)!, listing: true });
    } else {
      listings.push(...namedSourceRoutes(id, input.catalog, allowed, input.now).map((r) => ({ id: r.id, input: r.input, listing: true })));
      searches.push({ id, listing: false });
    }
  }
  const ordered = [...listings, ...searches];
  const seen = new Set<string>();
  const untried = ordered.filter((s) => !called.has(s.id) && !seen.has(s.id) && seen.add(s.id));
  return { applies: reached < GIVE_UP_MIN_SOURCES && untried.length > 0, reached, untried };
}

/** The refusal the planner reads (English, for the model; the customer never sees it). */
export function giveUpRefusalText(found: { reached: number; untried: UntriedSource[] }): string {
  const list = found.untried.slice(0, 4).map((s) => (s.listing ? `${s.id} (takes the named source itself: input ${s.input})` : s.id)).join(", ");
  return `do not end yet: no source has given a single row and only ${found.reached} source(s) of this job were really reached (a call refused as unavailable, over budget or repeated reaches nothing). Sample these untried catalog sources, cheapest first: ${list}. The customer named channels, accounts or pages: sample the source's own listing once for each named source, with its handle (@name) or page address as the input; when a source needs an id, resolve it with the catalog's own lookup endpoint, never an id you cannot show. End with cannot_serve only after at least ${GIVE_UP_MIN_SOURCES} sources were reached, or when the catalog has no untried source left.`;
}
