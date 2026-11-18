import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { PEOPLE_OF_COMPANY_CAPABILITIES, peopleOfCompaniesAskOf, peopleSourcesForCompanies, understoodPeopleOf } from "../src/lib/agentMission/childSources";
import { finderSourcesOf } from "../src/lib/agentMission/contactFinders";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { checkUnderstanding, planWithLlm, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_SCHEMA, UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * DT-20261118-08 (Megz: any wording → the model understands → the catalog → full delivery). Live after #575: «عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية» got NO people
 * step and the model's «لم يثبت أي مصدر متاح…». The planner now ANSWERS, in a REQUIRED field, whether the customer asked for the people of the companies (with the count per company it read and the
 * person contacts asked). Code acts on that answer even when the model writes no people step: the request goes to the company-and-people path, where the people of the companies are a step
 * and an «unavailable» note is refused while the catalog has finders. The model is scripted here: these tests prove what CODE does with its answer, for every wording.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);
/** A companies capability of this catalog that is not itself a people-of-company tool (read from the catalog, never named here). */
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const PEOPLE_CAP = [...PEOPLE_OF_COMPANY_CAPABILITIES].sort().find((c) => capabilitiesOf(catalog, NOT_ADMIN, c.split(".")[0]).has(c))!;

const companiesStep = (title = "شركات المقاولات") => ({ key: "companies", title_ar: title, platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] });
const ask = (asked: boolean, title_ar = "", per_company = 0, contact_kinds: string[] = []) => ({ asked, title_ar, per_company, contact_kinds });
const understanding = (poc: ReturnType<typeof ask>, steps: unknown[] = [companiesStep()], decision = "plan") => ({ decision, understanding_ar: "شركات مقاولات.", steps, accepts_available: false, people_of_companies: poc, ...(decision === "cannot" ? { cannot_ar: "لم يثبت أي مصدر متاح حتى الآن أنه يوفر أرقامهم الشخصية." } : {}) });

function scripted(answer: unknown): { model: PlannerModel; probes: () => number } {
  let probes = 0;
  const model: PlannerModel = async ({ tool }) => (tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(answer)), costUsd: 0.001 } : null);
  return { model, probes: () => probes };
}
const depsOf = (model: PlannerModel): LlmPlannerDeps => ({
  model, catalog, access: NOT_ADMIN, today: "2026-11-19",
  probe: async () => { throw new Error("no paid call may happen for a request that goes to the company-and-people path"); },
  readPage: async () => null,
  accept: acceptOf(catalog, NOT_ADMIN),
});

describe("the planner must answer whether the people of the companies were asked (a REQUIRED field)", () => {
  it("the schema requires people_of_companies with all four of its fields (no optional property is added: the structured-output size limit)", () => {
    const schema = UNDERSTAND_SCHEMA as { required: string[]; properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
    expect(schema.required).toContain("people_of_companies");
    const poc = schema.properties.people_of_companies;
    expect(Object.keys(poc.properties ?? {}).sort()).toEqual(["asked", "contact_kinds", "per_company", "title_ar"]);
    expect([...(poc.required ?? [])].sort()).toEqual(["asked", "contact_kinds", "per_company", "title_ar"]);
    expect(UNDERSTAND_SYSTEM).toContain("people_of_companies");
  });
  it("code reads the answer: the count per company (0 = none given), the person contacts (only e-mail and phone), the people as the customer named them; a missing answer is «not asked»", () => {
    expect(peopleOfCompaniesAskOf({ asked: true, title_ar: "مسؤولو الإدارة", per_company: 2, contact_kinds: ["phone", "phone", "fax"] })).toEqual({ asked: true, title_ar: "مسؤولو الإدارة", per_company: 2, contact_kinds: ["phone"] });
    expect(peopleOfCompaniesAskOf({ asked: true, title_ar: "المديرون", per_company: 0, contact_kinds: [] })).toEqual({ asked: true, title_ar: "المديرون", per_company: null, contact_kinds: [] });
    expect(peopleOfCompaniesAskOf(undefined)).toEqual({ asked: false, title_ar: "", per_company: null, contact_kinds: [] });
    const checked = checkUnderstanding(understanding(ask(true, "مسؤولو الإدارة", 0, ["phone"])), catalog, NOT_ADMIN);
    expect(checked.ok && checked.value.people_of_companies).toEqual({ asked: true, title_ar: "مسؤولو الإدارة", per_company: null, contact_kinds: ["phone"] });
  });
  it("the people of the companies are understood from that answer even when the model wrote NO people step; a step it wrote still wins", () => {
    const steps = [{ key: "companies", title_ar: "شركات المقاولات", parent: null, platform: "companies", capability: COMPANIES_CAP, count: { per_parent: null } }];
    expect(understoodPeopleOf(steps, peopleOfCompaniesAskOf(ask(true, "مسؤولو الإدارة", 2, ["phone"])))).toEqual({ noun_ar: "مسؤولو الإدارة", parent_ar: "شركات المقاولات", per_parent: 2, contact_kinds: ["phone"] });
    expect(understoodPeopleOf(steps, peopleOfCompaniesAskOf(ask(false)))).toBeNull();
    const withStep = [...steps, { key: "pp", title_ar: "المديرون", parent: "companies", platform: PEOPLE_CAP.split(".")[0], capability: PEOPLE_CAP, count: { per_parent: null } }];
    expect(understoodPeopleOf(withStep, peopleOfCompaniesAskOf(ask(true, "مسؤولو الإدارة", 3, ["email"])))).toEqual({ noun_ar: "المديرون", parent_ar: "شركات المقاولات", per_parent: 3, contact_kinds: ["email"] });
  });
});

// one case per wording (QA live and the order): the model's understanding is scripted as a model that FORGOT the people step but answered the required field; the count comes from the
// model (digits, the dual, words); code never reads the words
describe.each([
  ["مسؤولي الإدارة + dual (live)", "عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية", "مسؤولو الإدارة", 0, ["phone"]],
  ["المديرين + Arabic-Indic digits", "هات ٢ شركات مقاولات في الرياض والمديرين فيها وأرقام تليفوناتهم الشخصية", "المديرون", 0, ["phone"]],
  ["الـ CEO + e-mail and mobile", "عايز شركتين تسويق في القاهرة والـ CEO بتاع كل واحدة بإيميله وموبايله", "الرؤساء التنفيذيون", 1, ["email", "phone"]],
  ["صناع القرار + words", "خمس شركات عقارات في جدة ومن كل شركة اتنين من صناع القرار", "صناع القرار", 2, []],
  ["Latin digits + per company", "10 companies in Cairo with 3 managers each and their emails", "المديرون", 3, ["email"]],
])("planner path: %s", (_name, words, title, perCompany, kinds) => {
  const poc = ask(true, title, perCompany, kinds as string[]);
  it("goes to the company-and-people path before any paid call, with the people understood from the answer", async () => {
    const m = scripted(understanding(poc));
    const r = await planWithLlm({ words: [words], request: "" }, depsOf(m.model));
    expect(r).toMatchObject({ kind: "cannot", detail: "handed_over" });
    expect(understoodPeopleOf(r.understanding!.steps, r.understanding!.people_of_companies)).toMatchObject({ noun_ar: title, parent_ar: "شركات المقاولات", per_parent: perCompany || null });
  });
  it("the model's «cannot … no source» is not the answer while the catalog has people of companies: the request goes to the company-and-people path", async () => {
    const r = await planWithLlm({ words: [words], request: "" }, depsOf(scripted(understanding(poc, [], "cannot")).model));
    expect(r).toMatchObject({ kind: "cannot", detail: "handed_over" });
  });
  it("a companies step from a map search (no companies key) is handed over too", async () => {
    const maps = [...capabilitiesOf(catalog, NOT_ADMIN, "google")].find((c) => /maps/.test(c));
    if (!maps) return;
    const r = await planWithLlm({ words: [words], request: "" }, depsOf(scripted(understanding(poc, [{ ...companiesStep(), platform: "google", capability: maps }])).model));
    expect(r).toMatchObject({ kind: "cannot", detail: "handed_over" });
  });
});

describe("a request that does not ask for people stays on the planner path; «cannot» stays the model's answer there", () => {
  it("asked false: no handover, the model's cannot is kept", async () => {
    const r = await planWithLlm({ words: ["عايز تغريدات"], request: "" }, depsOf(scripted(understanding(ask(false), [], "cannot")).model));
    expect(r).toMatchObject({ kind: "cannot", detail: "model_cannot" });
  });
  it("a catalog without people-of-company tools does not hand over on the answer alone", () => {
    const empty = { ...catalog, endpoints: catalog.endpoints.filter((e) => !(e.capability && PEOPLE_OF_COMPANY_CAPABILITIES.has(e.capability))) } as typeof catalog;
    expect(acceptOf(empty, NOT_ADMIN)({ decision: "plan", understanding_ar: "", steps: [], people_of_companies: peopleOfCompaniesAskOf(ask(true, "المديرون")) } as never)).toBe(true);
  });
});

describe("the company-and-people path: with the answer alone (no people step written), the «unavailable» note is refused and the people are asked for as a step", () => {
  const companies = { key: "companies", title_ar: "شركات المقاولات في الرياض", endpoint_id: "tomba.companies.search.reveal", expected_rows: 2, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [{ name: "شركة أ", website: "a.example" }, { name: "شركة ب", website: "b.example" }], measured_by: ["call_0001"] };
  const lookup = (contact_kinds: Array<"email" | "phone">): PlanLookup => ({
    call: (id) => (id === "call_0001" ? { id, endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "contracting" } } : null),
    evidenceText: () => "a.example b.example شركة أ شركة ب", endpointAllowed: () => true,
    // the customer's words name no contact word code knows: only the model's answer says what was asked
    requestText: "عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم",
    endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null,
    isContactSource: (id) => /email|phone/i.test(id),
    childStepSources: () => peopleSourcesForCompanies(catalog, allowed),
    contactFinders: (kind) => finderSourcesOf(kind, catalog, allowed),
    understoodPeople: understoodPeopleOf([{ key: "companies", title_ar: "شركات المقاولات في الرياض", parent: null, platform: "companies", capability: COMPANIES_CAP, count: { per_parent: null } }], peopleOfCompaniesAskOf({ asked: true, title_ar: "مسؤولو الإدارة", per_company: 0, contact_kinds }))!,
  });
  it("the excuse note about the people's phones is refused (the catalog has phone finders)", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركتان مقاولات في الرياض.", stages: [companies], contacts_note_ar: "لم يثبت أي مصدر متاح حتى الآن أنه يوفر أرقامهم الشخصية بدقة كافية." }, lookup(["phone"]));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("the note is not a reason");
  });
  it("even without a note, a plan of the companies only is refused: the people of the companies are a step", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركتان مقاولات في الرياض.", stages: [companies] }, lookup([]));
    expect(checked.ok).toBe(false);
  });
});
