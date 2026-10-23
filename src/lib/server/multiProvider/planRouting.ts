import { getLlmPricingSettings } from "../../../functions/shared/llmClient";
import { NO_ROUTE_AR } from "../../multiProvider/copy";
import { multiProviderEnabled } from "../../multiProvider/flag";
import { PREVIEW_WORLD_DAILY_CAP_USD, previewWorldActive } from "../../multiProvider/previewWorld";
import { buildAllowedRoutes, chooseRoute, defaultRouterState, type ProviderState, type RouteChoice, type RouteChooser, type RouterState } from "../../multiProvider/router";
import { routeByCode, routeCodeOf } from "../../multiProvider/routes";
import type { RoutingDecision } from "../../multiProvider/trace";
import type { DataProviderId, RequiredField, RouteRequest } from "../../multiProvider/types";
import { getLiveProviderGateStatusFromSettings } from "../providerGate";
import { resolveProviderKey } from "../providerKeys";
import { readProviderKeySettings } from "../providerKeyAdmin";
import { getProviderStatus } from "../providerStatus";
import { resolveAllProviderDailyCaps, readProviderSpendToday } from "./providerCaps";

/**
 * Plan time: builds the router's facts from the real system (the flag, the keys, a free health read, the daily caps, today's recorded
 * spend), lets the router list the allowed routes, makes at most ONE short model call to choose among them, and hands the quote the
 * chosen route's cost. The model never sees or states a price, a cap or whether a spend is allowed (see router.ts).
 */

const REQUIRED: readonly RequiredField[] = ["work_email", "office_phone", "profile_link", "decision_maker"];

export function normalizeRequiredFields(value: unknown): RequiredField[] {
  const list = Array.isArray(value) ? value.filter((f): f is RequiredField => (REQUIRED as readonly unknown[]).includes(f)) : [];
  const unique = [...new Set(list)];
  // A chain job needs at least one verifiable field (an email, a phone, a decision maker): without one the request is a plain company list,
  // which the existing directory serves.
  return unique.some((f) => f === "work_email" || f === "office_phone" || f === "decision_maker") ? unique : ["work_email", ...unique];
}

export function routeRequestFromParams(params: Record<string, any> | undefined, volume: number): RouteRequest {
  const p = params || {};
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  return { industry: text(p.industry), country: text(p.country), keyword: text(p.keyword), count: Math.max(1, Math.floor(volume || 1)), requiredFields: normalizeRequiredFields(p.requiredFields) };
}

let routerStateForTests: RouterState | null = null;
export function setRouterStateForTesting(state: RouterState | null): void { routerStateForTests = state; }
let chooserForTests: RouteChooser | null | undefined;
/** Test-only: replaces the model call (null means «no model»; undefined restores the real one). */
export function setRouteChooserForTesting(chooser: RouteChooser | null | undefined): void { chooserForTests = chooser; }

export async function loadRouterState(client: any, options: { fetchFn?: (input: string, init?: RequestInit) => Promise<Response> } = {}): Promise<RouterState> {
  if (routerStateForTests) return routerStateForTests;
  const flagOn = multiProviderEnabled();
  const empty = (): ProviderState => ({ enabled: false, keyPresent: false, healthOk: false, dailyCapUsd: 0, spentTodayUsd: 0 });
  const providers: Record<DataProviderId, ProviderState> = { treg: empty(), firecrawl: empty(), contextdev: empty() };
  if (!flagOn) return defaultRouterState(false, providers);
  // A preview on a test database with the fake world: every provider is ready within a small limit (never on a live deployment).
  if (previewWorldActive()) {
    const ready = (): ProviderState => ({ enabled: true, keyPresent: true, healthOk: true, dailyCapUsd: PREVIEW_WORLD_DAILY_CAP_USD, spentTodayUsd: 0 });
    return defaultRouterState(true, { treg: ready(), firecrawl: ready(), contextdev: ready() });
  }

  const caps = await resolveAllProviderDailyCaps(client).catch(() => ({ treg: 0, firecrawl: 0, contextdev: 0 }));
  const settings = await readProviderKeySettings(client).catch(() => null);
  for (const id of ["treg", "firecrawl", "contextdev"] as const) {
    const key = await resolveProviderKey(id).catch(() => null);
    const spent = await readProviderSpendToday(client, id);
    const status = key?.key ? await getProviderStatus(id, key.key, { orgIdOverride: id === "treg" ? settings?.tregOrgId ?? null : null, fetchFn: options.fetchFn }).catch(() => null) : null;
    const creditsOk = id === "treg" || !status?.balance.available || (status.balance.credits ?? 1) > 0;
    providers[id] = {
      enabled: id === "treg" ? (await getLiveProviderGateStatusFromSettings(client).catch(() => ({ isReady: false }))).isReady : true,
      keyPresent: Boolean(key?.key),
      healthOk: Boolean(status?.health.ok) && creditsOk,
      dailyCapUsd: caps[id],
      // an unreadable spend counts as «no room left»: never guess in the platform's favour
      spentTodayUsd: spent === null ? caps[id] : spent,
    };
  }
  return defaultRouterState(true, providers);
}

const CHOOSE_TOOL = "choose_route";

/** The production chooser: one short call with a forced tool, a short timeout, never throws. Disabled when the assistant is off or in test mode. */
export function createClaudeRouteChooser(client: any, userId: string | null): RouteChooser | null {
  const flag = (name: string) => (process.env[name] || "").trim().toLowerCase();
  if (flag("LLM_PROVIDER") === "fake" || ["false", "0", "off"].includes(flag("LLM_ENABLED")) || flag("LLM_LIVE") === "false") return null;
  return async ({ options, request }) => {
    const key = (await resolveProviderKey("anthropic")).key;
    if (!key) throw new Error("no_key");
    const model = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
    const started = Date.now();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(6_000),
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: "You pick ONE data-collection route for a research request from the given options. Choose by fit to the request: where the companies are likely to be found and how well the contact pages are read. You never decide prices, limits or whether anything is allowed: only pick an option id and give a one-line reason.",
        messages: [{ role: "user", content: JSON.stringify({ request, options }) }],
        tools: [{ name: CHOOSE_TOOL, description: "Submit the chosen route.", input_schema: { type: "object", properties: { routeId: { type: "string", enum: options.map((o) => o.routeId) }, reason: { type: "string", maxLength: 200 } }, required: ["routeId", "reason"] } }],
        tool_choice: { type: "tool", name: CHOOSE_TOOL },
      }),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data: any = await response.json();
    try {
      const inputTokens = (Number(data?.usage?.input_tokens) || 0) + (Number(data?.usage?.cache_read_input_tokens) || 0) + (Number(data?.usage?.cache_creation_input_tokens) || 0);
      const outputTokens = Number(data?.usage?.output_tokens) || 0;
      const pricing = getLlmPricingSettings("anthropic", model);
      const costUsd = (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
      if (client && userId) await client.from("llm_usage").insert({ user_id: userId, tokens_in: inputTokens, tokens_out: outputTokens, model, latency_ms: Date.now() - started, reason: "route_choice", cost_usd: Number(costUsd.toFixed(6)), created_at: new Date().toISOString() });
    } catch { /* the usage row is best effort */ }
    const tool = Array.isArray(data?.content) ? data.content.find((b: any) => b?.type === "tool_use" && b?.name === CHOOSE_TOOL) : null;
    return tool?.input;
  };
}

export type ChainItemRouting =
  | { ok: true; routeCode: string; routeId: string; costPerDeliveredRowUsd: number; budgetUsd: number; count: number; unitPricePoints: number; reservePoints: number; choice: Pick<RouteChoice, "source" | "reason" | "fallbackReason">; request: RouteRequest; decision: RoutingDecision }
  | { ok: false; messageAr: string };

/**
 * The route of one chain plan item. A route the plan already carries (an edit of the plan) is kept when it is still allowed, so a plan
 * costs at most one model call; the cost and the provider budget are always recomputed for the volume of THIS quote.
 */
export async function resolveChainItemRouting(args: { client: any; params: Record<string, any> | undefined; volume: number; userId?: string | null; state?: RouterState }): Promise<ChainItemRouting> {
  const request = routeRequestFromParams(args.params, args.volume);
  const state = args.state ?? (await loadRouterState(args.client));
  const { allowed, excluded } = buildAllowedRoutes(request, state);
  if (allowed.length === 0) return { ok: false, messageAr: NO_ROUTE_AR };

  const kept = routeByCode(args.params?.routeCode);
  const keptAllowed = kept ? allowed.find((a) => a.id === kept.id) : undefined;
  const choice: RouteChoice | null = keptAllowed
    ? { route: keptAllowed, source: "only_option", reason: null }
    : await chooseRoute(allowed, request, chooserForTests !== undefined ? chooserForTests : createClaudeRouteChooser(args.client, args.userId ?? null));
  if (!choice) return { ok: false, messageAr: NO_ROUTE_AR };
  const r = choice.route;
  const decision: RoutingDecision = {
    at: new Date().toISOString(),
    routeId: r.id,
    routeCode: routeCodeOf(r.id),
    source: choice.source,
    reason: choice.reason,
    ...(choice.fallbackReason ? { fallbackReason: choice.fallbackReason } : {}),
    modelCalled: choice.source === "model" || choice.fallbackReason === "model_failed" || choice.fallbackReason === "invalid_choice",
    request,
    count: r.count,
    unitPricePoints: r.unitPricePoints,
    reservePoints: r.reservePoints,
    budgetUsd: r.estimate.budgetUsd,
    stages: r.estimate.stages.map((s) => ({ stage: s.stage, provider: s.provider, capabilityId: s.capabilityId, unitPricePoints: s.unitPricePoints, maxCalls: s.maxCalls, expectedYield: s.expectedYield, estimatedJobUsd: s.jobUsd })),
    allowed: allowed.map((a) => ({ routeId: a.id, costPerDeliveredRowUsd: a.estimate.costPerDeliveredRowUsd, unitPricePoints: a.unitPricePoints, reservePoints: a.reservePoints, count: a.count })),
    excluded: excluded.map((e) => ({ routeId: e.routeId, reason: e.reason, ...(e.provider ? { provider: e.provider } : {}), ...(e.capabilityId ? { capabilityId: e.capabilityId } : {}) })),
  };
  return {
    ok: true,
    routeCode: routeCodeOf(r.id),
    routeId: r.id,
    costPerDeliveredRowUsd: r.estimate.costPerDeliveredRowUsd,
    budgetUsd: r.estimate.budgetUsd,
    count: r.count,
    unitPricePoints: r.unitPricePoints,
    reservePoints: r.reservePoints,
    choice: { source: choice.source, reason: choice.reason, ...(choice.fallbackReason ? { fallbackReason: choice.fallbackReason } : {}) },
    request,
    decision,
  };
}
