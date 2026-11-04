import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildB2BAsk } from "../src/lib/agentMission/stage3/b2bAsk";
import { buildB2BDelivery } from "../src/lib/agentMission/stage3/b2bDelivery";
import { compileB2BPlan, B2B_NOT_SEARCHED_AR, type Attempt } from "../src/lib/agentMission/stage3/b2bCompile";
import { NOT_AVAILABLE_AR } from "../src/lib/agentMission/taskContracts";
import { SUMMARY_SHEET_AR } from "../src/lib/modelPlanner/missionWorkbook";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * STAGE 3 S2 and S4 (docs/STAGE-3.md): THE B2B DELIVERY, pure. From the compiled B2B plan, the company rows and what each lookup answered per row, it writes the contact cells (the fallthrough:
 * «غير متوفر» only after every tool of a chain was tried, «لم يكتمل البحث» otherwise), the mark columns, removes EXACT duplicates only, and states every gap and mark as a line for the file's
 * «حدود هذا التسليم». No row is ever removed except an exact duplicate. Rows: the clearly fake companies of tests/fixtures/extraction/companies-electricity-eg.json (example.eg sites), with
 * made-up sizes and founding years; the file is built by the real `buildMissionFiles` (no real call).
 */
const fixture = (JSON.parse(readFileSync(new URL("./fixtures/extraction/companies-electricity-eg.json", import.meta.url), "utf8")) as { rows: Array<{ row: Record<string, string> }> }).rows.map((r) => r.row);
const employees: unknown[] = ["51-200", "11-50", "11-100", 120, undefined];
const founded: unknown[] = [2018, "2010", undefined, 2016, 2020];
const base = fixture.slice(0, 5).map((r, i) => ({ id: r.id, name: r.company_name, activity: r.industry, hq: r.location, website: r.website, employees: employees[i], founded: founded[i] }));
// 7 rows in: the five, an EXACT copy of the first (removed) and a near copy of the second that differs in one character (kept: no fuzzy matching)
const rowsIn = [...base, { ...base[0] }, { ...base[1], id: "co_2_near", website: `${base[1].website}/` }];

const ask = buildB2BAsk("هات ٥ شركات كهرباء في مصر عدد موظفيها أكثر من ٥٠ وتأسست بعد ٢٠١٥")!;
const plan = (() => { const r = compileB2BPlan(ask); if (!r.ok) throw new Error(r.reason); return r; })();
const V = (endpointId: string, value: string): Attempt => ({ endpointId, outcome: "value", value });
const E = (endpointId: string, outcome: "empty" | "failed" | "refused"): Attempt => ({ endpointId, outcome });
const MAPS = "crawl4ai.google.serp.maps";
const attempts = {
  hq_phone: { co_1: [V(MAPS, "+20 2 0000 0001")], co_2: [E(MAPS, "empty")], co_3: [E(MAPS, "failed")], co_4: [E(MAPS, "refused")], co_5: [V(MAPS, "+20 2 0000 0005")], co_2_near: [E(MAPS, "empty")] },
};

describe("the plan the delivery is built on (customer path: verified cards only)", () => {
  it("two contact columns, two mark columns (no verified tool carries a size or a founding year), the maps lookup as the only HQ-phone chain and none for the general e-mail", () => {
    expect(plan.chains.hq_phone).toEqual([MAPS]);
    expect(plan.chains.general_email).toEqual([]);
    expect(plan.marks.map((m) => m.titleAr)).toEqual(["عدد الموظفين أكثر من ٥٠", "تأسست بعد ٢٠١٥"]);
  });
});

describe("buildB2BDelivery", () => {
  const d = buildB2BDelivery({ plan, rows: rowsIn, attempts });
  it("removes the EXACT duplicate only: 7 rows in, 6 out, the near copy kept, the order kept", () => {
    expect(d.removedDuplicates).toBe(1);
    expect(d.rows.map((r) => r.id)).toEqual(["co_1", "co_2", "co_3", "co_4", "co_5", "co_2_near"]);
  });
  it("the contact cells: the value of the first tool that gave one; «غير متوفر» after every tool of the chain ANSWERED with nothing; «لم يكتمل البحث» when a call failed, was refused or the chain is empty (Part B)", () => {
    expect(d.rows.map((r) => r.hq_phone)).toEqual(["+20 2 0000 0001", NOT_AVAILABLE_AR, B2B_NOT_SEARCHED_AR, B2B_NOT_SEARCHED_AR, "+20 2 0000 0005", NOT_AVAILABLE_AR]);
    // no verified tool lists a company's general e-mail: nothing was tried, so it is never «غير متوفر»
    expect(d.rows.every((r) => r.general_email === B2B_NOT_SEARCHED_AR)).toBe(true);
  });
  it("the mark columns: «نعم», «لا» or «غير معروف» from the row's own value; no row is removed for a mark", () => {
    expect(d.rows.map((r) => r.__mark_0)).toEqual(["نعم", "لا", "غير معروف", "نعم", "غير معروف", "لا"]);
    expect(d.rows.map((r) => r.__mark_1)).toEqual(["نعم", "لا", "غير معروف", "نعم", "نعم", "لا"]);
  });
  it("the input rows are not changed", () => {
    expect(rowsIn[0]).not.toHaveProperty("hq_phone");
    expect(rowsIn).toHaveLength(7);
  });
  it("the file's lines: the duplicates, each column's gap, each mark (Arabic, Arabic-Indic digits, no provider, no free text)", () => {
    expect(d.limitLines).toEqual([
      "حذفنا شركة واحدة مكررة تمامًا، ولم نحذف شيئًا غيرها.",
      "الإيميل العام للشركة: لم يكتمل البحث لكل الشركات (٦ شركات).",
      "هاتف المقر الرئيسي: وُجد لشركتين من ٦ شركات، وغير متوفر لشركتين بعد تجربة مصدر واحد، ولم يكتمل البحث لشركتين.",
      "«عدد الموظفين أكثر من ٥٠»: كُتب في عمود خاص (نعم أو لا أو غير معروف)، ولم تُحذف أي شركة بسببه.",
      "«تأسست بعد ٢٠١٥»: كُتب في عمود خاص (نعم أو لا أو غير معروف)، ولم تُحذف أي شركة بسببه.",
    ]);
    for (const l of d.limitLines) { expect(checkCustomerText(l).issues, l).toEqual([]); expect(l).not.toMatch(/[0-9]/); }
    expect(d.gaps.hq_phone).toEqual({ total: 6, found: 2, unavailable: 2, incomplete: 2, tools: 1 });
  });
  it("no duplicate and no gap: no line about them", () => {
    const clean = buildB2BDelivery({ plan, rows: base.slice(0, 1), attempts: { hq_phone: { co_1: [V(MAPS, "+20 2 0000 0001")] } } });
    expect(clean.removedDuplicates).toBe(0);
    expect(clean.limitLines.some((l) => l.startsWith("حذفنا"))).toBe(false);
    expect(clean.limitLines).toContain("هاتف المقر الرئيسي: وُجد لكل الشركات (شركة واحدة).");
  });
});

describe("in the file", () => {
  const d = buildB2BDelivery({ plan, rows: rowsIn, attempts });
  const stageColumns = plan.columns.company.filter((c) => c.key !== "row_number" && c.key !== "notes").map((c) => ({ key: c.key, title_ar: c.titleAr }));
  const filePlan = (() => { const p = pricedTwoStagePlan(); return { ...p, stages: [{ ...p.stages[0], key: "companies", title_ar: "الشركات", parent_key: null, deliver: true, columns: stageColumns }] }; })();
  it("the limits row of the summary sheet carries the lines; the companies sheet keeps every row and shows the mark and contact cells", async () => {
    const withLines = await buildMissionFiles(filePlan as never, { companies: d.rows }, undefined, undefined, { extraLimitLines: d.limitLines });
    const sheets = await cellsOf(withLines.xlsx);
    const summary = sheets[SUMMARY_SHEET_AR].flat().join("\n");
    for (const l of d.limitLines) expect(summary, l).toContain(l);
    expect(summary).not.toContain("لا قيود سُجّلت على هذا التسليم");
    const sheet = sheets[Object.keys(sheets).find((n) => n !== SUMMARY_SHEET_AR)!];
    const [head, ...body] = sheet;
    expect(body).toHaveLength(6);
    expect(head).toContain("عدد الموظفين أكثر من ٥٠");
    expect(body.map((r) => r[head.indexOf("عدد الموظفين أكثر من ٥٠")])).toEqual(["نعم", "لا", "غير معروف", "نعم", "غير معروف", "لا"]);
    expect(body.map((r) => r[head.indexOf("هاتف المقر الرئيسي")])).toEqual(["+20 2 0000 0001", NOT_AVAILABLE_AR, NOT_AVAILABLE_AR, B2B_NOT_SEARCHED_AR, "+20 2 0000 0005", NOT_AVAILABLE_AR]);
  });
  it("without the option the file is exactly what it was (the summary has none of the lines)", async () => {
    const without = await buildMissionFiles(filePlan as never, { companies: d.rows });
    const summary = (await cellsOf(without.xlsx))[SUMMARY_SHEET_AR].flat().join("\n");
    for (const l of d.limitLines) expect(summary).not.toContain(l);
    const again = await buildMissionFiles(filePlan as never, { companies: d.rows }, undefined, undefined, { extraLimitLines: [] });
    expect(JSON.stringify(await cellsOf(again.xlsx))).toBe(JSON.stringify(await cellsOf(without.xlsx)));
  });
});
