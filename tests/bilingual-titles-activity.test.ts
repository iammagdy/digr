import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { cell, g1 } from "./helpers/g1World";
import { activityArabic, bilingualActivity, bilingualTitle, titleArabic } from "../src/lib/agentMission/titleLexicon";
import { ACTIVITY_AR_KEY, TITLE_AR_KEY, namesPrompt, runNamesStep } from "../agent/src/namesAr";
import { NAMES_STEP_USD_PER_PERSON } from "../src/lib/agentMission/constants";
import type { ReviewCall } from "../agent/src/review";

/**
 * F5 (golden G1, msn_ecca2a0d074fef9f4456): «مدير المبيعات (Sales Manager)» was right but «Business Owner», «Aftermarket Engineer», «Workforce Management», «Vendor Relationship Manager» stayed English only, and the activity column («Machinery Manufacturing») was English.
 * Every title and every activity is «العربية (English)»: the code lexicon first, then the SAME batched request that writes the names (its cost is added to the price by code) for what the lexicon misses.
 */
describe("F5: the lexicon reads the four live titles and the common activities", () => {
  it("the four titles of the live file", () => {
    expect(bilingualTitle("Business Owner")).toBe("صاحب العمل (Business Owner)");
    expect(bilingualTitle("Aftermarket Engineer")).toBe("مهندس خدمات ما بعد البيع (Aftermarket Engineer)");
    expect(bilingualTitle("Workforce Management")).toBe("إدارة القوى العاملة (Workforce Management)");
    expect(bilingualTitle("Vendor Relationship Manager")).toBe("مدير علاقات الموردين (Vendor Relationship Manager)");
    expect(titleArabic("Sales Manager")).toBe("مدير المبيعات");
  });
  it("an activity is «العربية (English)» when the table reads it, else the source's words; the model's spelling is used when the table cannot read it", () => {
    expect(bilingualActivity("Machinery Manufacturing", null)).toBe("تصنيع الآلات (Machinery Manufacturing)");
    expect(bilingualActivity("Electrical Equipment Manufacturing", null)).toBe("تصنيع المعدات الكهربائية (Electrical Equipment Manufacturing)");
    expect(activityArabic("Quantum Pastry Engineering")).toBeNull();
    expect(bilingualActivity("Quantum Pastry Engineering", null)).toBe("Quantum Pastry Engineering");
    expect(bilingualActivity("Quantum Pastry Engineering", "هندسة المعجنات الكمية")).toBe("هندسة المعجنات الكمية (Quantum Pastry Engineering)");
    expect(bilingualActivity("تصنيع الآلات", null)).toBe("تصنيع الآلات");
    expect(bilingualTitle("Chief Happiness Wizard", "كبير سحرة السعادة")).toBe("كبير سحرة السعادة (Chief Happiness Wizard)");
    expect(bilingualTitle("Chief Happiness Wizard", "Wizard")).toBe("Chief Happiness Wizard");
  });
});

describe("F5: what the lexicon misses goes in the same batched request as the names, deduplicated, and nothing else", () => {
  const plan = {
    stages: [
      { key: "companies", deliver: true, parent_key: null, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "activity", title_ar: "النشاط والتخصص" }] },
      { key: "people", deliver: true, parent_key: "companies", role_preference: { role: "manager" }, columns: [{ key: "full_name", title_ar: "اسم صانع القرار" }, { key: "job_title", title_ar: "المسمى الوظيفي" }] },
    ],
  };
  const companies = [{ id: "c1", name: "A", activity: "Quantum Pastry Engineering" }, { id: "c2", name: "B", activity: "Machinery Manufacturing" }, { id: "c3", name: "C", activity: "Quantum Pastry Engineering" }];
  const people = [{ id: "p1", parent_id: "c1", full_name: "Karim Orascom", job_title: "Chief Happiness Wizard" }, { id: "p2", parent_id: "c2", full_name: "Mona Nile", job_title: "Sales Manager" }, { id: "p3", parent_id: "c3", full_name: "Tamer Delta", job_title: "Chief Happiness Wizard" }];
  const fake = () => {
    const committed: any[] = [];
    return { committed, store: { acceptedRows: (k: string) => (k === "companies" ? companies : people), commit: async (ops: any[]) => { committed.push(...ops); }, mirror: async () => {} } as any };
  };
  it("one request: the three names, the one title the lexicon cannot read and the one activity it cannot read (each once)", async () => {
    const { committed, store } = fake();
    const prompts: string[] = [];
    const call: ReviewCall = async (input) => {
      prompts.push(input.user);
      const lines = input.user.split("\n").slice(1);
      const out = lines.map((l) => (/\[job title\]/.test(l) ? "كبير سحرة السعادة" : /\[activity\]/.test(l) ? "هندسة المعجنات الكمية" : "اسم عربي"));
      return { text: JSON.stringify(out), usage: { input_tokens: 300, output_tokens: 90 } };
    };
    const out = await runNamesStep({ items: store, plan, call });
    expect(prompts.length).toBe(1);
    expect(prompts[0].match(/\[job title\]/g)?.length).toBe(1);
    expect(prompts[0].match(/\[activity\]/g)?.length).toBe(1);
    expect(prompts[0]).not.toContain("Sales Manager");
    expect(prompts[0]).not.toContain("Machinery Manufacturing");
    expect(out.calls).toBe(1);
    expect(out.costUsd).toBeGreaterThan(0);
    const cellsOf = (stage: string, id: string) => Object.assign({}, ...committed.filter((o) => o.stage === stage && o.id === id).map((o) => o.cells));
    expect(cellsOf("people", "p1")[TITLE_AR_KEY]).toBe("كبير سحرة السعادة");
    expect(cellsOf("people", "p3")[TITLE_AR_KEY]).toBe("كبير سحرة السعادة");
    expect(cellsOf("companies", "c1")[ACTIVITY_AR_KEY]).toBe("هندسة المعجنات الكمية");
    expect(cellsOf("companies", "c3")[ACTIVITY_AR_KEY]).toBe("هندسة المعجنات الكمية");
    expect(cellsOf("people", "p2")[TITLE_AR_KEY]).toBeUndefined();
    expect(cellsOf("companies", "c2")[ACTIVITY_AR_KEY]).toBeUndefined();
  });
  it("an answer that is not Arabic for a title or an activity is dropped (the English stays); the prompt format of plain names is unchanged", async () => {
    const { committed, store } = fake();
    await runNamesStep({ items: store, plan, call: async (input) => ({ text: JSON.stringify(input.user.split("\n").slice(1).map((l) => (/\[/.test(l) ? "English words" : "اسم عربي"))), usage: {} }) });
    expect(committed.some((o) => o.cells[TITLE_AR_KEY] || o.cells[ACTIVITY_AR_KEY])).toBe(false);
    expect(namesPrompt(["Karim orascom", "Mona nile"])).toBe("Names:\n1. Karim orascom\n2. Mona nile");
  });
  it("the price carries the names, titles and activities step per delivered person by code", () => {
    expect(NAMES_STEP_USD_PER_PERSON).toBeGreaterThanOrEqual(0.00006);
  });
});

describe("F5: G1 replay: every title and every activity of the delivered file is «العربية (English)»", () => {
  const TITLES: Record<string, string[]> = {
    "orascom-em": ["Business Owner", "Aftermarket Engineer", "Chief Executive Officer"],
    "nile-em": ["Workforce Management", "Vendor Relationship Manager", "Managing Director"],
    "delta-em": ["Chief Happiness Wizard", "Chief Joy Officer", "Director of Operations"],
  };
  const ARABIC: Record<string, string> = { "Chief Happiness Wizard": "كبير سحرة السعادة" };
  const requested: string[] = [];
  const call: ReviewCall = async (input) => {
    if (input.rows) return { text: JSON.stringify(Array.from({ length: input.rows }, () => 1)), usage: { input_tokens: 10, output_tokens: 2 } };
    const lines = input.user.split("\n").slice(1).map((l) => l.replace(/^\d+\.\s*/, ""));
    requested.push(...lines);
    return { text: JSON.stringify(lines.map((l) => (/^\[job title\]/.test(l) ? ARABIC[l.replace(/^\[job title\]\s*/, "")] ?? "مسمى" : /^\[activity\]/.test(l) ? "نشاط" : "اسم عربي"))), usage: { input_tokens: 500, output_tokens: 200 } };
  };
  it("titles and activity: no cell stays English only", async () => {
    const r = await g1({ titles: TITLES as never, deps: (base) => ({ ...base, reviewCall: call }) });
    await assertReplayInvariants(r);
    const wb = await readWorkbook(r);
    const read = (i: number) => { const s = wb.worksheets[i]; const header = (s.getRow(1).values as unknown[]).map(cell); const at = (t: string) => header.indexOf(t); return (t: string) => Array.from({ length: s.rowCount - 1 }, (_, k) => cell(s.getRow(k + 2).getCell(at(t)).value)); };
    const titles = read(2)("المسمى الوظيفي");
    const activity = read(1)("النشاط والتخصص");
    const bilingual = /^[؀-ۿ][؀-ۿ\s]*\s\([^()]*[A-Za-z][^()]*\)$/;
    for (const t of [...titles, ...activity]) expect(t, t).toMatch(bilingual);
    expect(titles.length).toBe(10);
    expect(activity.length).toBe(5);
    // a title only the model could read carries its spelling, and a title the lexicon reads never went to the model
    for (const t of titles.filter((x) => /Wizard/.test(x))) expect(t).toBe("كبير سحرة السعادة (Chief Happiness Wizard)");
    expect(requested.join("\n")).not.toContain("Vendor Relationship Manager");
  });
});
