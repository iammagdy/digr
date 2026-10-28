import { isSellable, type CatalogEndpoint, type CatalogInput, type TregCatalog } from "../treg/catalog";
import { blockedEndpointReason } from "../treg/blockList";
import { categoryOf, policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { checkParamValue, isWindowParamName, resolvedParamValue } from "./paramRules";
import { unitCost, callEstimateUsd, type CallCost } from "./pricing";
import type { PlanParam } from "./types";
import { applyReverseOrder } from "../treg/reverseOrder";

/**
 * PROVIDER ALTERNATIVES. The catalog lists, for most endpoints, the siblings that do the same job through another provider. When an endpoint fails, answers nothing, takes too long
 * or is refused by a cap, the planner (at sample time) and the worker (at run time) try a sibling instead, cheapest first and best observed success first, before anyone gives up.
 *
 * A sibling takes the same VALUES under its own parameter NAMES: the values are the customer's (or the approved plan's), only the names are mapped, by what the parameter is
 * (an account, a search word, a link, an id of a kind). A sibling whose required inputs cannot all be filled from the step's own values is skipped: nothing is ever invented.
 */
const WORDS = {
  account: new Set(["handle", "username", "screen", "unique", "uniqueid", "account", "channel", "profile", "user"]),
  url: new Set(["url", "urls", "uri", "link", "permalink"]),
  query: new Set(["query", "keyword", "keywords", "q", "term", "terms", "search", "searchstringsarray"]),
};

const tokensOf = (name: string): string[] => String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());

/** What a parameter IS: an account, a link, a search phrase, an id of some kind («id:video»), or just its own name. */
export function paramClass(name: string): string {
  const tokens = tokensOf(name);
  if (tokens.length === 0) return `name:${name}`;
  const last = tokens[tokens.length - 1];
  if (last === "id" || last === "ids") return tokens.length > 1 ? `id:${tokens.slice(0, -1).join("_")}` : "id";
  if (tokens.some((t) => WORDS.url.has(t))) return "url";
  if (tokens.some((t) => WORDS.query.has(t))) return "query";
  if (tokens.some((t) => WORDS.account.has(t))) return "account";
  return `name:${tokens.join("_")}`;
}

const LIMIT_NAMES = new Set(["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxitems", "max_items", "n", "pagesize", "perpage"]);
const isLimitName = (name: string) => LIMIT_NAMES.has(String(name).toLowerCase());

export type MappedParams = { ok: true; params: PlanParam[] } | { ok: false; reason: string };

/** The step's parameters under the sibling's names, or why they cannot be mapped. A parameter the sibling lacks is dropped only when it is a fixed choice (a literal): a value of the customer's is never dropped. */
export function mapParamsToSibling(params: ReadonlyArray<PlanParam>, to: CatalogEndpoint, ctx: { customerText?: string } = {}): MappedParams {
  const byName = new Map(to.inputs.map((i) => [i.name, i]));
  const byClass = new Map<string, CatalogInput[]>();
  for (const i of to.inputs) { const c = paramClass(i.name); byClass.set(c, [...(byClass.get(c) ?? []), i]); }
  const out: PlanParam[] = [];
  const used = new Set<string>();
  for (const p of params) {
    if (isLimitName(p.name) || isWindowParamName(p.name)) continue; // the page size is set by code; a period is never carried over
    let target = byName.get(p.name);
    if (!target) {
      const candidates = (byClass.get(paramClass(p.name)) ?? []).filter((i) => !used.has(i.name));
      if (candidates.length >= 1) target = candidates.find((i) => i.required) ?? candidates[0];
    }
    if (!target || used.has(target.name)) {
      if (p.source === "literal") continue;
      return { ok: false, reason: `no input of «${to.id}» takes «${p.name}»` };
    }
    if (p.source === "prior_step") { used.add(target.name); out.push({ ...p, name: target.name }); continue; } // its value comes from the listed item at run time
    const value = resolvedParamValue(p);
    if (value === undefined || value === null || value === "") { if (p.source === "literal") continue; return { ok: false, reason: `«${p.name}» has no value` }; }
    const problem = checkParamValue(target, value);
    if (problem) { if (p.source === "literal") continue; return { ok: false, reason: problem.message }; }
    used.add(target.name);
    out.push({ ...p, name: target.name });
  }
  const missing = to.inputs.find((i) => i.required && !used.has(i.name) && !isLimitName(i.name));
  if (missing) return { ok: false, reason: `«${to.id}» also needs «${missing.name}»` };
  return { ok: true, params: out };
}

/** An endpoint whose median answer takes longer than this (ms) is tried after the faster ones. */
export const SLOW_P50_MS = 8_000;

export interface SiblingChoice { endpoint: CatalogEndpoint; cost: CallCost; estimateUsd: number; okRate: number | null; p50Ms: number | null }

const obs = (e: CatalogEndpoint, key: "ok_rate" | "p50_ms"): number | null => { const v = (e.observed as Record<string, unknown> | null)?.[key]; return typeof v === "number" && Number.isFinite(v) ? v : null; };

/**
 * The siblings of an endpoint the account may use and the shop can price, in the order to try them: the cheaper call first, then the better observed success, then the faster p50;
 * a routed wrapper (its price is a worst case) last; an endpoint observed failing more often than not is left out. `maxEstimateUsd` keeps only calls that fit (a budget, a ceiling).
 */
export function rankSiblings(endpoint: CatalogEndpoint, catalog: TregCatalog, access: AccountAccess, opts: { maxEstimateUsd?: number; exclude?: ReadonlySet<string>; pageRows?: number } = {}): SiblingChoice[] {
  const out: SiblingChoice[] = [];
  for (const id of endpoint.siblings ?? []) {
    if (id === endpoint.id || opts.exclude?.has(id)) continue;
    const e = catalog.byId.get(id);
    if (!e || !isSellable(id, catalog) || blockedEndpointReason(id, e.scope)) continue;
    const category = categoryOf(id);
    if (category === "sensitive" || category === "blocked" || !policyVerdict(id, access).allowed) continue;
    const cost = unitCost(e, catalog);
    if (!cost) continue;
    const estimateUsd = callEstimateUsd(cost, opts.pageRows ?? 1);
    if (opts.maxEstimateUsd !== undefined && estimateUsd > opts.maxEstimateUsd + 1e-12) continue;
    const okRate = obs(e, "ok_rate");
    if (okRate !== null && okRate < 0.5) continue;
    out.push({ endpoint: e, cost, estimateUsd, okRate, p50Ms: obs(e, "p50_ms") });
  }
  const routed = (c: SiblingChoice) => (c.endpoint.kind === "routed" ? 1 : 0);
  // an endpoint whose usual answer takes longer than a sample is allowed to wait is tried after the ones that answer in time
  const slow = (c: SiblingChoice) => ((c.p50Ms ?? 0) > SLOW_P50_MS ? 1 : 0);
  // the reverse lookups keep their evidence order (src/lib/treg/reverseOrder.ts); every other sibling keeps its place
  return applyReverseOrder(out.sort((a, b) => routed(a) - routed(b) || slow(a) - slow(b) || a.cost.usd - b.cost.usd || (b.okRate ?? 0.8) - (a.okRate ?? 0.8) || (a.p50Ms ?? 5000) - (b.p50Ms ?? 5000) || a.endpoint.id.localeCompare(b.endpoint.id)), (c) => c.endpoint.id);
}
