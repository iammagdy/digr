import { callEstimateUsd, unitCost } from "../modelPlanner/pricing";
import { endpointCostUsd, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import type { AccountAccess } from "../treg/dataPolicy";
import { AGENT_PLANNING_BUDGET_CAP_USD, AGENT_PLANNING_STAGE_RESERVE_SHARE, AGENT_PLANNING_SAMPLES_FIRST_STAGE, AGENT_PLANNING_SAMPLES_LATER_STAGE, AGENT_PLANNING_SAMPLE_MARGIN, AGENT_PLANNING_SLACK_USD } from "./constants";
import { expectedStageCount, planningBudgetUsd } from "./budget";
import { rankedCandidates } from "./candidates";
import { priorRowsPerCall, type StatsMap } from "./sourceRanking";

/**
 * THE PLANNING BUDGET, SCALED TO THE PLATFORM'S COST, by code (owner decision 2026-10-29). Planning must not end before a card because a source is dear: a post search of Facebook costs a few cents a call, so the flat budget of a cheap platform
 * cannot pay for one sample of each stage. The budget is the base figure (budget.ts), or the cost of the samples the request's stages need on the sources the ranking puts first, whichever is more, never above the hard cap
 * (AGENT_PLANNING_BUDGET_CAP_USD) that the call budget enforces. The same sizes give each stage its own reserve (the cost of ITS first samples), so a dear first stage can never spend what the next stage needs. Pure over the catalog snapshot: no I/O.
 */
export type StageRole = "only" | "parent" | "child";

export interface StagePlanFacts {
  role: StageRole;
  /** The job the request's words name for the stage, for the admin («facebook search posts»). */
  job: string;
  /** The source the ranking puts first for it (null: none found) and the cost of one call of it, USD. */
  sourceId: string | null;
  callUsd: number;
  /** What the stage's samples are expected to cost, margin included, and what is kept for its first sample while it is not sampled yet. */
  needUsd: number;
  reserveUsd: number;
}

export interface PlanningBudgetFacts { baseUsd: number; budgetUsd: number; capUsd: number; scaled: boolean; stages: StagePlanFacts[] }

interface JobWords { platform: string | null; words: string[]; job: string }

const PLATFORMS: ReadonlyArray<{ re: RegExp; platform: string }> = [
  { re: /فيس\s*بوك|فيسبوك|facebook/i, platform: "facebook" },
  { re: /انستقرام|انستجرام|إنستغرام|إنستجرام|instagram/i, platform: "instagram" },
  { re: /تيك\s*توك|تيكتوك|tiktok/i, platform: "tiktok" },
  { re: /يوتيوب|youtube/i, platform: "youtube" },
  { re: /لينكد\s*إن|لينكدإن|linkedin/i, platform: "linkedin" },
  { re: /تغريد|تويتر|twitter|tweets?|(?:^|[^\p{L}])(?:إكس|اكس|x)(?:[^\p{L}]|$)/iu, platform: "x" },
];
const FIRST_JOBS: ReadonlyArray<{ re: RegExp; platform?: string; words: string[]; job: string }> = [
  { re: /شركات|شركة|compan/i, platform: "companies", words: ["companies", "search"], job: "companies search" },
  { re: /مطعم|مطاعم|أماكن|اماكن|مكان|ماب|خرائط|maps|places?/i, platform: "google", words: ["maps", "places", "search"], job: "maps places search" },
  { re: /فيديو|ريلز|videos?|reels/i, words: ["search", "videos"], job: "search videos" },
  { re: /بوست|منشور|posts?/i, words: ["search", "posts"], job: "search posts" },
  { re: /تغريد|tweets?/i, platform: "x", words: ["search", "posts"], job: "search posts" },
];
const CHILD_JOBS: ReadonlyArray<{ re: RegExp; words: string[]; job: string; platform?: string }> = [
  { re: /تعليق|comments?/i, words: ["comments"], job: "comments" },
  { re: /مراجعات|مراجعه|تقييمات|reviews?|ريفيو/i, words: ["reviews"], job: "reviews" },
  { re: /ردود|replies/i, words: ["replies"], job: "replies" },
  { re: /موظف|عاملين|employees?|مدير|مديري/i, words: ["employees"], job: "employees", platform: "people" },
];

/** The stages the request's words name, in order: the first job (what is searched) and, when the request asks for a parent and its children, the child job. */
export function jobsOfRequest(request: string): { platform: string | null; stages: Array<JobWords & { role: StageRole }> } {
  const text = String(request ?? "");
  const platform = PLATFORMS.find((p) => p.re.test(text))?.platform ?? null;
  const first = FIRST_JOBS.find((j) => j.re.test(text));
  const child = CHILD_JOBS.find((j) => j.re.test(text));
  const multi = expectedStageCount(text) > 1;
  const stages: Array<JobWords & { role: StageRole }> = [];
  const firstPlatform = first?.platform ?? platform;
  stages.push({ platform: firstPlatform, words: first?.words ?? ["search"], job: `${firstPlatform ?? "any"} ${first?.job ?? "search"}`, role: multi ? "parent" : "only" });
  if (multi) {
    const childPlatform = child?.platform ?? platform ?? firstPlatform;
    // the child's job is named with its parent («post comments», «video comments», «maps reviews»): the capability of the comments of a post is not the one of the replies to a comment
    const parentWord = first?.words.includes("videos") ? "video" : first?.words.includes("posts") ? "post" : first?.words.includes("maps") ? "maps" : null;
    const words = child?.words ?? ["comments"];
    stages.push({ platform: childPlatform, words: parentWord && !words.includes(parentWord) ? [parentWord, ...words] : words, job: `${childPlatform ?? "any"} ${child?.job ?? "children"}`, role: "child" });
  }
  return { platform, stages };
}

/** What one call of an endpoint costs when asked for its usual page, USD (the catalog's price; a flat guess when it has none). */
export function oneCallUsd(endpoint: CatalogEndpoint, catalog: TregCatalog): number {
  const cost = unitCost(endpoint, catalog);
  if (cost) return Math.max(callEstimateUsd(cost, priorRowsPerCall(endpoint)), 0.000001);
  const own = endpointCostUsd(endpoint);
  return own !== null && own > 0 ? own : 0.01;
}

export interface BudgetContext { catalog: TregCatalog; access: AccountAccess; stats: StatsMap; now: number }

export function planningBudgetFacts(request: string, ctx: BudgetContext): PlanningBudgetFacts {
  const baseUsd = planningBudgetUsd(request);
  const { stages } = jobsOfRequest(request);
  const facts: StagePlanFacts[] = stages.map((st, index) => {
    const samples = index === 0 ? AGENT_PLANNING_SAMPLES_FIRST_STAGE : AGENT_PLANNING_SAMPLES_LATER_STAGE;
    const ranking = rankedCandidates({ catalog: ctx.catalog, access: ctx.access, words: st.words, platform: st.platform, stats: ctx.stats, now: ctx.now });
    const [first] = ranking.ranked;
    const firstEndpoint = first ? ranking.endpoints.get(first.id) : undefined;
    const c1 = firstEndpoint ? oneCallUsd(firstEndpoint, ctx.catalog) : 0;
    // the samples of its cheapest ranked source, margin included; what is kept for a stage not sampled yet is its first samples' worth (two calls of it), never less than the flat share of the base budget
    const need = samples * c1 * AGENT_PLANNING_SAMPLE_MARGIN;
    return { role: st.role, job: st.job, sourceId: first?.id ?? null, callUsd: c1, needUsd: need, reserveUsd: Math.max(Number((AGENT_PLANNING_STAGE_RESERVE_SHARE * baseUsd).toFixed(6)), Number((Math.min(samples, 2) * c1 * AGENT_PLANNING_SAMPLE_MARGIN).toFixed(6))) };
  });
  const wanted = facts.reduce((n, f) => n + f.needUsd, 0) + AGENT_PLANNING_SLACK_USD;
  const budgetUsd = Number(Math.min(AGENT_PLANNING_BUDGET_CAP_USD, Math.max(baseUsd, wanted)).toFixed(6));
  return { baseUsd, budgetUsd, capUsd: AGENT_PLANNING_BUDGET_CAP_USD, scaled: budgetUsd > baseUsd + 1e-9, stages: facts };
}
