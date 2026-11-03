import { alignQueryToCairoPeriod, type DateWindow } from "../../src/lib/agentMission/dateWindow";
import { isEnabled, type StageFilter } from "../../src/lib/agentMission/filters";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { CatalogEndpoint } from "../../src/lib/treg/catalog";
import { toolProfile } from "../../src/lib/agentMission/toolProfile";

/**
 * THE REQUEST THAT RUNS COVERS EXACTLY THE ASKED CAIRO DAYS (live finding B, 2026-11-03). The stored recipe of the live mission held the right Cairo moments, but the model-written
 * query that ran carried `since:2026-10-01 until:2026-10-31` (day only), which the source read as UTC days. Two places send a model-written query on the old path: the engine's first
 * read of a stage, and the model's own `treg_call` when a stage has no recipe. Both go through `alignQueryToCairoPeriod`, only for a stage whose period filter is a range of days.
 */

/** The enabled period filter of a stage that is a range of days (not «the last N days»), or null. */
export function dayRangeOf(stage: Pick<PricedPlan["stages"][number], "filters">): { from: string; to?: string } | null {
  const f = ((stage.filters ?? []) as StageFilter[]).find((x) => x.kind === "period" && isEnabled(x) && x.days === undefined && typeof x.from === "string");
  return f ? { from: f.from as string, ...(typeof f.to === "string" ? { to: f.to } : {}) } : null;
}

/** The engine's first-page inputs of a stage whose source takes the period as `since:` / `until:` in its query: the customer's Cairo days written into them. Anything else is returned as it is. */
export function withCairoPeriod(stage: Pick<PricedPlan["stages"][number], "filters">, window: DateWindow | undefined | null, params: Record<string, unknown>): Record<string, unknown> {
  if (!window || window.kind !== "query_operators") return { ...params };
  const range = dayRangeOf(stage);
  const query = params[window.param];
  if (!range || typeof query !== "string") return { ...params };
  return { ...params, [window.param]: alignQueryToCairoPeriod(query, range) };
}

/** A search of something else than the period's items: the replies addressed to an account, one conversation, one quoted post. Its dates are its own. */
const NOT_THE_PERIOD_SEARCH = /(^|[\s(])(?:to|conversation_id|in_reply_to_tweet_id|quoted_tweet_id|retweets_of|list):/i;

/**
 * The inputs of a call the MODEL makes in the execution phase: when the plan has one first-level stage on this endpoint with a period of days (all such stages agreeing), the day-only
 * operators of its query are written as the period's Cairo moments. A call that is not a search of the period (see above), a source whose query takes no operators, and a plan with no
 * such stage are returned untouched.
 */
export function alignedModelCall(plan: PricedPlan | null | undefined, endpoint: CatalogEndpoint | undefined, params: unknown): unknown {
  if (!plan || !endpoint || typeof params !== "object" || params === null || Array.isArray(params)) return params;
  const profile = toolProfile(endpoint);
  const field = profile.query?.field ?? null;
  if (!profile.queryOperators || !field) return params;
  const p = params as Record<string, unknown>;
  const query = p[field];
  if (typeof query !== "string" || NOT_THE_PERIOD_SEARCH.test(query)) return params;
  const ranges = plan.stages.filter((s) => s.parent_key === null && s.endpoint_id === endpoint.id).map(dayRangeOf).filter((r): r is { from: string; to?: string } => r !== null);
  if (ranges.length === 0 || ranges.some((r) => r.from !== ranges[0].from || r.to !== ranges[0].to)) return params;
  return { ...p, [field]: alignQueryToCairoPeriod(query, ranges[0]) };
}
