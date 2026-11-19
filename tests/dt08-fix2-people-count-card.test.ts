import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { PEOPLE_OF_COMPANY_CAPABILITIES, peopleSourcesForCompanies, understoodPeopleOf } from "../src/lib/agentMission/childSources";
import { DEFAULT_PEOPLE_PER_PARENT } from "../src/lib/agentMission/quantity";
import { countWrittenIn, isCountOfOtherNoun } from "../src/lib/agentMission/numberWords";
import { customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { customerSaidOf, planWithLlm, withCheckedPerCompany, type LlmPlannerDeps, type LlmPlannerInput, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_SCHEMA, UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * DT-20261118-08 FIX2 (QA FAIL on #576 head 16320169 + Gate 2 r2 P1-A/B/C). The customer sees the CARD: these tests drive the planner's understanding (scripted model) through the planner, the plan check and the
 * customer's card view, and assert what the card says: the «لم تحدد عدد … فاعتمدنا …» line present or absent, and the words it shows. The count of the COMPANIES must never be read as the count of people, however the
 * model carries it (the answer field, a people child step, no steps at all), a count the customer gave in an answer to a question is kept, and a title the model wrote never reaches the card.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const PEOPLE_CAP = [...PEOPLE_OF_COMPANY_CAPABILITIES].sort().find((c) => capabilitiesOf(catalog, NOT_ADMIN, c.split(".")[0]).has(c))!;

/** a noun no list of people words knows, so the plan check cannot read the people from the request text: only the planner's understanding carries them */
const REQUEST = "عايز شركتين مقاولات في القاهرة ومعاهم الإدارة العليا";
const LINE = (n: number) => `لم تحدد عدد الأشخاص لكل شركة، فاعتمدنا ${n === 2 ? "٢" : String(n)}؛ تقدر تغيّره من «عدّل الطلب».`;

const companiesStep = { key: "companies", title_ar: "شركات المقاولات", platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] };
const peopleStep = (per: number | null, title = "الإدارة العليا") => ({ key: "pp", title_ar: title, platform: PEOPLE_CAP.split(".")[0], capability: PEOPLE_CAP, parent: "companies", deliver: true, count: { total: null, per_parent: per, all: false } });
const answerOf = (poc: { title_ar?: string; per_company?: number; per_company_text?: string; companies_text?: string }, steps: unknown[], decision = "plan") => ({
  decision, understanding_ar: "شركات مقاولات والإدارة العليا.", steps, accepts_available: false,
  people_of_companies: { asked: true, title_ar: "الإدارة العليا", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: ["phone"], ...poc },
  ...(decision === "cannot" ? { cannot_ar: "تعذر." } : {}),
});
const modelOf = (answer: unknown): PlannerModel => async ({ tool }) => (tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(answer)), costUsd: 0.001 } : null);
const depsOf = (model: PlannerModel): LlmPlannerDeps => ({
  model, catalog, access: NOT_ADMIN, today: "2026-11-19",
  probe: async () => { throw new Error("no paid call may happen for a request that goes to the company-and-people path"); },
  readPage: async () => null,
  accept: acceptOf(catalog, NOT_ADMIN),
});

const companies = { key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: "tomba.companies.search.reveal", expected_rows: 2, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [{ id: "kahromika-co.com", name: "KAHROMIKA", website: "https://kahromika-co.com" }], measured_by: ["call_0001"] };
const peopleStage = (per: number) => ({ key: "people", title_ar: "الإدارة العليا في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: per * 2, parent_key: "companies", per_parent_rows: per, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] });
const calls = new Map([
  ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "contracting" } }],
  ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.001, rows: 2, params: { website: "kahromika-co.com", perPage: 2, page: 0 } }],
]);

/** the whole way: the model's understanding → the planner → the people it understood → the plan check → the card the customer reads */
async function cardOf(input: Partial<LlmPlannerInput> & { words: string[] }, answer: unknown) {
  const r = await planWithLlm({ request: "", ...input }, depsOf(modelOf(answer)));
  expect(r).toMatchObject({ kind: "cannot", detail: "handed_over" });
  const people = understoodPeopleOf(r.understanding!.steps, r.understanding!.people_of_companies);
  const lookup: PlanLookup = {
    call: (id) => calls.get(id) ?? null, evidenceText: () => "kahromika-co.com https://kahromika-co.com person-1 person-2", endpointAllowed: () => true, requestText: input.words.join(" "),
    endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null, childStepSources: () => peopleSourcesForCompanies(catalog, allowed),
    endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]), isContactSource: (id) => /email|phone/i.test(id),
    ...(people ? { understoodPeople: people } : {}),
  };
  const checked = validateAndPricePlan({ summary_ar: "شركتان ومعهما الإدارة العليا.", stages: [companies, peopleStage(1)], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة." }, lookup);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) throw new Error("plan refused");
  const card = customerPlanView(checked.plan).assumptions_ar ?? [];
  return { people, card, rows: checked.plan.stages.find((s) => s.key === "people")!.per_parent_rows, companyAnswer: r.understanding!.people_of_companies! };
}

describe("FIX2 QA-1 / Gate 2 P1-A: the company count copied into a people CHILD STEP is not the people count (the card says «فاعتمدنا»)", () => {
  it("«عايز شركتين مقاولات … الإدارة العليا»: the model writes a people step with per_parent 2 and cites «شركتين»: the count is dropped and the card says code's default was used", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({ per_company: 2, per_company_text: "شركتين", companies_text: "شركتين" }, [companiesStep, peopleStep(2)]));
    expect(got.people).toMatchObject({ noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null });
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    expect(got.rows).toBe(DEFAULT_PEOPLE_PER_PARENT);
  });
  it("a people step's per_parent the customer never wrote at all (50) is dropped as well: the card says «فاعتمدنا», not 100 people", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({}, [companiesStep, peopleStep(50)]));
    expect(got.people?.per_parent).toBeNull();
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    expect(got.rows).toBe(DEFAULT_PEOPLE_PER_PARENT);
  });
  it("the same number the customer DID write for each company is kept, by the step and by the answer: no «لم تحدد» line", async () => {
    const words = ["عايز شركتين مقاولات في القاهرة ومن كل شركة اتنين من الإدارة العليا"];
    const got = await cardOf({ words }, answerOf({ per_company: 2, per_company_text: "اتنين", companies_text: "شركتين" }, [companiesStep, peopleStep(2)]));
    expect(got.people).toMatchObject({ per_parent: 2 });
    expect(got.card.filter((l) => l.startsWith("لم تحدد عدد"))).toEqual([]);
    expect(got.rows).toBe(2);
  });
  it("a different count the customer wrote in digits is kept in the step: «٣ من كل شركة» → 3", async () => {
    const got = await cardOf({ words: ["عايز شركتين مقاولات ومن كل شركة ٣ من الإدارة العليا"] }, answerOf({ per_company: 3, per_company_text: "٣", companies_text: "شركتين" }, [companiesStep, peopleStep(3)]));
    expect(got.people).toMatchObject({ per_parent: 3 });
    expect(got.rows).toBe(3);
  });
});

describe("FIX2 QA-1 second path: «cannot» with NO steps compares with the company count the customer wrote in their own words (companies_text)", () => {
  it("the dual «شركتين» cited for the people while the model wrote no company step: dropped; the card says «فاعتمدنا»", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({ per_company: 2, per_company_text: "شركتين", companies_text: "شركتين" }, [], "cannot"));
    expect(got.people).toMatchObject({ noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null });
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
  });
  it("«٥ شركات» cited as the per-company count with no step: dropped; the count the customer wrote for each company with no step: kept", () => {
    const answer = (per: number, text: string) => answerOf({ per_company: per, per_company_text: text, companies_text: "٥ شركات" }, [], "cannot") as never;
    const asked = (words: string, a: never) => withCheckedPerCompany({ ...(a as object), steps: [], people_of_companies: (a as { people_of_companies: object }).people_of_companies } as never, [words]).people_of_companies!.per_company;
    expect(asked("عايز ٥ شركات ومعاهم الإدارة العليا", answer(5, "٥ شركات"))).toBeNull();
    expect(asked("عايز ٥ شركات ومن كل شركة ٣ من الإدارة العليا", answer(3, "٣"))).toBe(3);
  });
  it("words the model cites for the companies that are NOT in the customer's message say nothing (no company count is known): the count is judged as before", () => {
    expect(countWrittenIn("عايز مقاولات ومعاهم الإدارة العليا", "شركتين")).toBeNull();
    expect(countWrittenIn("عايز شركتين مقاولات", "شركتين")).toBe(2);
    expect(countWrittenIn("عايز ٥ شركات مقاولات", "٥ شركات")).toBe(5);
    expect(countWrittenIn("عايز خمس شركات", "خمس شركات")).toBe(5);
    expect(countWrittenIn("عايز ٥ شركات و٣ مديرين", "٥ شركات و٣ مديرين")).toBeNull();
  });
});

describe("FIX2 QA-2: a title the model wrote — also a source name in Arabic spelling — never reaches the card", () => {
  it("«موظفو بليتز» as the answer's title, the step's title and the parent's title: the card line says «الأشخاص» and «شركة», and shows no source name", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({ title_ar: "موظفو بليتز" }, [{ ...companiesStep, title_ar: "شركات بليتز" }, peopleStep(null, "موظفو بليتز")]));
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    expect(got.card.join(" ")).not.toContain("بليتز");
    expect(got.people).toMatchObject({ noun_ar: "الأشخاص", parent_ar: "الشركات" });
  });
});

describe("FIX2 Gate 2 P1-C: a count the customer gave in an ANSWER to a planner question is theirs", () => {
  const model = answerOf({ per_company: 3, per_company_text: "٣ من كل شركة", companies_text: "شركتين" }, [companiesStep, peopleStep(null)]);
  it("customerSaidOf: their messages and their answers, never the questions or the summary", () => {
    expect(customerSaidOf({ words: ["أ"], answer: "ب", exchanges: [{ question: "س؟", answer: "ج" }] })).toEqual(["أ", "ج", "ب"]);
    expect(customerSaidOf({ words: ["أ"], exchanges: [] })).toEqual(["أ"]);
  });
  it("given only in an exchange's answer: kept, and the card has no «لم تحدد» line", async () => {
    const got = await cardOf({ words: [REQUEST], exchanges: [{ question: "كام شخص من كل شركة؟", answer: "٣ من كل شركة" }] }, model);
    expect(got.people).toMatchObject({ per_parent: 3 });
    expect(got.card.filter((l) => l.startsWith("لم تحدد عدد"))).toEqual([]);
    expect(got.rows).toBe(3);
  });
  it("given only in the single question/answer pair: kept too", async () => {
    const got = await cardOf({ words: [REQUEST], question: "كام شخص من كل شركة؟", answer: "٣ من كل شركة" }, model);
    expect(got.people).toMatchObject({ per_parent: 3 });
    expect(got.rows).toBe(3);
  });
  it("the same answer NOT given: dropped, and the card says «فاعتمدنا» (the control: the check really reads the answers)", async () => {
    const got = await cardOf({ words: [REQUEST] }, model);
    expect(got.people?.per_parent).toBeNull();
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
  });
});

describe("FIX2: the schema and the prompt carry the companies' words", () => {
  it("companies_text is a required string of the answer, and the prompt says what it is", () => {
    const poc = (UNDERSTAND_SCHEMA as { properties: Record<string, { required: string[]; properties: Record<string, { type: string }> }> }).properties.people_of_companies;
    expect(poc.properties.companies_text.type).toBe("string");
    expect(poc.required).toContain("companies_text");
    expect(UNDERSTAND_SYSTEM).toContain("companies_text");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// FIX3 (QA final recheck + Gate 2 r3 P1-1 / P2-1): with NO company count to compare with, a per-company count is not trusted
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("FIX3: when the company count cannot be established, the per-company count is «not given» (the card says «فاعتمدنا»)", () => {
  const unit = (words: string, answer: ReturnType<typeof answerOf>) => withCheckedPerCompany(answer as never, [words]);
  it("the QA case: «cannot», no steps, per_company 2 cited «شركتين», companies_text EMPTY (the model left it out): dropped; the card line is present with the default count", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({ per_company: 2, per_company_text: "شركتين", companies_text: "" }, [], "cannot"));
    expect(got.people).toMatchObject({ noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null });
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    expect(unit("عايز شركتين مقاولات والمديرين فيهم", answerOf({ per_company: 2, per_company_text: "شركتين" }, [], "cannot")).people_of_companies!.per_company).toBeNull();
  });
  it("50 companies and 50 per company, companies_text empty: dropped, not 2,500 people; the card says «فاعتمدنا»", async () => {
    const got = await cardOf({ words: ["عايز ٥٠ شركة مقاولات في القاهرة ومعاهم الإدارة العليا"] }, answerOf({ per_company: 50, per_company_text: "٥٠" }, [], "cannot"));
    expect(got.people?.per_parent).toBeNull();
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    expect(got.rows).toBe(DEFAULT_PEOPLE_PER_PARENT);
  });
  it("the same rule on the STEP path (FIX4 narrows it): a parent step with no total — what the customer wrote as the amount per company is kept (step and answer); a dual copied from the companies is dropped", () => {
    const parent = { ...companiesStep, parent: null, count: { total: null, all: true } };
    const run = (words: string, per: number, text: string) => withCheckedPerCompany({ ...(answerOf({ per_company: per, per_company_text: text }, []) as object), steps: [parent, { ...peopleStep(per), parent: "companies" }] } as never, [words]);
    const kept = run("عايز كل الشركات ومن كل شركة اتنين من الإدارة العليا", 2, "اتنين");
    expect(kept.steps[1].count.per_parent).toBe(2);
    expect(kept.people_of_companies!.per_company).toBe(2);
    const copied = run("عايز شركتين مقاولات ومعاهم الإدارة العليا", 2, "شركتين");
    expect(copied.steps[1].count.per_parent).toBeNull();
    expect(copied.people_of_companies!.per_company).toBeNull();
  });
  it("the control: companies_text filled and in the message — a legit «٣ شركات … ٣ مديرين» is kept (written twice), and so is a different per-company count; the card has no «لم تحدد» line", async () => {
    const same = await cardOf({ words: ["عايز ٣ شركات مقاولات ومن كل شركة ٣ من الإدارة العليا"] }, answerOf({ per_company: 3, per_company_text: "٣", companies_text: "٣ شركات" }, [], "cannot"));
    expect(same.people).toMatchObject({ per_parent: 3 });
    expect(same.card.filter((l) => l.startsWith("لم تحدد عدد"))).toEqual([]);
    expect(same.rows).toBe(3);
    const other = await cardOf({ words: ["عايز شركتين مقاولات ومن كل شركة ٣ من الإدارة العليا"] }, answerOf({ per_company: 3, per_company_text: "٣", companies_text: "شركتين" }, [], "cannot"));
    expect(other.people).toMatchObject({ per_parent: 3 });
    expect(other.rows).toBe(3);
  });
});

describe("FIX3 (Gate 2 r3 P2-1): the words cited for the companies must stand in the message as WHOLE words", () => {
  it("«5» is not inside «50», «خمس» is not inside «خمسين»; the conjunction «و» before the cited words is allowed", () => {
    expect(countWrittenIn("عايز 50 شركة", "5")).toBeNull();
    expect(countWrittenIn("عايز ٥٠ شركة", "٥")).toBeNull();
    expect(countWrittenIn("عايز 50 شركة", "50")).toBe(50);
    expect(countWrittenIn("عايز خمسين شركة", "خمس")).toBeNull();
    expect(countWrittenIn("عايز مقاولات وخمس شركات", "خمس شركات")).toBe(5);
    expect(countWrittenIn("عايز ٥ شركات", "٥ شركات")).toBe(5);
    expect(countWrittenIn("عايز شركتين مقاولات", "شركتين")).toBe(2);
  });
  it("a company count the model cites for a number that is only PART of a bigger number is not a known count (FIX4: the amount per company is then judged by its own words: «٣ من كل شركة» is kept, «٥» counted next to «شركة» is not)", () => {
    const run = (per: number, text: string) => withCheckedPerCompany({ ...(answerOf({ per_company: per, per_company_text: text, companies_text: "٥" }, [], "cannot") as object), steps: [] } as never, ["عايز ٥٠ شركة ومن كل شركة ٣ من الإدارة العليا"]).people_of_companies!.per_company;
    expect(run(3, "٣")).toBe(3);
    expect(run(50, "٥٠ شركة")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// FIX4 (QA on FIX3, Gate 2 r3): the fail-safe is NARROW — only a count that is itself the count of another noun (the companies) is distrusted when the company count is unknown
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("FIX4: with no company count, a number counting ANOTHER noun is dropped; the amount per company the customer wrote is kept", () => {
  const stripped = (card: string[]) => card.filter((l) => l.startsWith("لم تحدد عدد"));
  it("(a) the QA FIX2 case: «شركتين» cited, cannot, no steps, companies_text empty → default + «فاعتمدنا»", async () => {
    const got = await cardOf({ words: [REQUEST] }, answerOf({ per_company: 2, per_company_text: "شركتين" }, [], "cannot"));
    expect(got.people?.per_parent).toBeNull();
    expect(got.card).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
  });
  it("(b) the QA FIX3 case: «عايز كل الشركات والمديرين فيهم» + the answer «اتنين من كل شركة», parent total null, per_company 2 «اتنين», a people step per_parent 2, companies_text empty → kept 2 (step and answer), no «لم تحدد» line", async () => {
    const parent = { ...companiesStep, count: { total: null, all: true } };
    const r = withCheckedPerCompany({ ...(answerOf({ title_ar: "المديرين", per_company: 2, per_company_text: "اتنين" }, [parent, { ...peopleStep(2), parent: "companies" }]) as object), steps: [{ ...parent, parent: null }, { ...peopleStep(2), parent: "companies" }] } as never, ["عايز كل الشركات والمديرين فيهم", "اتنين من كل شركة"]);
    expect(r.steps[1].count.per_parent).toBe(2);
    expect(r.people_of_companies!.per_company).toBe(2);
    // at card level, with the company count written in words that the model left out of the step and of companies_text
    const got = await cardOf({ words: [REQUEST], question: "كام شخص من كل شركة؟", answer: "اتنين من كل شركة" }, answerOf({ per_company: 2, per_company_text: "اتنين" }, [{ ...companiesStep, count: { total: null, all: true } }, peopleStep(2)]));
    expect(got.people).toMatchObject({ per_parent: 2 });
    expect(stripped(got.card)).toEqual([]);
    expect(got.rows).toBe(2);
  });
  it("(c) «٥٠ شركة» cited (and the bare «٥٠» that the message writes only next to «شركة») → default + «فاعتمدنا»", async () => {
    for (const cited of ["٥٠ شركة", "٥٠"]) {
      const got = await cardOf({ words: ["عايز ٥٠ شركة مقاولات ومعاهم الإدارة العليا"] }, answerOf({ per_company: 50, per_company_text: cited }, [], "cannot"));
      expect(got.people?.per_parent, cited).toBeNull();
      expect(got.card, cited).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    }
  });
  it("(d) «عايز مديرين ٣ من كل شركة مقاولات», no company count: 3 is kept, whether the model cites «٣», «٣ من كل شركة» or «مديرين ٣»", () => {
    for (const cited of ["٣", "٣ من كل شركة", "مديرين ٣"]) {
      const per = withCheckedPerCompany({ ...(answerOf({ title_ar: "المديرين", per_company: 3, per_company_text: cited }, [], "cannot") as object), steps: [] } as never, ["عايز مديرين ٣ من كل شركة مقاولات"]).people_of_companies!.per_company;
      expect(per, cited).toBe(3);
    }
  });
  it("(d) a cited PHRASE («٣ مديرين من كل شركة») is the amount per company even when the people's title shares no root with its noun", () => {
    const per = withCheckedPerCompany({ ...(answerOf({ title_ar: "الإدارة العليا", per_company: 3, per_company_text: "٣ مديرين من كل شركة" }, [], "cannot") as object), steps: [] } as never, ["عايز ٣ مديرين من كل شركة مقاولات"]).people_of_companies!.per_company;
    expect(per).toBe(3);
  });
  it("(d) at card level: «عايز الإدارة العليا ٣ من كل شركة مقاولات» → 3 people each, no «لم تحدد» line", async () => {
    const got = await cardOf({ words: ["عايز الإدارة العليا ٣ من كل شركة مقاولات"] }, answerOf({ per_company: 3, per_company_text: "٣" }, [], "cannot"));
    expect(got.people).toMatchObject({ per_parent: 3 });
    expect(stripped(got.card)).toEqual([]);
    expect(got.rows).toBe(3);
  });
  it("BUG HUNTER R1/R3: «عايز شركات مقاولات في الرياض ومن كل شركة ٣ مديرين» (cited «٣ مديرين» under «المديرين»), and the 3 given in an answer → kept 3", () => {
    const run = (said: string[], cited: string) => withCheckedPerCompany({ ...(answerOf({ title_ar: "المديرين", per_company: 3, per_company_text: cited }, [], "cannot") as object), steps: [] } as never, said).people_of_companies!.per_company;
    expect(run(["عايز شركات مقاولات في الرياض ومن كل شركة ٣ مديرين"], "٣ مديرين")).toBe(3);
    expect(run(["عايز شركات مقاولات في الرياض ومعاهم المديرين", "٣"], "٣")).toBe(3);
    expect(run(["عايز شركات مقاولات في الرياض ومن كل شركة لمديرين ٣"], "لمديرين ٣")).toBe(3);
  });
  it("BUG HUNTER P2: the dual with a joined letter or the article, and a digit glued to its noun, are still counts of the companies → dropped, default + «فاعتمدنا»", async () => {
    const cases: Array<[string, number, string]> = [
      ["عايز مقاولات لشركتين ومعاهم الإدارة العليا", 2, "لشركتين"],
      ["عايز مقاولات بشركتين ومعاهم الإدارة العليا", 2, "بشركتين"],
      ["عايز مقاولات للشركتين ومعاهم الإدارة العليا", 2, "للشركتين"],
      ["عايز ٥شركات مقاولات ومعاهم الإدارة العليا", 5, "٥شركات"],
    ];
    for (const [words, per, cited] of cases) {
      const got = await cardOf({ words: [words] }, answerOf({ per_company: per, per_company_text: cited }, [], "cannot"));
      expect(got.people?.per_parent, cited).toBeNull();
      expect(got.card, cited).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    }
  });
  it("(e) the controls: «٣ شركات … ٣ مديرين» kept with the companies' words, «5» is not inside «50», and the glued/joined forms are found for the companies' own count", () => {
    expect(withCheckedPerCompany({ ...(answerOf({ per_company: 3, per_company_text: "٣", companies_text: "٣ شركات" }, [], "cannot") as object), steps: [] } as never, ["عايز ٣ شركات مقاولات ومن كل شركة ٣ من الإدارة العليا"]).people_of_companies!.per_company).toBe(3);
    expect(countWrittenIn("عايز 50 شركة", "5")).toBeNull();
    expect(countWrittenIn("عايز ٥شركات مقاولات", "٥ شركات")).toBe(5);
    expect(countWrittenIn("عايز مقاولات لشركتين", "شركتين")).toBe(2);
    expect(countWrittenIn("عايز مقاولات للشركتين", "الشركتين")).toBeNull();
    expect(countWrittenIn("عايز مقاولات بشركتين", "بشركتين")).toBe(2);
  });
  it("isCountOfOtherNoun reads grammar, not words: a lone noun after a number or the dual alone is another noun's count unless it is the people's own noun; a bare number or a phrase is an amount", () => {
    expect(isCountOfOtherNoun("عايز شركتين", "شركتين", 2, "المديرين")).toBe(true);
    expect(isCountOfOtherNoun("عايز ٥٠ شركة", "٥٠ شركة", 50, "المديرين")).toBe(true);
    expect(isCountOfOtherNoun("عايز ٣ مديرين", "٣ مديرين", 3, "المديرين")).toBe(false);
    expect(isCountOfOtherNoun("عايز ٣ مديرين", "٣ مديرين", 3, "")).toBe(true);
    expect(isCountOfOtherNoun("من كل شركة اتنين", "اتنين", 2, "المديرين")).toBe(false);
    expect(isCountOfOtherNoun("اتنين من كل شركة", "٣ من كل شركة", 3, "المديرين")).toBe(false);
  });
});

// DT-20261118-09 item 6 (BUG HUNTER FIX4 check: P1-1 and the two surviving mutants M8, M10)
describe("DT-09 item 6: the people title's HEAD noun is the people's own noun; the stem endings and the dual reading are pinned", () => {
  it("P1-1 at card level: a title that carries the company word («مسؤولو الشركات», «المديرين في الشركات», «مدراء الشركات») does not make the companies' own count the people count", async () => {
    const cases: Array<[string, string, number, string, string]> = [
      ["عايز شركتين مقاولات والإدارة العليا", "مسؤولو الشركات", 2, "شركتين", "شركتين"],
      ["عايز 5 شركات والإدارة العليا", "المديرين في الشركات", 5, "5 شركات", "5 شركات"],
      ["عايز 5 شركات والإدارة العليا", "مدراء الشركات", 5, "5", "5"],
    ];
    for (const [words, title, per, cited] of cases) {
      const got = await cardOf({ words: [words] }, answerOf({ title_ar: title, per_company: per, per_company_text: cited }, [], "cannot"));
      expect(got.people?.per_parent, `${title} / ${cited}`).toBeNull();
      expect(got.card, `${title} / ${cited}`).toContain(LINE(DEFAULT_PEOPLE_PER_PARENT));
    }
  });
  it("the head noun is the people's own noun: «٣ مديرين» under the title «المديرين في الشركات» is the people's amount and is kept", () => {
    expect(isCountOfOtherNoun("عايز ٣ مديرين", "٣ مديرين", 3, "المديرين في الشركات")).toBe(false);
    expect(isCountOfOtherNoun("عايز شركتين", "شركتين", 2, "المديرين في الشركات")).toBe(true);
  });
  it("M8: a noun that differs from the people's noun only by its ending is the same noun («مسؤولي» for the title «مسؤولو الإدارة»)", () => {
    expect(isCountOfOtherNoun("عايز ٣ مسؤولي", "٣ مسؤولي", 3, "مسؤولو الإدارة")).toBe(false);
    expect(isCountOfOtherNoun("عايز ٣ مسؤولين", "٣ مسؤولين", 3, "مسؤولو الإدارة")).toBe(false);
  });
  it("M10: a bare number is another noun's count when the message writes it only as a dual of another noun; a dual of the people's own noun is not", () => {
    expect(isCountOfOtherNoun("عايز شركتين مقاولات وأصحاب القرار فيهم", "اتنين", 2, "أصحاب القرار")).toBe(true);
    expect(isCountOfOtherNoun("عايز شركات مقاولات ومديرين", "اتنين", 2, "المديرين")).toBe(false);
  });
});
