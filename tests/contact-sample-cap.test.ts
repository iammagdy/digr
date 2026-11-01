import { describe, expect, it, vi } from "vitest";
import { replay } from "./helpers/agentReplay";
import { companiesPage, peopleOfCompany, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import { readFileSync } from "node:fs";
import { createGateway } from "../agent/src/gateway";
import { peopleAndContactAdvice } from "../src/lib/agentMission/peopleCheck";
import { CONTACT_SAMPLE_SHARE, contactFinderKind, contactSampleCapUsd, contactSampleRefusal } from "../src/lib/agentMission/contactSampling";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import type { CallRow } from "../agent/src/types";
import type { FakeStep } from "../agent/src/fakeDriver";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * THE PLANNING BUDGET IS NOT FOR CONTACT FINDERS. Live re-test 2026-10-31 (A1 «٥ شركات كهروميكانيكا + صناع القرار», msn_1d3c… then msn_e750…): the planning source spend was 0.0696 USD of 0.10, and 79.8% of it went to e-mail and phone FINDER samples made in the first
 * 49 seconds (one phone sample alone cost 0.0445). The customer then answered a question, the gateway forgot which stages it had sampled, every later call was refused «stage_reserved» (the people stage looked unsampled and its reserve was kept back), one more was
 * refused «over_budget», and the customer read «تعذّر تجهيز خطة… بسبب حد من جانبنا» (`planning_over_budget`). This is the platform's planning spend, not the customer's money.
 *
 * Fixed in the gateway, by code: contact-finder samples (e-mail, phone) may take at most a quarter of the planning budget, the cheapest ranked finder first, one sample per kind, never a finder whose single call costs more than that quarter; and the
 * sample state of the gateway is rebuilt from the calls the mission has recorded, so a customer's answer does not reset it.
 */
const A1_FIRST_ATTEMPT_LOG = [
  { endpoint_id: "tomba.companies.search.reveal", status: "ok", rows: 5, cost: 0.0002 },
  { endpoint_id: "anyapi.linkedin.email.work.find", status: "ok", rows: 1, cost: 0.011 },
  { endpoint_id: "tomba.people.phone.find", status: "ok", rows: 1, cost: 0.0445 },
  { endpoint_id: "tomba.companies.emails.list", status: "ok", rows: 8, cost: 0.0089 },
  { endpoint_id: "blitzapi.people.waterfall-icp", status: "ok", rows: 5, cost: 0.005 },
] as const;

function recordedRows(missionId: string): CallRow[] {
  return A1_FIRST_ATTEMPT_LOG.map((c, i) => ({
    id: `${missionId}:call_${String(i + 1).padStart(4, "0")}`, mission_id: missionId, phase: "planning", endpoint_id: c.endpoint_id, params_digest: { domain: "orascom-em.com.eg" }, status: c.status, refused_reason: null, http_status: 200,
    rows_returned: c.rows, cost_usd: c.cost, estimate_usd: c.cost, provider_cost_id: null, storage_path: null, duration_ms: 900, created_at: new Date(Date.parse("2026-10-31T19:25:40Z") + i * 9_000).toISOString(),
  }) as unknown as CallRow);
}

describe("A1 replay: the planning that followed the customer's answer, with the call log of the first run (0.0696 USD spent, a 0.0445 phone sample among it)", () => {
  /** What the live planner did after the answer: it samples the companies and the people again, a company-people source dearer than the whole budget is refused, then it proposes the plan. */
  const steps: FakeStep[] = planFlow().flatMap((s, i, all) => (i === all.length - 1 ? [{ tool: "treg_call", args: { endpoint_id: "anyapi.linkedin.company.people", params: { company: "orascom-em" }, why: "the live planner tried this source before the plan" } } as FakeStep, s] : [s]))
    .concat([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة." } } as FakeStep]);

  it("a valid plan is proposed: no call is refused for a reserve of a stage that was already sampled, and planning does not end in «planning_over_budget»", async () => {
    let store: ReturnType<typeof createMemoryStore> | null = null;
    let missionId = "";
    let thrown: unknown;
    let r: Awaited<ReturnType<typeof replay>> | null = null;
    try {
      r = await replay({
        request,
        planning: steps,
        execution: () => [],
        answers: [tregResult(companiesPage, 0.0005), tregResult(peopleOfCompany("orascom-em"), 0.0005), tregResult(companiesPage, 0.0005), ...Array.from({ length: 12 }, () => tregResult({ results: [] }, 0.0005))],
        deps: (base) => {
          store = base.store as ReturnType<typeof createMemoryStore>;
          missionId = [...(base.store as ReturnType<typeof createMemoryStore>).missions.keys()][0];
          for (const row of recordedRows(missionId)) void base.store.addCall(row);
          return base;
        },
      });
    } catch (e) { thrown = e; }
    const mission = store && missionId ? (store as ReturnType<typeof createMemoryStore>).missions.get(missionId) : null;
    const recorded = store && missionId ? (await (store as ReturnType<typeof createMemoryStore>).listCalls(missionId)).filter((c) => c.status === "refused").map((c) => String(c.refused_reason)) : [];
    expect(thrown === undefined, `planning ended with status ${mission?.status}, error ${String(mission?.error)}; refused calls: ${recorded.join(", ")}; ${String((thrown as Error | undefined)?.message ?? "").slice(0, 900)}`).toBe(true);
    expect(String(mission?.error ?? "")).not.toContain("planning_over_budget");
    expect(r!.plannedPlan.stages.map((s) => s.key)).toEqual(["companies", "people"]);
    // the calls that were refused in this run: the one dearer than the whole budget, and nothing for a stage reserve
    const calls = await r!.store.listCalls(r!.missionId);
    const refused = calls.filter((c) => c.status === "refused").map((c) => String(c.refused_reason).split(":")[0]);
    expect(refused).not.toContain("stage_reserved");
    expect(refused).toContain("over_budget");
  });
});

// ------------------------------------------------------------------------------------------------------------------ the gateway itself
const catalog: any = loadTregCatalog();
function gatewayOf(options: { budgetUsd?: number; stages?: number; prior?: CallRow[]; answers?: number } = {}) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_cap", user_id: USER_ID, request_text: request, status: "planning" });
  store.missions.set(mission.id, mission);
  const prior = options.prior ?? [];
  for (const row of prior) void store.addCall({ ...row, mission_id: mission.id });
  const { recorder, commit } = fakeRecorder({});
  const call = vi.fn(async () => tregResult({ results: [{ email: "x@orascom-em.com.eg", phone: "+201001234567" }] }, 0.001));
  const budgetUsd = options.budgetUsd ?? 0.1;
  const budget = createJobCallBudget({ ceilingUsd: budgetUsd, spentUsd: prior.reduce((n, c) => n + Number(c.cost_usd ?? 0), 0) });
  const client: any = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
  const gateway = createGateway({
    store, client, missionId: mission.id, userId: USER_ID, jobId: null, phase: "planning", access: NOT_ADMIN, catalog, budget, recorder, commit, call: call as any, defaultPurpose: request, counter: { seq: prior.length },
    stageBudget: { stages: options.stages ?? 2, budgetUsd },
    priorCalls: prior,
  } as any);
  return { gateway, call, store };
}
const requiredParams = (id: string): Record<string, unknown> => Object.fromEntries(catalog.byId.get(id).inputs.filter((i: any) => i.required).map((i: any) => [i.name, i.type === "number" || i.type === "integer" ? 5 : "orascom-em.com.eg"]));
const ask = (g: ReturnType<typeof gatewayOf>, id: string) => g.gateway.tregCall({ endpoint_id: id, params: { ...requiredParams(id), email: "karim@orascom-em.com.eg", domain: "orascom-em.com.eg", linkedin: "https://www.linkedin.example/in/karim" }, why: "the contact sample under test" });

describe("contact-finder samples are capped, cheapest first, one per kind", () => {
  it("a phone finder whose single call costs more than a quarter of the planning budget is never sampled (0.0445 against 0.025), and the answer says the cells are filled only if found in the approved job", async () => {
    const g = gatewayOf();
    const r: any = await ask(g, "tomba.people.phone.find");
    expect(r).toMatchObject({ ok: false, refused: "contact_sample" });
    expect(r.message).toMatch(/approved job/);
    expect(g.call).not.toHaveBeenCalled();
  });

  it("the cheapest ranked finder of a kind is the one sampled first: a dearer finder that is still inside the cap is refused and the answer names the cheapest", async () => {
    const g = gatewayOf();
    const refused: any = await ask(g, "anyapi.linkedin.email.work.find");
    expect(refused).toMatchObject({ ok: false, refused: "contact_sample" });
    const cheapest = String(refused.message).match(/first: (\S+)/)?.[1];
    expect(cheapest).toBeTruthy();
    expect(cheapest).not.toBe("anyapi.linkedin.email.work.find");
    expect(g.call).not.toHaveBeenCalled();
    expect(await ask(g, cheapest!)).toMatchObject({ ok: true });
    expect(g.call).toHaveBeenCalledTimes(1);
  });

  it("one sample per kind: after the e-mail finder was sampled a second e-mail finder is refused, and the phone kind is still open", async () => {
    const g = gatewayOf();
    const cheapestEmail = String(((await ask(g, "anyapi.linkedin.email.work.find")) as any).message).match(/first: (\S+)/)![1];
    expect(await ask(g, cheapestEmail)).toMatchObject({ ok: true });
    expect(await ask(g, "tomba.people.email.find")).toMatchObject({ ok: false, refused: "contact_sample" });
    expect(g.call).toHaveBeenCalledTimes(1);
    const cheapestPhone = String(((await ask(g, "quickenrich.people.phone.find")) as any).message).match(/first: (\S+)/)![1];
    expect(await ask(g, cheapestPhone)).toMatchObject({ ok: true });
    expect(g.call).toHaveBeenCalledTimes(2);
  });

  it("the sample state is rebuilt from the recorded calls: a kind sampled before the customer's answer is not sampled again, and a stage sampled before it is not kept back", async () => {
    const g = gatewayOf({ prior: recordedRows("msn_cap") });
    // the e-mail and phone kinds were sampled in the first run (a finder was called: that is a sample, whatever it gave)
    expect(await ask(g, "blitzapi.people.email.find")).toMatchObject({ ok: false, refused: "contact_sample" });
    expect(await ask(g, "blitzapi.people.phone.find")).toMatchObject({ ok: false, refused: "contact_sample" });
    // the people stage and the companies stage were sampled in the first run: their next call is not refused for «a stage not sampled yet»
    const people: any = await g.gateway.tregCall({ endpoint_id: "blitzapi.people.waterfall-icp", params: { company_linkedin_url: "https://linkedin.example/company/nile-em", cascade: [{ include_title: ["Chief Executive Officer"] }], max_results: 5 }, why: "the people stage, again" });
    expect(people.refused).not.toBe("stage_reserved");
    expect(people.ok).toBe(true);
  });
});

describe("what the planner is told matches what the gateway enforces", () => {
  const prompt = readFileSync(new URL("../agent/prompts/system.md", import.meta.url), "utf8");
  it("the system prompt no longer asks for two phone finder samples: one sample per kind, the cheapest ranked, within a quarter of the planning budget; the finder step is added by code (owner direction 2026-11-01, was: cells filled only if found)", () => {
    expect(prompt).not.toMatch(/sample at least two phone finders/i);
    expect(prompt).toMatch(/one sample per kind/i);
    expect(prompt).toMatch(/quarter of the planning budget/i);
    expect(prompt).toMatch(/FINDER STEPS ARE ADDED BY CODE/);
  });
  // CHANGED (owner direction 2026-11-01): a delivered people stage gets its phone finder step by code, so the plan check no longer sends the planner back about phones
  it("the plan check does not send the planner back about phones when a delivered people stage is there: the phone finder step is added by code", () => {
    const plan = { stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: "tomba.companies.search.reveal", parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }] }, { key: "people", title_ar: "الأشخاص", endpoint_id: "blitzapi.people.waterfall-icp", parent_key: "companies", deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }] }] };
    const issues = peopleAndContactAdvice({
      plan, requestText: request, capabilityOf: (id: string) => (id.includes("waterfall") ? "people.search" : "companies.search"), peopleSources: ["blitzapi.people.waterfall-icp"], phoneSources: ["blitzapi.people.phone.find", "quickenrich.people.phone.find"],
      calls: new Map([["blitzapi.people.waterfall-icp", { rows: 5 }]]),
    } as never);
    expect(issues).toEqual([]);
  });
  it("one phone finder tried (or refused by the gateway) is enough: the plan is accepted with or without a sentence about it (the finder step is added by code)", () => {
    const plan = (assumptions: string[]) => ({ assumptions_ar: assumptions, stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: "tomba.companies.search.reveal", parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }] }, { key: "people", title_ar: "الأشخاص", endpoint_id: "blitzapi.people.waterfall-icp", parent_key: "companies", deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }] }] });
    const advice = (assumptions: string[]) => peopleAndContactAdvice({
      plan: plan(assumptions), requestText: request, capabilityOf: (id: string) => (id.includes("waterfall") ? "people.search" : "companies.search"), peopleSources: ["blitzapi.people.waterfall-icp"], phoneSources: ["blitzapi.people.phone.find", "quickenrich.people.phone.find"],
      calls: new Map([["blitzapi.people.waterfall-icp", { rows: 5 }], ["tomba.people.phone.find", { rows: 0 }], ["blitzapi.people.phone.find", { rows: 0 }]]),
    } as never);
    expect(advice(["أرقام التليفون تُضاف فقط إذا وُجدت أثناء تنفيذ المهمة المعتمدة."])).toEqual([]);
    expect(advice([])).toEqual([]);
  });
});

describe("the sampling rule, pure", () => {
  it("the kind of a source comes from its capability; a lister, a people source and a verifier are not finders", () => {
    expect(contactFinderKind("people.email.find")).toBe("email");
    expect(contactFinderKind("people.email.find.personal")).toBe("email");
    expect(contactFinderKind("people.phone.find")).toBe("phone");
    for (const c of ["companies.emails.list", "people.search", "people.email.verify", "people.phone.verify", "companies.search", null, undefined, ""]) expect(contactFinderKind(c as never)).toBeNull();
  });
  it("the cap is a quarter of the planning budget", () => {
    expect(CONTACT_SAMPLE_SHARE).toBe(0.25);
    expect(contactSampleCapUsd(0.1)).toBe(0.025);
    expect(contactSampleCapUsd(0.2)).toBe(0.05);
    expect(contactSampleCapUsd(null)).toBeNull();
    expect(contactSampleCapUsd(0)).toBeNull();
  });
  const base = { kind: "phone" as const, estimateUsd: 0.005, capUsd: 0.025, sampledKinds: new Set<"email" | "phone">(), spentOnContactUsd: 0, endpointId: "a", cheapestId: "a" };
  it("the order of reasons: kind sampled, too dear, quarter spent, cheaper first; none when the sample fits", () => {
    expect(contactSampleRefusal(base)).toBeNull();
    expect(contactSampleRefusal({ ...base, sampledKinds: new Set(["phone"]), estimateUsd: 1 })).toBe("kind_sampled");
    expect(contactSampleRefusal({ ...base, estimateUsd: 0.0445 })).toBe("too_dear");
    expect(contactSampleRefusal({ ...base, estimateUsd: 0.02, spentOnContactUsd: 0.01 })).toBe("over_cap");
    expect(contactSampleRefusal({ ...base, cheapestId: "b" })).toBe("cheapest_first");
    expect(contactSampleRefusal({ ...base, cheapestId: null })).toBeNull();
    expect(contactSampleRefusal({ ...base, capUsd: null, estimateUsd: 5 })).toBeNull();
  });
  it("a sample exactly at the cap is allowed", () => {
    expect(contactSampleRefusal({ ...base, estimateUsd: 0.025 })).toBeNull();
  });
});
