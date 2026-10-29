import { describe, expect, it } from "vitest";
import { excludesGovernment, governmentVerdict, hostsOf, isPublicHost, textGovernmentVerdict } from "../src/lib/agentMission/government";
import { filterLineAr, filterVerdict, governmentUnclear, promiseIssues, type StageFilter } from "../src/lib/agentMission/filters";
import { exactPlaceLabelAr, placeCellKind, placeCellsAr, PLACE_NOT_STATED_AR } from "../src/lib/agentMission/places";
import { ingestRows } from "../agent/src/items/ingest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * C. THE CARD'S EXCLUSIONS ON TOP-LEVEL ITEMS ARE ENFORCED («بدون جهات حكومية»): government, military and public research bodies are recognised from EVIDENCE in the row (the website's suffix, the name, the description), and a body that MAY be public
 * goes to the model check. The place cells are written in Arabic and never left empty when the card promised the place.
 */
describe("government bodies are recognised from the row's own evidence", () => {
  it("public suffixes: .gov, .mil, .edu and the country forms (mod.gov.eg, hbrc.edu.eg, army.mil, ox.ac.uk, go.jp); a company's domain is not one", () => {
    for (const h of ["mod.gov.eg", "hbrc.edu.eg", "army.mil", "nasa.gov", "ox.ac.uk", "mof.go.jp", "service-public.gouv.fr"]) expect(isPublicHost(h), h).toBe(true);
    for (const h of ["orascom.com", "redseaconstruction.com", "goal.com", "go.com", "academy.com", "arabcont.example.com", "gov.com"]) expect(isPublicHost(h), h).toBe(false);
    expect(hostsOf("https://www.hbrc.edu.eg/en/about?x=1")).toEqual(["hbrc.edu.eg"]);
  });

  it("names: a ministry, an authority, the armed forces, a governorate are public (definite); a research institute or a university MAY be (unclear); a contractor is neither", () => {
    expect(textGovernmentVerdict("Egyptian Armed Forces Engineering Authority")).toBe("government");
    expect(textGovernmentVerdict("Ministry of Housing")).toBe("government");
    expect(textGovernmentVerdict("وزارة الإسكان والمجتمعات العمرانية")).toBe("government");
    expect(textGovernmentVerdict("الهيئة الهندسية للقوات المسلحة")).toBe("government");
    expect(textGovernmentVerdict("محافظة القاهرة")).toBe("government");
    expect(textGovernmentVerdict("Housing and Building National Research Institute")).toBe("unclear");
    expect(textGovernmentVerdict("مركز بحوث البناء")).toBe("unclear");
    expect(textGovernmentVerdict("Cairo University")).toBe("unclear");
    expect(textGovernmentVerdict("Orascom Construction")).toBe("ok");
    expect(textGovernmentVerdict("The Arab Contractors")).toBe("ok");
    expect(textGovernmentVerdict("شركة المقاولون العرب")).toBe("ok");
  });

  it("the item's verdict reads every evidence field: a domain alone decides; a plain name stays ok", () => {
    const f = ["website", "name", "description"];
    expect(governmentVerdict({ website: "https://mod.gov.eg", name: "Engineering Authority", description: "" }, f)).toBe("government");
    expect(governmentVerdict({ website: "https://hbrc.edu.eg", name: "Construction and Project Management Research Institute" }, f)).toBe("government");
    expect(governmentVerdict({ website: "https://orascom.com", name: "Orascom Construction", description: "Engineering and construction" }, f)).toBe("ok");
    expect(governmentVerdict({ website: "https://x.com", name: "Building Research Centre" }, f)).toBe("unclear");
    expect(governmentVerdict({ website: "", name: "", description: "" }, f)).toBe("ok");
  });

  it("the request's words: «بدون جهات حكومية», «دون الجهات الحكومية», «غير حكومية», «ما عدا الهيئات الحكومية»; not a request for government bodies", () => {
    for (const t of ["عايز ٣ شركات مقاولات بدون جهات حكومية", "شركات دون الجهات الحكومية", "شركات خاصة غير حكومية", "ما عدا الهيئات الحكومية", "بدون جهات عسكرية"]) expect(excludesGovernment(t), t).toBe(true);
    for (const t of ["عايز ٣ شركات مقاولات في مصر", "هات الجهات الحكومية في مصر", "شركات تتعامل مع الحكومة"]) expect(excludesGovernment(t), t).toBe(false);
  });
});

describe("the filter and the card's promise", () => {
  const filter: StageFilter = { kind: "exclude_government", fields: ["website", "name"] };
  it("a government body is rejected with its reason; a private company passes; a body that may be public is flagged for the model check, not rejected", () => {
    expect(filterVerdict([filter], { website: "https://mod.gov.eg", name: "X" }, { textKey: null, now: 0 })).toBe("filter_government");
    expect(filterVerdict([filter], { website: "https://orascom.com", name: "Orascom Construction" }, { textKey: null, now: 0 })).toBeNull();
    expect(filterVerdict([filter], { website: "https://x.com", name: "Building Research Centre" }, { textKey: null, now: 0 })).toBeNull();
    expect(governmentUnclear([filter], { website: "https://x.com", name: "Building Research Centre" })).toBe(true);
    expect(governmentUnclear([filter], { website: "https://orascom.com", name: "Orascom Construction" })).toBe(false);
    // switched off by the customer: neither applied nor flagged
    expect(filterVerdict([{ ...filter, enabled: false }], { website: "https://mod.gov.eg" }, { textKey: null, now: 0 })).toBeNull();
    expect(governmentUnclear([{ ...filter, enabled: false }], { name: "Cairo University" })).toBe(false);
    expect(filterLineAr(filter)).toBe("دون الجهات الحكومية والعسكرية.");
  });

  it("a card sentence that promises it without the filter is refused (no promise without a check); with the filter on it is accepted", () => {
    const sentences = [{ where: "assumptions_ar[0]", text: "شركات خاصة بدون جهات حكومية." }];
    expect(promiseIssues(sentences, [{ key: "companies", filters: [], hasRelevance: true }]).join(" ")).toMatch(/promises/);
    expect(promiseIssues(sentences, [{ key: "companies", filters: [filter], hasRelevance: true }])).toEqual([]);
  });
});

describe("the place cells of a row", () => {
  it("Latin or coded place names become Arabic when the table knows them", () => {
    expect(exactPlaceLabelAr("al qahirah", "city")).toBe("القاهرة");
    expect(exactPlaceLabelAr("Cairo", "city")).toBe("القاهرة");
    expect(exactPlaceLabelAr("Cairo Governorate", "region")).toBe("القاهرة");
    expect(exactPlaceLabelAr("Alexandria", "city")).toBe("الإسكندرية");
    expect(exactPlaceLabelAr("EG", "country")).toBe("مصر");
    expect(exactPlaceLabelAr("Egypt", "country")).toBe("مصر");
    // a street address, or a place the table does not know, is left as the source wrote it
    expect(exactPlaceLabelAr("12 Tahrir Street, Dokki, Giza", "city")).toBeNull();
    expect(exactPlaceLabelAr("Faiyum", "city")).toBeNull();
    expect(placeCellKind({ key: "city", title_ar: "المدينة" })).toBe("city");
    expect(placeCellKind({ key: "x", title_ar: "الدولة" })).toBe("country");
    expect(placeCellKind({ key: "name", title_ar: "الاسم" })).toBeNull();
  });

  const columns = [{ key: "name", title_ar: "الاسم" }, { key: "country", title_ar: "الدولة" }, { key: "city", title_ar: "المدينة" }];
  it("an empty cell is never delivered when the card promised the place: the country from the proof, the city from another field of the item, else «غير مذكورة في المصدر»", () => {
    const promised = { places: ["EG"], fields: ["country", "city", "address", "website"] };
    const a: Record<string, unknown> = { name: "A", country: "", city: "" };
    placeCellsAr(a, columns, { name: "A", country: "", city: "", address: "5 Nasr City, Cairo", website: "https://a.com.eg" }, promised);
    expect(a).toMatchObject({ country: "مصر", city: "القاهرة" });
    const b: Record<string, unknown> = { name: "B", country: "EG", city: "" };
    placeCellsAr(b, columns, { name: "B", country: "EG", city: "", website: "https://b.com" }, promised);
    expect(b).toMatchObject({ country: "مصر", city: PLACE_NOT_STATED_AR });
    // not promised: only the Arabic spelling, empty stays empty
    const c: Record<string, unknown> = { name: "C", country: "EG", city: "" };
    placeCellsAr(c, columns, { name: "C", country: "EG", city: "" }, null);
    expect(c).toMatchObject({ country: "مصر", city: "" });
  });
});

describe("the model check for a body that MAY be public (ingest)", () => {
  const plan = { summary_ar: "x", stages: [], price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } } as unknown as PricedPlan;
  const stage = {
    key: "companies", title_ar: "شركات المقاولات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
    columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }, { key: "description", title_ar: "نبذة" }],
    relevance: { subject_ar: "شركات مقاولات", terms: ["contracting", "construction"], text_columns: ["name", "description"], entity: true, review: true },
    filters: [{ kind: "exclude_government", fields: ["website", "name", "description"] }],
  } as never;
  const rows = [
    { id: "a", name: "Nile Contracting", website: "https://nile.example.com", description: "contracting company" },
    { id: "b", name: "Building Research Centre for Construction", website: "https://brc.example.com", description: "construction research" },
    { id: "c", name: "Mod Contracting Authority", website: "https://mod.gov.eg", description: "construction" },
  ];
  it("the clearly private company is delivered by rule, the one that may be public goes to the model (told the customer wants no government bodies), the clearly public one is excluded", async () => {
    const items = await ItemStore.open(createMemoryStore(), "msn_gov", { legacyStages: ["companies"] });
    const asked: Array<{ subject: string; ids: string[] }> = [];
    const reviewer = { budgetUsd: 1, state: async () => ({ stop: null }) as never, review: async ({ subject, rows: r }: { subject: string; rows: Array<{ id: string }> }) => { asked.push({ subject, ids: r.map((x) => x.id) }); return new Map(r.map((x) => [x.id, false])); } };
    const result = await ingestRows({ items, plan, addEvent: async () => undefined, reviewer: reviewer as never }, stage, rows, { silent: true, idField: null });
    expect(items.acceptedRows("companies").map((r) => r.id)).toEqual(["a"]);
    expect(asked).toHaveLength(1);
    expect(asked[0].ids).toEqual(["b"]);
    expect(asked[0].subject).toContain("ليست جهة حكومية");
    expect(items.counts("companies").excludedByReason.filter_government).toBe(1);
    expect(result.counts.accepted).toBe(1);
  });
});
