import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/** A plan the way the site stores it (stages with readable columns, kinds, helper stages); the files are built from it and the saved rows. */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over });
const plan = (stages: unknown[]): PricedPlan => ({ summary_ar: "ستحصل على شركات وموظفيها. وتفاصيل أخرى.", stages: stages as any, price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } });

async function load(xlsx: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
const header = (sheet: ExcelJS.Worksheet) => (sheet.getRow(1).values as unknown[]).slice(1);

const COMPANIES = stage({ key: "companies", title_ar: "الشركات", columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "site", title_ar: "الموقع" }, { key: "staff", title_ar: "عدد العاملين" }] });
const EMPLOYEES = stage({ key: "employees", title_ar: "الموظفون", parent_key: "companies", per_parent_rows: 2, columns: [{ key: "person", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "mail", title_ar: "البريد المهني", kind: "work_email" }, { key: "tel", title_ar: "الموبايل", kind: "phone" }] });
const companyRows = [{ id: "co1", name: "النيل للتركيبات", site: "https://nile.example", staff: "120" }, { id: "co2", name: "دلتا للمقاولات", site: "https://delta.example", staff: "80" }];
const employeeRows = [
  { id: "co1-p1", parent_id: "co1", person: "أحمد حسن", title: "مدير المشتريات", mail: "a.hassan@nile.example", tel: "+20227945000" },
  { id: "co1-p2", parent_id: "co1", person: "منى سليم", title: "مدير العمليات", mail: "", tel: "01012345678" },
  { id: "co2-p1", parent_id: "co2", person: "خالد سليم", title: "مدير", mail: "k@delta.example", tel: "" },
];

describe("the files are readable first", () => {
  it("each employee row starts with the COMPANY'S NAME and site, then the employee's own columns, and the ids come LAST under Arabic headers", async () => {
    const built = await buildMissionFiles(plan([COMPANIES, EMPLOYEES]), { companies: companyRows, employees: employeeRows });
    const wb = await load(built.xlsx);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "الشركات", "الموظفون"]);
    expect(header(wb.getWorksheet("الشركات")!)).toEqual(["اسم الشركة", "الموقع", "عدد العاملين", "المعرّف"]);
    const sheet = wb.getWorksheet("الموظفون")!;
    expect(header(sheet)).toEqual(["اسم الشركة", "الموقع", "اسم الموظف", "المسمى الوظيفي", "البريد المهني", "الموبايل", "المعرّف", "معرّف الأصل"]);
    expect(sheet.getRow(2).getCell(1).value).toBe("النيل للتركيبات");
    expect((sheet.getRow(2).getCell(2).value as any).hyperlink).toBe("https://nile.example");
    expect(sheet.getRow(4).getCell(1).value).toBe("دلتا للمقاولات");
    // the ids at the end: the id as text, the parent id as a link to the parent's row (its id column D of the companies sheet)
    expect(sheet.getRow(2).getCell(7).value).toBe("co1-p1");
    expect((sheet.getRow(2).getCell(8).value as any).hyperlink).toBe("#'الشركات'!D2");
    expect((sheet.getRow(4).getCell(8).value as any).hyperlink).toBe("#'الشركات'!D3");
  });

  it("headers are frozen, filters are on, numbers are stored as numbers, phones and links are not", async () => {
    const wb = await load((await buildMissionFiles(plan([COMPANIES, EMPLOYEES]), { companies: companyRows, employees: employeeRows })).xlsx);
    for (const name of ["ملخص المهمة", "الشركات", "الموظفون"]) {
      const sheet = wb.getWorksheet(name)!;
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, rightToLeft: true });
      expect(sheet.autoFilter).toBeTruthy();
    }
    const companies = wb.getWorksheet("الشركات")!;
    expect(companies.getRow(2).getCell(3).value).toBe(120);
    expect(typeof companies.getRow(2).getCell(3).value).toBe("number");
    const employees = wb.getWorksheet("الموظفون")!;
    // a phone stays text (a leading zero or a plus is not lost), an unverified (empty) e-mail is empty
    expect(employees.getRow(2).getCell(6).value).toBe("+20227945000");
    expect(employees.getRow(3).getCell(6).value).toBe("01012345678");
    expect(employees.getRow(3).getCell(5).value).toBe("");
  });

  it("the first sheet says what each sheet holds, in plain Arabic, with the one-sentence summary", async () => {
    const wb = await load((await buildMissionFiles(plan([COMPANIES, EMPLOYEES]), { companies: companyRows, employees: employeeRows })).xlsx);
    const s = wb.getWorksheet("ملخص المهمة")!;
    // (the old line had «الصفوف» as the third header: «صف» is a spreadsheet word, the customer's file says «العدد»)
    expect((s.getRow(1).values as unknown[]).slice(1)).toEqual(["المرحلة", "الورقة", "العدد", "المتوقع", "ملاحظة"]);
    // (the old line expected «تابع لصف في مرحلة «الشركات»»: «صف» is a spreadsheet word a file note never uses)
    expect(s.getRow(3).getCell(5).value).toContain("تابع لعنصر في مرحلة «الشركات»");
    expect(String(s.getRow(3).getCell(5).value)).not.toMatch(/صف|سجل/);
    // (the old line expected the agent's own sentence «ستحصل على شركات وموظفيها.»: the sentence about the delivery is now built from the real counts, so it can never name a number that differs from what was delivered)
    expect(String(s.getRow(5).getCell(1).value)).toMatch(/^تم تسليم \d|^تم تسليم [٠-٩]/);
  });

  it("a column that repeats another (same title, or the same values) appears once; a context column the child already has is not added twice", async () => {
    const dup = stage({ key: "employees", title_ar: "الموظفون", parent_key: "companies", columns: [{ key: "person", title_ar: "اسم الموظف" }, { key: "person2", title_ar: "اسم الموظف" }, { key: "co", title_ar: "الشركة" }, { key: "copy", title_ar: "نسخة الاسم" }] });
    const rows = employeeRows.map((e) => ({ ...e, person2: e.person, co: companyRows.find((c) => c.id === e.parent_id)!.name, copy: e.person }));
    const wb = await load((await buildMissionFiles(plan([COMPANIES, dup]), { companies: companyRows, employees: rows })).xlsx);
    // «الشركة» holds the company's name already: the parent's name is not added a second time
    expect(header(wb.getWorksheet("الموظفون")!)).toEqual(["الموقع", "اسم الموظف", "الشركة", "المعرّف", "معرّف الأصل"]);
  });

  it("a parent stage that is not delivered (a helper) still gives its name to the child's rows, and has no sheet", async () => {
    const place = stage({ key: "place", title_ar: "المكان", deliver: false, columns: [{ key: "name", title_ar: "اسم المكان" }] });
    const reviews = stage({ key: "reviews", title_ar: "التقييمات", parent_key: "place", columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }] });
    const wb = await load((await buildMissionFiles(plan([place, reviews]), { place: [{ id: "pl1", name: "مطعم أبو طارق" }], reviews: [{ id: "r1", parent_id: "pl1", text: "ممتاز", rating: "5" }, { id: "r2", parent_id: "pl1", text: "سيئ", rating: "1" }] })).xlsx);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "التقييمات"]);
    const sheet = wb.getWorksheet("التقييمات")!;
    expect(header(sheet)).toEqual(["اسم المكان", "نص التقييم", "الدرجة", "المعرّف", "معرّف الأصل"]);
    expect(sheet.getRow(2).getCell(1).value).toBe("مطعم أبو طارق");
    expect(sheet.getRow(2).getCell(3).value).toBe(5);
    // no sheet for the parent: the parent id is plain text
    expect(typeof sheet.getRow(2).getCell(5).value).toBe("string");
  });

  it("the CSV is the deepest delivered stage with the same readable columns and the ids last", async () => {
    const { csv } = await buildMissionFiles(plan([COMPANIES, EMPLOYEES]), { companies: companyRows, employees: employeeRows });
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe('"اسم الشركة","الموقع","اسم الموظف","المسمى الوظيفي","البريد المهني","الموبايل","المعرّف","معرّف الأصل"');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"النيل للتركيبات","https://nile.example","أحمد حسن"');
    expect(lines[1].endsWith('"co1-p1","co1"')).toBe(true);
  });

  it("a text that starts like a formula is stored as text", async () => {
    const wb = await load((await buildMissionFiles(plan([stage({ key: "t", title_ar: "التغريدات", columns: [{ key: "text", title_ar: "النص" }] })]), { t: [{ id: "1", text: "=HYPERLINK(\"x\")" }] })).xlsx);
    // (the old line expected a visible leading apostrophe: «'=HYPERLINK»; the owner's decision: no mark in the xlsx) a STRING cell holding the text exactly as written is never run as a formula; the CSV keeps the apostrophe
    const cell = wb.getWorksheet("التغريدات")!.getRow(2).getCell(1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe("=HYPERLINK(\"x\")");
  });
});
