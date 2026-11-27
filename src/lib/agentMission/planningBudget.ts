import { callEstimateUsd, unitCost } from "../modelPlanner/pricing";
import { floorMicroUsd } from "../server/callBudget";
import { blockedEndpointReason } from "../treg/blockList";
import { isSellable, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import { policyVerdict, type AccountAccess } from "../treg/dataPolicy";
import { implicitCompanyStages, planningBudgetUsd, type BudgetUnderstandingInput } from "./budget";
import { rankedCandidates } from "./candidates";
import { COMPANIES_PLATFORM, PEOPLE_PLATFORM, rankedPeopleSources } from "./childSources";
import {
  AGENT_PLANNING_BUDGET_CAP_USD, AGENT_PLANNING_SAMPLE_MARGIN, AGENT_PLANNING_SAMPLES_FIRST_STAGE,
  AGENT_PLANNING_SAMPLES_LATER_STAGE, AGENT_PLANNING_SLACK_USD, AGENT_PLANNING_STAGE_RESERVE_SHARE,
} from "./constants";
import { priorRowsPerCall, rankEndpoints, type StatsMap } from "./sourceRanking";

export type StageRole = "only" | "parent" | "child";

export interface StagePlanFacts {
  role: StageRole;
  job: string;
  sourceId: string | null;
  callUsd: number;
  needUsd: number;
  reserveUsd: number;
}

export interface PlanningBudgetFacts {
  baseUsd: number;
  budgetUsd: number;
  capUsd: number;
  scaled: boolean;
  stages: StagePlanFacts[];
}

export interface BudgetContext {
  catalog: TregCatalog;
  access: AccountAccess;
  stats: StatsMap;
  now: number;
}

interface FundingContext extends BudgetContext {
  defaultAdmissionUsdOf: (endpointId: string) => number | null;
  ceilToMicroUsd: (usd: number) => number;
}

interface BudgetStage {
  role: StageRole;
  job: string;
  samples: number;
  ranked: readonly string[];
}

const capUsd = AGENT_PLANNING_BUDGET_CAP_USD;
const reserveShare = AGENT_PLANNING_STAGE_RESERVE_SHARE;

/** What a usual catalog page costs before sampling. */
export function oneCallUsd(endpoint: CatalogEndpoint, catalog: TregCatalog): number {
  const cost = unitCost(endpoint, catalog);
  return cost ? Math.max(callEstimateUsd(cost, priorRowsPerCall(endpoint)), 0.000001) : 0;
}

function stagesOf(u: BudgetUnderstandingInput | null, ctx: BudgetContext): BudgetStage[] {
  if (!u) return [];
  const allowed = (id: string) => isSellable(id, ctx.catalog) && !blockedEndpointReason(id) && policyVerdict(id, ctx.access).allowed;
  const implicit = implicitCompanyStages(u);
  const steps = [...u.steps];
  if (implicit.companies) {
    steps.unshift({ key: "", parent: null, platform: COMPANIES_PLATFORM, capability: `${COMPANIES_PLATFORM}.search` });
  }
  const multi = steps.length + Number(implicit.people) > 1;
  const stages = steps.map(({ parent, platform, capability }, index): BudgetStage => {
    const exact = ctx.catalog.endpoints.filter((endpoint) => endpoint.capability === capability && endpoint.platform === platform && allowed(endpoint.id));
    const words = capability.split(/[.\s_-]+/).filter((word) => word !== platform);
    const existing = rankedCandidates({ ...ctx, words, platform }).ranked.filter((route) => exact.some((endpoint) => endpoint.id === route.id));
    const ranked = existing.length > 0 ? existing : rankEndpoints(exact, ctx.catalog, ctx.stats, ctx.now).ranked;
    return {
      role: parent !== null ? "child" : multi ? "parent" : "only",
      job: capability,
      samples: index === 0 ? AGENT_PLANNING_SAMPLES_FIRST_STAGE : AGENT_PLANNING_SAMPLES_LATER_STAGE,
      ranked: ranked.map((route) => route.id),
    };
  });
  if (implicit.people) {
    stages.push({
      role: "child", job: PEOPLE_PLATFORM, samples: AGENT_PLANNING_SAMPLES_LATER_STAGE,
      ranked: rankedPeopleSources(ctx.catalog, allowed, ctx.now).map((route) => route.id),
    });
  }
  return stages;
}

const routeCost = (id: string | undefined, catalog: TregCatalog): number => {
  const endpoint = id ? catalog.byId.get(id) : undefined;
  return endpoint ? oneCallUsd(endpoint, catalog) : 0;
};

/** The planner's direct web budget follows main's rank-first rule, including main's six-place rounding. */
export function webPlanningCeilingUsd(u: BudgetUnderstandingInput, ctx: BudgetContext): number {
  const need = stagesOf(u, ctx).reduce((sum, stage) =>
    sum + stage.samples * routeCost(stage.ranked[0], ctx.catalog) * AGENT_PLANNING_SAMPLE_MARGIN, 0);
  return Number(Math.min(capUsd, Math.max(planningBudgetUsd(u), need + AGENT_PLANNING_SLACK_USD)).toFixed(6));
}

interface SampleRoute {
  id: string;
  callUsd: number;
  firstUsd: number;
  needUsd: number;
  reserveNeedUsd: number;
}

function sampleRoutes(stage: BudgetStage, ctx: FundingContext): SampleRoute[] {
  return stage.ranked.flatMap((id) => {
    const callUsd = routeCost(id, ctx.catalog);
    const firstUsd = ctx.defaultAdmissionUsdOf(id);
    if (!Number.isFinite(callUsd) || callUsd <= 0 || firstUsd === null || !Number.isFinite(firstUsd) || firstUsd <= 0) return [];
    return [{
      id, callUsd, firstUsd,
      needUsd: stage.samples * callUsd * AGENT_PLANNING_SAMPLE_MARGIN,
      reserveNeedUsd: Math.max(firstUsd, ctx.ceilToMicroUsd(Math.min(stage.samples, 2) * callUsd * AGENT_PLANNING_SAMPLE_MARGIN)),
    }];
  });
}

/** Handover funds the first affordable root before keeping room for child samples. */
export function planningBudgetFacts(u: BudgetUnderstandingInput | null, ctx: FundingContext, recordedPlanningSpentUsd = 0): PlanningBudgetFacts {
  const { ceilToMicroUsd } = ctx;
  const baseUsd = planningBudgetUsd(u);
  const stages = stagesOf(u, ctx).map((stage) => ({ ...stage, routes: sampleRoutes(stage, ctx) }));
  const roots = stages.map((stage) => stage.role === "child" ? undefined : stage.routes.find((route) => route.firstUsd <= capUsd));
  const parentKeep = Math.max(ceilToMicroUsd(baseUsd * (1 - reserveShare)), ...roots.map((route) => route?.firstUsd ?? 0));
  const childRoom = floorMicroUsd(capUsd - parentKeep);
  const choices = stages.map((stage) => stage.role === "child"
    ? stage.routes.filter((route) => route.reserveNeedUsd <= childRoom).sort((a, b) => a.callUsd - b.callUsd)
    : []);
  const selected = stages.map((_, index) => roots[index] ?? choices[index][0]);
  const need = selected.reduce((sum, route) => sum + (route?.needUsd ?? 0), 0);
  const budgetUsd = Math.min(capUsd, Math.max(baseUsd, ceilToMicroUsd(need + AGENT_PLANNING_SLACK_USD)));
  const reserveFloor = ceilToMicroUsd(baseUsd * reserveShare);
  let pool = floorMicroUsd(budgetUsd - Math.max(0, recordedPlanningSpentUsd) - parentKeep);
  const facts = stages.map((stage, index): StagePlanFacts => {
    const route = stage.role === "child" ? choices[index].find((option) => option.reserveNeedUsd <= pool) : roots[index];
    const reserveUsd = stage.role === "child" && route ? Math.min(pool, Math.max(route.reserveNeedUsd, reserveFloor)) : 0;
    pool = floorMicroUsd(pool - reserveUsd);
    return { role: stage.role, job: stage.job, sourceId: route?.id ?? null, callUsd: route?.callUsd ?? 0, needUsd: route?.needUsd ?? 0, reserveUsd };
  });
  return { baseUsd, budgetUsd, capUsd, scaled: budgetUsd > baseUsd, stages: facts };
}
