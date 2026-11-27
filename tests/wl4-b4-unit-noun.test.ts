import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { chooseTools, planWithLlm, type LlmPlannerDeps, type UnderstoodStep } from "../agent/src/llmPlanner/planner";
import { customerPlanView } from "../src/lib/agentMission/plan";
import endpointMetadataOverlay from "../data/treg/endpoint_metadata_overlay.json";
import { TOOL_CHOICE_SCHEMA, TOOL_CHOICE_SYSTEM, UNDERSTAND_SCHEMA } from "../agent/src/llmPlanner/prompts";
import { coerceItemNoun, GENERIC_ITEM_NOUN, ITEM_NOUNS, itemNounOfPlan, itemNounStored, knownItemNoun, UNIT_NOUN_SINGULARS, unitNounBySingular } from "../src/lib/agentMission/itemNoun";
import { stagesView } from "../src/lib/agentMission/customerView";
import { buildMissionNotice } from "../src/lib/agentMission/notices";

/**
 * DT-20261126-b4-unit-noun (D-0239 B4): the planning model writes the unit noun of every step in its TOOL CHOICE answer (the call that sees what a row of the chosen tool is), from the closed table; code validates it by exact match and carries it on the stage as `unit_noun_ar`, which outranks every older reading.
 * Stages without it read exactly as before. Nothing here reads a customer's words.
 */
const catalog = loadTregCatalog();
const place = knownItemNoun("مكان")!;
const article = knownItemNoun("مقال")!;

describe("B4: the unit noun of a step", () => {
  it("1. the tool-choice schema asks for it, required, from exactly the closed table (+ «عنصر»); the understanding schema is untouched (its property count is guarded by planner-schema-guard)", () => {
    const schema = TOOL_CHOICE_SCHEMA as any;
    expect(schema.required).toContain("unit_noun");
    expect(schema.properties.unit_noun.enum).toEqual([...ITEM_NOUNS.map((n) => n.singular), "عنصر"]);
    expect(TOOL_CHOICE_SYSTEM).toContain('"unit_noun"');
    expect(UNIT_NOUN_SINGULARS).toEqual([...ITEM_NOUNS.map((n) => n.singular), GENERIC_ITEM_NOUN.singular]);
    expect(JSON.stringify(UNDERSTAND_SCHEMA)).not.toContain("unit_noun");
  });

  it("2. exact match only: a table singular is accepted, a plural, a near spelling, a word outside the table and a non-string are not", () => {
    expect(unitNounBySingular("مكان")?.key).toBe(place.key);
    expect(unitNounBySingular("عنصر")).toBe(GENERIC_ITEM_NOUN);
    for (const bad of ["أماكن", "المكان", "مكانٌ", "صف", "سجل", "", " مكان", null, undefined, 5, {}]) expect(unitNounBySingular(bad as any)).toBeNull();
    for (const n of ITEM_NOUNS) expect(unitNounBySingular(n.singular)).toBe(n);
  });

  it("3. the stored shape reads back to the same noun, for every noun of the table", () => {
    for (const n of [...ITEM_NOUNS, GENERIC_ITEM_NOUN]) {
      const back = coerceItemNoun(itemNounStored(n))!;
      expect(back).toMatchObject({ singular: n.singular, dual: n.dual, dualGen: n.dualGen, plural: n.plural, tamyiz: n.tamyiz, feminine: n.feminine });
    }
  });

  it("4. chooseTools keeps the model's noun only when it is a noun of the table (else the step has none, and the step still stands); a later bad answer keeps an earlier good one", async () => {
    const mapsEp = catalog.endpoints.find((e: any) => e.id === "anyapi.google.serp.maps") as any;
    expect(mapsEp).toBeTruthy();
    const step = (): UnderstoodStep => ({ key: "companies", title_ar: "شركات المقاولات", platform: mapsEp.platform, capability: mapsEp.capability, parent: null, deliver: true, count: { total: 5, per_parent: null, all: false }, source: null, topic: "مقاولات", search_terms: ["مقاولات"], period: null });
    const run = async (st: UnderstoodStep, unit: unknown) => {
      const deps: any = { model: async () => ({ input: { options: [], ...(unit === undefined ? {} : { unit_noun: unit }) }, costUsd: 0 }), catalog, access: null, today: "2026-11-15" };
      await chooseTools(st, null, deps);
      return st;
    };
    expect((await run(step(), "شركة")).unit_noun).toBe("شركة");
    for (const bad of ["صف", "أماكن", 7, undefined]) expect((await run(step(), bad)).unit_noun ?? null).toBeNull();
    const kept = await run({ ...step(), unit_noun: "مكان" }, "سجل");
    expect(kept.unit_noun).toBe("مكان");
  });

  it("5. the live case: a companies step on a map endpoint whose endpoint noun says «مقال» reads «٥ شركات» when the model wrote «شركة», on the card and in the notice", () => {
    const company = itemNounStored(knownItemNoun("شركة")!);
    const articleStored = itemNounStored(article);
    const view = stagesView({ stages: [{ key: "companies", expected_rows: 5, title_ar: "نتائج الخرائط", item_noun_ar: articleStored, unit_noun_ar: company, deliver: true }] });
    expect(view.stages[0].rowsAr).toBe("٥ شركات");
    const plan = { stages: [{ key: "companies", title_ar: "نتائج الخرائط", deliver: true, parent_key: null, item_noun_ar: articleStored, unit_noun_ar: company }] };
    expect(itemNounOfPlan(plan).singular).toBe("شركة");
    expect(itemNounOfPlan({ stages: [{ ...plan.stages[0], unit_noun_ar: undefined }] }).singular).toBe("مقال"); // what the live card said before: the endpoint's noun
    const notice = buildMissionNotice("completed", { delivered: 5, planned: 5, chargedPoints: 50, releasedPoints: 0, reservedPoints: 50, hasJob: true, stages: [{ titleAr: "نتائج الخرائط", delivered: 5, planned: 5, item_noun_ar: articleStored, unit_noun_ar: company }] });
    expect(notice.body).toContain("٥ شركات");
    expect(notice.body).not.toContain("مقال");
  });

  it("6. the model's noun wins over the title's words, and the title still serves a stage that has none (counter-case, until B5)", () => {
    const withModel = stagesView({ stages: [{ expected_rows: 5, title_ar: "تغريدات عن المقاولات", unit_noun_ar: itemNounStored(place), deliver: true }] });
    expect(withModel.stages[0].rowsAr).toBe("٥ أماكن");
    const notice = buildMissionNotice("completed", { delivered: 5, planned: 5, chargedPoints: 50, releasedPoints: 0, reservedPoints: 50, hasJob: true, stages: [{ titleAr: "تغريدات عن المقاولات", delivered: 5, planned: 5, unit_noun_ar: itemNounStored(place) }] });
    expect(notice.body).toContain("٥ أماكن");
    const none = stagesView({ stages: [{ expected_rows: 5, title_ar: "التغريدات", deliver: true }] });
    expect(none.stages[0].rowsAr).toBe("٥ تغريدات");
    const generic = stagesView({ stages: [{ expected_rows: 5, title_ar: "نتائج", unit_noun_ar: itemNounStored(GENERIC_ITEM_NOUN), deliver: true }] });
    expect(generic.stages[0].rowsAr).toBe("٥ عناصر");
  });
});

// the same scripted-model harness as tests/llm-first-planner.test.ts (a fixture, NOT a measure of the real model)
const tweet = (i: number) => ({ id: `19000000000000${String(i).padStart(4, "0")}`, text: `وزارة الصحة تنفي شائعة رقم ${i}`, authorName: "وزارة الصحة", authorUsername: "SaudiMOH", createdUtc: "2026-10-01T10:00:00.000Z", url: `https://x.com/SaudiMOH/status/${i}`, likeCount: 5, viewCount: 100 });
const xPage = (n: number, cursor: string | null) => ({ output: { data: { items: Array.from({ length: n }, (_, k) => tweet(k)), nextCursor: cursor } } });
const STEP = { key: "tweets", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true, count: { total: 50, per_parent: null, all: false }, source: { kind: "account", value: "SaudiMOH" }, topic: "الشائعات", search_terms: ["الشائعات", "شائعة", "شائعات", "إشاعة", "معلومات مغلوطة"], period: { from: "2021-11-15", to: "2026-11-15" } };
const CHOICE = { options: [{ endpoint_id: "anyapi.x.search.posts", params: { query: "(الشائعات OR شائعة) from:SaudiMOH since:2021-11-15 until:2026-11-16", limit: 50, queryType: "Latest" }, cursor_input: "cursor", parent_input: null, more_params: [] }] };
const MAP = { fields: { id: ["id"], text: ["text"], author: ["authorName"], username: ["authorUsername"], posted_at: ["createdUtc"], link: ["url"] }, link_template: null, extra: [] };

async function planWith(unit?: unknown) {
  const answers: Record<string, unknown[]> = { request_plan: [{ decision: "plan", understanding_ar: "تغريدات الوزارة", assumptions_ar: [], steps: [STEP] }], tool_choice: [{ ...CHOICE, ...(unit === undefined ? {} : { unit_noun: unit }) }], field_map: [MAP] };
  const deps: LlmPlannerDeps = {
    model: async ({ tool }) => { const next = (answers[tool?.name ?? "none"] ?? []).shift(); return next === undefined ? null : { input: next as any, costUsd: 0.01 }; },
    catalog, access: null, today: "2026-11-15",
    probe: async () => ({ ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 20, has_more: true, next_cursor: "c2", shape: null, first_rows: [], warnings: [], saved: "call_0001" }),
    readPage: async () => xPage(20, "c2"),
  };
  const r = await planWithLlm({ words: ["٥٠ تغريدة من حساب وزارة الصحة السعودية عن الشائعات"], request: "" }, deps);
  if (r.kind !== "plan") throw new Error(`expected a plan, got ${r.kind}`);
  return r.plan;
}

describe("B4: the planner carries the model's noun onto the stage and the card shows it", () => {
  const overlayNoun = (endpointMetadataOverlay as Record<string, any>)["anyapi.x.search.posts"]?.item_noun_ar;

  it("7. the model's noun is on the stage in the stored shape and in the customer view; the endpoint's own noun is left as it was", async () => {
    const plan = await planWith("منشور");
    expect(plan.stages[0].unit_noun_ar).toEqual(itemNounStored(knownItemNoun("منشور")!));
    const view = customerPlanView(plan) as any;
    expect(view.stages[0].unit_noun_ar.singular).toBe("منشور");
    expect(view.stages[0].item_noun_ar).toEqual(overlayNoun);
    expect(overlayNoun.singular).not.toBe("منشور");
  });

  it("8. counter-case: no noun (or one outside the table) → no stage noun and a customer view with no `unit_noun_ar` key: byte-for-byte what it was before", async () => {
    for (const unit of [undefined, "صف"]) {
      const plan = await planWith(unit);
      expect(plan.stages[0].unit_noun_ar).toBeUndefined();
      const stage = (customerPlanView(plan) as any).stages[0];
      expect("unit_noun_ar" in stage).toBe(false);
      expect(stage.item_noun_ar).toEqual(overlayNoun);
    }
  });
});
