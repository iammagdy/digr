import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { PARSER_IDS, WEB_SOURCES, WEB_SOURCE_IDS } from "../../../src/lib/agentMission/sources";
import { tregCallBoundOf, type Gateway } from "../gateway";
import { floorMicroUsd } from "../../../src/lib/server/callBudget";
import type { TregCatalog } from "../../../src/lib/treg/catalog";
import type { WebGateway } from "../webGateway";
import type { AgentStore } from "../types";
import { callTregWithAsync } from "../asyncTreg";

/**
 * PHASE 5 (docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md §9.1, PR-5.1): ONE PROVIDER-NEUTRAL WAY FOR A STAGE TO CALL ITS SOURCE.
 *
 * It replaces nothing. It dispatches to the two gateways that already exist and keep every check they have:
 *   - a TREG catalog id (Firecrawl and Context.dev resold by TREG included) → `Gateway.tregCall` (data policy, block list, sellable check, sensitive audit, parameters, the job's budget, the provider's daily cap, the record, the raw answer);
 *   - a direct web id (`firecrawl.search`, `contextdev.scrape`, `contextdev.parse.*`, …: sources.ts) → the existing `WebGateway` (key, the job's budget, the provider's daily cap, the record with its provider_costs id, the raw answer).
 * Before either is asked, the stage's STORED SCOPE is checked here: a stage may call only the endpoint its approved recipe names (plan.stages[].engine.endpoint_id, sealed at approval), and only while its own spend
 * stays inside its cap when the plan gives one. A call outside the scope is refused with no request and no cost. Pricing, the ledger, approval, reservation and settlement are not touched: the money of every call
 * is still settled on the job's one call budget by the gateway that made it.
 *
 * Every call made through it is remembered with its identity (stage, endpoint, provider, call id): the provenance the engine writes on the rows it saves (`_src`, `_call`, internal marks never written to the file).
 */
export type SourceRefusal = "out_of_scope" | "stage_cap" | "stage_cap_unbounded" | "source_unavailable" | "bad_input";

export interface SourceCall { stageKey: string; endpoint_id: string; params: Record<string, unknown> }

export type SourceCallResult =
  | { ok: true; call_id: string; endpoint_id: string; provider: string; via: "treg" | "web"; http_status: number; rows_in_page: number; has_more: boolean | null; next_cursor: string | null }
  | { ok: false; call_id: string; endpoint_id: string; refused: string; message: string }
  | { ok: false; call_id: string; endpoint_id: string; failed: true; http_status: number; message: string };

export interface SourceCallRecord { stageKey: string; endpoint_id: string; provider: string; via: "treg" | "web" | "none"; call_id: string; outcome: "ok" | "refused" | "failed"; refused?: string; spentUsd: number }

/** What one stage may call: the endpoint of its approved recipe and the approved fallback tools of that recipe (`engine.alternatives`, S1 item 1.9), and an optional cap (USD) on what its own calls may spend. */
export interface StageScope { endpointIds: string[]; capUsd: number | null }

export interface SourceGateway {
  call(input: SourceCall): Promise<SourceCallResult>;
  /** Every call asked through this gateway, in order (refusals included). */
  records(): ReadonlyArray<SourceCallRecord>;
  /** What one stage's calls spent so far (USD), as the job budget moved during them. */
  stageSpentUsd(stageKey: string): number;
  /** What a CAPPED stage's calls count against its cap (USD): what they spent, except that a failed call (its charge may be unknown) counts at its verified maximum. Equals `stageSpentUsd` for a stage with no cap. */
  stageCapUsedUsd(stageKey: string): number;
}

/**
 * PHASE 5 SAFETY GATE: THE ADMISSION BOUND OF ONE CALL, for a stage that has a cap (DT-20261119-11): the call is admitted only when this bound fits what the stage has left. Only a bound that has a provider-enforced ceiling counts:
 *   - a TREG catalog id: the estimated bound (`tregCallBoundOf`). What is SENT is all the money the stage has left (reserved before dispatch and enforced by TREG through the header), so a stale price can neither refuse a call that fits nor overrun the cap;
 *   - a direct web id (Firecrawl, Context.dev): null. These providers bill the credits they report AFTER the call (a failed call too; people search per returned match), with no cap the call can set, so no maximum is verified.
 * Null means «unknown», never «free»: a capped stage refuses such a call before any request.
 */
export function verifiedCallMaxUsdOf(catalog: TregCatalog): (endpointId: string, params: Record<string, unknown>) => number | null {
  return (endpointId, params) => (isDirectWebSource(endpointId) ? null : tregCallBoundOf(endpointId, params, catalog));
}

/** The provider of an endpoint id (its prefix: «firecrawl», «contextdev», «tikhub», …). */
export const providerOf = (endpointId: string): string => String(endpointId).split(".")[0] || "unknown";
/** A direct web source of this worker (not a TREG id). */
export const isDirectWebSource = (endpointId: string): boolean => WEB_SOURCE_IDS.has(endpointId) || Object.prototype.hasOwnProperty.call(PARSER_IDS, endpointId);

/**
 * THE STORED SCOPE OF A PLAN: for every stage that has an approved recipe, the endpoint it names and the fallback tools the same approved recipe lists. A stage without a recipe has no scope (the engine never runs it;
 * the model path keeps its own checks).
 * `stage.max_usd` (a number, when a plan carries one) is that stage's cap; absent, the job's budget is the only bound, as today.
 */
export function stageScopeOf(plan: Pick<PricedPlan, "stages">, catalog?: TregCatalog): Record<string, StageScope> {
  const out: Record<string, StageScope> = {};
  for (const s of plan.stages) {
    const endpointId = s.engine?.endpoint_id;
    if (typeof endpointId !== "string" || endpointId === "") continue;
    const cap = (s as { max_usd?: unknown }).max_usd;
    const alternatives = (s.engine?.alternatives ?? []).map((a) => a.endpoint_id).filter((id): id is string => typeof id === "string" && id !== "");
    const pollEndpoints: string[] = [];
    if (catalog) {
      for (const id of [endpointId, ...alternatives]) {
        const ep = catalog.byId.get(id);
        const poll = (ep?.async_config as any)?.poll?.endpoint;
        if (typeof poll === "string" && poll !== "") pollEndpoints.push(poll);
      }
    }
    out[s.key] = { endpointIds: [...new Set([endpointId, ...alternatives, ...pollEndpoints])], capUsd: typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : null };
  }
  return out;
}

/** The arguments of the web gateway method that serves a direct web id, from the stage's parameters. Null: this id is not a direct web source. */
export function webRequestOf(endpointId: string, params: Record<string, unknown>): { method: "parsePage" | "webSearch" | "webScrape" | "peopleSearch"; args: Record<string, unknown> } | null {
  const parser = PARSER_IDS[endpointId];
  if (parser) return { method: "parsePage", args: { parser, url: params.url, ...(params.sort !== undefined ? { sort: params.sort } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) } };
  const spec = WEB_SOURCES.find((w) => w.id === endpointId);
  if (!spec) return null;
  if (spec.kind === "search") return { method: "webSearch", args: { provider: spec.provider, query: params.query ?? params.q, ...(params.limit !== undefined ? { limit: params.limit } : {}), ...(params.country !== undefined ? { country: params.country } : {}) } };
  if (spec.kind === "scrape") return { method: "webScrape", args: { provider: spec.provider, url: params.url } };
  return { method: "peopleSearch", args: { query: params.query ?? params.q, ...(params.country !== undefined ? { country: params.country } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor } : {}) } };
}

export function createSourceGateway(deps: {
  gateway: Pick<Gateway, "tregCall">;
  web?: Pick<WebGateway, "parsePage" | "webSearch" | "webScrape" | "peopleSearch">;
  scope: Record<string, StageScope>;
  /** The job's one call budget (read only: the gateways settle on it). */
  budget: { spentUsd(): number };
  /** The verified maximum of one call (`verifiedCallMaxUsdOf`). Asked only for a stage with a cap; absent or null: no maximum is known, and a capped stage makes no call. */
  maxCallUsd?: (endpointId: string, params: Record<string, unknown>) => number | null;
  catalog?: TregCatalog;
  store?: AgentStore;
  missionId?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): SourceGateway {
  const log: SourceCallRecord[] = [];
  const spent = new Map<string, number>();
  /** Per capped stage: what its finished calls count against the cap, and the maxima of its calls still in flight (reserved before the request, released when it returns). */
  const capUsed = new Map<string, number>();
  const inFlight = new Map<string, number>();
  let refusals = 0;
  const refuse = (input: SourceCall, code: SourceRefusal, message: string): SourceCallResult => {
    refusals += 1;
    const call_id = `scope_refused_${refusals}`;
    log.push({ stageKey: input.stageKey, endpoint_id: input.endpoint_id, provider: providerOf(input.endpoint_id), via: "none", call_id, outcome: "refused", refused: code, spentUsd: 0 });
    return { ok: false, call_id, endpoint_id: input.endpoint_id, refused: code, message };
  };
  return {
    records: () => log,
    stageSpentUsd: (stageKey) => spent.get(stageKey) ?? 0,
    stageCapUsedUsd: (stageKey) => (deps.scope[stageKey]?.capUsd ?? null) !== null ? capUsed.get(stageKey) ?? 0 : spent.get(stageKey) ?? 0,
    async call(input) {
      const scope = deps.scope[input.stageKey];
      // THE STORED SCOPE: only the approved endpoint of this stage; nothing else is ever asked, whoever asks
      if (!scope || !scope.endpointIds.includes(input.endpoint_id)) return refuse(input, "out_of_scope", "this stage may call only the source its approved plan names; the call was NOT made");
      // THE STAGE CAP (Phase 5 safety gate): checked BEFORE the call with the call's VERIFIED MAXIMUM, never after the spend: what the stage counts, plus what its calls in flight may still cost, plus the most this call can cost,
      // must stay within the cap. A call with no verified maximum is not made under a cap (an unknown cost is never taken as zero). The maximum is reserved while the call runs, so calls racing on one stage cannot pass it together.
      let bound = 0;
      if (scope.capUsd !== null) {
        const max = deps.maxCallUsd ? deps.maxCallUsd(input.endpoint_id, input.params) : null;
        if (max === null || !Number.isFinite(max) || max <= 0) return refuse(input, "stage_cap_unbounded", "this stage has a spending cap and this source has no verified maximum cost per call; the call was NOT made");
        if ((capUsed.get(input.stageKey) ?? 0) + (inFlight.get(input.stageKey) ?? 0) + max > scope.capUsd + 1e-12) return refuse(input, "stage_cap", "this call could take the stage past what its plan allows; the call was NOT made");
        // DT-20261119-11 D1/D3: the stage reserves ALL the money it has left for this call (the gateway sends it as the most the provider may bill, and reserves it on the job, daily and grant ledgers too), so calls racing on one stage cannot pass the cap
        // together. The estimate above only admits the call (it must fit); it is no longer the amount booked.
        bound = floorMicroUsd(scope.capUsd - (capUsed.get(input.stageKey) ?? 0) - (inFlight.get(input.stageKey) ?? 0));
        if (!(bound > 0)) return refuse(input, "stage_cap", "this stage has no money left for this call; the call was NOT made");
        inFlight.set(input.stageKey, (inFlight.get(input.stageKey) ?? 0) + bound);
      }
      const release = () => { if (bound > 0) inFlight.set(input.stageKey, Math.max(0, (inFlight.get(input.stageKey) ?? 0) - bound)); };
      const before = deps.budget.spentUsd();
      const provider = providerOf(input.endpoint_id);
      const note = (r: SourceCallResult, via: "treg" | "web", charge?: { usd: number | null | undefined; reserved: number | undefined }) => {
        const delta = Math.max(0, deps.budget.spentUsd() - before);
        spent.set(input.stageKey, (spent.get(input.stageKey) ?? 0) + delta);
        // against the cap (D3): the gateway reports THIS call's own charge, so a known charge is booked as it is (zero stays zero, an overrun is never clipped: the job's spend delta can hold another stage's charge); a charge that is NOT known
        // (a cut call, none reported) keeps the amount that was reserved for the call; a refused call was never sent (zero)
        if (scope.capUsd !== null) {
          release();
          const refused = !r.ok && "refused" in r;
          const booked = refused ? 0 : charge ? (typeof charge.usd === "number" ? charge.usd : Math.min(typeof charge.reserved === "number" ? charge.reserved : bound, bound)) : (!r.ok && "failed" in r ? bound : Math.min(delta, bound));
          capUsed.set(input.stageKey, (capUsed.get(input.stageKey) ?? 0) + booked);
        }
        log.push({ stageKey: input.stageKey, endpoint_id: input.endpoint_id, provider, via, call_id: r.call_id, outcome: r.ok ? "ok" : "refused" in r ? "refused" : "failed", ...(!r.ok && "refused" in r ? { refused: r.refused } : {}), spentUsd: delta });
        return r;
      };
      const dispatch = async (): Promise<SourceCallResult> => {
        if (isDirectWebSource(input.endpoint_id)) {
          const req = webRequestOf(input.endpoint_id, input.params);
          if (!req) { release(); return refuse(input, "bad_input", "unknown web source"); }
          if (!deps.web) { release(); return refuse(input, "source_unavailable", "this web source is not available to this worker (no key); the call was NOT made"); }
          const w = await deps.web[req.method](req.args as never);
          if (w.ok) return note({ ok: true, call_id: w.call_id, endpoint_id: input.endpoint_id, provider, via: "web", http_status: 200, rows_in_page: w.rows_in_page, has_more: w.next_cursor ? true : w.next_cursor === null ? false : null, next_cursor: w.next_cursor ?? null }, "web");
          if ("refused" in w) return note({ ok: false, call_id: w.call_id, endpoint_id: input.endpoint_id, refused: w.refused, message: w.message }, "web");
          return note({ ok: false, call_id: w.call_id, endpoint_id: input.endpoint_id, failed: true, http_status: 0, message: w.message }, "web");
        }
        const callFn = (endpoint_id: string, params: Record<string, unknown>) =>
          deps.gateway.tregCall({ endpoint_id, params, ...(scope.capUsd !== null ? { spend_limit_usd: bound } : {}) });
        const t = (deps.catalog && deps.store && deps.missionId)
          ? await callTregWithAsync({ catalog: deps.catalog, store: deps.store, missionId: deps.missionId, sleep: deps.sleep, now: deps.now }, callFn, input.endpoint_id, input.params)
          : await callFn(input.endpoint_id, input.params);
        const charge = "charge_usd" in t || "reserved_usd" in t ? { usd: (t as { charge_usd?: number | null }).charge_usd, reserved: (t as { reserved_usd?: number }).reserved_usd } : undefined;
        if (t.ok) return note({ ok: true, call_id: t.call_id, endpoint_id: input.endpoint_id, provider, via: "treg", http_status: t.http_status, rows_in_page: t.rows_in_page, has_more: t.has_more, next_cursor: t.next_cursor }, "treg", charge);
        if ("refused" in t) return note({ ok: false, call_id: t.call_id, endpoint_id: input.endpoint_id, refused: t.refused, message: t.message }, "treg", charge);
        return note({ ok: false, call_id: t.call_id, endpoint_id: input.endpoint_id, failed: true, http_status: t.http_status, message: t.message }, "treg", charge);
      };
      if (scope.capUsd === null) return dispatch();
      try {
        return await dispatch();
      } catch (error) {
        // a call that threw may have gone out: under a cap it counts at its maximum (never at zero), and its reservation is released
        release();
        capUsed.set(input.stageKey, (capUsed.get(input.stageKey) ?? 0) + bound);
        throw error;
      }
    },
  };
}

/**
 * PHASE 5, PER-STAGE DISPATCH (audit §9.1.3): which stages the engine carries out and which are left to the model, instead of «every stage has a recipe or none runs on the engine». A stage runs on the engine when it has an
 * approved recipe AND its parent does (a child is fed by its parent's saved rows: the engine never reads a child of a stage it did not carry out). The rest, in plan order, are left to the model path, which sees what the
 * engine already saved. With every stage on the engine this is today's engine run exactly; with none it is today's model run exactly.
 */
export function stageDispatchOf(plan: Pick<PricedPlan, "stages">): { engine: string[]; model: string[] } {
  const engine = new Set<string>();
  for (const s of plan.stages) {
    if (!s.engine) continue;
    if (s.parent_key !== null && !engine.has(s.parent_key)) continue;
    engine.add(s.key);
  }
  return { engine: plan.stages.filter((s) => engine.has(s.key)).map((s) => s.key), model: plan.stages.filter((s) => !engine.has(s.key)).map((s) => s.key) };
}
