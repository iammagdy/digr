import { describe, expect, it } from "vitest";
import { alternativesOf, matchesAnyNamedSource, nameWords, sourceNameMatches, unresolvedSources, unresolvedSourcesLineAr } from "../src/lib/agentMission/namedSources";
import { onlyTimesAdded, withoutDayCut } from "../src/lib/agentMission/dateLoss";
import { addDays, dateWindowOf, dayOf, firstWindowEndDay, nextWindowEndDay, windowParams } from "../src/lib/agentMission/dateWindow";
import { isDomainOnly, withRealName } from "../src/lib/agentMission/companyNames";
import { neutralPeopleTitleAr } from "../src/lib/agentMission/roles";
import { exactPlaceLabelAr, isPlaceFragment, placeAskedOfSource, placeVerdict } from "../src/lib/agentMission/places";
import { createReviewer, parseVerdicts } from "../agent/src/review";
import { createMemoryStore } from "../agent/src/memoryStore";
import { loadTregCatalog } from "../src/lib/treg/catalog";

describe("a named source is matched by the NAME the customer wrote, on every platform", () => {
  it("the same name, or every word of it, whatever the order, the case, the Arabic article, the kind word and the handle's punctuation", () => {
    expect(sourceNameMatches("BBC News", "BBC News")).toBe(true);
    expect(sourceNameMatches("BBC News", "news bbc")).toBe(true);
    expect(sourceNameMatches("اليوم السابع", "اليوم السابع - Youm7")).toBe(true);
    expect(sourceNameMatches("اليوم السابع", "قناة اليوم السابع الرسمية")).toBe(true);
    expect(sourceNameMatches("العربية", "Al Arabiya العربية")).toBe(true);
    expect(sourceNameMatches("@AlAhly", "al_ahly")).toBe(true);
    expect(sourceNameMatches("@MoSalah", "mosalah")).toBe(true);
    // alternative spellings in one value
    expect(sourceNameMatches("اليوم السابع / Youm7", "Youm7 Live")).toBe(true);
    expect(alternativesOf("a | b، c")).toEqual(["a", "b", "c"]);
  });

  it("another source is not it", () => {
    expect(sourceNameMatches("العربية", "قناة الحدث")).toBe(false);
    expect(sourceNameMatches("BBC News", "BBC Arabic")).toBe(false);
    expect(sourceNameMatches("اليوم السابع", "")).toBe(false);
    expect(sourceNameMatches("اليوم السابع", null)).toBe(false);
    expect(matchesAnyNamedSource(["العربية", "BBC News"], "Sky News Arabia")).toBe(false);
    expect(nameWords("قناة الجزيرة الرسمية")).toEqual(["جزيره"]);
  });

  it("the named sources no sampled item belongs to are listed, and the card says so in Arabic", () => {
    expect(unresolvedSources(["العربية", "اليوم السابع", "BBC News"], ["BBC News", "اليوم السابع - Youm7", "Sky"])).toEqual(["العربية"]);
    expect(unresolvedSourcesLineAr(["العربية"])).toBe("لم نجد «العربية» بين ما فحصناه قبل عرض الخطة، فقد لا يصلك منه شيء. يمكنك تعديل الاسم قبل الاعتماد.");
    expect(unresolvedSourcesLineAr(["أ", "ب"])).toContain("«أ»، «ب»");
  });
});

describe("the model check judges the topic only, in the item's own language, and its answer is read in either shape", () => {
  it("the answer as one JSON array, or one line per row; a sentence that mentions «[1]» does not hide the array; a wrong count is no answer", () => {
    expect(parseVerdicts("[1, 0, 1]", 3)).toEqual([true, false, true]);
    expect(parseVerdicts("Row [1] is fine. Here: [1,0]", 2)).toEqual([true, false]);
    expect(parseVerdicts("1: 1\n2: 0\n3. yes", 3)).toEqual([true, false, true]);
    expect(parseVerdicts("1: 1\n2: 0", 3)).toBeNull();
    expect(parseVerdicts("1: 1\n1: 0", 2)).toBeNull();
    expect(parseVerdicts("لا أعرف", 2)).toBeNull();
    expect(parseVerdicts("[1, 2]", 2)).toBeNull();
  });

  it("the instruction says so, and the first words of an unusable answer are kept for the admin", async () => {
    const seen: string[] = [];
    const answers = ["I think the first one is about the topic.", "[1]"];
    const reviewer = createReviewer({ call: async ({ system }) => { seen.push(system); return { text: answers.shift() ?? "[1]", usage: { input_tokens: 10, output_tokens: 5 } }; }, store: createMemoryStore(), missionId: "msn_r", requestText: "x", budgetUsd: 1 });
    const verdicts = await reviewer.review({ subject: "الحرب", rows: [{ id: "a", text: "What next for the war in Iran?" }] });
    expect(verdicts.get("a")).toBe(true);
    expect(seen[0]).toContain("in the row's own language");
    expect(seen[0]).toContain("never reject a row because of the language");
    expect((await reviewer.state()).lastUnusable).toBe("I think the first one is about the topic.");
  });
});

describe("the time of a timestamp is not cut to a day by a mapping", () => {
  it("the three ways of cutting it are removed; a mapping with no cut is left alone", () => {
    const base = "date: new Date(r.createdUtc * 1000).toISOString()";
    expect(withoutDayCut(`${base}.slice(0,10)`)).toBe(base);
    expect(withoutDayCut(`${base}.slice( 0 , 10 )`)).toBe(base);
    expect(withoutDayCut(`${base}.substring(0, 10)`)).toBe(base);
    expect(withoutDayCut(`${base}.split('T')[0]`)).toBe(base);
    expect(withoutDayCut(`${base}.split("T")[0]`)).toBe(base);
    expect(withoutDayCut(`${base}`)).toBeNull();
    expect(withoutDayCut("date: String(r.day).slice(0,10)")).toBeNull();
  });

  it("the repair is accepted only when the rows are the same and every changed value is the same day with a time", () => {
    const before = [{ id: "1", date: "2026-10-29", n: 1 }];
    expect(onlyTimesAdded(before, [{ id: "1", date: "2026-10-29T17:21:03.000Z", n: 1 }])).toBe(true);
    expect(onlyTimesAdded(before, [{ id: "1", date: "2026-10-28T17:21:03.000Z", n: 1 }])).toBe(false);
    expect(onlyTimesAdded(before, [{ id: "1", date: "2026-10-29T17:21:03.000Z", n: 2 }])).toBe(false);
    expect(onlyTimesAdded(before, before)).toBe(false);
    expect(onlyTimesAdded(before, [])).toBe(false);
  });
});

describe("date windows from the catalog", () => {
  const catalog = loadTregCatalog();
  it("the X search documents «since:» and «until:» in its search text; the Facebook post search takes two days; a source with neither has no window", () => {
    expect(dateWindowOf(catalog.byId.get("anyapi.x.search.posts")!, { query: "x", limit: 50 })).toEqual({ kind: "query_operators", param: "query" });
    expect(dateWindowOf(catalog.byId.get("justoneapi.x.facebook-search-post-v1")!, { keyword: "x" })).toEqual({ kind: "range_params", from: "startDate", to: "endDate", format: "date" });
    expect(dateWindowOf(catalog.byId.get("crawl4ai.x.user.posts")!, { username: "AlAhly" })).toBeNull();
    // a date pair whose note does not say how a day is written is not used
    expect(dateWindowOf({ summary: "", inputs: [{ name: "startDate", in: "body", type: "string", required: false, enum: null, minimum: null, maximum: null, default: null, example: null, note: "start" }, { name: "endDate", in: "body", type: "string", required: false, enum: null, minimum: null, maximum: null, default: null, example: null, note: "end" }] } as any, {})).toBeNull();
  });

  it("the window's inputs: the search text keeps its words and gets the period's first day and the day AFTER the end (until is exclusive); a pair of inputs takes the days themselves", () => {
    const op = { kind: "query_operators" as const, param: "query" };
    expect(windowParams(op, { query: "(a OR b) since:2026-07-29 until:2026-10-30 lang:ar", limit: 50 }, "2026-07-29", "2026-10-27")).toEqual({ query: "(a OR b) lang:ar since:2026-07-29 until:2026-10-28", limit: 50 });
    expect(windowParams({ kind: "range_params", from: "startDate", to: "endDate", format: "date" }, { keyword: "k" }, "2026-07-29", "2026-10-27")).toEqual({ keyword: "k", startDate: "2026-07-29", endDate: "2026-10-27" });
    expect(windowParams({ kind: "range_params", from: "publishedAfter", to: "publishedBefore", format: "iso" }, {}, "2026-07-29", "2026-10-27")).toEqual({ publishedAfter: "2026-07-29T00:00:00Z", publishedBefore: "2026-10-27T23:59:59Z" });
    expect(firstWindowEndDay(op, { query: "x until:2026-10-30" }, Date.parse("2026-10-29T10:00:00Z"))).toBe("2026-10-29");
    expect(firstWindowEndDay(op, { query: "x" }, Date.parse("2026-10-29T10:00:00Z"))).toBe("2026-10-29");
  });

  it("the next window ends on the oldest day read; when that is no step back it ends the day before; it ends at the period's first day", () => {
    const ms = (d: string) => Date.parse(`${d}T12:00:00Z`);
    expect(nextWindowEndDay({ oldestMs: ms("2026-10-28"), lastEndDay: "2026-10-29", sinceDay: "2026-07-29" })).toBe("2026-10-28");
    expect(nextWindowEndDay({ oldestMs: ms("2026-10-29"), lastEndDay: "2026-10-29", sinceDay: "2026-07-29" })).toBe("2026-10-28");
    expect(nextWindowEndDay({ oldestMs: ms("2026-07-29"), lastEndDay: "2026-08-02", sinceDay: "2026-07-29" })).toBeNull();
    expect(nextWindowEndDay({ oldestMs: null, lastEndDay: "2026-10-29", sinceDay: "2026-07-29" })).toBeNull();
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayOf(Date.parse("2026-10-29T23:59:59Z"))).toBe("2026-10-29");
  });
});

describe("company data quality", () => {
  it("a name that is only a domain is recognised; a name with a word or a space is not", () => {
    for (const d of ["al-hashemiah.com.eg", "ecom.com.eg", "https://www.siac.com.eg/", "detac.eg"]) expect(isDomainOnly(d), d).toBe(true);
    for (const n of ["Orascom Construction", "Arab Contractors", "ecom.com.eg Ltd", "Al-Hashemiah", ""]) expect(isDomainOnly(n), n).toBe(false);
  });

  it("it is replaced from another name field of the same item, else it stays as given (no name is made up from the domain, the link or the description)", () => {
    const cols = [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }];
    expect(withRealName({ name: "al-hashemiah.com.eg", legal_name: "الهاشمية للمقاولات", website: "x" }, cols).name).toBe("الهاشمية للمقاولات");
    expect(withRealName({ name: "ecom.com.eg", display_name: "ecom.com.eg", description: "Egyptian Company for Contracting" }, cols).name).toBe("ecom.com.eg");
    const same = { name: "Orascom", website: "x" };
    expect(withRealName(same, cols)).toBe(same);
  });

  it("the sheet of the people does not promise managers when it only ranks by title (live: «موظفو الإدارة في كل شركة» held an accountant and a water-plant operator)", () => {
    expect(neutralPeopleTitleAr("موظفو الإدارة في كل شركة", "manager", "شركة")).toBe("موظفو كل شركة");
    expect(neutralPeopleTitleAr("المديرين في كل شركة", "manager", "شركة")).toBe("موظفو كل شركة");
    expect(neutralPeopleTitleAr("موظفو كل شركة", "manager", "شركة")).toBe("موظفو كل شركة");
    expect(neutralPeopleTitleAr("مهندسو الشركات", "engineer", "شركة")).toBe("موظفو كل شركة");
    expect(neutralPeopleTitleAr("الأشخاص المرتبطون بالشركة", "manager", "شركة")).toBe("الأشخاص المرتبطون بالشركة");
  });

  it("places: a district is written in Arabic; a stop word is not a place; a city of Egypt is evidence of Egypt; the source's own country filter is evidence too, unless the item names another country", () => {
    expect(exactPlaceLabelAr("Mokattam", "city")).toBe("المقطم");
    expect(exactPlaceLabelAr("Sheikh Zayed Egypt", "city")).toBe("الشيخ زايد");
    expect(exactPlaceLabelAr("القاهرة مصر", "city")).toBe("القاهرة");
    expect(isPlaceFragment("Of")).toBe(true);
    expect(isPlaceFragment("n/a")).toBe(true);
    expect(isPlaceFragment("-")).toBe(true);
    expect(isPlaceFragment("Cairo")).toBe(false);
    expect(isPlaceFragment("Tanta")).toBe(false);
    expect(placeVerdict(["EG"], { city: "Giza" }, ["city"])).toBe("pass");
    expect(placeVerdict(["EG"], { city: "" }, ["city"])).toBe("no_evidence");
    expect(placeVerdict(["EG"], { city: "" }, ["city"], { bySource: true })).toBe("pass");
    expect(placeVerdict(["EG"], { city: "Luxembourg" }, ["city"], { bySource: true })).toBe("other_place");
    expect(placeAskedOfSource(["EG"], { page: 1, filters: { industry: { include: ["Construction"] }, location_country: { include: ["EG"] } } })).toBe(true);
    expect(placeAskedOfSource(["EG"], { query: "construction companies in Egypt" })).toBe(false);
    expect(placeAskedOfSource(["EG"], { country: "DE" })).toBe(false);
  });
});
