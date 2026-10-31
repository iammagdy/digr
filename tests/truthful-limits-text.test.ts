import { describe, expect, it } from "vitest";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { shortfallClauseAr, stageTruthBodyAr, zeroDeliveryReasonAr } from "../agent/src/finalize";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * THE LIMITS AND EXCLUSION TEXT TELLS THE TRUTH FROM RECORDED COUNTS. Live re-test 2026-10-31 (A1 msn_e750…, A2 msn_6fe6…): the people stage read 31 (A1) / 41 with 9 repeats (A2) rows, every one was left out by our own row rule, and the delivered file said
 * «سُلّم ٠ من ١٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب» (the source did return people) while the mission's closing sentence and notice said «المراجعة الآلية بلغت حدّها المسموح» (the 10 surplus companies of ANOTHER stage were waiting for a review
 * nobody needed: the sentence read the pending items of every stage, not of the stage that fell short).
 */
const person = { key: "people", title_ar: "موظفو كل شركة", endpoint_id: "blitzapi.people.waterfall-icp", expected_rows: 10, planned_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, columns: [{ key: "full_name", title_ar: "الاسم" }, { key: "job_title", title_ar: "المسمى الوظيفي" }], role_preference: { role: "manager" } };
const companies = { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00001, columns: [{ key: "name", title_ar: "اسم الشركة" }] };
const plan = { summary_ar: "x", stages: [companies, person] as any, price: { totalCostUsd: 0, deliveredRows: 15, costPerFinalRowUsd: 0.0001, unitPricePoints: 13.3, reservePoints: 200, maxChargePoints: 200, overCap: false } as any } as PricedPlan;
const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 0, duplicates: 0, accepted: 0, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 0, excludedByReason: {}, stop: "source_exhausted", ...over });
const facts = (people: StageRecord, extra: Partial<MissionFacts> = {}): MissionFacts => ({ requestText: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار", deliveredAt: new Date("2026-10-31T12:00:00Z"), reviewStop: null, stages: { companies: record({ found: 50, accepted: 5, excluded: 34, pending: 10, excludedByReason: { review_no: 34 }, stop: "target_reached" }), people }, ...extra });
const limitsOf = (f: MissionFacts, got: { companies: number; people: number }): string[] => {
  const rowsByStage = { companies: Array.from({ length: got.companies }, (_, i) => ({ id: `c${i}` })), people: Array.from({ length: got.people }, (_, i) => ({ id: `p${i}` })) };
  const m = buildMethodology({ plan, layouts: [], rowsByStage, facts: f });
  return m.items.find((i) => i.label === "حدود هذا التسليم")!.values;
};
const OLD_CLAIM = "المصدر لم يعد يعطي نتائج أخرى";

describe("the limits row of the delivered file (live A1 and A2: people read, all left out, «the source gave no more»)", () => {
  it("A1: 31 people found, none delivered: it says how many were found, that none was delivered and why; it never says the source ran dry", () => {
    const v = limitsOf(facts(record({ found: 31, excluded: 31, excludedByReason: { no_verified_contact: 31 } })), { companies: 5, people: 0 }).join("\n");
    expect(v).toContain("سُلّم ٠ من ١٠");
    expect(v).toContain("وُجد ٣١ شخصًا");
    expect(v).toContain("ولم يُسلَّم ٣١");
    expect(v).toContain("٣١ لا اسم شخص فيه ولا بيانات تواصل موثّقة");
    expect(v).not.toContain(OLD_CLAIM);
  });

  it("A2: 41 read, 9 repeats removed, 32 people found, none delivered: the repeats are told apart from the people", () => {
    const v = limitsOf(facts(record({ found: 41, duplicates: 9, excluded: 32, excludedByReason: { no_verified_contact: 32 } })), { companies: 5, people: 0 }).join("\n");
    expect(v).toContain("وُجد ٣٢ شخصًا (بعد إزالة ٩ مكررًا)");
    expect(v).toContain("ولم يُسلَّم ٣٢");
    expect(v).not.toContain(OLD_CLAIM);
  });

  it("some delivered, some left out for different reasons: each reason has its own count", () => {
    const v = limitsOf(facts(record({ found: 31, accepted: 3, excluded: 28, excludedByReason: { not_a_person: 20, no_verified_contact: 8 } })), { companies: 5, people: 3 }).join("\n");
    expect(v).toContain("سُلّم ٣ من ١٠: وُجد ٣١ شخصًا، ولم يُسلَّم ٢٨:");
    expect(v).toContain("٢٠ لا يخص شخصًا بعينه (بريد عام أو اسم جهة أو بلا اسم");
    expect(v).toContain("٨ لا اسم شخص فيه ولا بيانات تواصل موثّقة");
  });

  it("when the source really gave no more (everything it gave was delivered, or only what does not match the request was left out) the old sentence is still the true one", () => {
    const v = limitsOf(facts(record({ found: 7, accepted: 7, stop: "source_exhausted" })), { companies: 5, people: 7 }).join("\n");
    expect(v).toContain("سُلّم ٧ من ١٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب.");
    const w = limitsOf(facts(record({ found: 12, accepted: 7, excluded: 5, excludedByReason: { no_term: 5 }, stop: "source_exhausted" })), { companies: 5, people: 7 }).join("\n");
    expect(w).toContain("لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب");
  });

  it("the surplus companies a review never needed are not reported as a review that ran out: the table says the count was reached", () => {
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { companies: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })), people: [] }, facts: facts(record({ found: 31, excluded: 31, excludedByReason: { no_verified_contact: 31 } })) });
    const companiesRow = m.table.rows.find((r) => r[0] === companies.title_ar)!;
    expect(companiesRow[4]).toContain("بقي ١٠ دون مراجعة لأن العدد المطلوب اكتمل");
    expect(companiesRow[4]).not.toContain("فلم يُسلَّم");
    expect(m.reasons.join("\n")).toContain("٣١ لا اسم شخص فيه ولا بيانات تواصل موثّقة");
  });
});

describe("every new sentence is customer-safe: Arabic only, Arabic-Indic digits, no provider, no endpoint, no money figure", () => {
  const cases: StageRecord[] = [
    record({ found: 31, excluded: 31, excludedByReason: { no_verified_contact: 31 } }),
    record({ found: 41, duplicates: 9, excluded: 32, excludedByReason: { no_verified_contact: 32 } }),
    record({ found: 31, accepted: 3, excluded: 28, pending: 4, excludedByReason: { not_a_person: 20, no_verified_contact: 8 } }),
  ];
  it.each(cases.map((c, i) => [i, c] as const))("limits row %i and its closing clause", (_i, c) => {
    const lines = [...limitsOf(facts(c, { reviewStop: "budget" }), { companies: 5, people: c.accepted }), `إذ ${stageTruthBodyAr({ found: c.found, duplicates: c.duplicates, delivered: c.accepted, excludedByReason: c.excludedByReason, pending: c.pending, reviewStop: "budget", stop: c.stop, people: true })}`];
    for (const line of lines) {
      expect(checkCustomerText(line, { maxChars: 1100 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
      expect(line).not.toMatch(/tomba|blitz|aviato|aiark|anyapi|endpoint|USD|\$|claude|haiku|call_\d{4}|msn_/i);
    }
  });
});

describe("the wording of the reasons and of the zero-delivery sentence", () => {
  it("stageTruthBodyAr: the counts come from the record; it is null when the source gave nothing", () => {
    expect(stageTruthBodyAr({ found: 0, duplicates: 0, delivered: 0, excludedByReason: {}, pending: 0, reviewStop: null, stop: "source_exhausted", people: true })).toBeNull();
    expect(stageTruthBodyAr({ found: 31, duplicates: 0, delivered: 3, excludedByReason: { not_a_person: 28 }, pending: 0, reviewStop: null, stop: "source_exhausted", people: true })).toContain("وُجد ٣١ شخصًا");
  });
  it("a stage short only because the review could not reach its own items still says the review ran out (a pending count of ANOTHER stage never does)", () => {
    expect(shortfallClauseAr("review_limit", { pending: 5, stop: "budget" })).toContain("بلغت حدّها المسموح");
    expect(stageTruthBodyAr({ found: 40, duplicates: 0, delivered: 10, excludedByReason: { not_a_person: 5 }, pending: 25, reviewStop: "budget", stop: "review_limit", people: true })).toContain("بقي ٢٥ دون مراجعة لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة");
  });
  it("the zero-delivery reason for the contact rule names what it was, not «a contact that was not verified» for a person", () => {
    const text = zeroDeliveryReasonAr({ found: 5, excludedByReason: { no_verified_contact: 5 }, pending: 0, reviewStop: null });
    expect(text).toContain("لا اسم شخص فيه ولا بيانات تواصل موثّقة");
  });
});

describe("replay: the closing sentence and the notice use the short stage's own counts (live: 10 surplus companies made the people stage's shortfall «the review ran out»)", () => {
  const COMPANIES = "tomba.companies.search.reveal";
  const PEOPLE = "blitzapi.people.waterfall-icp";
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const request = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";
  const SLUGS = ["orascom-em", "nile-em", "delta-em", "cairo-em", "suez-em"];
  const linkedinOf = (slug: string) => `https://linkedin.example/company/${slug}`;
  const company = (slug: string, i: number) => ({ id: linkedinOf(slug), name: `${["Orascom", "Nile", "Delta", "Cairo", "Suez"][i]} Electromechanical`, website_url: `${slug}.com.eg`, linkedin_url: linkedinOf(slug), city: "Cairo" });
  // five companies the rule accepts and ten the rule cannot decide: the room is full after the first five, so the ten wait and are never reviewed (live: pending 10)
  const extra = Array.from({ length: 10 }, (_, i) => ({ id: `https://linkedin.example/company/foo-${i}`, name: `Foo Trading ${i}`, website_url: `foo${i}.com.eg`, linkedin_url: `https://linkedin.example/company/foo-${i}`, city: "Cairo" }));
  const companiesPage = { data: { companies: [...SLUGS.map(company), ...extra] } };
  const personRow = (slug: string, n: number, name: string, title: string) => ({ person: { full_name: name, linkedin_url: `https://www.linkedin.example/in/${slug}-${n}`, experiences: [{ job_title: title, company_name: slug }] } });
  // each company: ONE real decision maker and two rows with no name and no contact (the shape of the live files that were all dropped)
  const peopleOf = (slug: string) => ({ results: [personRow(slug, 0, `Manager of ${slug}`, "General Manager"), personRow(slug, 1, "", ""), personRow(slug, 2, "", "")] });
  const answer = (o: TregCallOptions) => { const s = SLUGS.find((x) => JSON.stringify(o.params ?? {}).includes(x)); return tregResult(s ? peopleOf(s) : { results: [] }, 0.0005); };
  const columnsOf = (...c: Array<[string, string, string?]>) => c.map(([key, title_ar, kind]) => ({ key, title_ar, ...(kind ? { kind } : {}) }));
  const planning = (): FakeStep[] => [
    { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))", files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["General Manager"] }], max_results: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0002.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: '', phone: '' }; })", files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (res: Results) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة أبرز صناع القرار فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية.",
      stages: [
        { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: columnsOf(["name", "اسم الشركة"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]),
          relevance: { subject_ar: "شركات الكهروميكانيكا", terms: ["electromechanical"], entity: true, review: true, text_columns: ["name"], min_own_words: 0 }, yield_from: firstOutputId(res),
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Electromechanical", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true,
          columns: columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]),
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-0", full_name: "Manager of orascom-em", job_title: "General Manager", company: "orascom-em", linkedin: "https://www.linkedin.example/in/orascom-em-0", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
    }) },
  ];
  const run = () => replay({
    request, planning: planning(), execution: () => [],
    answers: [tregResult(companiesPage, 0.0005), tregResult(peopleOf("orascom-em"), 0.0005), tregResult(companiesPage, 0.0005), ...Array.from({ length: 12 }, () => answer)],
    deps: (base) => ({ ...base, reviewCall: (async () => ({ text: "[]", usage: { input_tokens: 1, output_tokens: 1 } })) as any }),
  });

  it("5 companies + 5 managers delivered; the closing sentence and the notice say what the people stage found and left out, never that the review ran out", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 10, expectStatus: "partial" });
    const summary = String(r.mission.summary_ar);
    expect(summary).not.toContain("المراجعة الآلية بلغت حدّها");
    expect(summary).not.toContain(OLD_CLAIM);
    expect(summary).toContain("وُجد ١٥ شخصًا");
    expect(summary).toContain("ولم يُسلَّم ١٠");
    expect(String(r.notices[0].facts.shortfallClauseAr)).toContain("وُجد ١٥ شخصًا");
    expect(String(r.notices[0].facts.shortfallClauseAr)).not.toContain("المراجعة الآلية");
  });
});
