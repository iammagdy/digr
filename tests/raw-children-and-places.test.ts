import { describe, expect, it } from "vitest";
import { validateAndPricePlan, customerPlanView, type PlanLookup } from "../src/lib/agentMission/plan";
import { classifyRowDetailed } from "../src/lib/agentMission/relevance";
import { filterVerdict } from "../src/lib/agentMission/filters";
import { placeVerdict, placesInText } from "../src/lib/agentMission/places";
import { requestNamesSector, sectorWordsOf } from "../src/lib/agentMission/entities";
import { childCardTitleAr, childRuleLinesAr } from "../src/lib/agentMission/childItems";
import { platformCostNotesAr } from "../src/lib/agentMission/platformNotes";
import { contentFingerprint, deriveItemId } from "../src/lib/agentMission/contract";
import { bindQuantity, parseQuantities } from "../src/lib/agentMission/quantity";

/**
 * FIX MISSION 5. The items of a CHILD stage (comments, replies, reviews, employees) are raw; the place a card names is enforced from the items' own fields; a company of another trade goes to the model check; a dear platform still gets its card
 * with one honest sentence. The unit level (the engine replays are in raw-children-engine.test.ts).
 */
describe("places and countries: found in the request, proved on the item", () => {
  it("the request's own words name the country or the city", () => {
    expect(placesInText("عايز ١٠ شركات مقاولات في مصر").map((p) => p.key)).toEqual(["EG"]);
    expect(placesInText("عايز ٥ مطاعم في القاهرة").map((p) => p.key)).toEqual(["EG:cairo"]);
    expect(placesInText("شركات في الإسكندرية والرياض").map((p) => p.key).sort()).toEqual(["EG:alexandria", "SA:riyadh"]);
    expect(placesInText("هات ٣٠٠ تغريدة عن محمد صلاح")).toEqual([]);
    expect(placesInText("شركات في لوكسمبورغ").map((p) => p.key)).toEqual(["LU"]);
  });

  it("an item passes with the place in a location field, a country suffix of its website or a phone prefix; another country or nothing fails", () => {
    const eg = ["EG"];
    const fields = ["country", "address", "url", "phone"];
    expect(placeVerdict(eg, { country: "مصر" }, fields)).toBe("pass");
    expect(placeVerdict(eg, { country: "Egypt" }, fields)).toBe("pass");
    expect(placeVerdict(eg, { address: "12 Tahrir Square, Cairo, Egypt" }, fields)).toBe("pass");
    expect(placeVerdict(eg, { country: "Luxembourg" }, fields)).toBe("other_place");
    expect(placeVerdict(eg, { country: "Luxembourg", url: "https://acme.com.eg" }, fields)).toBe("other_place");
    expect(placeVerdict(eg, { country: "", url: "https://acme.com.eg" }, fields)).toBe("pass");
    expect(placeVerdict(eg, { url: "https://acme.lu" }, fields)).toBe("other_place");
    expect(placeVerdict(eg, { url: "https://acme.com" }, fields)).toBe("no_evidence");
    expect(placeVerdict(eg, { phone: "+20 100 123 4567" }, fields)).toBe("pass");
    expect(placeVerdict(eg, { phone: "+352 621 123" }, fields)).toBe("other_place");
    expect(placeVerdict(eg, { phone: "0100 123 4567" }, fields)).toBe("no_evidence");
    expect(placeVerdict(eg, {}, fields)).toBe("no_evidence");
    // a text that names both the place and another country is the place's
    expect(placeVerdict(eg, { address: "Egypt and Luxembourg" }, fields)).toBe("pass");
    // a city is asked for: the country alone is no evidence of it, the city is
    expect(placeVerdict(["EG:cairo"], { address: "Giza, Egypt" }, fields)).toBe("no_evidence");
    expect(placeVerdict(["EG:cairo"], { address: "التجمع الخامس، القاهرة" }, fields)).toBe("pass");
    expect(placeVerdict(["EG:cairo"], { address: "Alexandria, Egypt" }, fields)).toBe("no_evidence");
  });

  it("the filter of the card rejects what the evidence rejects, with its own reason", () => {
    const f = { kind: "place" as const, field: "country", fields: ["country", "url"], places: ["EG"], values: ["مصر"] };
    expect(filterVerdict([f], { country: "مصر" }, { textKey: null, now: 0 })).toBeNull();
    expect(filterVerdict([f], { country: "Luxembourg" }, { textKey: null, now: 0 })).toBe("filter_place");
    expect(filterVerdict([f], { country: "" }, { textKey: null, now: 0 })).toBe("filter_place");
  });
});

describe("companies: the kind of company is checked, an exhibition or another trade goes to the model", () => {
  const spec = { subject_ar: "شركات مقاولات", terms: ["مقاولات", "contracting", "construction"], text_columns: ["text"], min_own_words: 0, entity: true };
  const verdict = (text: string, s: typeof spec | Omit<typeof spec, "entity"> = spec) => classifyRowDetailed(s as never, { text }).verdict;

  it("a company that names the sector is accepted by rule; one that does not, and an event, is sent to the check", () => {
    expect(verdict("شركة النيل للمقاولات العامة")).toBe("match");
    expect(verdict("Orascom Construction")).toBe("match");
    // another trade: the check decides (a contractor does not always say so in its name)
    expect(verdict("Egytic Sports")).toBe("review");
    // an exhibition whose name carries the sector word
    expect(verdict("Big 5 Construction Egypt - the international exhibition for construction")).toBe("review");
    expect(verdict("مؤتمر المقاولات العربي السنوي")).toBe("review");
    // a bare name with no words of its own is not «a mention» for an entity
    expect(verdict("Orascom Construction")).toBe("match");
  });

  it("without the entity flag nothing changes: a row with no term is left out, as before", () => {
    const { entity: _e, ...plain } = spec;
    void _e;
    expect(verdict("Egytic Sports", plain)).toBe("exclude");
  });

  it("the sector words of a request are found by code", () => {
    expect(sectorWordsOf("عايز ١٠ شركات مقاولات في مصر")).toEqual(["مقاولات"]);
    expect(requestNamesSector("هات ٥ شركات في مصر")).toBe(false);
    expect(requestNamesSector("عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين بإيميلاتهم")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the plan check
const call = (id: string, endpointId: string, costUsd: number, rows: number) => ({ id, endpointId, ok: true, costUsd, rows });
function lookupFor(requestText: string, calls: Array<ReturnType<typeof call>>): PlanLookup {
  const byId = new Map(calls.map((c) => [c.id, c]));
  return { call: (id) => byId.get(id) ?? null, evidenceText: () => "co1 co2 co1-p1 https://c.example/1 https://c.example/2 post1 post1-c1 فيديو", endpointAllowed: () => true, requestText };
}

describe("a plan for companies in a country: the place is a filter the items must prove", () => {
  const stages = (mapped: string[]) => [
    { key: "companies", title_ar: "الشركات", endpoint_id: "aiark.companies.search", expected_rows: 10, parent_key: null, deliver: true, columns: mapped.map((k) => ({ key: k, title_ar: k === "text" ? "اسم الشركة" : k === "country" ? "الدولة" : k === "url" ? "الموقع" : "النص" })), sample_rows: [{ id: "co1", ...Object.fromEntries(mapped.map((k) => [k, k === "url" ? "https://c.example/1" : k === "country" ? "مصر" : "شركة النيل للمقاولات"])) }], measured_by: ["call_0001"] },
  ];
  const lk = lookupFor("عايز ١٠ شركات مقاولات في مصر", [call("call_0001", "aiark.companies.search", 0.0005, 10)]);

  it("with a country field mapped the plan gets the place filter from the request and a sector rule built by code", () => {
    const r = validateAndPricePlan({ summary_ar: "ستحصل على شركات مقاولات في مصر.", stages: stages(["text", "country"]) }, lk);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const st = r.plan.stages[0];
    const place = st.filters?.find((f) => f.kind === "place");
    expect(place).toMatchObject({ places: ["EG"], values: ["مصر"], field: "country" });
    expect(place?.enabled).not.toBe(false);
    expect(st.relevance).toMatchObject({ entity: true, terms: expect.arrayContaining(["مقاولات"]), text_columns: ["text"] });
    const view = customerPlanView(r.plan);
    expect(view.assumptions_ar).toContain("في: مصر.");
    expect(view.edit.stages[0].filters.some((f) => f.kind === "place" && f.enabled)).toBe(true);
  });

  it("with no field that can carry the place the plan is refused (the card must not promise what no code can check)", () => {
    const r = validateAndPricePlan({ summary_ar: "ستحصل على شركات مقاولات في مصر.", stages: stages(["text"]) }, lk);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(!r.ok && r.issues)).toContain("evidence of it from a mapped field");
  });

  it("a request that names no place and no sector has neither the filter nor the rule", () => {
    const r = validateAndPricePlan({ summary_ar: "ستحصل على شركات.", stages: stages(["text"]) }, lookupFor("هات ٥ شركات", [call("call_0001", "aiark.companies.search", 0.0005, 10)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages[0].filters?.some((f) => f.kind === "place")).toBeFalsy();
    expect(r.plan.stages[0].relevance).toBeUndefined();
  });
});

describe("a plan with a parent and its children: the children are raw, the card says so, the dear platform is said honestly", () => {
  const base = (child: Record<string, unknown>, platform = "facebook") => ({
    summary_ar: "ستحصل على منشورات وتعليقاتها.",
    stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: `justoneapi.x.${platform}-search-post-v1`, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }], sample_rows: [{ id: "post1", text: "غلاء الأسعار منشور" }], measured_by: ["call_0001"], relevance: { subject_ar: "غلاء الأسعار", terms: ["غلاء الأسعار"], text_columns: ["text"], min_own_words: 0 } },
      { key: "comments", title_ar: "التعليقات", endpoint_id: `scrapecreators.x.v1-${platform}-post-comments`, expected_rows: 50, parent_key: "posts", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }], sample_rows: [{ id: "post1-c1", text: "Great post" }], measured_by: ["call_0002"], ...child },
    ],
  });
  const lk = lookupFor("هات ٥ بوستات فيسبوك عن غلاء الأسعار، ومع كل بوست ١٠ تعليقات", [call("call_0001", "justoneapi.x.facebook-search-post-v1", 0.02952, 5), call("call_0002", "scrapecreators.x.v1-facebook-post-comments", 0.00188, 10)]);
  // the sample page of the posts, mapped: the stage's `yield_from` is not needed for the child
  const withYield = (plan: ReturnType<typeof base>) => ({ ...plan, stages: [{ ...plan.stages[0], yield_from: "out_0001" }, plan.stages[1]] });
  const lkYield: PlanLookup = { ...lk, evidenceText: (id) => (id === "out_0001" ? JSON.stringify([{ id: "post1", text: "غلاء الأسعار منشور" }, { id: "post2", text: "غلاء الأسعار منشور آخر" }]) : lk.evidenceText(id)) };

  it("a relevance rule and a language or place filter given on the CHILD stage are not applied; the parent keeps its own", () => {
    const r = validateAndPricePlan(withYield(base({ relevance: { subject_ar: "غلاء الأسعار", terms: ["غلاء"], text_columns: ["text"] }, filters: [{ kind: "language", lang: "ar" }, { kind: "place", values: ["مصر"] }] })), lkYield);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [posts, comments] = r.plan.stages;
    expect(comments.relevance).toBeUndefined();
    expect(comments.filters?.some((f) => f.kind === "language" || f.kind === "place") ?? false).toBe(false);
    expect(comments.yield_share).toBeUndefined();
    // the posts are text items of an Arabic request: the one language rule applies to them, as before
    expect(posts.filters?.some((f) => f.kind === "language" && f.lang === "ar" && f.enabled !== false)).toBe(true);
  });

  it("the card says the children are collected as they are, names the parent in the child's title, and tells the honest cost sentence for Facebook", () => {
    const r = validateAndPricePlan(withYield(base({})), lkYield);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = customerPlanView(r.plan);
    expect(view.notes_ar).toContain("تُجمع التعليقات كما هي على كل منشور، دون تصفية.");
    expect(view.notes_ar).toContain(platformCostNotesAr([{ endpoint_id: "justoneapi.x.facebook-search-post-v1" }])[0]);
    expect(view.stages[1].title_ar).toBe("التعليقات على منشورات");
    // no provider name, no technical word, Arabic digits only
    for (const line of view.notes_ar ?? []) { expect(line).not.toMatch(/[A-Za-z]{2,}/); expect(line).not.toMatch(/[0-9]/); }
    // a platform that is not dear has no such sentence
    const tt = validateAndPricePlan(base({}, "tiktok") as never, lkYield);
    expect(tt.ok && customerPlanView(tt.plan).notes_ar?.some((n) => n.includes("فيسبوك"))).toBeFalsy();
  });

  it("the card's lines are built by code from the nouns: comments, replies, reviews, employees", () => {
    const mk = (child: string, parent: string) => childRuleLinesAr([{ key: "p", title_ar: parent, parent_key: null, deliver: true }, { key: "c", title_ar: child, parent_key: "p", deliver: true }]);
    expect(mk("تعليقات كل فيديو", "الفيديوهات")).toEqual(["تُجمع التعليقات كما هي على كل فيديو، دون تصفية."]);
    expect(mk("التقييمات", "الأماكن")).toEqual(["تُجمع التقييمات كما هي على كل مكان، دون تصفية."]);
    expect(mk("موظفو كل شركة", "الشركات")).toEqual(["تُجمع الموظفون كما هي على كل شركة، دون تصفية."]);
    expect(childCardTitleAr({ title_ar: "تعليقات على فيديوهات عن الدوري المصري", parent_key: "p" }, [{ key: "p", title_ar: "الفيديوهات" }])).toBe("تعليقات على فيديوهات عن الدوري المصري");
  });
});

describe("an item with no id of its own, under a parent, is keyed within the parent", () => {
  it("the same words under two posts are two comments; under one post they are one only when nothing else tells them apart", () => {
    const row = { text: "تعليق واحد", author: "منى" };
    expect(deriveItemId(row, null, "post1")).not.toBe(deriveItemId(row, null, "post2"));
    expect(deriveItemId(row, null, "post1")).toBe(deriveItemId(row, null, "post1"));
    expect(contentFingerprint(row)).toBe(deriveItemId(row, null));
  });
});

describe("the quantity of the live Facebook request: five posts, ten comments of each", () => {
  const refs = (titles: string[]) => titles.map((t, i) => ({ index: i, title_ar: t, deliver: true }));
  it("«٥ بوستات» counts the posts, not the comments whose title names the post («تعليقات كل بوست»); «١٠ تعليقات» after «مع كل بوست» is per post", () => {
    const req = "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات";
    expect(bindQuantity(req, refs(["المنشورات", "تعليقات كل بوست"]))).toEqual({ index: 0, value: 5 });
    expect(bindQuantity(req, refs(["البوستات", "تعليقات كل بوست"]))).toEqual({ index: 0, value: 5 });
    expect(parseQuantities(req).map((q) => [q.value, q.perEach])).toEqual([[5, false], [10, true]]);
    expect(bindQuantity("عايز ٣ شركات كهروميكانيكا في مصر، وكل شركة موظفين اتنين", refs(["الشركات", "موظفو كل شركة"]))).toEqual({ index: 0, value: 3 });
    // the plain cases keep their meaning
    expect(bindQuantity("هات ٣٠٠ تغريدة عن محمد صلاح", refs(["التغريدات"]))).toEqual({ index: 0, value: 300 });
    expect(bindQuantity("عايز ٥٠٠ تعليق على فيديوهات الدوري", refs(["الفيديوهات", "تعليقات كل فيديو"]))).toEqual({ index: 1, value: 500 });
  });
});
