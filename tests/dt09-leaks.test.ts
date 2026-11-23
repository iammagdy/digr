import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryDb } from "./helpers/memoryDb";
import { loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { NEUTRAL_HEADLINE_AR, customerMissionView, guardViewText, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { PLATFORM_LABEL_FALLBACK_AR, customerSafe, platformAr, planWithLlm, requestPartsAr, scoutFallbackAr, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";

/**
 * DT-20261118-09 items 4, 5 and 7 (live runs 2 and 3 of «عايز شركتين مقاولات في الرياض …»): a source name and a Latin «ceo» reached the card. No new word list: the LATIN letters and the code's OWN platform table
 * are compared with what the customer wrote; the customer's own words are always allowed.
 */
const LATIN = /[A-Za-z]{2,}/;
const row = (plan_public: unknown): MissionRowForCustomer => ({ id: "msn_x", status: "plan_ready", question_ar: null, plan_public, reserved_points: 100, unit_price_points: 1, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-19T00:00:00Z" });
const viewOf = (plan_public: unknown, requestText?: string) => customerMissionView({ mission: row(plan_public), events: [], ...(requestText !== undefined ? { requestText } : {}) });

describe("S1: a line of the card that holds a Latin word the customer did not write is not shown, even when it also holds Arabic", () => {
  const plan = {
    summary_ar: "شركتان في الرياض ومعهما ceo لكل شركة.", notes_ar: ["نفضّل مسمى ceo عند ترتيب الأشخاص.", "نجمع بالعدد الذي طلبته."], request_parts_ar: ["شركات", "ceo", "الرياض"], assumptions_ar: ["اعتمدنا الأقرب، وعرضنا سبع شركات.", "اعتمدنا مسمى cto."],
    stages: [{ key: "s", title_ar: "مديرو ceo", deliver: true, rows: 2, planned_rows: 2, sample_rows: [], columns: [] }],
  };
  it("summary, notes, assumptions, request parts and a stage title lose the line with the foreign Latin word; the lines without one stay", () => {
    const v = viewOf(plan, "عايز شركتين مقاولات في الرياض");
    expect(v.summaryAr).toBe(NEUTRAL_HEADLINE_AR);
    expect(v.notesAr).toEqual(["نجمع بالعدد الذي طلبته."]);
    expect(v.requestPartsAr).toEqual(["شركات", "الرياض"]);
    expect(v.assumptionsAr).toEqual(["اعتمدنا الأقرب، وعرضنا سبع شركات."]);
    expect(v.stages[0].titleAr).not.toMatch(LATIN);
    expect([v.summaryAr, v.notesAr, v.requestPartsAr, v.assumptionsAr, v.stages.map((s) => s.titleAr)].flat().filter(Boolean).join(" ")).not.toMatch(LATIN);
  });
  it("a Latin word the CUSTOMER wrote stays (their topic, their account): the same plan with the request «عايز شركتين مقاولات ceo cto»", () => {
    const v = viewOf(plan, "عايز شركتين مقاولات ceo cto");
    expect(v.requestPartsAr).toContain("ceo");
    expect(v.notesAr).toContain("نفضّل مسمى ceo عند ترتيب الأشخاص.");
    expect(v.assumptionsAr).toContain("اعتمدنا مسمى cto.");
  });
  it("with no request text given the guard is strict, and the old rule (a text with no Arabic at all) still holds", () => {
    expect(viewOf(plan).requestPartsAr).toEqual(["شركات", "الرياض"]);
    const g = guardViewText({ ...viewOf(plan, "x"), notesAr: ["agent mission delivered nothing"] }, "");
    expect(g.notesAr.join(" ")).not.toMatch(LATIN);
  });
});

describe("S1 through the real caller: the customer's stored request is what decides which Latin word is theirs", () => {
  it("loadCustomerMission hands the mission's own request text to the view: «ceo» written by the customer stays, «cto» they did not write goes", async () => {
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_leak00001", user_id: "u-1", status: "plan_ready", request_text: "عايز شركتين مقاولات وال ceo بتاعهم", plan: null, plan_public: { summary_ar: "شركتان مقاولات.", request_parts_ar: ["شركات", "ceo", "cto"], stages: [] }, created_at: "2026-11-19T00:00:00Z" }]);
    const client: any = { from: (t: string) => db.from(t), rpc: async () => ({ data: null, error: null }) };
    const r: any = await loadCustomerMission(client, { id: "msn_leak00001", userId: "u-1" });
    expect(r.ok).toBe(true);
    expect(r.view.requestPartsAr).toEqual(["شركات", "ceo"]);
  });
});

describe("S1 at the source: the topic of the request line is a word the customer wrote or an Arabic one", () => {
  const step = (topic: string | null) => ({ key: "t", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true, count: { total: 30, per_parent: null, all: false }, source: null, topic, search_terms: [], period: null }) as never;
  it("a Latin topic the customer did not write is dropped; one the customer wrote, and an Arabic one, stay", () => {
    expect(requestPartsAr([step("ceo")], ["٣٠ تغريدة عن الإدارة"])).toEqual(["إكس"]);
    expect(requestPartsAr([step("ceo")], ["٣٠ تغريدة عن ceo"])).toContain("ceo");
    expect(requestPartsAr([step("الإدارة")], ["٣٠ تغريدة عن الإدارة"])).toContain("الإدارة");
  });
});

describe("S2: a platform label of the code's own table is product information always shown to the customer", () => {
  it("platformAr: always returns the platform Arabic name; a platform the table does not know keeps «المنصة»", () => {
    expect(platformAr("google", "google.maps.places", ["عايز شركتين مقاولات في الرياض"])).toBe("خرائط جوجل");
    expect(platformAr("google", "google.maps.places", ["عايز شركات مقاولات من جوجل ماب"])).toBe("خرائط جوجل");
    expect(platformAr("linkedin", undefined, ["مديرين الشركات"])).toBe("لينكدإن");
    expect(platformAr("x", "x.search.posts", ["تغريدات على إكس عن اللقاح"])).toBe("إكس");
    expect(platformAr("x", "x.search.posts", ["تغريدات تويتر عن اللقاح"])).toBe("إكس");
    expect(platformAr("nope", undefined, ["نص"])).toBe("المنصة");
    expect(PLATFORM_LABEL_FALLBACK_AR).toBe("المصدر");
  });
  it("a sentence the model wrote that names a label of the table the customer did not write keeps its platform display names", () => {
    const text = "شركتان تسويق في القاهرة من خرائط جوجل ومعهما مديرهما.";
    expect(customerSafe(text, 400)).toBe(text);
    expect(customerSafe(text, 400, ["عايز شركتين تسويق في القاهرة"])).toBe(text);
    expect(customerSafe(text, 400, ["عايز شركتين تسويق من جوجل"])).toBe(text);
    expect(customerSafe("نجمع تغريدات على إكس وبإكس وللإكس.", 400, ["تغريدات عن اللقاح"])).toBe("نجمع تغريدات على إكس وبإكس وللإكس.");
    expect(customerSafe("شركتان تسويق في القاهرة ومعهما مديرهما.", 400, ["عايز شركتين تسويق في القاهرة"])).toBe("شركتان تسويق في القاهرة ومعهما مديرهما.");
  });
  it("scoutFallbackAr and requestPartsAr read the same rule", () => {
    const weak = [{ step: { title_ar: "الأماكن", platform: "google", capability: "google.maps.places", source: null, topic: null, period: null }, requested: 50, found: 12, sets: 3 }] as never;
    const said = ["عايز أماكن في القاهرة"];
    expect(scoutFallbackAr(weak, said).question_ar).toContain("خرائط جوجل");
    expect(scoutFallbackAr(weak, said).question_ar).toContain("جوجل");
    expect(scoutFallbackAr(weak, ["عايز أماكن من جوجل"]).question_ar).toContain("جوجل");
    const st = { key: "t", title_ar: "الأماكن", platform: "google", capability: "google.maps.places", parent: null, deliver: true, count: { total: 5, per_parent: null, all: false }, source: null, topic: null, search_terms: [], period: null } as never;
    expect(requestPartsAr([st], said)).toEqual(["خرائط جوجل"]);
  });
});

describe("S2 end to end: the planner path says nothing about a source the customer did not name", () => {
  const catalog = loadTregCatalog();
  const UNDERSTOOD = {
    decision: "plan", understanding_ar: "تغريدات وزارة الصحة عن الشائعات على إكس، بعدد ٥٠ تغريدة.", assumptions_ar: ["نقرأ من إكس ما يعرضه المصدر."],
    steps: [{ key: "tweets", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true, count: { total: 50, per_parent: null, all: false }, source: { kind: "account", value: "SaudiMOH" }, topic: "الشائعات", search_terms: ["الشائعات", "شائعة"], period: null }],
  };
  const CHOICE = { options: [{ endpoint_id: "anyapi.x.search.posts", params: { query: "(الشائعات OR شائعة) from:SaudiMOH", limit: 50, queryType: "Latest" }, cursor_input: "cursor", parent_input: null, more_params: [] }] };
  const MAP = { fields: { id: ["id"], text: ["text"], author: ["authorName"], username: ["authorUsername"], posted_at: ["createdUtc"], link: ["url"], likes: ["likeCount"] }, link_template: null, extra: [] };
  const tweet = (i: number) => ({ id: `19000000000000${String(i).padStart(4, "0")}`, text: `وزارة الصحة تنفي شائعة رقم ${i}`, authorName: "وزارة الصحة", authorUsername: "SaudiMOH", createdUtc: "2024-03-01T10:00:00Z", url: `https://x.com/SaudiMOH/status/${i}`, likeCount: i });
  const page = { output: { data: { items: Array.from({ length: 20 }, (_, k) => tweet(k)), nextCursor: "c2" } } };
  const run = async (words: string[]) => {
    const queues: Record<string, unknown[]> = { request_plan: [UNDERSTOOD], tool_choice: [CHOICE], field_map: [MAP] };
    const model: PlannerModel = async ({ tool }) => { const next = (queues[tool.name] ?? []).shift(); return next === undefined ? null : { input: JSON.parse(JSON.stringify(next)), costUsd: 0.001 }; };
    const progress: string[] = [];
    const deps: LlmPlannerDeps = { model, catalog, access: null, today: "2026-11-19", onProgress: async (l) => { progress.push(l); }, probe: async () => ({ ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 20, has_more: true, next_cursor: "c2", shape: null, first_rows: [], warnings: [], saved: "call_0001" }), readPage: async () => page };
    const r = await planWithLlm({ words, request: "" }, deps);
    return { r, progress };
  };
  it("the customer wrote «إكس»: the label shows everywhere (the control)", async () => {
    const { r, progress } = await run(["٥٠ تغريدة من حساب وزارة الصحة على إكس عن الشائعات"]);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.summary_ar).toContain("إكس");
    expect(progress.join(" ")).toContain("من إكس");
    expect((r.plan.compiled as unknown as { llm: { request_parts_ar: string[] } }).llm.request_parts_ar[0]).toBe("إكس");
  });
  it("the customer did not write it: the summary, the assumptions, the progress lines and the request line say «إكس» as product info", async () => {
    const { r, progress } = await run(["٥٠ تغريدة من حساب وزارة الصحة عن الشائعات"]);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const shown = JSON.stringify([r.plan.summary_ar, r.plan.assumptions_ar ?? [], r.plan.notes_ar ?? [], progress, (r.plan.compiled as unknown as { llm: { request_parts_ar: string[] } }).llm.request_parts_ar]);
    expect(shown).toContain("إكس");
    expect(progress.join(" ")).toContain("من إكس");
    expect(r.plan.summary_ar).toContain("٥٠");
  });
});

describe("item 7: the card's headline does not promise managers only when the people are ranked by role, not filtered", () => {
  const companies = { key: "companies", title_ar: "شركات المقاولات في الرياض", endpoint_id: "tomba.companies.search.reveal", expected_rows: 2, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [{ id: "kahromika-co.com", name: "شركة أ", website: "kahromika-co.com" }], measured_by: ["call_0001"] };
  const people = { key: "people", title_ar: "المديرون في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 6, parent_key: "companies", per_parent_rows: 3, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] };
  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "contracting" } }],
    ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.001, rows: 2, params: { website: "kahromika-co.com", perPage: 2, page: 0 } }],
  ]);
  const catalog = loadTregCatalog();
  const lookupOf = (requestText: string): PlanLookup => ({
    call: (id) => calls.get(id) ?? null, evidenceText: () => "kahromika-co.com https://kahromika-co.com person-1 person-2", endpointAllowed: () => true, requestText,
    endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null, endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]),
  });
  const planOf = (summary_ar: string, requestText: string) => {
    const r = validateAndPricePlan({ summary_ar, stages: [companies, people] }, lookupOf(requestText));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("refused");
    return r.plan;
  };
  const ASK = "عايز شركتين مقاولات في الرياض ومن كل شركة ٣ من المديرين";
  it("the model's sentence that names the role is preserved in the summary when role_preference is set, backed by roleLineAr honest fallback and file marking on the card", () => {
    const plan = planOf("شركتا مقاولات في الرياض مع ثلاثة من مديريها.", ASK);
    expect(plan.stages.find((s) => s.key === "people")!.role_preference).toEqual({ role: "manager" });
    expect(plan.summary_ar).toContain("مديريها");
    expect(plan.summary_ar).toContain("شركتا مقاولات في الرياض");
    expect(plan.summary_ar).not.toContain("العميل");
    const card = customerPlanView(plan);
    const notesJson = JSON.stringify(card.notes_ar ?? []);
    expect(notesJson).toContain("نستخرج مديرين في كل شركة");
    expect(notesJson).toContain("يكتمل العدد");
    expect(notesJson).toMatch(/صانع القرار/);
  });
  it("a sentence that names no role is kept as the model wrote it; the other sentences of a summary are kept and third-person «العميل» is removed", () => {
    expect(planOf("شركتا مقاولات في الرياض.", ASK).summary_ar).toBe("شركتا مقاولات في الرياض.");
    const mixed = planOf("العميل عايز شركتا مقاولات في الرياض مع ثلاثة من مديريها. نجمع ما يعرضه المصدر.", ASK).summary_ar;
    expect(mixed).toContain("نجمع ما يعرضه المصدر.");
    expect(mixed).toContain("مديريها");
    expect(mixed).not.toContain("العميل");
  });
  it("a plan whose people stage carries no role preference no longer headlines a role either (DT-20261119-03 R4 supersedes keeping it)", () => {
    const r = validateAndPricePlan({ summary_ar: "شركتا مقاولات في الرياض مع ثلاثة من مديريها.", stages: [companies, { ...people, title_ar: "الأشخاص في كل شركة" }] }, lookupOf("عايز شركتين مقاولات في الرياض ومعاهم أشخاص"));
    if (r.ok) expect(r.plan.stages.find((s) => s.key === "people")!.role_preference).toBeUndefined();
    if (r.ok) expect(r.plan.summary_ar).not.toContain("مديريها");
  });
  it("FIX1 (Gate 2 P2): a kept sentence that already names the companies is not repeated; «إدارة» in a sentence about the companies' trade is not a role claim", () => {
    const repeat = planOf("نجمع شركات المقاولات في الرياض. ثلاثة من مديريها.", ASK).summary_ar;
    expect(repeat.match(/شركات المقاولات في الرياض/g)).toHaveLength(1);
    expect(repeat).toContain("مديريها");
    expect(repeat).not.toContain("العميل");
    expect(planOf("شركات إدارة العقارات في الرياض فقط.", ASK).summary_ar).toBe("شركات إدارة العقارات في الرياض فقط.");
  });
});
