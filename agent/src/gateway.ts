import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../src/functions/shared/tregClient";
import type { CallRecorder } from "../../src/lib/server/multiProvider/adapterTypes";
import { commitTregSpend, tregCallStatusOf, tregCapabilityIdOf } from "../../src/lib/server/tregCallRecord";
import type { JobCallBudget } from "../../src/lib/server/callBudget";
import { runSensitiveCall, sensitiveRefusalAr, type SensitiveRefusal } from "../../src/lib/server/sensitiveAccess";
import { digestValue, buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { callEstimateUsd, unitCost } from "../../src/lib/modelPlanner/pricing";
import { toolCatalogSearch, toolDescribeEndpoint } from "../../src/lib/modelPlanner/tools";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { endpointCostUsd, isSellable, type CatalogEndpoint, type TregCatalog } from "../../src/lib/treg/catalog";
import { categoryOf, policyVerdict, type AccountAccess } from "../../src/lib/treg/dataPolicy";
import { AGENT_FIRST_ROWS } from "../../src/lib/agentMission/constants";
import type { AgentStore, CallPhase } from "./types";

/**
 * THE GATEWAY: the only way the agent reaches TREG. Three tools — catalog_search, describe_endpoint, treg_call — and `treg_call` enforces, IN CODE, before every call, in this order:
 *
 *   1. isSellable          the endpoint is in the sellable catalog snapshot (a made-up id, an own-account or a paused endpoint is not);
 *   2. the block list      write actions, own_account, apollo, datagma, policy-blocked, not-sellable (src/lib/treg/blockList.ts);
 *   3. the data policy     a SENSITIVE endpoint only for the admin or an account marked verified business, through the audited path (runSensitiveCall);
 *   4. the parameters      every required input present, unknown inputs dropped;
 *   5. the mission budget  the USD budget of the phase (planning 0.05; execution 40% of the approved reserve's value, floor 0.005): a call that would pass it is NOT made;
 *   6. the provider's daily cap and the record  reserve_provider_spend_atomic BEFORE the call; if the spend cannot be recorded the call is not made;
 * and after the call it
 *   7. commits the ACTUAL charge into provider_costs (commit_provider_spend_v2), writes a mission_calls row, saves the FULL raw answer to the private bucket, and returns to the model
 *      a SHAPE DIGEST and the FIRST ROWS only, never a large page. The model never sees a price of its own mission, and a refused call costs nothing.
 *
 * Nothing in this file decides what the customer pays; it only records what was spent.
 */
export const GATEWAY_CALL_TIMEOUT_MS = 90_000;
export const GATEWAY_UNKNOWN_PRICE_ESTIMATE_USD = 0.01;
export const GATEWAY_DEFAULT_PAGE_ROWS = 10;
const LIMIT_PARAM_NAMES = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "maxItems", "max_items", "n", "Count", "pageSize", "perPage"];

export type RefusalCode =
  | "not_sellable" | "blocked" | "sensitive_not_allowed" | "purpose_required" | "daily_limit" | "audit_unavailable"
  | "missing_params" | "over_budget" | "daily_cap" | "recording_unavailable";

export type GatewayCallResult =
  | { ok: true; call_id: string; http_status: number; rows_in_page: number; has_more: boolean | null; next_cursor: string | null; shape: unknown; first_rows: unknown[]; warnings: string[]; saved: string }
  | { ok: false; call_id: string; refused: RefusalCode; message: string }
  | { ok: false; call_id: string; failed: true; http_status: number; message: string };

export interface GatewayDeps {
  store: AgentStore;
  /** Supabase client, for the sensitive-lookup audit only. */
  client: unknown;
  missionId: string;
  userId: string;
  /** The job of the approved mission; null while planning (no job exists yet). */
  jobId: string | null;
  phase: CallPhase;
  access: AccountAccess;
  catalog: TregCatalog;
  budget: JobCallBudget;
  recorder: CallRecorder;
  commit?: typeof commitTregSpend;
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  /** TREG token for the call (the worker passes TREG_TOKEN). */
  token?: string;
  /** Used as the purpose of a sensitive lookup when the model gives none. */
  defaultPurpose: string;
  /** Call counter, shared by the whole mission (continues after a restart). */
  counter: { seq: number };
}

const clip = (s: unknown, n: number): string => String(s ?? "").slice(0, n);

function pageRowsOf(endpoint: CatalogEndpoint, params: Record<string, unknown>): number {
  const input = endpoint.inputs.find((i) => LIMIT_PARAM_NAMES.includes(i.name));
  const asked = input ? Number(params[input.name]) : NaN;
  const dflt = input ? Number(input.default) : NaN;
  const n = Number.isFinite(asked) && asked > 0 ? asked : Number.isFinite(dflt) && dflt > 0 ? dflt : GATEWAY_DEFAULT_PAGE_ROWS;
  return Math.max(1, Math.floor(input?.maximum ? Math.min(n, input.maximum) : n));
}

/** What a call may cost for the budget check: the catalog price of the call (or of the page asked for, for a per-record price); a flat guess when the catalog has none. */
export function estimateCallUsd(endpoint: CatalogEndpoint, params: Record<string, unknown>, catalog: TregCatalog): number {
  const cost = unitCost(endpoint, catalog);
  if (cost) return Math.max(callEstimateUsd(cost, pageRowsOf(endpoint, params)), 0.000001);
  const catalogUsd = endpointCostUsd(endpoint);
  return catalogUsd !== null && catalogUsd > 0 ? catalogUsd : GATEWAY_UNKNOWN_PRICE_ESTIMATE_USD;
}

const callIdOf = (n: number) => `call_${String(n).padStart(4, "0")}`;
export const RAW_PATH = (callId: string) => `raw/${callId}.json`;

const REFUSAL_TEXT: Record<RefusalCode, string> = {
  not_sellable: "this endpoint is not in the catalog you may use; search the catalog and use an id exactly as catalog_search returned it",
  blocked: "this endpoint can never be called (write action, own-account, paused provider or blocked by policy); choose another source",
  sensitive_not_allowed: "this endpoint returns personal data and this account may not use it; choose another source or tell the customer honestly that it cannot be served",
  purpose_required: "a purpose is required for this lookup",
  daily_limit: "the daily limit of this kind of lookup is reached",
  audit_unavailable: "this lookup could not be audited, so it was not made",
  missing_params: "required parameters are missing",
  over_budget: "the budget for source calls of this mission would be passed by this call, so it was NOT made; work with what is already saved or stop and explain honestly",
  daily_cap: "the provider's daily limit has no room for this call, so it was NOT made; stop and explain honestly",
  recording_unavailable: "the call could not be recorded, so it was NOT made; try once more, then stop and explain honestly",
};

export function createGateway(deps: GatewayDeps) {
  const call = deps.call ?? executeTregCall;
  const commit = deps.commit ?? commitTregSpend;
  const spendField = deps.phase === "planning" ? "planning_treg_usd" : "execution_treg_usd";

  async function logCall(row: { id: string; endpoint_id: string; params: Record<string, unknown>; status: "ok" | "failed" | "empty" | "refused"; refused_reason?: string; http_status?: number; rows?: number; cost_usd?: number; estimate_usd?: number; provider_cost_id?: number | null; storage_path?: string | null; duration_ms?: number }) {
    await deps.store.addCall({
      id: `${deps.missionId}:${row.id}`, mission_id: deps.missionId, phase: deps.phase, endpoint_id: row.endpoint_id,
      // parameter NAMES and short values; never a token (the call carries none in its params)
      params_digest: Object.fromEntries(Object.entries(row.params).slice(0, 20).map(([k, v]) => [k, typeof v === "string" ? clip(v, 80) : v])),
      status: row.status, refused_reason: row.refused_reason ?? null, http_status: row.http_status ?? null, rows_returned: row.rows ?? null,
      cost_usd: row.cost_usd ?? 0, estimate_usd: row.estimate_usd ?? 0, provider_cost_id: row.provider_cost_id ?? null, storage_path: row.storage_path ?? null, duration_ms: row.duration_ms ?? null,
    });
  }

  const refuse = async (id: string, endpointId: string, params: Record<string, unknown>, code: RefusalCode, detail: string = ""): Promise<GatewayCallResult> => {
    await logCall({ id, endpoint_id: endpointId, params, status: "refused", refused_reason: `${code}${detail ? `:${detail}` : ""}`.slice(0, 120) });
    return { ok: false, call_id: id, refused: code, message: REFUSAL_TEXT[code] };
  };

  return {
    catalogSearch(input: { platform?: string; words?: string[]; limit?: number }) {
      return toolCatalogSearch(input, deps.access, deps.catalog);
    },
    describeEndpoint(input: { id?: string }) {
      return toolDescribeEndpoint(input, deps.access, deps.catalog, null);
    },

    async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown; why?: unknown }): Promise<GatewayCallResult> {
      deps.counter.seq += 1;
      const id = callIdOf(deps.counter.seq);
      const endpointId = String(input.endpoint_id ?? "").trim();
      const params: Record<string, unknown> = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? { ...(input.params as Record<string, unknown>) } : {};

      // 1 + 2: sellable, block list
      const endpoint = deps.catalog.byId.get(endpointId);
      const blocked = blockedEndpointReason(endpointId, endpoint?.scope ?? null);
      if (blocked) return refuse(id, endpointId, params, blocked === "not_sellable" ? "not_sellable" : "blocked", blocked);
      if (!endpoint || !isSellable(endpointId, deps.catalog)) return refuse(id, endpointId, params, "not_sellable");

      // 3: data policy
      const verdict = policyVerdict(endpointId, deps.access);
      if (!verdict.allowed) return refuse(id, endpointId, params, verdict.reason === "blocked" ? "blocked" : "sensitive_not_allowed", verdict.category);

      // 4: parameters
      const known = new Set([...endpoint.inputs.map((i) => i.name), ...(endpoint.pagination ?? [])]);
      for (const k of Object.keys(params)) if (!known.has(k)) delete params[k];
      // what the call log keeps of the parameters: the values given, plus WHY a dearer source was chosen when the agent said so (for the admin's trace; never shown to a customer)
      const trace: Record<string, unknown> = { ...params, ...(input.why ? { _why: clip(input.why, 300) } : {}) };
      const missing = endpoint.inputs.filter((i) => i.required && (params[i.name] === undefined || params[i.name] === null || params[i.name] === "")).map((i) => i.name);
      if (missing.length) return refuse(id, endpointId, trace, "missing_params", missing.join(","));

      // 5: the mission's USD budget
      const estimate = estimateCallUsd(endpoint, params, deps.catalog);
      if (!deps.budget.reserve(estimate)) return refuse(id, endpointId, trace, "over_budget", `${deps.phase}`);

      // 6: the provider's daily cap, recorded BEFORE the call
      const capabilityId = tregCapabilityIdOf({ endpointId });
      const reservation = await deps.recorder.reserve({ provider: "treg", capabilityId, estimatedUsd: estimate, jobId: deps.jobId });
      if (!reservation.allowed) {
        deps.budget.settle(estimate, 0);
        return refuse(id, endpointId, trace, reservation.reason === "cap" ? "daily_cap" : "recording_unavailable", reservation.reason ?? "");
      }

      // the call itself, through the audited path for a sensitive endpoint
      const started = Date.now();
      let res: TregCallResult | null = null;
      let thrown = false;
      let actualUsd = 0;
      const perform = async () => {
        try {
          res = await call({
            endpointId, method: endpoint.method === "GET" ? "GET" : "POST", params, allowedParamKeys: [...known], userId: deps.userId, jobId: deps.jobId ?? `agent_${deps.missionId}`,
            stepId: id, page: 1, idempotencyKey: `agent_${deps.missionId}_${id}`, routeMaxCostUsd: Number(Math.max(estimate, 0.001).toFixed(6)), timeoutMs: GATEWAY_CALL_TIMEOUT_MS,
            endpointScope: endpoint.scope, sensitiveAccess: { allowed: true }, ...(deps.token ? { token: deps.token } : {}),
          });
        } catch {
          thrown = true;
        }
        const r = res as TregCallResult | null;
        // a call that was cut or never answered may still have been billed: its estimate stays counted (as the website's worker does)
        const unknown = thrown || !r || r.timedOut === true || r.error === "network_failure";
        actualUsd = unknown ? estimate : Math.max(0, r?.costMicro ?? 0) / 1_000_000;
        return { result: null, costUsd: actualUsd, ok: Boolean(r?.ok) };
      };
      const purpose = clip(input.purpose, 300) || clip(deps.defaultPurpose, 300);
      const outcome = await runSensitiveCall({ client: deps.client, account: { userId: deps.userId, access: deps.access }, endpointId, params, purpose, jobId: deps.jobId, call: perform });
      if (!outcome.ok) {
        // the reserved estimate must not stay open: commit it at zero as a failed call
        deps.budget.settle(estimate, 0);
        await commit(deps.client, { costId: reservation.costId, costUsd: 0, units: 0, capabilityId, status: "failed", durationMs: 0, jobId: deps.jobId });
        void sensitiveRefusalAr; // the Arabic sentence is for the customer's screen, not for the model
        return refuse(id, endpointId, trace, outcome.refused as SensitiveRefusal, "sensitive");
      }

      const durationMs = Date.now() - started;
      const result = res as TregCallResult | null;
      deps.budget.settle(estimate, thrown || !result || result.timedOut || result.error === "network_failure" ? null : actualUsd);
      await deps.store.updateMission(deps.missionId, { [spendField]: Number(deps.budget.spentUsd().toFixed(6)) });

      if (!result) {
        await commit(deps.client, { costId: reservation.costId, costUsd: actualUsd, units: 0, capabilityId, status: "failed", durationMs, jobId: deps.jobId });
        await logCall({ id, endpoint_id: endpointId, params: trace, status: "failed", cost_usd: actualUsd, estimate_usd: estimate, provider_cost_id: reservation.costId, duration_ms: durationMs });
        return { ok: false, call_id: id, failed: true, http_status: 0, message: "the call did not complete; it may be tried once more" };
      }
      if (result.blocked) {
        // executeTregCall's own gate refused (it runs the same lists): nothing was sent
        await commit(deps.client, { costId: reservation.costId, costUsd: 0, units: 0, capabilityId, status: "failed", durationMs, jobId: deps.jobId });
        return refuse(id, endpointId, trace, result.blocked === "sensitive_not_allowed" ? "sensitive_not_allowed" : "blocked", String(result.blocked));
      }

      // save the FULL raw answer, then read its shape
      let storagePath: string | null = null;
      if (result.data !== null && result.data !== undefined) {
        try { await deps.store.putFile(deps.missionId, RAW_PATH(id), JSON.stringify(result.data), "application/json"); storagePath = RAW_PATH(id); } catch { storagePath = null; }
      }
      const { digest, reading } = result.ok ? buildShapeDigest(result.data, endpoint) : { digest: null, reading: null };
      const rows = reading ? reading.rows.length : 0;
      const status = tregCallStatusOf({ ok: result.ok, rows: reading?.rows ?? [] });
      await commit(deps.client, { costId: reservation.costId, costUsd: actualUsd, units: rows, capabilityId, status, durationMs, jobId: deps.jobId });
      await logCall({ id, endpoint_id: endpointId, params: trace, status: status === "success" ? "ok" : status, http_status: result.httpStatus, rows, cost_usd: actualUsd, estimate_usd: estimate, provider_cost_id: reservation.costId, storage_path: storagePath, duration_ms: durationMs });

      if (!result.ok) {
        return { ok: false, call_id: id, failed: true, http_status: result.httpStatus, message: clip(result.errorDetails || result.detail || result.error || "the source answered with an error", 240) };
      }
      return {
        ok: true, call_id: id, http_status: result.httpStatus, rows_in_page: rows,
        has_more: reading?.hasMore ?? null, next_cursor: reading?.nextCursor ?? null,
        shape: digest ? { rows_in_page: digest.rowsInSample, list_path: digest.listPath, fields: digest.fields, next_cursor_path: digest.nextCursorPath, cursor_kind: digest.cursorKind } : null,
        first_rows: (reading?.rows ?? []).slice(0, AGENT_FIRST_ROWS).map((r) => digestValue(r)),
        warnings: reading?.warnings ?? [],
        saved: storagePath ? `${id} (the full page is saved; give "${id}" to run_code to process it)` : "not saved",
      };
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
export { categoryOf };
