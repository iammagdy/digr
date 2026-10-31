import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { dateOnlyText, isDateValues, parseDateOnly, parseMoment, cairoText } from "../src/lib/agentMission/dateCells";
import { comparableValue, reconcileParentColumns } from "../src/lib/agentMission/parentColumns";
import { fixFileWordingAr } from "../src/lib/agentMission/fileWording";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { jobFileIds } from "../src/lib/producedFormats";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/** Fix mission 9 (live retest of 2026-10-29 20:50-21:03 Cairo): the file's parent columns, dates, empty cells and the words about the files. The replay of the live mission is `tests/live-run-9-replay.test.ts`. */

describe("dates: a date with no time is a date; a real timestamp is moved to Cairo time", () => {
  it("date-only values (with or without a label before them) are calendar dates", () => {
    expect(parseDateOnly("2022-03-01")).toEqual({ y: 2022, mo: 3, da: 1 });
    expect(parseDateOnly("تاريخ البداية: 2022-03-01")).toEqual({ y: 2022, mo: 3, da: 1 });
    expect(parseDateOnly("2022/03/01")).toEqual({ y: 2022, mo: 3, da: 1 });
    expect(dateOnlyText(parseDateOnly("2019-11-15")!)).toBe("2019-11-15");
  });
  it("anything with a time, a non-day or a sentence is not a date-only value", () => {
    expect(parseDateOnly("2022-03-01T00:00:00Z")).toBeNull();
    expect(parseDateOnly("2022-03-01 08:30")).toBeNull();
    expect(parseDateOnly("2022-02-30")).toBeNull();
    expect(parseDateOnly("2022-13-01")).toBeNull();
    expect(parseDateOnly("بدأ في 2022-03-01 مع الشركة")).toBeNull();
    expect(parseDateOnly(20220301)).toBeNull();
    expect(parseDateOnly("")).toBeNull();
  });
  it("a text with Arabic words is never a moment (the engine's own parser read a date out of «تاريخ البداية: 2022-03-01»)", () => {
    expect(parseMoment("تاريخ البداية: 2022-03-01")).toBeNull();
    expect(parseMoment("بدأ 2022-03-01")).toBeNull();
  });
  it("real timestamps are unchanged: Cairo time", () => {
    expect(cairoText(parseMoment("2026-10-28T20:06:00Z")!)).toBe("2026-10-28 23:06");
    expect(cairoText(parseMoment("Wed Oct 28 20:06:00 +0000 2026")!)).toBe("2026-10-28 23:06");
    expect(cairoText(parseMoment(1793217960)!)).toBe("2026-10-28 23:06");
  });
  it("a column of dates, of timestamps, or of both is a date column; a column with a non-date is not", () => {
    expect(isDateValues("تاريخ البداية في الوظيفة", "start_date", ["تاريخ البداية: 2022-03-01", "", "2019-11-15"])).toBe(true);
    expect(isDateValues("التاريخ", "date", ["2022-03-01", "2026-10-28T20:06:00Z"])).toBe(true);
    expect(isDateValues("التاريخ", "date", ["2022-03-01", "غير معروف"])).toBe(false);
  });
});

describe("the parent-describing columns of a child sheet come from the row's own parent", () => {
  const parents = [
    { id: "orascom.com", name: "Orascom Construction", website: "orascom.com" },
    { id: "arabcont.com", name: "The Arab Contractors", website: "arabcont.com" },
    { id: "elhazek.com", name: "El Hazek Contracting", website: "elhazek.com" },
  ];
  const stages = [{ key: "companies", parent_key: null }, { key: "people", parent_key: "companies" }];
  const columns = (key: string) => (key === "companies" ? ["name", "website"] : ["name", "title", "website"]);
  const person = (i: number, parent: string, website: string) => ({ id: `p${i}`, parent_id: parent, name: `شخص ${i}`, title: "Manager", website });

  it("the live case: the first company's website on all six people is replaced, row by row, from each person's own company", () => {
    const people = [person(1, "orascom.com", "orascom.com"), person(2, "orascom.com", "orascom.com"), person(3, "arabcont.com", "orascom.com"), person(4, "arabcont.com", "orascom.com"), person(5, "elhazek.com", "orascom.com"), person(6, "elhazek.com", "orascom.com")];
    const out = reconcileParentColumns(stages, { companies: parents, people }, columns, columns);
    expect(out.rowsByStage.people.map((r) => r.website)).toEqual(["orascom.com", "orascom.com", "arabcont.com", "arabcont.com", "elhazek.com", "elhazek.com"]);
    expect(out.fixes).toEqual([{ stage_key: "people", column: "website", parent_field: "website", rows: 4 }]);
    // the input rows are not changed in place
    expect(people[2].website).toBe("orascom.com");
  });
  it("a column that is already right is not touched, and nothing is reported", () => {
    const people = [person(1, "orascom.com", "orascom.com"), person(2, "arabcont.com", "arabcont.com")];
    const out = reconcileParentColumns(stages, { companies: parents, people }, columns, columns);
    expect(out.fixes).toEqual([]);
    expect(out.rowsByStage.people).toEqual(people);
  });
  it("the style of the column is kept: a bare domain stays bare; a link with a scheme keeps its scheme", () => {
    const withScheme = [{ ...parents[0], website: "https://orascom.com" }, { ...parents[1], website: "https://arabcont.com" }];
    const people = [{ ...person(1, "orascom.com", "https://orascom.com") }, { ...person(2, "arabcont.com", "https://orascom.com") }];
    const out = reconcileParentColumns(stages, { companies: withScheme, people }, columns, columns);
    expect(out.rowsByStage.people.map((r) => r.website)).toEqual(["https://orascom.com", "https://arabcont.com"]);
    const bare = reconcileParentColumns(stages, { companies: withScheme, people: [person(1, "orascom.com", "orascom.com"), person(2, "arabcont.com", "orascom.com")] }, columns, columns);
    expect(bare.rowsByStage.people.map((r) => r.website)).toEqual(["orascom.com", "arabcont.com"]);
  });
  it("a column that is not made of parent values (a person's own name) is never touched, even when one value equals a company's name", () => {
    const people = [{ ...person(1, "orascom.com", "orascom.com"), name: "The Arab Contractors" }, { ...person(2, "arabcont.com", "arabcont.com"), name: "علي" }];
    const out = reconcileParentColumns(stages, { companies: parents, people }, columns, columns);
    expect(out.rowsByStage.people.map((r) => r.name)).toEqual(["The Arab Contractors", "علي"]);
    expect(out.fixes).toEqual([]);
  });
  it("a parent whose own field is empty gives an empty value, never another parent's", () => {
    const opaque = [{ id: "c1", name: "A", website: "a.com" }, { id: "c2", name: "B", website: "b.com" }, { id: "c3", name: "C", website: "" }];
    const people = [person(1, "c1", "a.com"), person(2, "c2", "a.com"), person(3, "c3", "a.com")];
    const out = reconcileParentColumns(stages, { companies: opaque, people }, columns, columns);
    expect(out.rowsByStage.people.map((r) => r.website)).toEqual(["a.com", "b.com", ""]);
  });
  it("one parent only, a field all parents share, or a row whose parent is unknown: nothing to compare, nothing changed", () => {
    expect(reconcileParentColumns(stages, { companies: [parents[0]], people: [person(1, "orascom.com", "orascom.com")] }, columns, columns).fixes).toEqual([]);
    const same = [{ ...parents[0], website: "x.com" }, { ...parents[1], website: "x.com" }];
    expect(reconcileParentColumns(stages, { companies: same, people: [person(1, "orascom.com", "x.com")] }, columns, columns).fixes).toEqual([]);
    expect(reconcileParentColumns(stages, { companies: parents, people: [person(1, "ghost.com", "orascom.com")] }, columns, columns).fixes).toEqual([]);
  });
  it("two links are the same value with or without the scheme, «www.» and the closing slash", () => {
    expect(comparableValue("https://www.Orascom.com/")).toBe(comparableValue("orascom.com"));
    expect(comparableValue("Cairo")).toBe("cairo");
  });
});

describe("the file: no empty texts, dates keep their form, the repair is returned for the admin", () => {
  const plan = {
    stages: [
      { key: "companies", title_ar: "شركات مقاولات", deliver: true, parent_key: null, columns: [{ key: "name", title_ar: "اسم" }, { key: "website", title_ar: "الموقع الإلكتروني" }] },
      { key: "people", title_ar: "موظفون", deliver: true, parent_key: "companies", columns: [{ key: "name", title_ar: "الاسم" }, { key: "start", title_ar: "تاريخ البداية" }, { key: "at", title_ar: "وقت التسجيل" }, { key: "place", title_ar: "المكان" }, { key: "website", title_ar: "موقع الشركة" }] },
    ],
    price: { deliveredRows: 4 },
  } as unknown as PricedPlan;
  const rows = {
    companies: [{ id: "a.com", name: "A", website: "a.com" }, { id: "b.com", name: "B", website: "b.com" }],
    people: [
      { id: "p1", parent_id: "a.com", name: "س", start: "2022-03-01", at: "2026-10-28T20:06:00Z", place: "", website: "a.com" },
      { id: "p2", parent_id: "b.com", name: "ص", start: "", at: "2026-10-28T20:06:00Z", place: "القاهرة", website: "a.com" },
    ],
  };
  async function build() {
    const built = await buildMissionFiles(plan, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    return { built, sheet: wb.worksheets[2] };
  }
  it("a missing value is an empty cell; a date-only cell has no time; a timestamp keeps Cairo time; the CSV agrees", async () => {
    const { built, sheet } = await build();
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    const at = (title: string, r: number) => sheet.getRow(r).getCell(header.indexOf(title));
    expect(at("المكان", 2).value).toBeNull();
    expect(at("المكان", 3).value).toBe("القاهرة");
    expect(at("تاريخ البداية", 3).value).toBeNull();
    const day = at("تاريخ البداية", 2);
    expect(day.numFmt).toBe("yyyy-mm-dd");
    expect((day.value as Date).toISOString()).toBe("2022-03-01T00:00:00.000Z");
    const stamp = at("وقت التسجيل", 2);
    expect(stamp.numFmt).toBe("yyyy-mm-dd hh:mm");
    expect((stamp.value as Date).toISOString()).toBe("2026-10-28T23:06:00.000Z");
    expect(built.csv).toContain("2022-03-01");
    expect(built.csv).toContain("2026-10-28 23:06");
  });
  it("the wrong parent value is repaired in the file and reported (admin only)", async () => {
    const { built, sheet } = await build();
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    expect([2, 3].map((r) => String(sheet.getRow(r).getCell(header.indexOf("موقع الشركة")).value))).toEqual(["a.com", "b.com"]);
    expect(built.parentFixes).toEqual([{ stage_key: "people", column: "website", parent_field: "website", rows: 1 }]);
  });
  it("the empty cells keep the sheet's borders and fill (every cell of the row is styled)", async () => {
    const { sheet } = await build();
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    expect(sheet.getRow(2).getCell(header.indexOf("المكان")).border).toBeTruthy();
    expect(sheet.getRow(2).getCell(header.indexOf("المكان")).fill).toBeTruthy();
  });
});

describe("the words about the files match the files (live: «تم تسليم ملفين مرتبطين» for one workbook of two sheets)", () => {
  const stages = [{ title_ar: "فيديوهات تيك توك عن منتخب مصر", deliver: true }, { title_ar: "أحدث تعليقات على فيديوهات منتخب مصر", deliver: true }];
  const live = "تم تسليم ملفين مرتبطين. ملف الفيديوهات يضم فيديوهات تيك توك تتحدث صراحة عن منتخب مصر، مع رابط كل فيديو ووصفه. ملف التعليقات يضم أول التعليقات لكل فيديو بالترتيب الذي يعرضه تيك توك نفسه. عمود «الردود» في ملف الفيديوهات فارغ لأن المصدر لا يوفره. يشير عمود «معرّف الأصل» في ملف التعليقات إلى «المعرّف» في ملف الفيديوهات.";
  it("the stored sentence becomes: one Excel file of two linked sheets, the sheets named as sheets", () => {
    const fixed = fixFileWordingAr(live, stages);
    expect(fixed.startsWith("تم تسليم ملف إكسل واحد من ورقتين مرتبطتين.")).toBe(true);
    expect(fixed).toContain("ورقة الفيديوهات تضم فيديوهات");
    expect(fixed).toContain("ورقة التعليقات تضم أول التعليقات");
    expect(fixed).toContain("في ورقة الفيديوهات فارغ");
    expect(fixed).toContain("في ورقة التعليقات إلى «المعرّف» في ورقة الفيديوهات");
    expect(fixed).not.toMatch(/ملفين|ملف الفيديوهات|ملف التعليقات/);
  });
  it("three sheets, a number of files in digits or words, and a sentence that says nothing about files are handled; «ملف إكسل» and unrelated text are left alone", () => {
    const three = [...stages, { title_ar: "ردود على التعليقات", deliver: true }];
    expect(fixFileWordingAr("تم تسليم ثلاثة ملفات مرتبطة.", three)).toBe("تم تسليم ملف إكسل واحد من ثلاث أوراق مرتبطة.");
    expect(fixFileWordingAr("تم تسليم ٢ ملفات مرتبطة.", stages)).toBe("تم تسليم ملف إكسل واحد من ورقتين مرتبطتين.");
    expect(fixFileWordingAr("الملف إكسل فيه ورقة واحدة وبيانات الشركات.", stages)).toBe("الملف إكسل فيه ورقة واحدة وبيانات الشركات.");
    expect(fixFileWordingAr("حمّل ملف إكسل الآن.", stages)).toBe("حمّل ملف إكسل الآن.");
    // an intermediate stage's noun is not a sheet: «ملف» before it is left as the model wrote it
    expect(fixFileWordingAr("ملف الفيديوهات", [{ title_ar: "تعليقات", deliver: true }, { title_ar: "فيديوهات", deliver: false }])).toBe("ملف الفيديوهات");
  });
  it("the card shows the corrected sentence for the live mission (the stored text is not changed, the view is)", () => {
    const v = customerMissionView({
      mission: { id: "m", status: "completed", question_ar: null, plan_public: { stages: [{ key: "videos", title_ar: stages[0].title_ar, deliver: true, expected_rows: 5 }, { key: "comments", title_ar: stages[1].title_ar, deliver: true, expected_rows: 50, parent_key: "videos" }], price: { max_charge_points: 200, reserve_points: 200 }, quantity: { requested: 5, target: 5, stage_key: "videos" } }, reserved_points: 200, unit_price_points: 3.636363, delivered_units: 55, charged_points: 200, summary_ar: live, files: [{ name: "result.xlsx", kind: "xlsx" }, { name: "result.csv", kind: "csv" }], created_at: "2026-10-29T17:51:15Z" },
      events: [],
    });
    expect(v.resultSummaryAr).toContain("تم تسليم ملف إكسل واحد من ورقتين مرتبطتين.");
    expect(v.resultSummaryAr).not.toContain("ملفين");
    expect(v.files.map((f) => f.kind)).toEqual(["xlsx"]);
  });
});

describe("«طلباتي» lists the files the completion panel lists", () => {
  const xlsx = "u/job/result.xlsx";
  const csv = "u/job/result.csv";
  it("the live case: the job's artifact row was missing from the page's list: the mission's own files (Excel and CSV) still give both", () => {
    expect(jobFileIds({ artifacts: [], resultFileId: csv, missionFiles: [{ kind: "xlsx", path: "result/result.xlsx" }, { kind: "csv", path: "result/result.csv" }] })).toEqual({ xlsx: "result/result.xlsx", pdf: null, csv });
  });
  it("the artifact row, newest first, gives its files; the stored result file fills the format it names; no mission files: the older behaviour", () => {
    expect(jobFileIds({ artifacts: [{ file_id_xlsx: xlsx, file_id_csv: csv }, { file_id_xlsx: "old.xlsx", file_id_pdf: "old.pdf" }], resultFileId: csv })).toEqual({ xlsx, pdf: "old.pdf", csv });
    expect(jobFileIds({ resultFileId: csv })).toEqual({ xlsx: null, pdf: null, csv });
    expect(jobFileIds({})).toEqual({ xlsx: null, pdf: null, csv: null });
  });
  it("a mission file of another kind is not a download", () => {
    expect(jobFileIds({ missionFiles: [{ kind: "json", path: "x.json" }] })).toEqual({ xlsx: null, pdf: null, csv: null });
  });
  it("the page asks for the artifact rows BY JOB (never «the latest 100 of the account»), reads the mission's files, and uses the one function", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain('.from("artifact_versions")');
    expect(page).toContain('.in("job_id", listedJobIds)');
    expect(page).toContain("jobFileIds({ artifacts: artifactsByJob.get(r.id)");
    expect(page).toContain('stages:plan_public->stages, files');
    expect(page).not.toMatch(/artifact_versions"\)\s*\.select\([^)]*\)\s*\.eq\("user_id", user\.id\)\s*\.order\("version_number", \{ ascending: false \}\)\s*\.limit\(100\)/);
  });
});
