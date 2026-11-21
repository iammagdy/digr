import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PEOPLE_OF_COMPANY_CAPABILITIES, understoodPeopleOf } from "../src/lib/agentMission/childSources";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { planWithLlm, understandRequest, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { DECIDE_IT_AR_EN, UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { roleEnded } from "../src/lib/agentMission/roles";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, columnsOf, linkedinOf, why } from "./helpers/a1World";
import { callIds } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { dispatcher, PHONES, SECTOR_WORLD } from "./helpers/g1World";
import type { Results } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";

beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
afterEach(() => vi.unstubAllEnvs());

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * DT-20261119-04 (live after #580, chat 5eb4c9aa…; BUG HUNTER's RCA5): the first planner answer was a refused sensitivity «ask» (people of the companies asked, personal phones); the no-ask retry planned companies only and its answer REPLACED the
 * first one, so the people structure was lost: the old path got no understanding of the people, and the card promised companies and company phones with no people stage and no unserved block. The customer must get what was asked or an honest
 * «خطوة لم تُضَف إلى الخطة» block, never a silent swap. The model is scripted: these tests prove what CODE does with its two answers.
 */
const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const PEOPLE_CAP = [...PEOPLE_OF_COMPANY_CAPABILITIES].sort().find((c) => capabilitiesOf(catalog, NOT_ADMIN, c.split(".")[0]).has(c))!;
const LIVE1 = "عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية";
/** The live sentence without its city: the fake provider world of these replays has no company in Riyadh (the place filter would refuse the sample; it is the people of the companies that are under test). */
const LIVE1_NO_CITY = "عايز شركتين مقاولات ومسؤولي الإدارة فيهم بأرقامهم الشخصية";
const peopleAsk = (asked: boolean, kinds: string[] = ["phone"]) => ({ asked, title_ar: asked ? "مسؤولو الإدارة" : "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: asked ? kinds : [] });
const askAnswer = (over: Record<string, unknown> = {}) => ({ decision: "ask", understanding_ar: "شركتان مقاولات في الرياض.", question_ar: "الأرقام الشخصية للمسؤولين ممكن تكون بيانات حساسة. تحب نجيب إيه بالظبط؟", options_ar: ["أسماء المسؤولين وأرقام العمل", "الشركات فقط"], accepts_available: false, steps: [], people_of_companies: peopleAsk(true), missing: [], ...over });
const companiesStep = { key: "companies", title_ar: "شركات المقاولات", platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] };
const peopleStep = { key: "pp", title_ar: "مسؤولو الإدارة", platform: PEOPLE_CAP.split(".")[0], capability: PEOPLE_CAP, parent: "companies", deliver: true, count: { per_parent: 2, all: false }, search_terms: [] };
const planAnswer = (over: Record<string, unknown> = {}) => ({ decision: "plan", understanding_ar: "شركتان مقاولات في الرياض.", accepts_available: false, missing: [], steps: [companiesStep], people_of_companies: peopleAsk(false), ...over });
interface Seen { user: string; schemaDecision: string }
function sequence(answers: unknown[]): { model: PlannerModel; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const model: PlannerModel = async ({ tool, user }) => {
    if (tool.name !== UNDERSTAND_TOOL) return null;
    seen.push({ user, schemaDecision: ((tool.schema as any).properties.decision.enum as unknown[]).join("|") });
    const next = answers[Math.min(i, answers.length - 1)]; i += 1;
    return { input: JSON.parse(JSON.stringify(next)), costUsd: 0.001 };
  };
  return { model, seen };
}
const depsOf = (model: PlannerModel): LlmPlannerDeps => ({ model, catalog, access: NOT_ADMIN, today: "2026-11-19", probe: async () => { throw new Error("no paid call"); }, readPage: async () => null, accept: acceptOf(catalog, NOT_ADMIN) });
const understood = async (answers: unknown[], words = LIVE1) => {
  const m = sequence(answers);
  const got = await understandRequest({ words: [words], request: "" }, { model: m.model, catalog, access: NOT_ADMIN, today: "2026-11-19" });
  if (!got.ok) throw new Error(got.error);
  return { value: got.value, seen: m.seen, people: understoodPeopleOf(got.value.steps, got.value.people_of_companies) };
};

describe("must-pass 1-4: the retry keeps what the first answer said about the people of the companies", () => {
  it("1. live 1: answer 1 = a sensitivity ask (people asked, phone, missing []), answer 2 = a plan that forgot the people → the people of the companies are understood, with their contact kind; 2 model calls, no question", async () => {
    const r = await understood([askAnswer(), planAnswer()]);
    expect(r.seen).toHaveLength(2);
    expect(r.value.people_of_companies).toMatchObject({ asked: true, title_ar: "مسؤولو الإدارة", contact_kinds: ["phone"] });
    expect(r.people).toEqual({ noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null, contact_kinds: ["phone"] });
    const plan = await planWithLlm({ words: [LIVE1], request: "" }, depsOf(sequence([askAnswer(), planAnswer()]).model));
    expect(plan.kind).not.toBe("question");
  });
  it("2. the retry asks the people too, with a people step: the result is exactly what the same answer gives with no refused ask before it (nothing is merged)", async () => {
    const withStep = planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(true, ["email"]) });
    const afterRefusal = await understood([askAnswer({ people_of_companies: peopleAsk(true, ["phone"]) }), withStep]);
    const alone = await understood([withStep]);
    expect(afterRefusal.value).toEqual(alone.value);
    expect(afterRefusal.people).toEqual(alone.people);
    expect(afterRefusal.value.people_of_companies?.contact_kinds).toEqual(["email"]);
  });
  it("3. contact kinds: the retry's own stay when it has some; when it has none the first answer's are used (phone restored)", async () => {
    const empty = await understood([askAnswer(), planAnswer({ people_of_companies: peopleAsk(true, []) })]);
    expect(empty.value.people_of_companies?.contact_kinds).toEqual(["phone"]);
    expect(empty.people?.contact_kinds).toEqual(["phone"]);
    const own = await understood([askAnswer(), planAnswer({ people_of_companies: peopleAsk(true, ["email"]) })]);
    expect(own.value.people_of_companies?.contact_kinds).toEqual(["email"]);
    // a retry that wrote a people step but no people ask keeps its step: the people are understood from the step, nothing is overwritten
    const step = await understood([askAnswer(), planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(false) })]);
    expect(step.value.steps.map((x) => x.key)).toEqual(["companies", "pp"]);
    expect(step.people).not.toBeNull();
    // FIX1 (QA): the step stands, and the contact kind the first answer asked comes back (it lived only in the ask)
    expect(step.value.people_of_companies).toMatchObject({ asked: true, contact_kinds: ["phone"] });
    expect(step.people).toMatchObject({ contact_kinds: ["phone"] });
    // the retry's own kinds stay (step + its own ask with e-mail); a first answer with NO kind changes nothing
    const own2 = await understood([askAnswer(), planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(true, ["email"]) })]);
    expect(own2.people?.contact_kinds).toEqual(["email"]);
    const noKind = await understood([askAnswer({ people_of_companies: peopleAsk(true, []) }), planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(false) })]);
    expect(noKind.value.people_of_companies).toBeUndefined();
    expect(noKind.people?.contact_kinds).toBeUndefined();
    const noAsk = await understood([askAnswer({ people_of_companies: peopleAsk(false), missing: [] }), planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(false) })]);
    expect(noAsk.value.people_of_companies).toBeUndefined();
  });
  it("4. the retry's text says to keep everything the customer asked; the first call's text does not", async () => {
    const r = await understood([askAnswer(), planAnswer()]);
    expect(r.seen[0].user).not.toMatch(/Keep EVERYTHING the customer asked/);
    expect(r.seen[1].user).toMatch(/Keep EVERYTHING the customer asked/);
    expect(DECIDE_IT_AR_EN).toMatch(/Keep EVERYTHING the customer asked/);
    expect(r.seen[1].user).toMatch(/decide it/i);
  });
});

describe("counter-cases a-f: nothing else changes", () => {
  it("a. «هات شركتين مقاولات في الرياض مع أرقام تليفوناتهم»: the first answer did not ask the people (a plan, one call): nothing is restored; a refused ask that did not ask them either restores nothing", async () => {
    const one = await understood([planAnswer()], "هات شركتين مقاولات في الرياض مع أرقام تليفوناتهم");
    expect(one.seen).toHaveLength(1);
    expect(one.value.people_of_companies).toBeUndefined();
    expect(one.people).toBeNull();
    const refusedNoPeople = await understood([askAnswer({ people_of_companies: peopleAsk(false), missing: [] }), planAnswer()], "هات شركتين مقاولات في الرياض مع أرقام تليفوناتهم");
    expect(refusedNoPeople.seen).toHaveLength(2);
    expect(refusedNoPeople.value.people_of_companies).toBeUndefined();
    expect(refusedNoPeople.people).toBeNull();
  });
  it("b. «عايز شركات»: ONE question, one model call (the ask is earned: items and place missing)", async () => {
    const m = sequence([askAnswer({ people_of_companies: peopleAsk(false), missing: ["items", "place"], question_ar: "أي نوع شركات وفي أي مكان؟", options_ar: ["مقاولات", "برمجة"] })]);
    const r = await planWithLlm({ words: ["عايز شركات"], request: "" }, depsOf(m.model));
    expect(r).toMatchObject({ kind: "question", question_ar: "أي نوع شركات وفي أي مكان؟" });
    expect(m.seen).toHaveLength(1);
  });
  it("c. the first answer did not ask the people, the retry did: the retry's answer stands as it is", async () => {
    const r = await understood([askAnswer({ people_of_companies: peopleAsk(false), missing: [] }), planAnswer({ people_of_companies: peopleAsk(true, ["email"]) })]);
    expect(r.value.people_of_companies).toMatchObject({ asked: true, contact_kinds: ["email"] });
  });
  it("d. an earned ask (people asked, missing [place]) is the question as today: no retry, nothing restored", async () => {
    const m = sequence([askAnswer({ missing: ["place"] })]);
    const r = await planWithLlm({ words: ["عايز شركات مقاولات ومسؤوليها"], request: "" }, depsOf(m.model));
    expect(r.kind).toBe("question");
    expect(m.seen).toHaveLength(1);
  });
  it("e. no refused ask (the run-2 sentence): one model call and the answer exactly as given", async () => {
    const answer = planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(true, ["email", "phone"]) });
    const r = await understood([answer]);
    expect(r.seen).toHaveLength(1);
    expect(r.value.people_of_companies).toMatchObject({ asked: true, contact_kinds: ["email", "phone"] });
  });
  it("f. the accepted trade: a first answer that asked the people of a request that is not about people is restored too; the plan check then needs a people stage or an honest unserved step (the hold follows the plan: no charge risk)", async () => {
    const r = await understood([askAnswer({ missing: [] }), planAnswer()], "هات ٥٠ تغريدة");
    expect(r.people).not.toBeNull();
  });
});

describe("the whole planning of live 1 (replay): the card has the people stage, or says honestly it has not; a companies-only card with neither is refused", () => {
  const ccols = columnsOf(["name", "اسم الشركة"], ["activity", "القطاع"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["phone", "التليفون", "phone"], ["address", "العنوان"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
  const pcols = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);
  const world = SECTOR_WORLD.electromechanical;
  const companiesStage = (res: Results) => ({ key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccols,
    sample_rows: [{ id: linkedinOf("orascom-em"), name: world.names[0], activity: world.industry, city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] });
  const sampling: FakeStep[] = [
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director"] }], max_results: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: p.email || '', phone: '' }; })`, files: [callIds(r)[1]] }) },
  ];
  const companiesOnly: FakeStep = { tool: "propose_plan", args: (res: Results) => ({ summary_ar: "شركتان من شركات المقاولات في الرياض مع بياناتها ورقم هاتف كل شركة من موقعها الرسمي.", stages: [companiesStage(res)] }) };
  const withPeople: FakeStep = { tool: "propose_plan", args: (res: Results) => ({ summary_ar: "ستحصل على شركتين من شركات المقاولات ومع كل شركة اثنين من مسؤوليها بالاسم والمسمى الوظيفي.",
    stages: [companiesStage(res), { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 4, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols,
      sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] }] }) };
  const planner = (answers: unknown[]) => (base: any) => ({ ...base, plannerModel: sequence(answers).model });
  const run = (planning: FakeStep[], answers: unknown[]) => replay({ request: LIVE1_NO_CITY, planning, execution: () => [], answers: Array.from({ length: 100 }, () => dispatcher({})) as any, deps: planner(answers) });
  it("a companies-only proposal is REFUSED once the planner's first answer (people asked) is kept; the agent then proposes the people stage and the card has it", async () => {
    const r = await run([...sampling, companiesOnly, withPeople], [askAnswer(), planAnswer()]);
    const refusal = r.planningDriver.results.filter((x) => x.tool === "propose_plan").map((x) => x.result);
    expect(refusal[0]).toMatchObject({ ok: false });
    expect(JSON.stringify(refusal[0])).toMatch(/the customer asked for a step the plan does not have/);
    const plan: any = (r.mission as any).plan;
    expect(plan.stages.map((s: any) => s.key)).toEqual(["companies", "people"]);
    expect(r.planView.stages.length).toBe(2);
  }, 120_000);
  it("the control: a first answer that did not ask the people keeps the companies-only card as today (company phones, no people stage)", async () => {
    const r = await run([...sampling, companiesOnly], [askAnswer({ people_of_companies: peopleAsk(false), missing: [] }), planAnswer()]);
    expect((r.mission as any).plan.stages.map((s: any) => s.key)).toEqual(["companies"]);
  }, 120_000);
});

describe("roleEnded (from #580's Gate 2): a boolean `ended: true` is ended; a bare number text is not a date", () => {
  it("true is ended, false is not; «12» and «3» are not dates, «2019», «Dec 2019» and an ISO date are; «Present», empty and null are as before", () => {
    expect(roleEnded({ ended: true })).toBe(true);
    expect(roleEnded({ ended: false })).toBe(false);
    expect(roleEnded({ end_date: "12" })).toBe(false);
    expect(roleEnded({ end_date: "3" })).toBe(false);
    expect(roleEnded({ end: "12" })).toBe(false);
    expect(roleEnded({ end_date: "2019" })).toBe(true);
    expect(roleEnded({ end_date: "Dec 2019" })).toBe(true);
    expect(roleEnded({ end_date: "2019-05-01" })).toBe(true);
    expect(roleEnded({ end_date: "Present" })).toBe(false);
    expect(roleEnded({ end_date: "" })).toBe(false);
    expect(roleEnded({ end_date: null })).toBe(false);
    expect(roleEnded({ title: "Manager", start_date: "2019" })).toBe(false);
    expect(roleEnded({ to_date: 2021 })).toBe(true);
  });
});
