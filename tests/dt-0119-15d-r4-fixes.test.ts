import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANIES_ONLY_OPTION_LABELS,
  PEOPLE_RETRY_OPTION_LABELS,
  PLAIN_PEOPLE_FALLBACK_OPTIONS_AR,
  PLAIN_PEOPLE_FALLBACK_QUESTION_AR,
  isCompaniesOnlyChoice,
  isPeopleRetryChoice,
} from "../agent/src/companyPeopleRecovery";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning } from "../agent/src/runMission";
import { updateRunState } from "../agent/src/runState";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { LLM_PLANNER_SETTING_KEY } from "../src/lib/agentMission/llmPlannerFlag";
import { CAPABILITY_DISCOVERY_FLAG_KEY, verifyApprovedScope } from "../src/lib/agentMission/capabilities";
import { parseBrief, storedBriefOf, validateBrief, type ResearchBrief } from "../src/lib/agentMission/researchBrief";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { INTERNAL_PLANNING_AR } from "../src/lib/agentMission/refusal";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * DT-20261119-15d (ORDER 08 REVISED): LLM-First Root-Cause Fixes & Replays (NO stored brief on planner-on path)
 * 1) llm_planner_v1=true skips chat researchBrief AND worker brief continuity/refinement; capability discovery reads r.understanding directly.
 * 2) Case 2 generic "مدير كل شركة": catalog seniorityScore + titleTierOf + honest per-row "ملاحظة" (ZERO extra model calls), Intern counter-case.
 * 3) Plain Arabic fallback question + "نحاول تاني" retry across remaining eligible people sources -> 2-stage plan OR honest companies-only/unserved (never "حد من جانبنا").
 * 4) Drop-people P0 ("شركات بس من غير مديرين"): 0 people rows, 0 people charge, even with saved people on disk; counter-case child stage in proposal recovers people.
 */
vi.stubGlobal("fetch", () => {
  throw new Error("a real network call was attempted");
});

afterEach(() => {
  setChatModelForTesting(null);
});

const PLAIN_Q_AR = "لقينا الشركات، بس بيانات المديرين في العينة مش كفاية. تحب نكمّل بالشركات بس، ولا نحاول تاني؟";
const PLAIN_OPTS_AR = ["نكمّل بالشركات بس", "نحاول تاني"] as const;

const catalog = loadTregCatalog();
const allSkip = Object.fromEntries(catalog.endpoints.map((e) => [e.id, "other"]));

function validatedBrief(raw: Record<string, unknown>, customerTurns: string[]): ResearchBrief {
  const parsed = parseBrief({
    status: "ready",
    platforms: [],
    content: ["companies", "people"],
    count: null,
    topic: "برمجيات",
    period: null,
    country: "مصر",
    language: null,
    ...raw,
  });
  if (!parsed.ok) throw new Error(`parseBrief failed: ${parsed.issue}`);
  const v = validateBrief(parsed.brief, { customerTurns });
  if (!v.ok) throw new Error(`validateBrief failed: ${v.reason}`);
  return v.brief;
}

const tombaCloudSoft5 = {
  data: {
    companies: [
      {
        name: "CloudSoft5",
        website_url: "cloudsoft5.com",
        linkedin_url: "https://linkedin.com/company/cloudsoft5",
        street_address: "",
        phone_number: false,
        city: "Cairo",
        country: "EG",
        industry: "Software Development",
        company_size: "11-50",
        founded: 2015,
        total_emails: 8,
      },
      {
        name: "NileApps",
        website_url: "nileapps.com",
        linkedin_url: "https://linkedin.com/company/nileapps",
        street_address: "",
        phone_number: false,
        city: "Cairo",
        country: "EG",
        industry: "Software Development",
        company_size: "11-50",
        founded: 2018,
        total_emails: 6,
      },
    ],
  },
};

const tombaCarLog = {
  data: {
    companies: Array.from({ length: 10 }, (_, i) => ({
      name: i === 0 ? "CarLog" : `SoftCo ${i}`,
      website_url: i === 0 ? "carlog.com" : `softco${i}.com`,
      linkedin_url: i === 0 ? "https://www.linkedin.com/company/357338" : `https://www.linkedin.com/company/softco-${i}`,
      city: "Cairo",
      country: "EG",
      industry: "Software",
      total_emails: 5,
    })),
  },
};

async function runReplay(opts: {
  id: string;
  requestText: string;
  answerText?: string | null;
  questionAr?: string | null;
  understanding?: Record<string, unknown>;
  callHandler: (o: TregCallOptions) => Promise<TregCallResult>;
  steps: Parameters<typeof createFakeDriver>[0];
  peopleRecoveryAsked?: boolean;
  priorCalls?: Array<{ endpointId: string; params: Record<string, unknown>; ok: boolean; data: unknown; error?: string; httpStatus?: number }>;
  storeSettings?: Record<string, unknown>;
  reviewCall?: (input: { model: string; system: string; user: string; maxTokens: number }) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } } | null>;
  readMissionBrief?: () => Promise<ResearchBrief | null>;
}) {
  const store = createMemoryStore();
  store.settings[CAPABILITY_DISCOVERY_FLAG_KEY] = { user_ids: [USER_ID] };
  if (opts.storeSettings) Object.assign(store.settings, opts.storeSettings);
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const m = newMission({
    id: opts.id,
    user_id: USER_ID,
    status: "planning",
    request_text: opts.requestText,
    ...(opts.answerText ? { answer_text: opts.answerText } : {}),
    ...(opts.questionAr ? { question_ar: opts.questionAr } : {}),
  });
  store.missions.set(m.id, m);
  if (opts.peopleRecoveryAsked) {
    await updateRunState(store, m.id, (s) => ({ ...s, peopleRecoveryAsked: true }));
  }
  if (opts.priorCalls) {
    for (let i = 0; i < opts.priorCalls.length; i += 1) {
      const pc = opts.priorCalls[i];
      const callId = `call_${String(i + 1).padStart(4, "0")}`;
      if (pc.ok) {
        await store.putFile(m.id, `raw/${callId}.json`, JSON.stringify(pc.data), "application/json");
      }
      await store.addCall({
        id: `${m.id}:${callId}`,
        mission_id: m.id,
        phase: "planning",
        endpoint_id: pc.endpointId,
        params_digest: pc.params,
        status: pc.ok ? "ok" : "failed",
        refused_reason: null,
        http_status: pc.httpStatus ?? (pc.ok ? 200 : 404),
        rows_returned: pc.ok ? 1 : 0,
        cost_usd: pc.ok ? 0.001 : 0,
        estimate_usd: 0.001,
        provider_cost_id: null,
        storage_path: pc.ok ? `raw/${callId}.json` : null,
        duration_ms: 10,
      });
    }
  }
  const logs: string[] = [];
  const call = vi.fn(opts.callHandler);

  await runPlanning(
    {
      store,
      client: money.client,
      catalog,
      driver: createFakeDriver(opts.steps),
      recorder: rec.recorder,
      commit: rec.commit,
      call: call as never,
      ...(opts.readMissionBrief ? { readMissionBrief: opts.readMissionBrief } : {}),
      ...(opts.reviewCall ? { reviewCall: opts.reviewCall as never } : {}),
      ...(opts.understanding
        ? {
            plannerModel: (async ({ tool }: { tool: { name: string } }) =>
              tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(opts.understanding)), costUsd: 0.001 } : null) as never,
          }
        : {}),
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
      resolveAccess: async () => NOT_ADMIN,
      notify: async () => undefined,
      log: (l) => logs.push(l),
    },
    m,
  );
  const mission = store.missions.get(m.id)!;
  const events = store.events.filter((e) => e.mission_id === m.id);
  const calls = await store.listCalls(m.id);
  return { mission, store, events, calls, money, call, logs };
}

describe("DT-20261119-15d (ORDER 08 LLM-First): No Brief on Planner-On + Planner-Driven Discovery + Recovery", () => {
  it("Must-pass 1 (Case 1, llm_planner_v1=true, NO brief): chat stores no brief -> worker r.understanding drives company_people discovery -> 2x1 card", async () => {
    const req = "عايز شركتين برمجيات في مصر ومدير كل شركة";
    const db: any = createMemoryDb();
    db.seed("conversations", [{ id: "conv_15d_v2", user_id: USER_ID, title: "شركات برمجيات", status: "active" }]);
    db.seed("credit_ledger", [{ user_id: USER_ID, delta: 5000 }]);
    for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
    db.seed("agent_settings", [
      { key: LLM_PLANNER_SETTING_KEY, value: true },
      { key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: true },
      { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER_ID] } },
    ]);
    db.seed("messages", [
      { id: "u1", conversation_id: "conv_15d_v2", user_id: USER_ID, role: "user", content_ar: req, request_status: "planning", created_at: "2026-11-20T09:00:00Z" },
      { id: "a1", conversation_id: "conv_15d_v2", user_id: USER_ID, role: "assistant", content_ar: "…", created_at: "2026-11-20T09:00:01Z" },
    ]);

    setChatModelForTesting(async () => ({
      ok: true,
      text: JSON.stringify({ type: "data_request", reason: "case1", reply: "", count: null }),
      usage: { inputTokens: 800, outputTokens: 80 },
    }));

    const turnRes = await agentChatTurn({
      sb: db,
      userId: USER_ID,
      conversationId: "conv_15d_v2",
      userMsgId: "u1",
      assistantMsgId: "a1",
      message: req,
      conversationTitle: "شركات برمجيات",
    });
    expect(turnRes.ok).toBe(true);
    const assistantMsg = db.rows("messages").find((m: any) => m.id === "a1");
    expect(storedBriefOf(assistantMsg?.plan), "llm_planner_v1=true must skip chat researchBrief").toBeNull();

    // Replay in worker with ZERO brief (readMissionBrief spy must NOT be called; single planner understanding call drives discovery).
    const readBriefSpy = vi.fn(async () => null);
    const badProp = {
      summary_ar: "خطتين",
      stages: [{ key: "bad", title_ar: "شركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم" }], measured_by: ["call_0001"], yield_from: "out_0001" }],
    };
    const res = await runReplay({
      id: "msn_case1_15d_v2",
      requestText: req,
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      readMissionBrief: readBriefSpy,
      understanding: {
        decision: "plan",
        understanding_ar: "شركتين برمجيات في مصر ومدير كل شركة.",
        accepts_available: false,
        companies_count: 2,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 2, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCloudSoft5, 0.0002);
        return tregResult({
          employees: [
            {
              companyName: "CloudSoft5",
              companyID: "aviato_cs5",
              linkedinNumID: 18125389,
              positionList: [{ title: "CEO", startDate: "2021-01-01", seniorityScore: 9 }],
              person: {
                fullName: "Khaled Mansour",
                location: "Cairo, Egypt",
                URLs: { linkedin: "https://linkedin.com/in/khaled" },
              },
            },
          ],
        }, 0.005);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "cloudsoft5.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
      ],
    });

    expect(readBriefSpy).not.toHaveBeenCalled();
    expect(res.logs.some((l) => l.includes("capability_discovery") && l.includes("company_people:"))).toBe(true);
    expect(res.mission.status, `logs=${res.logs.join(" | ")}`).toBe("plan_ready");
    const plan = res.mission.plan as PricedPlan;
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(2);
    expect(plan.stages.find((s) => s.key === "company_people")).toMatchObject({ parent_key: "companies", per_parent_rows: 1, planned_rows: 2 });
  }, 30_000);

  it("Must-pass 1B (Rollback parity): llm_planner_v1=false still uses legacy stored brief without breaking", async () => {
    const req = "عايز شركتين برمجيات في مصر ومدير كل شركة";
    const brief = validatedBrief(
      {
        request: req,
        count: 2,
        objectives: [
          { id: "o1", operation: "companies.discover" },
          { id: "o2", operation: "people.discover", parent: "o1" },
        ],
      },
      [req],
    );
    const res = await runReplay({
      id: "msn_rollback_15d_v2",
      requestText: req,
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: false },
      readMissionBrief: async () => brief,
      callHandler: async () => tregResult(tombaCloudSoft5, 0.0002),
      steps: [{ tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } }],
    });
    expect(res.logs.some((l) => l.includes("capability_discovery") && l.includes("company_people:"))).toBe(true);
  });

  it("Must-pass 2 (Case 2, NO brief): 10x1 card + seniorityScore + 6016-char uncertain title (0 extra calls + 'ملاحظة') + Intern counter-cases", async () => {
    const req = "عايز 100 شركة ومدير كل شركة بالإيميل والتليفون";
    const ans = "مصر - شركات برمجيات - نبدأ بـ 10";
    const badProp = {
      summary_ar: "خطة",
      stages: [{ key: "bad", title_ar: "شركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 10, deliver: true, columns: [{ key: "name", title_ar: "اسم" }], measured_by: ["call_0001"], yield_from: "out_0001" }],
    };
    const steps: Parameters<typeof createFakeDriver>[0] = [
      { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
      { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
      { tool: "propose_plan", args: badProp },
      { tool: "propose_plan", args: badProp },
      { tool: "propose_plan", args: badProp },
      { tool: "propose_plan", args: badProp },
    ];
    const understanding = {
      decision: "plan",
      understanding_ar: "عشر شركات برمجيات في مصر ومدير كل شركة مع الإيميل والتليفون.",
      accepts_available: false,
      companies_count: 10,
      steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
      people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: ["email", "phone"] },
    };

    const aviatoEmployee = (fullName: string, title: string, extraPos: Record<string, unknown> = {}) => ({
      employees: [
        {
          companyName: "CarLog",
          companyID: "aviato_carlog",
          linkedinNumID: 357338,
          positionList: [{ title, startDate: "2020-01-01", ...extraPos }],
          person: {
            fullName,
            email: `${fullName.toLowerCase().replace(/\s+/g, ".")}@carlog.com`,
            location: "Cairo, Egypt",
            URLs: { linkedin: `linkedin.com/in/${fullName.toLowerCase().replace(/\s+/g, "-")}` },
          },
        },
      ],
    });

    // 2a: seniorityScore on non-keyword title ("Principal Architect") -> 10x1 plan_ready, zero role_mismatch
    const rScore = await runReplay({
      id: "msn_case2_score_v2",
      requestText: req,
      answerText: ans,
      understanding,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        return tregResult(aviatoEmployee("Karim Nabil", "Principal Architect", { seniorityScore: 7 }), 0.005);
      },
      steps,
    });
    expect(rScore.mission.status).toBe("plan_ready");
    expect(rScore.logs.some((l) => l.includes("capability_discovery") && l.includes("company_people:"))).toBe(true);
    expect((rScore.mission.plan as PricedPlan).stages.find((s) => s.key === "company_people")).toMatchObject({ planned_rows: 10, per_parent_rows: 1 });
    expect(rScore.events.some((e) => e.counts && "issue_rec_role_mismatch" in e.counts)).toBe(false);

    // 2b: uncertain long title (6,016 chars) makes ZERO extra model calls + honest "ملاحظة"
    const chatModelSpy = vi.fn(async () => ({ ok: true as const, text: "{}", usage: { inputTokens: 1, outputTokens: 1 } }));
    const reviewSpy = vi.fn(async () => ({ text: "{}", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    setChatModelForTesting(chatModelSpy as never);
    const longUncertainTitle = `Special Envoy ${"x".repeat(6002)}`;
    expect(longUncertainTitle.length).toBe(6016);
    const rLongUncertain = await runReplay({
      id: "msn_case2_long_uncertain_v2",
      requestText: req,
      answerText: ans,
      understanding,
      reviewCall: reviewSpy,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        return tregResult(aviatoEmployee("Hossam Zaki", longUncertainTitle), 0.005);
      },
      steps,
    });
    expect(rLongUncertain.mission.status).toBe("plan_ready");
    expect(reviewSpy).not.toHaveBeenCalled();
    expect(chatModelSpy).not.toHaveBeenCalled();
    const longStage = (rLongUncertain.mission.plan as PricedPlan).stages.find((s) => s.key === "company_people")!;
    expect(longStage.columns.some((c) => c.key === "notes" && c.title_ar === "ملاحظة")).toBe(true);
    const longMapped = JSON.parse((await rLongUncertain.store.getFile("msn_case2_long_uncertain_v2", "out/out_0001.json"))!) as Array<Record<string, unknown>>;
    expect(String(longMapped[0]?.notes ?? "")).toContain("أقرب شخص متاح");
    setChatModelForTesting(null);

    // 2c Counter-case: explicit non-senior ("Intern") after answer -> note "ليس إداريًا"; Intern + CEO -> CEO ranks first
    const rInternAfterAnswer = await runReplay({
      id: "msn_case2_intern_after_v2",
      requestText: req,
      answerText: ans,
      understanding,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        return tregResult(aviatoEmployee("Ali Intern", "Intern"), 0.005);
      },
      steps,
    });
    expect(rInternAfterAnswer.mission.status).toBe("plan_ready");
    const internStage = (rInternAfterAnswer.mission.plan as PricedPlan).stages.find((s) => s.key === "company_people")!;
    expect(internStage.title_ar).not.toBe("مدير كل شركة");
    expect(internStage.columns.some((c) => c.key === "notes")).toBe(true);
    const internMapped = JSON.parse((await rInternAfterAnswer.store.getFile("msn_case2_intern_after_v2", "out/out_0001.json"))!) as Array<Record<string, unknown>>;
    expect(String(internMapped[0]?.notes ?? "")).toContain("ليس إداريًا");

    const rMixedSort = await runReplay({
      id: "msn_case2_mixed_sort_v2",
      requestText: req,
      answerText: ans,
      understanding,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        return tregResult({
          employees: [
            ...aviatoEmployee("Ali Intern", "Intern").employees,
            ...aviatoEmployee("Noura CEO", "CEO").employees,
          ],
        }, 0.005);
      },
      steps,
    });
    expect(rMixedSort.mission.status).toBe("plan_ready");
    const mixedMapped = JSON.parse((await rMixedSort.store.getFile("msn_case2_mixed_sort_v2", "out/out_0001.json"))!) as Array<Record<string, unknown>>;
    expect(mixedMapped[0]?.full_name).toBe("Noura CEO");
    expect(mixedMapped[0]?.notes).toBe("");
    expect(mixedMapped[1]?.full_name).toBe("Ali Intern");
    expect(String(mixedMapped[1]?.notes ?? "")).toContain("ليس إداريًا");

    // 2d Counter-case: Intern alone on FIRST pass (no prior answer) -> asks clarifying question
    const rInternFirstPass = await runReplay({
      id: "msn_case2_intern_first_v2",
      requestText: "عايز 10 شركات برمجيات في مصر ومدير كل شركة",
      answerText: null,
      understanding,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        return tregResult(aviatoEmployee("Ali Intern", "Intern"), 0.005);
      },
      steps: steps.slice(0, 2),
    });
    expect(rInternFirstPass.mission.status).toBe("needs_input");
    expect(rInternFirstPass.mission.question_ar).toMatch(/المسمى/);
  }, 30_000);

  it("Must-pass 3 (NO brief: Plain Arabic question + 'نحاول تاني' retry + 'نكمّل بالشركات بس' + honest end): never shows 'حد من جانبنا'", async () => {
    const req = "عايز 100 شركة ومدير كل شركة";
    const understanding = {
      decision: "plan",
      understanding_ar: "شركات برمجيات في مصر ومدير كل شركة.",
      accepts_available: false,
      companies_count: 10,
      steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
      people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: [] },
    };

    // 3a: First pass hits failing/ineligible people -> asks PLAIN_Q_AR
    const rQuestion = await runReplay({
      id: "msn_15d_v2_plain_q",
      requestText: req,
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      understanding,
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCarLog, 0.0002);
        if (o.endpointId === "aviato.companies.employees") return { ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false };
        return tregResult({ results: [{ full_name: "Youssef Mostafa", headline: "General Manager", linkedin_url: "https://www.linkedin.com/in/youssef-mostafa-carlog" }] }, 0.0005);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://www.linkedin.com/company/carlog.com", max_results: 1 }, why: "people", skip: allSkip } },
      ],
    });
    expect(rQuestion.mission.status).toBe("needs_input");
    expect(rQuestion.mission.question_ar).toBe(PLAIN_Q_AR);
    expect(rQuestion.mission.question_ar).not.toMatch(/خطة الاستخراج المعتمدة|مصادر بيانات|internal|capability/);
    expect((rQuestion.mission.plan_public as any)?.question_options).toEqual([...PLAIN_OPTS_AR]);

    // 3b: "نحاول تاني" -> retries untried eligible source -> 2-stage plan_ready
    const rRetrySuccess = await runReplay({
      id: "msn_15d_v2_retry_ok",
      requestText: req,
      answerText: "نحاول تاني",
      questionAr: PLAIN_Q_AR,
      peopleRecoveryAsked: true,
      understanding,
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: false, data: null, httpStatus: 404 },
      ],
      callHandler: async (o) => {
        if (o.endpointId === "leadmagic.x.employee-finder") {
          return tregResult({
            data: [
              {
                first_name: "Tarek",
                last_name: "El-Masry",
                full_name: "Tarek El-Masry",
                title: "CEO",
                website: "carlog.com",
                company_name: "CarLog",
                profile_url: "https://www.linkedin.com/in/tarek-carlog",
              },
            ],
          }, 0.005);
        }
        return { ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false };
      },
      steps: [],
    });
    expect(rRetrySuccess.call.mock.calls.some(([o]) => o.endpointId === "leadmagic.x.employee-finder")).toBe(true);
    expect(rRetrySuccess.mission.status, `logs=${rRetrySuccess.logs.join(" | ")}`).toBe("plan_ready");
    const retryPlan = rRetrySuccess.mission.plan as PricedPlan;
    expect(retryPlan.stages.some((s) => s.key === "company_people" && s.endpoint_id === "leadmagic.x.employee-finder")).toBe(true);
    expect(verifyApprovedScope(retryPlan, catalog).ok).toBe(true);

    // 3c: "نحاول تاني" when all remaining people fail + saved companies exist -> honest companies-only plan_ready
    const rRetryCompaniesOnly = await runReplay({
      id: "msn_15d_v2_retry_fallback_co",
      requestText: req,
      answerText: "نحاول تاني",
      questionAr: PLAIN_Q_AR,
      peopleRecoveryAsked: true,
      understanding,
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: false, data: null, httpStatus: 404 },
      ],
      callHandler: async () => ({ ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false }),
      steps: [],
    });
    expect(rRetryCompaniesOnly.mission.status, `logs=${rRetryCompaniesOnly.logs.join(" | ")}`).toBe("plan_ready");
    const coFallbackPlan = rRetryCompaniesOnly.mission.plan as PricedPlan;
    expect(coFallbackPlan.stages).toHaveLength(1);
    expect(coFallbackPlan.stages[0].key).toBe("companies");
    expect((customerPlanView(coFallbackPlan).assumptions_ar ?? []).join(" ")).toContain("جُرّبت");

    // 3d: "نحاول تاني" with NO usable companies -> honest unserved (NEVER "حد من جانبنا")
    const rRetryNoData = await runReplay({
      id: "msn_15d_v2_retry_nodata",
      requestText: req,
      answerText: "نحاول تاني",
      questionAr: PLAIN_Q_AR,
      peopleRecoveryAsked: true,
      understanding,
      callHandler: async () => ({ ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false }),
      steps: [],
    });
    expect(rRetryNoData.mission.status).toBe("unserved");
    expect(rRetryNoData.mission.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
    expect(rRetryNoData.mission.summary_ar ?? "").not.toContain("حد من جانبنا");

    // 3e: "نكمّل بالشركات بس" -> clean companies-only plan_ready
    const rCompaniesOnly = await runReplay({
      id: "msn_15d_v2_companies_only",
      requestText: req,
      answerText: "نكمّل بالشركات بس",
      questionAr: PLAIN_Q_AR,
      peopleRecoveryAsked: true,
      understanding,
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
      ],
      callHandler: async () => ({ ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false }),
      steps: [],
    });
    expect(rCompaniesOnly.mission.status).toBe("plan_ready");
    const chosenCoPlan = rCompaniesOnly.mission.plan as PricedPlan;
    expect(chosenCoPlan.stages).toHaveLength(1);
    expect(chosenCoPlan.stages[0].key).toBe("companies");
    expect(verifyApprovedScope(chosenCoPlan, catalog).ok).toBe(true);

    // 3f (ORDER 09): Exact label equality only — no synonym/word-list regex; free text goes to LLM planner
    expect(PLAIN_PEOPLE_FALLBACK_QUESTION_AR).toBe(PLAIN_Q_AR);
    expect(COMPANIES_ONLY_OPTION_LABELS.has(PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[0])).toBe(true);
    expect(PEOPLE_RETRY_OPTION_LABELS.has(PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[1])).toBe(true);
    expect(isCompaniesOnlyChoice(PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[0])).toBe(true);
    expect(isCompaniesOnlyChoice(`  ${PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[0]}  `)).toBe(true);
    expect(isCompaniesOnlyChoice("الاستمرار بالشركات فقط")).toBe(true);
    expect(isPeopleRetryChoice(PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[1])).toBe(true);
    expect(isPeopleRetryChoice(`  ${PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[1]}  `)).toBe(true);
    expect(isPeopleRetryChoice("إعادة المحاولة بمصدر آخر")).toBe(true);
    // Free-text phrasings/synonyms must return false for both (LLM planner decides)
    expect(isCompaniesOnlyChoice("لا خلاص الشركات بس كفاية")).toBe(false);
    expect(isPeopleRetryChoice("لا خلاص الشركات بس كفاية")).toBe(false);
    expect(isCompaniesOnlyChoice("نكمل بالشركات بس")).toBe(false);
    expect(isCompaniesOnlyChoice("الشركات بس")).toBe(false);
    expect(isPeopleRetryChoice("إعادة المحاولة")).toBe(false);
  }, 30_000);

  it("Must-pass 4 (Zero new model calls + companies-only control): planner-on path makes zero brief/decideTurn calls and equals control spend", async () => {
    const req = "عايز 100 شركة ومدير كل شركة بالإيميل والتليفون";
    const ans = "مصر - شركات برمجيات - نبدأ بـ 10";
    const step = { tool: "treg_call" as const, args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } };
    const callHandler = async () => tregResult(tombaCarLog, 0.0002);

    const chatSpy = vi.fn(async () => ({ ok: true as const, text: "{}", usage: { inputTokens: 800, outputTokens: 150 } }));
    const readBriefSpy = vi.fn(async () => null);
    setChatModelForTesting(chatSpy as never);

    const understandingWithPeople = {
      decision: "plan",
      understanding_ar: "عشر شركات برمجيات في مصر ومدير كل شركة.",
      accepts_available: false,
      companies_count: 10,
      steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
      people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: ["email", "phone"] },
    };

    const controlWithoutBriefDep = await runReplay({
      id: "msn_15d_v2_ctrl",
      requestText: req,
      answerText: ans,
      questionAr: "الدولة والتخصص؟",
      understanding: understandingWithPeople,
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      callHandler,
      steps: [step],
    });
    const plannerWithSpy = await runReplay({
      id: "msn_15d_v2_spy",
      requestText: req,
      answerText: ans,
      questionAr: "الدولة والتخصص؟",
      understanding: understandingWithPeople,
      readMissionBrief: readBriefSpy,
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      callHandler,
      steps: [step],
    });
    expect(chatSpy).not.toHaveBeenCalled();
    expect(readBriefSpy).not.toHaveBeenCalled();
    expect(plannerWithSpy.logs.some((l) => l.includes("capability_discovery") && l.includes("company_people:"))).toBe(true);
    expect(plannerWithSpy.mission.planning_llm_usd).toBe(controlWithoutBriefDep.mission.planning_llm_usd);
    expect(plannerWithSpy.mission.planning_treg_usd).toBe(controlWithoutBriefDep.mission.planning_treg_usd);

    // Companies-only control unchanged: no people in r.understanding -> no company_people in discovery
    const companiesOnlyCtrl = await runReplay({
      id: "msn_15d_v2_co_ctrl",
      requestText: "عايز 10 شركات برمجيات في مصر",
      understanding: {
        decision: "plan",
        understanding_ar: "عشر شركات برمجيات في مصر.",
        accepts_available: false,
        companies_count: 10,
        steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
        people_of_companies: { asked: false, title_ar: "", per_company: null, per_company_text: "", companies_text: "", contact_kinds: [] },
      },
      callHandler,
      steps: [
        step,
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.slice(0,3).map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0001"] } },
        {
          tool: "propose_plan",
          args: {
            summary_ar: "ستحصل على 10 شركات برمجيات في مصر.",
            stages: [
              {
                key: "companies",
                title_ar: "شركات البرمجيات في مصر",
                endpoint_id: "tomba.companies.search.reveal",
                expected_rows: 10,
                parent_key: null,
                deliver: true,
                columns: [
                  { key: "name", title_ar: "اسم الشركة" },
                  { key: "industry", title_ar: "النشاط والتخصص" },
                  { key: "city", title_ar: "المدينة" },
                  { key: "country", title_ar: "الدولة" },
                  { key: "website", title_ar: "الموقع الإلكتروني" },
                  { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
                ],
                measured_by: ["call_0001"],
                yield_from: "out_0001",
              },
            ],
          },
        },
      ],
    });
    expect(companiesOnlyCtrl.logs.find((l) => l.startsWith("capability_discovery"))).not.toContain("company_people");
    expect(companiesOnlyCtrl.mission.status).toBe("plan_ready");
    expect((companiesOnlyCtrl.mission.plan as PricedPlan).stages).toHaveLength(1);
  });

  it("Must-pass 5 (Drop-people P0, NO brief): planner ON + «شركات بس من غير مديرين» delivers companies-only with 0 people rows/charge; counter-case child stage recovers people", async () => {
    const req = "عايز 10 شركات ومدير كل شركة بالإيميل والتليفون";
    const decideSpy = vi.fn(async () => ({ ok: true as const, text: "{}", usage: { inputTokens: 1, outputTokens: 1 } }));
    setChatModelForTesting(decideSpy as never);

    const dropUnderstanding = {
      decision: "plan",
      understanding_ar: "عشر شركات برمجيات في مصر فقط.",
      accepts_available: false,
      companies_count: 10,
      steps: [
        { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" },
      ],
      people_of_companies: { asked: false, title_ar: "", per_company: null, per_company_text: "", companies_text: "", contact_kinds: [] },
    };

    const aviatoSavedPage = {
      employees: [
        {
          companyName: "CarLog",
          companyID: "aviato_carlog",
          linkedinNumID: 357338,
          positionList: [{ title: "CEO", startDate: "2020-01-01", seniorityScore: 9 }],
          person: { fullName: "Sherif Nabil", location: "Cairo, Egypt", URLs: { linkedin: "linkedin.com/in/sherif-nabil-carlog" } },
        },
      ],
    };

    // 5a: Accounted planner drops people -> propose_plan([companies]) succeeds with ZERO child_step_unserved, ZERO people rows, ZERO people charge
    const rDroppedProposal = await runReplay({
      id: "msn_15d_v2_drop_prop",
      requestText: req,
      answerText: "شركات بس من غير مديرين",
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      understanding: dropUnderstanding,
      priorCalls: [
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: true, data: aviatoSavedPage },
      ],
      callHandler: async () => tregResult(tombaCarLog, 0.0002),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0002.data.companies.slice(0,3).map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0002"] } },
        {
          tool: "propose_plan",
          args: {
            summary_ar: "ستحصل على 10 شركات برمجيات في مصر بالاسم والنشاط والموقع.",
            contacts_note_ar: "اكتفى الطلب ببيانات الشركات المتاحة فقط.",
            stages: [
              {
                key: "companies",
                title_ar: "شركات البرمجيات في مصر",
                endpoint_id: "tomba.companies.search.reveal",
                expected_rows: 10,
                parent_key: null,
                deliver: true,
                columns: [
                  { key: "name", title_ar: "اسم الشركة" },
                  { key: "industry", title_ar: "النشاط والتخصص" },
                  { key: "city", title_ar: "المدينة" },
                  { key: "country", title_ar: "الدولة" },
                  { key: "website", title_ar: "الموقع الإلكتروني" },
                  { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
                ],
                measured_by: ["call_0002"],
                yield_from: "out_0001",
                relevance: { subject_ar: "شركات البرمجيات في مصر", terms: ["software", "برمجيات"], text_columns: ["name", "industry"], min_own_words: 0, review: true },
              },
            ],
          },
        },
      ],
    });
    expect(decideSpy).not.toHaveBeenCalled();
    expect(rDroppedProposal.logs.find((l) => l.startsWith("capability_discovery"))).not.toContain("company_people");
    expect(rDroppedProposal.mission.status, `logs=${rDroppedProposal.logs.join(" | ")}`).toBe("plan_ready");
    const pDrop = rDroppedProposal.mission.plan as PricedPlan;
    expect(pDrop.stages).toHaveLength(1);
    expect(pDrop.stages[0].key).toBe("companies");
    expect(pDrop.stages.some((s) => s.parent_key !== null)).toBe(false);
    expect((pDrop.contact_steps ?? []).filter((c) => c.stage_key !== "companies")).toHaveLength(0);

    // 5b: Silent SDK stop with saved people on disk when planner dropped people -> recovery MUST NOT add people stage
    const rDroppedRecovery = await runReplay({
      id: "msn_15d_v2_drop_rec",
      requestText: req,
      answerText: "شركات بس من غير مديرين",
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      understanding: dropUnderstanding,
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: true, data: aviatoSavedPage },
      ],
      callHandler: async () => tregResult(tombaCarLog, 0.0002),
      steps: [],
    });
    expect(rDroppedRecovery.mission.status).toBe("plan_ready");
    const pRecDrop = rDroppedRecovery.mission.plan as PricedPlan;
    expect(pRecDrop.stages).toHaveLength(1);
    expect(pRecDrop.stages[0].key).toBe("companies");
    expect(pRecDrop.stages.some((s) => s.parent_key !== null)).toBe(false);
    expect((pRecDrop.contact_steps ?? []).filter((c) => c.stage_key !== "companies")).toHaveLength(0);

    // 5c Counter-case: after an answer, if planner's proposal itself includes a child people stage (e.g. missing_measured_call), recovery DOES add company_people
    const rChildInProp = await runReplay({
      id: "msn_15d_v2_child_counter",
      requestText: req,
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      storeSettings: { [LLM_PLANNER_SETTING_KEY]: true },
      understanding: {
        decision: "plan",
        understanding_ar: "عشر شركات برمجيات في مصر ومدير كل شركة.",
        accepts_available: false,
        companies_count: 10,
        steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: ["email", "phone"] },
      },
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: true, data: aviatoSavedPage },
      ],
      callHandler: async () => tregResult(tombaCarLog, 0.0002),
      steps: [
        {
          tool: "propose_plan",
          args: {
            summary_ar: "خطتان",
            stages: [
              { key: "companies", title_ar: "شركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 10, deliver: true, columns: [{ key: "name", title_ar: "اسم" }], measured_by: ["call_0001"], yield_from: "out_0001" },
              { key: "company_people", title_ar: "مدير كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }], measured_by: [], yield_from: "out_0002" },
            ],
          },
        },
      ],
    });
    expect(rChildInProp.mission.status).toBe("plan_ready");
    expect((rChildInProp.mission.plan as PricedPlan).stages.some((s) => s.key === "company_people")).toBe(true);
  }, 30_000);

  it("Must-pass 6 (ORDER 10 فزاع P0): capability_discovery_v1 OFF + companies-only choice NEVER prices/holds a proposed people stage", async () => {
    const req = "عايز 10 شركات برمجيات في مصر ومدير كل شركة";
    const aviatoSavedPage = {
      employees: [
        {
          companyName: "CarLog",
          companyID: "aviato_carlog",
          linkedinNumID: 357338,
          positionList: [{ title: "CEO", startDate: "2020-01-01", seniorityScore: 9 }],
          person: { fullName: "Sherif Nabil", location: "Cairo, Egypt", URLs: { linkedin: "linkedin.com/in/sherif-nabil-carlog" } },
        },
      ],
    };
    const rOffPeople = await runReplay({
      id: "msn_15d_v2_order10_disc_off",
      requestText: req,
      answerText: PLAIN_PEOPLE_FALLBACK_OPTIONS_AR[0],
      questionAr: PLAIN_Q_AR,
      peopleRecoveryAsked: true,
      storeSettings: {
        [CAPABILITY_DISCOVERY_FLAG_KEY]: false,
        [LLM_PLANNER_SETTING_KEY]: true,
      },
      understanding: {
        decision: "plan",
        understanding_ar: "شركات برمجيات في مصر.",
        accepts_available: false,
        companies_count: 10,
        steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: null, deliver: true, count: { total: 10, per_parent: null, all: false }, source: null, topic: "software", search_terms: ["software", "Egypt"], period: null, country: "EG" }],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: [] },
      },
      priorCalls: [
        { endpointId: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, ok: true, data: tombaCarLog },
        { endpointId: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, ok: true, data: aviatoSavedPage },
      ],
      callHandler: async () => tregResult(tombaCarLog, 0.0002),
      steps: [
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url, linkedin: c.linkedin_url }))", files: ["call_0001"] } },
        { tool: "run_code", args: { code: "return inputs.call_0002.employees.map(e => ({ id: e.person.URLs.linkedin, full_name: e.person.fullName, job_title: e.positionList[0].title, company: e.companyName, linkedin: e.person.URLs.linkedin }))", files: ["call_0002"] } },
        {
          tool: "propose_plan",
          args: {
            summary_ar: "ستحصل على 10 شركات ومدير كل شركة.",
            stages: [
              {
                key: "companies",
                title_ar: "شركات البرمجيات في مصر",
                endpoint_id: "tomba.companies.search.reveal",
                expected_rows: 10,
                parent_key: null,
                deliver: true,
                columns: [
                  { key: "name", title_ar: "اسم الشركة" },
                  { key: "industry", title_ar: "النشاط والتخصص" },
                  { key: "city", title_ar: "المدينة" },
                  { key: "country", title_ar: "الدولة" },
                  { key: "website", title_ar: "الموقع الإلكتروني" },
                  { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
                ],
                measured_by: ["call_0001"],
                yield_from: "out_0001",
                relevance: { subject_ar: "شركات البرمجيات في مصر", terms: ["software", "برمجيات"], text_columns: ["name", "industry"], min_own_words: 0, review: true },
              },
              {
                key: "company_people",
                title_ar: "مدير كل شركة",
                endpoint_id: "aviato.companies.employees",
                expected_rows: 10,
                parent_key: "companies",
                per_parent_rows: 1,
                deliver: true,
                columns: [
                  { key: "full_name", title_ar: "الاسم الكامل" },
                  { key: "job_title", title_ar: "المسمى الوظيفي" },
                  { key: "company", title_ar: "الشركة" },
                  { key: "linkedin", title_ar: "صفحة الشخص" },
                ],
                measured_by: ["call_0002"],
                yield_from: "out_0002",
              },
            ],
          },
        },
      ],
    });
    expect(rOffPeople.mission.status).toBe("plan_ready");
    const plan = rOffPeople.mission.plan as PricedPlan;
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0].key).toBe("companies");
    expect(plan.stages[0].planned_rows).toBe(10);
    expect(plan.stages.some((s) => s.parent_key !== null)).toBe(false);
    expect(plan.price.reservePoints).toBeLessThan(500);
  }, 30_000);
});
