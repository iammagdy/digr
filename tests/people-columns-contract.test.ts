import { describe, expect, it } from "vitest";
import { bilingualName, bilingualTitle, titleArabic } from "../src/lib/agentMission/titleLexicon";
import { NAMES_BATCH, NAME_AR_KEY, isArabicName, namesPrompt, parseNames, runNamesStep } from "../agent/src/namesAr";
import { companiesWithoutDecisionMakers } from "../agent/src/perParentLimits";
import { NAMES_STEP_USD_PER_PERSON } from "../src/lib/agentMission/constants";
import { stagePriceInputs, type PricedStage } from "../src/lib/agentMission/plan";
import { llmCostFromUsage } from "../agent/src/llmCost";
import { MODEL_HAIKU } from "../src/lib/agentMission/constants";

/**
 * AUDIT 2026-11 §6 PR 1 part c: the people's columns of the reference (A, columns 7 and 8 and the notes): a decision maker's title and name as «العربية (English)», the per-company note «لم نجد صناع قرار في هذه الشركة», and the price of the one names request.
 */
describe("job titles as «العربية (English)», by a code lexicon", () => {
  it("the common titles of the A1 world are read, with the English kept in brackets", () => {
    expect(bilingualTitle("Chief Executive Officer")).toBe("الرئيس التنفيذي (Chief Executive Officer)");
    expect(bilingualTitle("Chairman")).toBe("رئيس مجلس الإدارة (Chairman)");
    expect(bilingualTitle("Managing Director")).toBe("العضو المنتدب (Managing Director)");
    expect(bilingualTitle("General Manager")).toBe("المدير العام (General Manager)");
    expect(bilingualTitle("Director of Operations")).toBe("مدير العمليات (Director of Operations)");
    expect(bilingualTitle("Operations Manager")).toBe("مدير العمليات (Operations Manager)");
    expect(bilingualTitle("Head of Projects")).toBe("رئيس قسم المشاريع (Head of Projects)");
    expect(bilingualTitle("Finance Manager")).toBe("مدير المالية (Finance Manager)");
    expect(bilingualTitle("Plant Manager")).toBe("مدير المصنع (Plant Manager)");
    expect(bilingualTitle("Founder & CEO")).toBe("المؤسس والرئيس التنفيذي (Founder & CEO)");
    expect(bilingualTitle("Engineer II")).toBe("مهندس (Engineer II)");
    expect(bilingualTitle("Senior Sales Manager")).toBe("كبير مدير المبيعات (Senior Sales Manager)");
  });
  it("a title the table cannot read is NOT guessed (the English alone); an Arabic or empty title is kept as it is", () => {
    expect(titleArabic("Chief Happiness Wizard")).toBeNull();
    expect(bilingualTitle("Chief Happiness Wizard")).toBe("Chief Happiness Wizard");
    expect(bilingualTitle("مدير المشتريات")).toBe("مدير المشتريات");
    expect(bilingualTitle("")).toBe("");
    expect(bilingualTitle(null)).toBe("");
    // two roles where one cannot be read: nothing is half translated
    expect(bilingualTitle("Founder & Chief Happiness Wizard")).toBe("Founder & Chief Happiness Wizard");
  });
  it("a name is «العربية (English)» only when an Arabic spelling is known; an Arabic name is kept", () => {
    expect(bilingualName("Mohamed Saied", "محمد سعيد")).toBe("محمد سعيد (Mohamed Saied)");
    expect(bilingualName("Mohamed Saied", "")).toBe("Mohamed Saied");
    expect(bilingualName("Mohamed Saied", "Mohamed")).toBe("Mohamed Saied");
    expect(bilingualName("محمد سعيد", "محمد سعيد")).toBe("محمد سعيد");
  });
});

describe("the names: one batched request, read by code", () => {
  it("the answer must be exactly as many strings as names; an item that is not an Arabic spelling is dropped (the English stays), the rest are kept", () => {
    expect(parseNames('["محمد سعيد","Mona","منى علي"]', 3)).toEqual(["محمد سعيد", "", "منى علي"]);
    expect(parseNames('here: ["محمد سعيد"]', 1)).toEqual(["محمد سعيد"]);
    expect(parseNames('["محمد سعيد"]', 2)).toBeNull();
    expect(parseNames("no array", 1)).toBeNull();
    expect(isArabicName("محمد سعيد")).toBe(true);
    expect(isArabicName("محمد 5")).toBe(false);
    expect(isArabicName("a")).toBe(false);
  });
  it("the prompt carries the names as numbered data", () => {
    expect(namesPrompt(["Karim orascom", "Mona nile"])).toBe("Names:\n1. Karim orascom\n2. Mona nile");
  });

  /** A tiny item store: the accepted rows of one stage, and what was committed. */
  const fakeItems = (rows: Array<Record<string, unknown>>) => {
    const committed: any[] = [];
    return { committed, store: { acceptedRows: () => rows, commit: async (ops: any[]) => { committed.push(...ops); }, mirror: async () => {} } as any };
  };
  const plan = { stages: [{ key: "companies", deliver: true, parent_key: null, columns: [{ key: "name" }] }, { key: "people", deliver: true, parent_key: "companies", role_preference: { role: "manager" }, columns: [{ key: "full_name", title_ar: "اسم صانع القرار" }] }] };
  it("one request for the people of a mission; the Arabic spellings are stored as cells of their rows; the cost comes from the API's own usage", async () => {
    const rows = [{ id: "p1", full_name: "Karim Orascom" }, { id: "p2", full_name: "Mona Nile" }, { id: "p3", full_name: "محمد سعيد" }];
    const { committed, store } = fakeItems(rows);
    const calls: any[] = [];
    const usage = { input_tokens: 400, output_tokens: 100 };
    const out = await runNamesStep({ items: store, plan, call: async (input) => { calls.push(input); return { text: '["كريم أوراسكوم","منى النيل"]', usage }; } });
    expect(calls.length).toBe(1);
    expect(calls[0].user).toContain("1. Karim Orascom");
    expect(calls[0].user).not.toContain("محمد");
    expect(out.named).toBe(2);
    expect(out.costUsd).toBeCloseTo(llmCostFromUsage(MODEL_HAIKU, usage), 12);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(committed).toEqual([{ t: "cells", stage: "people", id: "p1", cells: { [NAME_AR_KEY]: "كريم أوراسكوم" } }, { t: "cells", stage: "people", id: "p2", cells: { [NAME_AR_KEY]: "منى النيل" } }]);
  });
  it("no request at all for a plan with no decision-maker stage, and a failed or unusable answer leaves every name as the source gave it (no throw, no cell)", async () => {
    const rows = [{ id: "p1", full_name: "Karim Orascom" }];
    const none = fakeItems(rows);
    const noPeople = await runNamesStep({ items: none.store, plan: { stages: [{ key: "companies", deliver: true, parent_key: null, columns: [{ key: "name" }] }] }, call: async () => { throw new Error("must not be called"); } });
    expect(noPeople.calls).toBe(0);
    for (const answer of [null, { text: "sorry", usage: {} }, { text: '["a"]', usage: {} }]) {
      const { committed, store } = fakeItems(rows);
      const out = await runNamesStep({ items: store, plan, call: async () => answer as never });
      expect(out.named).toBe(0);
      expect(committed).toEqual([]);
    }
    const thrown = fakeItems(rows);
    expect((await runNamesStep({ items: thrown.store, plan, call: async () => { throw new Error("down"); } })).named).toBe(0);
  });
  it("a name that already has its spelling (a resumed run) is not asked again, and a batch holds at most NAMES_BATCH names", async () => {
    const { store } = fakeItems([{ id: "p1", full_name: "Karim Orascom", [NAME_AR_KEY]: "كريم أوراسكوم" }]);
    expect((await runNamesStep({ items: store, plan, call: async () => { throw new Error("must not be called"); } })).calls).toBe(0);
    const many = Array.from({ length: NAMES_BATCH + 5 }, (_, i) => ({ id: `p${i}`, full_name: `Name Number${i}` }));
    const sizes: number[] = [];
    await runNamesStep({ items: fakeItems(many).store, plan, call: async (input) => { sizes.push(input.user.split("\n").length - 1); return null; } });
    expect(sizes).toEqual([NAMES_BATCH, 5]);
  });
});

describe("the note «لم نجد صناع قرار في هذه الشركة»: from the delivered people's titles, company by company", () => {
  const person = (parent: string, title: string) => ({ parent_id: parent, job_title: title });
  it("a company is marked when none of its delivered people holds a decision-maker title, or when it has no delivered person at all", () => {
    const people = [person("a", "Chief Executive Officer"), person("a", "Accountant"), person("b", "Engineer"), person("b", "Technician"), person("d", "Operations Manager")];
    expect([...companiesWithoutDecisionMakers(["a", "b", "c", "d"], people, "manager")].sort()).toEqual(["b", "c"]);
  });
  it("only for the decision makers' role (other roles have no such note)", () => {
    expect([...companiesWithoutDecisionMakers(["a"], [person("a", "Engineer")], "engineer")]).toEqual([]);
  });
});

describe("the names are in the price, by code", () => {
  const base = { key: "people", title_ar: "x", endpoint_id: "e", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [], sample_rows: [], measured_by: [], planned_rows: 10, measured_cost_per_row_usd: 0.001, measured_from_calls: [] } as unknown as PricedStage;
  it("a delivered decision-maker stage costs the names step's estimate more per person; any other stage costs what it did", () => {
    const manager = stagePriceInputs([{ ...base, role_preference: { role: "manager" } } as PricedStage])[0].costPerRowUsd;
    const plain = stagePriceInputs([base])[0].costPerRowUsd;
    expect(manager - plain).toBeCloseTo(NAMES_STEP_USD_PER_PERSON, 12);
    expect(NAMES_STEP_USD_PER_PERSON).toBeGreaterThan(0);
    expect(NAMES_STEP_USD_PER_PERSON).toBeLessThan(0.0005);
    const engineers = stagePriceInputs([{ ...base, role_preference: { role: "engineer" } } as PricedStage])[0].costPerRowUsd;
    expect(engineers).toBeCloseTo(plain, 12);
  });
});
