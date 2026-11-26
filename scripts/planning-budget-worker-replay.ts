/** Owner-only model replay. Both model modes use local provider transports and an in-memory worker. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission, type MemoryStore } from "../agent/src/memoryStore";
import { anthropicPlannerModel } from "../agent/src/llmPlanner/model";
import type { PlannerModel } from "../agent/src/llmPlanner/planner";
import { LLM_PLANNER_MODEL } from "../agent/src/llmPlanner/run";
import { resolveModels } from "../agent/src/modelConfig";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import type { CallRow } from "../agent/src/types";
import { AGENT_PLANNING_LLM_BUDGET_USD } from "../src/lib/agentMission/constants";
import { settlementCharge } from "../src/lib/agentMission/price";
import { modelPlanningForTests, setModelPlanningForTests } from "../src/lib/agentMission/testSeam";
import { loadTregCatalog, type TregCatalog } from "../src/lib/treg/catalog";
import { callEstimateUsd, unitCost } from "../src/lib/modelPlanner/pricing";
import { providerCallBound } from "../src/lib/server/spendGate/bounds";
import type { CallRecorder } from "../src/lib/server/multiProvider/adapterTypes";

const POSTS = "justoneapi.x.facebook-search-post-v1";
const COMMENTS = "treg.facebook.post.comments";
const AFFORDABLE_COMMENTS = "anyapi.facebook.post_comments";
const COMPANY = "tomba.companies.search.reveal";
const PEOPLE = "aviato.companies.employees";
const DEAR_CHILD = "enrichlayer.company.employees.list";
const X = "anyapi.x.search.posts";
const YOUTUBE = "crawl4ai.youtube.search.videos";
const WEB = "firecrawl.search";
const REQUEST_FB = "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات";
const PHRASES = ["غلاء الأسعار", "تكلفة المعيشة", "أسعار السلع", "ارتفاع الأسعار", "غلاء الأسعار في مصر"];
const ACCESS = { isAdmin: false, verifiedBusiness: false };
const sha = (contents: string) => createHash("sha256").update(contents).digest("hex");
const usd = (n: number) => Number(n.toFixed(6));

type World = "youtube" | "rumors" | "b2b" | "measured" | "fallback" | "dear-child" | "cheap-web";
type Expected = "card" | "two-turn-card" | "admissions";
export interface ReplayCase {
  id: string;
  world: World;
  expected: Expected;
  qaFile?: string;
  mission?: string;
  fallbackComments?: "affordable";
}

interface QaFixture {
  request_text?: string;
  requests?: { mission: string; text: string }[];
  turn_texts?: { turn1_request_text: string; turn2_answer_text: string };
  provider_calls?: { phase: string; endpointId: string; costUsd: number; status: string }[];
}

const COMPANY_STEP = { key: "companies", platform: "companies", capability: "companies.search", title_ar: "شركات البرمجيات", count: { total: 3 } };
const PEOPLE_STEP = { key: "people", platform: "companies", capability: "companies.employees", parent: "companies", title_ar: "مديرو الشركات", count: { per_parent: 1 } };
const CONTACTS = { asked: true, title_ar: "المدير", per_company: 1, per_company_text: "مدير", contact_kinds: ["email", "phone"] };

export const measuredUnderstanding = {
  decision: "plan", understanding_ar: "منشورات عن غلاء الأسعار وتعليقاتها.", accepts_available: true,
  steps: [
    { key: "posts", title_ar: "المنشورات", platform: "facebook", capability: "facebook.search.posts", count: { total: 5 }, topic: PHRASES[0], search_terms: PHRASES.slice(1) },
    { key: "comments", title_ar: "التعليقات", platform: "facebook", capability: "facebook.post.comments", parent: "posts", count: { per_parent: 10 } },
  ],
};

export function measuredCalls(now: number): CallRow[] {
  return [
    { endpoint_id: "scrapecreators.x.v1-facebook-post-comments", rows_returned: 0, cost_usd: 0.00188 },
    { endpoint_id: "brightdata.x.facebook-comments", rows_returned: 0, cost_usd: 0.0075 },
    { endpoint_id: COMMENTS, rows_returned: 100, cost_usd: 0.02952 },
  ].map((row, index) => ({
    ...row, id: `stats-${index}`, mission_id: "ranking-history", phase: "execution",
    status: row.rows_returned === 0 ? "empty" : "ok", created_at: new Date(now).toISOString(),
  } as CallRow));
}

const sample = (endpoint_id: string, params: Record<string, unknown>): FakeStep => ({
  tool: "treg_call", args: { endpoint_id, params, why: "The replay pins this catalog route and its evidence." },
});

const companies = Array.from({ length: 3 }, (_, i) => ({
  id: `company-${i}`, name: `شركة برمجيات ${i + 1}`, city: "المعادي", country: "مصر",
  industry: "البرمجيات", website_url: `company-${i}.example`, linkedin_url: `https://www.linkedin.com/company/example-${i}`,
}));
const employee = {
  personID: "employee-0", companyName: companies[0].name, positionList: [{ title: "المدير التنفيذي" }],
  person: { fullName: "أحمد حسن", URLs: { linkedin: "https://www.linkedin.com/in/example-manager", email: "manager@company-0.example" }, phone: "+12025550109", email: "manager@company-0.example" },
};

function legacySteps({ world, fallbackComments }: ReplayCase): FakeStep[] {
  if (world === "fallback") return [
    sample(POSTS, { keyword: PHRASES[0] }), sample(POSTS, { keyword: PHRASES[4] }),
    sample(fallbackComments === "affordable" ? AFFORDABLE_COMMENTS : COMMENTS, { url: "https://www.facebook.com/test/posts/1" }),
  ];
  if (world === "dear-child") return [
    sample("aiark.companies.search", { page: 1, size: 1 }),
    sample(DEAR_CHILD, { url: "https://www.linkedin.com/company/example-0" }),
  ];
  if (world !== "b2b") return [];
  return [
    sample(COMPANY, { query: "software Maadi", page: 1 }),
    { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url, linkedin: c.linkedin_url }))", files: ["call_0001"] } },
    sample(PEOPLE, { page: 1, perPage: 1, website: companies[0].website_url }),
    { tool: "run_code", args: { code: "return inputs.call_0002.employees.map(r => ({ id: r.personID, full_name: r.person.fullName, job_title: r.positionList[0].title, company: r.companyName, linkedin: r.person.URLs.linkedin, email: r.person.email, phone: r.person.phone }))", files: ["call_0002"] } },
    { tool: "propose_plan", args: (results) => ({
      summary_ar: "نجمع ثلاث شركات برمجيات في المعادي ومدير كل شركة وبيانات التواصل المتاحة.",
      stages: [
        {
          key: "companies", title_ar: "شركات البرمجيات في المعادي", endpoint_id: COMPANY, expected_rows: 3, parent_key: null, deliver: true,
          columns: [["name","اسم الشركة"],["industry","النشاط"],["city","المدينة"],["country","الدولة"],["website","الموقع الإلكتروني"],["linkedin","الصفحة المهنية"]].map(([key, title_ar]) => ({ key, title_ar })),
          sample_rows: [{ id: companies[0].linkedin_url, name: companies[0].name, industry: companies[0].industry, city: companies[0].city, country: companies[0].country, website: companies[0].website_url, linkedin: companies[0].linkedin_url }],
          measured_by: ["call_0001", results.find((r) => r.tool === "run_code")?.result.output_id].filter(Boolean),
        },
        {
          key: "people", title_ar: "المديرون", endpoint_id: PEOPLE, expected_rows: 3, parent_key: "companies", per_parent_rows: 1, deliver: true,
          columns: [["full_name","الاسم"],["job_title","المسمى الوظيفي"],["company","الشركة"],["linkedin","الصفحة المهنية"],["email","البريد الإلكتروني","work_email"],["phone","رقم الهاتف","phone"]].map(([key, title_ar, kind]) => ({ key, title_ar, ...(kind ? { kind } : {}) })),
          sample_rows: [{ id: employee.personID, full_name: employee.person.fullName, job_title: employee.positionList[0].title, company: employee.companyName, linkedin: employee.person.URLs.linkedin, email: employee.person.email, phone: employee.person.phone }],
          measured_by: ["call_0002"],
        },
      ],
    }) },
  ];
}

function scriptedModel(world: World, qa: QaFixture, turn: number, emptyB2B: boolean): PlannerModel {
  return async ({ tool, user }) => {
    let input: unknown;
    switch (tool.name) {
      case "request_plan":
        if (world === "measured") input = measuredUnderstanding;
        else if (world === "b2b") input = emptyB2B
          ? { decision: "cannot", understanding_ar: "شركات البرمجيات ومديروها.", steps: [], people_of_companies: CONTACTS }
          : { decision: "plan", understanding_ar: "شركات البرمجيات ومديروها.", steps: [COMPANY_STEP, PEOPLE_STEP], people_of_companies: CONTACTS };
        else if (world === "cheap-web") input = { ...measuredUnderstanding, steps: [{
          ...measuredUnderstanding.steps[0], platform: "x", capability: "x.search.posts", title_ar: "التغريدات",
        }] };
        else if (world === "dear-child") input = { decision: "plan", understanding_ar: "الشركات وموظفوها.", steps: [COMPANY_STEP, { ...PEOPLE_STEP, capability: "companies.employees.list" }] };
        else if (world === "rumors" && turn === 1) input = { decision: "ask", understanding_ar: "أخبار الشائعات.", question_ar: "أي نتائج تفضّل؟", missing: ["items"], options_ar: [qa.turn_texts!.turn2_answer_text] };
        else {
          const video = world === "youtube";
          const topic = video ? "التغذية الصحية" : "الشائعات";
          input = { decision: "plan", understanding_ar: "جمع العينة المطلوبة.", accepts_available: true, steps: [{
            key: "items", title_ar: video ? "فيديوهات" : "تغريدات", platform: video ? "youtube" : "x",
            capability: video ? "youtube.search.videos" : "x.search.posts", count: { total: video ? 5 : 1 }, topic,
          }] };
        }
        break;
      case "tool_choice": {
        const child = user.includes('"key":"comments"');
        const endpoint_id = world === "measured" ? (child ? COMMENTS : POSTS) : world === "youtube" ? YOUTUBE : X;
        const params = world === "measured" ? (child ? {} : { keyword: PHRASES[0] })
          : { query: world === "youtube" ? "التغذية الصحية" : world === "cheap-web" ? PHRASES[0] : "الشائعات" };
        input = { options: [{ endpoint_id, params_json: JSON.stringify(params), ...(child ? { parent_input: { param: "url", from_field: "link" } } : {}) }] };
        break;
      }
      case "field_map":
        input = { fields: user.includes("post_id") ? { id: ["post_id"], text: ["message"], link: ["url"] }
          : user.includes("description") ? { id: ["url"], text: ["description"], title: ["title"], link: ["url"] }
          : { id: ["id"], text: ["text"], title: ["title"], link: ["url"] }, extra: [] };
        break;
      case "judge_sample": input = { matching_indices: Array.from({ length: 5 }, (_, i) => i) }; break;
      default: throw new Error(`No recorded output for ${tool.name}`);
    }
    return { input, costUsd: 0 };
  };
}

function fixturePage(id: string, world: World, sequence: number, params: Record<string, unknown>): unknown | undefined {
  const rumor = { id: "replay-rumor", text: "توعية الأفراد ضد الشائعات", url: "https://x.example/u/status/100" };
  if (id === POSTS && (world === "measured" || world === "fallback")) return {
    code: 0, data: { results: [{ post_id: String(sequence), message: "غلاء الأسعار في مصر", url: `https://www.facebook.com/test/posts/${sequence}`, timestamp: 1785202291 }], cursor: null },
  };
  if (id === COMMENTS && (world === "measured" || world === "fallback")) return { comments: [{ id: "c1", text: "غلاء الأسعار في مصر", author: "قارئ" }] };
  if (id === AFFORDABLE_COMMENTS && world === "fallback") return {
    output: { data: { comments: [{ id: "c1", text: "غلاء الأسعار في مصر", author: "قارئ" }] } },
  };
  if ((world === "rumors" || world === "cheap-web") && id === X) {
    const item = world === "cheap-web" ? { ...rumor, text: "غلاء الأسعار في مصر" } : rumor;
    return { output: { data: { items: [item], nextCursor: null } } };
  }
  if (world === "rumors" && id === "anyapi.x.user.posts") return { output: { data: { tweets: [rumor], next_cursor: null } } };
  if (world === "youtube" && id === YOUTUBE) return { rows: Array.from({ length: 5 }, (_, i) => ({
    id: `video-${i}`, url: `https://www.youtube.com/watch?v=replay${i}`, title: `التغذية الصحية رقم ${i + 1}`, text: "التغذية الصحية ونصائح لمرضى السكري",
  })) };
  if (world === "dear-child" && id === "aiark.companies.search") return { content: [companies[0]], totalElements: 1, number: 0, size: 1, last: true };
  if (world === "b2b") {
    if (id === COMPANY) return { data: { companies } };
    if (id === PEOPLE && typeof params.website === "string" && companies.some((company) => company.website_url === params.website)) return { employees: [employee] };
  }
  return undefined;
}

function inMemoryRecorder() {
  const reservations = new Map<number, number>();
  const billed = new Map<number, number>();
  const recorder: CallRecorder = {
    async reserve({ estimatedUsd }) {
      const costId = reservations.size + 1;
      reservations.set(costId, estimatedUsd);
      return { allowed: true, costId };
    },
    async commit(id, row) { if (id !== null) billed.set(id, row.costUsd); },
  };
  return {
    reservations, billed, recorder,
    commit: (async (_client, args) => {
      if (args.costId !== null) billed.set(args.costId, args.costUsd);
    }) satisfies NonNullable<RunnerDeps["commit"]>,
  };
}

const client = {
  from: (table: string) => {
    if (table !== "credit_ledger") throw new Error(`Unexpected replay database operation: ${table}`);
    return { select: () => ({ eq: async () => ({ data: [{ delta: 25000 }], error: null }) }) };
  },
};

function selectAnswer(options: unknown, expected: string): string {
  if (!Array.isArray(options)) throw new Error("The worker did not publish answer options");
  const strings = options.filter((option): option is string => typeof option === "string");
  const exact = strings.find((option) => option === expected);
  if (exact) return exact;
  const takeFound = strings.filter((option) => option.startsWith("سلّمني الموجود") || option.startsWith("سلمني الموجود"));
  if (takeFound.length === 1) return takeFound[0];
  throw new Error("The requested take-available answer was not offered");
}

async function replayDriver(key: string) {
  const { createSdkDriver } = await import("../agent/src/sdkRuntime");
  return createSdkDriver({ ANTHROPIC_API_KEY: key, PATH: process.env.PATH, HOME: process.env.HOME });
}

interface ReplayOptions {
  qa: QaFixture;
  catalog: TregCatalog;
  key?: string;
  turnLimit?: number;
  modelRemaining?: () => number;
  priorPlanningUsd?: number;
  unknownWebCharge?: boolean;
  emptyB2B?: boolean;
  inspect?: (store: MemoryStore) => void;
}

export async function runWorkerReplay(spec: ReplayCase, { qa, catalog, key, turnLimit = 2, modelRemaining, priorPlanningUsd, unknownWebCharge = false, emptyB2B = false, inspect }: ReplayOptions) {
  const request = qa.turn_texts?.turn1_request_text ?? qa.request_text
    ?? qa.requests?.find((item) => item.mission === spec.mission)?.text ?? (!spec.qaFile ? spec.world === "cheap-web" ? "هات خمس تغريدات عن غلاء الأسعار" : spec.world === "dear-child" ? "عايز شركات وموظفيها" : REQUEST_FB : undefined);
  if (!request) throw new Error(`No request in fixture ${spec.id}`);
  const mission = newMission({ id: spec.id, user_id: "replay-user", status: "planning", request_text: request });
  const store = createMemoryStore([mission]);
  if (spec.world === "measured") for (const row of measuredCalls(Date.now())) await store.addCall(row);
  const rec = inMemoryRecorder();
  const failure: string[] = [];
  const decisions: string[] = [];
  const webQueries: string[] = [];
  const seenTreg = new Map<string, number>();
  const paidModel = key && spec.expected !== "admissions" ? anthropicPlannerModel(key, LLM_PLANNER_MODEL) : null;
  const fakeDriver = createFakeDriver(legacySteps(spec), { costUsd: 0, stopAfterTerminal: false });
  const driver = paidModel && spec.world === "b2b" && key ? await replayDriver(key) : fakeDriver;
  const turnOfCall = new Map<string, number>();
  if (priorPlanningUsd !== undefined) {
    const id = `${mission.id}:call_0001`;
    await store.addCall({
      id, mission_id: mission.id, phase: "planning", endpoint_id: WEB, status: "empty",
      rows_returned: 0, cost_usd: priorPlanningUsd, estimate_usd: priorPlanningUsd, created_at: new Date(Date.now()).toISOString(),
    } as CallRow);
    turnOfCall.set(id, 0);
  }
  const realDriver: RunnerDeps["driver"] = {
    run: (input) => {
      if (driver !== fakeDriver && modelRemaining && modelRemaining() < input.maxBudgetUsd) throw new Error("Replay model budget exhausted before worker call");
      return driver.run(input);
    },
  };

  const transportError = (message: string): never => {
    failure.push(message);
    throw new Error(message);
  };
  const status: string[] = [];
  for (let turn = 1; turn <= turnLimit; turn++) {
    const current = (await store.getMission(mission.id))!;
    const fallback = spec.world === "fallback";
    const model = paidModel ?? scriptedModel(spec.world, qa, turn, emptyB2B);
    const deps: RunnerDeps = {
      client, store, catalog, driver: realDriver,
      models: resolveModels({}, {}),
      recorder: rec.recorder, commit: rec.commit, resolveAccess: async () => ACCESS,
      ...((spec.world === "measured" || spec.world === "cheap-web") ? {
        providerKey: async (provider) => provider === "firecrawl" ? "fixture-key" : null,
        fetchFn: async (url, init) => {
          if (new URL(String(url)).pathname !== "/v2/search") transportError("Unexpected web operation");
          const query = String(JSON.parse(String(init?.body)).query);
          webQueries.push(query);
          if (unknownWebCharge) throw new Error("Fixture transport timed out");
          const rows = query === PHRASES[4]
            ? [{ url: "https://news.example/1", title: "غلاء الأسعار في مصر", description: "تكلفة المعيشة في مصر" }]
            : [];
          return Response.json({ success: true, creditsUsed: 6, data: { web: rows } });
        },
      } : {}),
      ...(fallback ? {} : { plannerModel: model }),
      call: async ({ endpointId, params, routeMaxCostUsd, stepId }) => {
        const count = (seenTreg.get(endpointId) ?? 0) + 1;
        seenTreg.set(endpointId, count);
        const page = fixturePage(endpointId, spec.world, count, params ?? {});
        const endpoint = catalog.byId.get(endpointId);
        if (!endpoint || page === undefined) return transportError(`No fixture mapping for ${endpointId}`);
        const price = unitCost(endpoint, catalog);
        if (!price) return transportError(`No catalog price for ${endpointId}`);
        const recorded = qa.provider_calls?.filter((row) => row.endpointId === endpointId && row.phase === "planning" && row.status === "ok")[count - 1];
        const fixedPrice = spec.world === "measured" ? 0.02952 : spec.world === "cheap-web" ? 0.001
          : spec.world === "fallback" ? (endpointId === POSTS ? 0.02952 : 0.002) : undefined;
        const billed = usd(fixedPrice ?? recorded?.costUsd ?? callEstimateUsd(price, Number(params?.limit ?? params?.size ?? params?.perPage ?? 1)));
        if (routeMaxCostUsd != null && billed > routeMaxCostUsd + 1e-9) return transportError(`Fixture cost for ${endpointId} exceeds the wire bound`);
        return { ok: true, httpStatus: 200, tregCallId: stepId, costMicro: Math.round(billed * 1_000_000), latencyMs: 0, data: page, isRouteMaxCost: false, isPlatformBalanceLow: false, allowLegacyEnvelope: true };
      },
      log: (line) => { if (line.startsWith("llm_planner ") || line.startsWith("planning_budget ")) decisions.push(line); },
    };
    const precedingTestSeam = modelPlanningForTests();
    if (fallback) setModelPlanningForTests(true);
    try { await runPlanning(deps, current); }
    finally { if (fallback) setModelPlanningForTests(precedingTestSeam); }

    const next = (await store.getMission(mission.id))!;
    status.push(next.status);
    for (const row of await store.listCalls(mission.id)) if (!turnOfCall.has(row.id)) turnOfCall.set(row.id, turn);
    if (failure.length) throw new Error(failure.join(" | "));
    if (turn === 1 && spec.expected === "two-turn-card") {
      if (next.status !== "needs_input" || !qa.turn_texts) throw new Error(`${spec.id} expected a question, got ${next.status}`);
      const publicPlan = next.plan_public as { question_options?: unknown } | null;
      await store.updateMission(mission.id, {
        status: "planning", answer_text: selectAnswer(publicPlan?.question_options, qa.turn_texts.turn2_answer_text),
      });
    } else break;
  }

  const next = (await store.getMission(mission.id))!;
  const calls = (await store.listCalls(mission.id)).map((row) => {
    const id = row.provider_cost_id;
    const web = row.endpoint_id === WEB;
    const limit = Number(row.params_digest?.limit ?? 30);
    const bound = providerCallBound({ provider: "firecrawl", op: "search", limit });
    const hold = row.status === "refused" ? null : web && bound.ok ? Math.max(Number(row.estimate_usd), bound.usd) : id == null ? null : rec.reservations.get(id) ?? null;
    const unknown = row.params_digest?.charge_unknown === true;
    return {
      turn: turnOfCall.get(row.id), endpoint: row.endpoint_id, status: row.status, reason: row.refused_reason,
      rows: row.rows_returned, reservedUsd: hold, unknown,
      billedUsd: unknown ? null : row.status === "refused" ? 0 : id == null ? Number(row.cost_usd) : rec.billed.get(id) ?? Number(row.cost_usd),
    };
  });
  if (spec.world === "b2b" && (!decisions.some((line) => line.includes("detail=handed_over")) || !calls.some((row) => row.status === "ok"))) throw new Error("B2B replay did not reach worker sampling");
  inspect?.(store);
  const price = next.plan?.price;
  if (spec.expected !== "admissions" && (next.status !== "plan_ready" || !price)) {
    const toolResults = fakeDriver.results.map(({ tool, result }) => [tool, result.ok, result.error ?? result.refused ?? result.message]);
    throw new Error(`${spec.id} did not produce a card: ${JSON.stringify({ status, calls, decisions, toolResults })}`);
  }
  const card = price ? [price.unitPricePoints, price.reservePoints, price.maxChargePoints, price.deliveredRows] : null;
  const settlement = price ? [0, 1].map((deliveredUnits) => settlementCharge({ ...price, reservedPoints: price.reservePoints, deliveredUnits })) : null;
  return {
    id: spec.id, expected: spec.expected, status, card, settlement, calls, webQueries,
    planning: {
      reservedUsd: usd(calls.reduce((total, row) => total + (row.reservedUsd ?? 0), 0)),
      billedUsd: usd(calls.reduce((total, row) => total + (row.billedUsd ?? 0), 0)),
      unknownCalls: calls.filter((row) => row.unknown).length, modelUsd: Number(next.planning_llm_usd ?? 0),
    },
    provenance: qa.provider_calls ? "recorded call log and reconstructed pages" : "deterministic catalog-priced provider fixtures",
  };
}

type ReplayResult = Awaited<ReturnType<typeof runWorkerReplay>>;
type ReplayEntry = ReplayResult & { iteration: number; head: string; fixtures: string; catalog: string; model: string };

export function compareWorkerReplay(base: ReplayEntry, branch: ReplayEntry) {
  if (base.id !== branch.id || base.iteration !== branch.iteration || base.fixtures !== branch.fixtures || base.catalog !== branch.catalog || base.model !== branch.model) throw new Error("Replay inputs differ");
  const admissions = (result: ReplayResult) => result.calls.map(({ turn, endpoint, status, reason }) => [turn, endpoint, status, reason]);
  const admissionChanged = JSON.stringify(admissions(base)) !== JSON.stringify(admissions(branch));
  const cardChanged = JSON.stringify([base.status, base.card, base.settlement]) !== JSON.stringify([branch.status, branch.card, branch.settlement]);
  if (base.expected !== "admissions" && (cardChanged || !base.card || !branch.card)) throw new Error(`${base.id} card/settlement drift: ${JSON.stringify({ base: base.card, branch: branch.card, baselineSettlement: base.settlement, branchSettlement: branch.settlement })}`);
  if (base.id === "measured-rank-facebook" && (admissionChanged || branch.webQueries.length !== 5)) throw new Error("Measured-rank web admission drift");
  return { id: base.id, iteration: base.iteration, admissionChanged, ...(admissionChanged ? { base: admissions(base), branch: admissions(branch) } : {}) };
}

async function main() {
  const { values } = parseArgs({ options: {
    fixtures: { type: "string", default: "scripts/fixtures/planning-budget-worker-replay.json" },
    "qa-dir": { type: "string", required: true },
    case: { type: "string" }, runs: { type: "string", default: "1" },
    output: { type: "string", required: true }, compare: { type: "string" },
    offline: { type: "boolean", default: false }, "max-model-usd": { type: "string" },
    "as-of": { type: "string", default: "2026-11-26T12:00:00Z" },
  } });
  const count = Number(values.runs);
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("Runs must be between one and five");
  const key = values.offline ? undefined : process.env.ANTHROPIC_API_KEY;
  if (!values.offline && !key) throw new Error("The real-model replay requires the owner model key");
  const maxModel = Number(values["max-model-usd"]);
  if (key && (!Number.isFinite(maxModel) || maxModel <= 0)) throw new Error("Set the approved model budget with --max-model-usd");
  const asOf = Date.parse(values["as-of"]!);
  if (!Number.isFinite(asOf)) throw new Error("Use an ISO date for --as-of");
  Date.now = () => asOf;
  const manifest = readFileSync(values.fixtures!, "utf8");
  const specs = (JSON.parse(manifest) as ReplayCase[]).filter((spec) => !values.case || spec.id === values.case);
  if (specs.length === 0) throw new Error("No matching replay cases");
  const catalog = loadTregCatalog();
  const catalogDigest = sha(JSON.stringify(catalog.endpoints));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const baseline = values.compare ? readFileSync(values.compare, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ReplayEntry) : [];
  if (values.compare && baseline.length !== count * specs.length) throw new Error("Baseline contains a different number of replay cases");
  const rows: ReplayEntry[] = [];
  if (key) console.error(JSON.stringify({ runs: count, cases: specs.length, maxModelUsd: maxModel, workerModelCeilingPerInvocationUsd: AGENT_PLANNING_LLM_BUDGET_USD, planningModel: LLM_PLANNER_MODEL }));
  let modelSpent = 0;
  for (let iteration = 1; iteration <= count; iteration++) {
    for (const spec of specs) {
      if (spec.qaFile && basename(spec.qaFile) !== spec.qaFile) throw new Error("Fixture file must be relative to the QA directory");
      const qaText = spec.qaFile ? readFileSync(resolve(values["qa-dir"]!, spec.qaFile), "utf8") : "{}";
      if (key && modelSpent >= maxModel) throw new Error("Replay model budget exhausted");
      const result = await runWorkerReplay(spec, { qa: JSON.parse(qaText), catalog, ...(key ? { key, modelRemaining: () => maxModel - modelSpent } : {}) });
      modelSpent += result.planning.modelUsd;
      if (key && modelSpent > maxModel) throw new Error("Replay exceeded its model budget");
      rows.push({ ...result, iteration, head, fixtures: sha(manifest + qaText + values["as-of"]), catalog: catalogDigest, model: key ? LLM_PLANNER_MODEL : "recorded" });
      if (values.compare) {
        const before = baseline.find((row) => row.id === spec.id && row.iteration === iteration);
        if (!before) throw new Error(`Missing baseline for ${spec.id} run ${iteration}`);
        console.error(JSON.stringify(compareWorkerReplay(before, rows.at(-1)!)));
      }
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  writeFileSync(values.output!, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Replay failed");
    process.exitCode = 1;
  });
}
