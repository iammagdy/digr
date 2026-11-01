import { describe, expect, it } from "vitest";
import { readWorkbook, replay } from "./helpers/agentReplay";
import { companiesPage, peopleAnswer, peopleOfCompany, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
// CHANGED (PR 1 part c): the people sheet of «companies and their decision makers» uses the owner's titles (taskContracts.ts): «اسم صانع القرار», «إيميل المسؤول المباشر», «هاتف / محمول المسؤول» and the statuses beside them

/**
 * WHAT THE A1 REPLAY DELIVERS, COUNTED FROM THE FILE (owner's question after #317: «people delivered out of the approved count, and how many have a name, a job title, a professional page, an e-mail, a phone»; and why a limits text could say «سُلّم ٣ من ١٠»).
 *
 * The live A1 shape: 5 companies, 31 people read (names and job titles, never a contact), the approved plan asks for two decision makers per company = 10. The file holds 10 people of 10: every one with a name, a job title and a professional page, none with an e-mail
 * or a phone (nothing was verified, so the cells are empty), and the 21 the source gave beyond the approved two per company are left out for exactly that reason. The «سُلّم ٣ من ١٠ ... وُجد ٣١ شخصًا» sentence of tests/truthful-limits-text.test.ts is the text for a DIFFERENT fixture: people rows that really are not
 * people (organisation names, role mailboxes, nameless rows), made up to pin the wording; it is not the live A1 shape, whose limits row says there is no limit.
 */
describe("the A1 replay, counted from the delivered file", () => {
  async function a1() {
    return replay({ request, planning: planFlow(), execution: () => [], answers: [tregResult(companiesPage, 0.0005), tregResult(peopleOfCompany("orascom-em"), 0.0005), tregResult(companiesPage, 0.0005), ...Array.from({ length: 12 }, () => peopleAnswer)] });
  }
  const cell = (v: unknown) => String(v ?? "").trim();

  it("10 people of the 10 approved: all 10 with a name, a job title and a professional page; none with an e-mail or a phone", async () => {
    const r = await a1();
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets[2];
    const header = (sheet.getRow(1).values as unknown[]).map(cell);
    const at = (title: string) => header.indexOf(title);
    const people = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
    const count = (title: string) => people.filter((row) => cell(row.getCell(at(title)).value) !== "").length;
    const approved = (r.plannedPlan.stages.find((s) => s.key === "people") as { planned_rows?: number; expected_rows?: number }).planned_rows ?? (r.plannedPlan.stages.find((s) => s.key === "people") as { expected_rows: number }).expected_rows;
    expect({ approved, delivered: people.length, name: count("اسم صانع القرار"), title: count("المسمى الوظيفي"), page: count("الملف المهني للشخص"), email: count("إيميل المسؤول المباشر"), phone: count("هاتف / محمول المسؤول") }).toEqual({ approved: 10, delivered: 10, name: 10, title: 10, page: 10, email: 0, phone: 0 });
  });

  it("the file's own table says what happened to the 31 the source gave: 10 delivered, 21 left out because they are beyond the approved two per company; and its limits row says there is no limit", async () => {
    const r = await a1();
    const sheet = (await readWorkbook(r)).worksheets[0];
    const rows: string[][] = [];
    sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(cell)));
    const people = rows.find((row) => row[0] === "موظفو كل شركة" && row.length >= 4 && /^[٠-٩]+$/.test(row[1]))!;
    expect(people.slice(1, 4)).toEqual(["٣١", "٢١", "١٠"]);
    const reasons = rows.find((row) => row[0] === "أسباب الاستبعاد")![1];
    expect(reasons).toContain("زاد عن العدد المعتمد");
    expect(reasons).not.toMatch(/لا بيانات تواصل موثّقة|لا يخص شخصًا/);
    const limits = rows.find((row) => row[0] === "حدود هذا التسليم")![1];
    expect(limits).toBe("لا قيود سُجّلت على هذا التسليم");
    expect(limits).not.toContain("المصدر لم يعد يعطي");
  });
});
