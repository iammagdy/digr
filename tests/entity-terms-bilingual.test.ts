import { describe, expect, it, vi } from "vitest";
import { replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords } from "./helpers/agentRelevance";
import { companyRuleTerms, sectorEnglishWords, sectorWordsOf } from "../src/lib/agentMission/entities";
import { classifyRowDetailed, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { anthropicReviewCall, parseVerdicts } from "../agent/src/review";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * LIVE INCIDENT 2026-10-31 15:48 (Cairo): the rule for «5 Egyptian electromechanical companies» held the terms ["مصريه","قطاع","الكهروميكانيكا","معاهم"] (a nationality, the word «sector» and «with them» are the request's frame, not the
 * sector) and no English word, while the source names its companies in English («mechanical and electrical construction company»): not one row matched, all 50 went to the model review. The sector is now built from the request in Arabic AND
 * English, the request's frame words are dropped, and a clear row is accepted by the rule alone.
 */
const OWNER = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";

describe("the sector of a companies request", () => {
  it("the request's frame words are not the sector: «قطاع», «مصرية» (a place), «معاهم» and the people clause are dropped", () => {
    expect(sectorWordsOf(OWNER)).toEqual(["الكهروميكانيكا"]);
    expect(sectorWordsOf("عايز ٥ شركات مصرية في قطاع البترول")).toEqual(["البترول"]);
    expect(sectorWordsOf("هات لي شركات سعودية في مجال المقاولات ومعاهم المديرين")).toEqual(["المقاولات"]);
  });
  it("the sector is also written in English, the way a company source names its companies", () => {
    const en = sectorEnglishWords("الكهروميكانيكا");
    for (const w of ["electromechanical", "electro-mechanical", "mechanical and electrical"]) expect(en).toContain(w);
    expect(sectorEnglishWords("البترول")).toEqual(expect.arrayContaining(["petroleum", "oil"]));
    expect(sectorEnglishWords("كلمة غريبة")).toEqual([]);
  });
  it("the terms of a company rule: the model's frame words out, the request's sector in Arabic and English in, never more than the limit", () => {
    const terms = companyRuleTerms(["مصريه", "قطاع", "الكهروميكانيكا", "معاهم"], OWNER);
    for (const filler of ["مصريه", "قطاع", "معاهم"]) expect(terms).not.toContain(filler);
    expect(terms).toEqual(expect.arrayContaining(["الكهروميكانيكا", "electromechanical", "electro-mechanical", "mechanical and electrical"]));
    expect(terms.length).toBeLessThanOrEqual(12);
    // a rule that already says everything is left as it is
    expect(companyRuleTerms(["oil", "petroleum", "بترول"], "عايز ٥ شركات في قطاع البترول")).toEqual(expect.arrayContaining(["oil", "petroleum", "بترول"]));
  });
});

describe("a clear row is accepted by the rule alone", () => {
  const spec = (): RelevanceSpec => ({ subject_ar: "شركات مصريه قطاع الكهروميكانيكا", terms: companyRuleTerms(["مصريه", "قطاع", "الكهروميكانيكا", "معاهم"], OWNER), text_columns: ["name", "description"], min_own_words: 0, review: true, entity: true });
  it("English and Arabic rows that name the sector match; a row that does not still goes to the model, never straight out", () => {
    const s = spec();
    expect(classifyRowDetailed(s, { name: "KAHROMIKA", description: "KAHROMIKA is a mechanical and electrical construction company." }).verdict).toBe("match");
    expect(classifyRowDetailed(s, { name: "Nile Electro-Mechanical Works", description: "" }).verdict).toBe("match");
    expect(classifyRowDetailed(s, { name: "شركة الكهروميكانيكا الحديثة", description: "" }).verdict).toBe("match");
    expect(classifyRowDetailed(s, { name: "Nile Bakery", description: "bread and pastry" }).verdict).toBe("review");
  });
});

describe("the plan keeps the sector terms and the run needs no model for clear rows", () => {
  const COMPANIES = "aiark.companies.search";
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const page = (names: string[]) => ({ content: names.map((name, i) => ({ id: `co${i + 1}`, name, domain: `company${i + 1}.example`, location: { country: "مصر" } })) });
  const SAMPLED = ["Kahromika Electromechanical Co", "Nile Electro-Mechanical Works"];
  const CLEAR = ["Kahromika Electromechanical Co", "Nile Electro-Mechanical Works", "Delta Mechanical & Electrical Contracting"];
  it("filler terms written by the model never reach the stored rule; three clear English rows are delivered with no review call", async () => {
    const review = vi.fn(async () => { throw new Error("the model review must not be asked for clear rows"); });
    const r = await replay({
      request: "عايز ٣ شركات مصرية في قطاع الكهروميكانيكا",
      planning: [
        { tool: "report_progress", args: { message_ar: "أبحث عن مصدر الشركات", counts: { sources: 3 } } },
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "describe_endpoint", args: { id: COMPANIES } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))", files: [callIds(res)[0]] }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر.",
          stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }],
            sample_rows: SAMPLED.map((text, i) => ({ id: `co${i + 1}`, text, url: `company${i + 1}.example` })), measured_by: [callIds(res)[0]], yield_from: "out_0001",
            relevance: aboutWords(["مصريه", "قطاع", "الكهروميكانيكا", "معاهم", "electromechanical"], { entity: true, review: true }) }],
        }) } as FakeStep,
      ],
      execution: () => [],
      deps: (base) => ({ ...base, reviewCall: review as never }),
      answers: [tregResult(page(SAMPLED), 0.0005267), ...Array.from({ length: 6 }, () => tregResult(page(CLEAR), 0.0005267))],
    });
    const terms = (r.plannedPlan.stages[0].relevance as RelevanceSpec).terms;
    for (const filler of ["مصريه", "قطاع", "معاهم"]) expect(terms).not.toContain(filler);
    expect(terms).toEqual(expect.arrayContaining(["الكهروميكانيكا", "electromechanical", "electro-mechanical"]));
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(3);
    expect(review).not.toHaveBeenCalled();
  });
});

describe("the answer shape of the review is enforced", () => {
  const okResponse = (content: unknown[]) => ({ ok: true, json: async () => ({ content, usage: { input_tokens: 100, output_tokens: 10 } }) }) as never;
  it("the request forces one tool whose input is an array of exactly n zeros and ones; the tool's answer is read as the array", async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return okResponse([{ type: "tool_use", name: "verdicts", input: { verdicts: [1, 0, 1] } }]); });
    const call = anthropicReviewCall("test-key", fetchFn as never);
    const res = await call({ model: "m", system: "s", user: "u", maxTokens: 100, rows: 3 });
    expect(bodies[0].tool_choice).toEqual({ type: "tool", name: "verdicts" });
    const schema = bodies[0].tools[0].input_schema.properties.verdicts;
    expect(schema).toMatchObject({ type: "array", minItems: 3, maxItems: 3, items: { type: "integer", enum: [0, 1] } });
    expect(parseVerdicts(res!.text, 3)).toEqual([true, false, true]);
  });
  it("a plain-text answer (no tool block) is still read as before; a request that names no row count sends no tool", async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return okResponse([{ type: "text", text: "[1,1]" }]); });
    const call = anthropicReviewCall("test-key", fetchFn as never);
    expect(parseVerdicts((await call({ model: "m", system: "s", user: "u", maxTokens: 100, rows: 2 }))!.text, 2)).toEqual([true, true]);
    await call({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(bodies[1].tools).toBeUndefined();
  });
  it("when the API refuses the tool request (HTTP 400), the same call is made once without the tool", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? ({ ok: false, status: 400, json: async () => ({}) } as never) : okResponse([{ type: "text", text: "[0,1]" }])));
    const call = anthropicReviewCall("test-key", fetchFn as never);
    const res = await call({ model: "m", system: "s", user: "u", maxTokens: 100, rows: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(parseVerdicts(res!.text, 2)).toEqual([false, true]);
  });
});
