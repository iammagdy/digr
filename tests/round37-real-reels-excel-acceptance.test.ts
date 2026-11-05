import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles, COUNTER_UNAVAILABLE_AR } from "../agent/src/workbook";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { missionTitleAr, subjectOfMission } from "../src/lib/agentMission/fileNames";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * ROUND 37: the REAL files delivered for mission `msn_b56312efe3a41bef94a8` (see tests/fixtures/round37/README.md for hashes).
 * The Excel (1).xlsx under test was re-saved by Excel for Android (docProps/app.xml): it is what the customer's viewer holds.
 * Machine-level integrity of that exact file against the delivered CSV, the real request's title, and the methodology's wording.
 * No network, no provider, no points.
 */
const DIR = "tests/fixtures/round37";

/**
 * KNOWN GAP E-37a (owner-approved 5 Nov 2026, docs/launch/ROUND37-HISTORICAL-TEST-EXCEPTION.md): the three original files (delivered.csv, methodology.csv,
 * delivered-saved-by-excel-android.xlsx) are PERMANENTLY unavailable and are never recreated, approximated or substituted under these names.
 * Without them, ONLY the checks that read those files are skipped (reported by vitest as «skipped», never as passed, never as a load failure); every
 * assertion below is unchanged. The checks that need no real file (group B, and the two methodology checks of group C) keep running; group C then
 * reads five rows labelled SYNTHETIC. If the three files are ever restored, every check runs again with no edit.
 * The compensating (and explicitly NOT equivalent) control is tests/round37-synthetic-resave.test.ts.
 */
const GAP = "[KNOWN GAP E-37: original files unavailable; not a pass]";
const REAL_FILES = ["delivered.csv", "methodology.csv", "delivered-saved-by-excel-android.xlsx"].every((f) => existsSync(`${DIR}/${f}`));
const evidenceDescribe = REAL_FILES ? describe : describe.skip;
const evidenceIt = REAL_FILES ? it : it.skip;
const REQUEST = "اجمع ٥ ريلز من إنستجرام عن الذكاء الاصطناعي، مع النصوص والروابط وتاريخ النشر واسم الحساب وعدد المشاهدات.";

/** RFC 4180 reader: quoted cells with embedded line breaks and doubled quotes; BOM removed. Every cell stays a STRING (a 19-digit id is never turned into a number). */
function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^﻿/, "");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") continue;
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** The UTC instant whose Cairo wall clock reads `text` ("2026-10-30 13:24"): Egypt's offset is +3 in summer time and +2 after the last Thursday of October, so it is found, not assumed. */
function utcOfCairo(text: string): string {
  const wall = Date.parse(`${text.replace(" ", "T")}:00Z`);
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const offset of [2, 3]) {
    const instant = new Date(wall - offset * 3600_000);
    if (fmt.format(instant).replace(/\u202f|\u00a0/g, " ").slice(0, 16) === text) return instant.toISOString();
  }
  throw new Error(`no UTC instant for Cairo time ${text}`);
}
const nl = (s: string) => s.replace(/\r\n/g, "\n");
const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace("T", " "); // the stored serial is the Cairo wall clock, written as UTC by the writer
  if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text);
  return String(v);
};

const csv = REAL_FILES ? parseCsv(readFileSync(`${DIR}/delivered.csv`, "utf8")) : [[] as string[]];
const header = csv[0];
const records = csv.slice(1);
const col = (title: string) => header.indexOf(title);

evidenceDescribe(`${GAP} the real Excel (1).xlsx against the real CSV (1).csv: no data corruption, cell by cell`, () => {
  let wb: ExcelJS.Workbook;
  const load = async () => { if (!wb) { wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(`${DIR}/delivered-saved-by-excel-android.xlsx`); } return wb; };

  it("the CSV is the shape the customer saw: 14 columns, 5 records, 19-digit ids last, kept as strings", () => {
    expect(header).toHaveLength(14);
    expect(records).toHaveLength(5);
    expect(header[13]).toBe("المعرّف");
    for (const r of records) { expect(r).toHaveLength(14); expect(r[13]).toMatch(/^\d{19}$/); }
  });

  it("every cell of the data sheet equals the CSV (text, account, date, link, counters, marks, id), with the id a TEXT cell", async () => {
    const sheet = (await load()).getWorksheet("الريلز")!;
    expect(sheet.rowCount).toBe(6);
    expect(sheet.columnCount).toBe(14);
    for (let c = 0; c < 14; c++) expect(cellText(sheet.getRow(1).getCell(c + 1).value), `header ${c + 1}`).toBe(header[c]);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 14; c++) {
      const cell = sheet.getRow(r + 2).getCell(c + 1);
      expect(nl(cellText(cell.value)), `${cell.address}`).toBe(nl(records[r][c]));
    }
    for (let r = 0; r < 5; r++) {
      const id = sheet.getRow(r + 2).getCell(14).value;
      expect(typeof id, `N${r + 2} is a string, not a float`).toBe("string");
      expect(id).toBe(records[r][13]);
    }
  });

  it("row -> account -> URL -> id is the same relation in both files, and every hyperlink target is the visible address", async () => {
    const sheet = (await load()).getWorksheet("الريلز")!;
    for (let r = 0; r < 5; r++) {
      const link = sheet.getRow(r + 2).getCell(col("الرابط") + 1);
      const v = link.value as { text: string; hyperlink: string };
      expect(v.text).toBe(records[r][col("الرابط")]);
      expect(v.hyperlink).toBe(records[r][col("الرابط")]);
      expect(String(sheet.getRow(r + 2).getCell(col("صاحب الحساب") + 1).value)).toBe(records[r][col("صاحب الحساب")]);
    }
    // five different reels, five different ids, five different links
    expect(new Set(records.map((r) => r[col("الرابط")])).size).toBe(5);
    expect(new Set(records.map((r) => r[13])).size).toBe(5);
  });

  it("full text is kept: no cell is cut (longest 1,097 characters), and counters are real numbers equal to the CSV", async () => {
    const sheet = (await load()).getWorksheet("الريلز")!;
    expect(Math.max(...records.map((r) => r[0].length))).toBe(1097);
    for (let r = 0; r < 5; r++) {
      expect(nl(String(sheet.getRow(r + 2).getCell(1).value)).length).toBe(nl(records[r][0]).length);
      for (const title of ["الإعجابات", "عدد التعليقات"]) expect(String(sheet.getRow(r + 2).getCell(col(title) + 1).value)).toBe(records[r][col(title)]);
    }
  });

  it("the structure a viewer needs: both sheets right-to-left, header frozen, no hidden column, no merged cell in the data sheet, a width on every column", async () => {
    const book = await load();
    expect(book.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "الريلز"]);
    for (const sheet of book.worksheets) { expect(sheet.views[0].rightToLeft, sheet.name).toBe(true); expect(sheet.views[0].state).toBe("frozen"); }
    const data = book.getWorksheet("الريلز")!;
    expect(Object.keys((data as any)._merges ?? {})).toHaveLength(0);
    for (let c = 1; c <= 14; c++) { const column = data.getColumn(c); expect(column.hidden, `col ${c}`).toBeFalsy(); expect(column.width ?? 0).toBeGreaterThan(8); }
    // no row is taller than Excel allows, so no text is cut by a row height the viewer cannot honour
    data.eachRow((row) => expect(row.height ?? 15).toBeLessThanOrEqual(409));
  });

  it("the methodology sheet's non-empty lines equal methodology.csv, line by line", async () => {
    const sheet = (await load()).getWorksheet("ملخص المهمة")!;
    const fromSheet: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => { const cells: string[] = []; row.eachCell({ includeEmpty: false }, (cell) => { if (cell.isMerged && cell.master.address !== cell.address) return; const t = nl(cellText(cell.value)); if (t !== "") cells.push(t); }); if (cells.length) fromSheet.push(cells); });
    const fromCsv = parseCsv(readFileSync(`${DIR}/methodology.csv`, "utf8")).map((r) => r.filter((x) => x !== "").map(nl)).filter((r) => r.length);
    expect(fromSheet).toEqual(fromCsv);
  });
});

describe("the title of the real request", () => {
  const plan = { stages: [{ deliver: true, title_ar: "الريلز", planned_rows: 5, expected_rows: 5, parent_key: null }] } as any;

  it("the subject is the topic, not the field list that follows it (live: «٥ ريلز عن وعدد المشاهدات»)", () => {
    expect(subjectOfMission({ plan, requestText: REQUEST })).toBe("الذكاء الاصطناعي");
    expect(missionTitleAr({ plan, requestText: REQUEST, delivered: 5 })).toBe("٥ ريلز عن الذكاء الاصطناعي");
  });

  it("a column name that contains «الحساب» never becomes the subject, whatever the other field words are", () => {
    for (const fields of ["واسم الحساب وعدد المشاهدات", "اسم الحساب", "وصاحب الحساب والرابط", "وعدد الحسابات", "ورابط الحساب"]) {
      const text = `اجمع ٥ ريلز من إنستجرام عن الذكاء الاصطناعي، مع ${fields}.`;
      expect(subjectOfMission({ plan, requestText: text }), fields).toBe("الذكاء الاصطناعي");
    }
  });

  it("a request that really names an account or a channel still gets it as the subject (unchanged)", () => {
    expect(subjectOfMission({ plan, requestText: "اجمع ٥ منشورات من حساب zhocare" })).toBe("zhocare");
    expect(subjectOfMission({ plan, requestText: "هات فيديوهات من قناة أون سبورت" })).toBe("أون سبورت");
    expect(subjectOfMission({ plan, requestText: "اجمع منشورات من حساب zhocare مع اسم الحساب وعدد المشاهدات" })).toBe("zhocare");
  });
});

describe("the methodology of the real mission does not contradict itself", () => {
  const ABOUT = topicRelationAr(2);
  const stage = {
    key: "posts", title_ar: "الريلز", endpoint_id: "anyapi.instagram.hashtag.posts", capability: "instagram.hashtag.posts", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: ["call_0001", "call_0002"], measured_from_calls: ["call_0001", "call_0002"], measured_cost_per_row_usd: 0.0002,
    columns: [{ key: "text", title_ar: "النص" }, { key: "author", title_ar: "صاحب الحساب" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "link", title_ar: "الرابط" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments", title_ar: "عدد التعليقات" }, { key: "views", title_ar: "المشاهدات" }, { key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }],
    engine: { endpoint_id: "anyapi.instagram.hashtag.posts", params: { hashtag: "الذكاء_الاصطناعي", mediaType: "reel" }, cursor_param: "cursor", map_code: "return []", map_file_id: "page", parent_binding: null },
  };
  const plan = {
    summary_ar: "ستحصل على ريلز.", stages: [stage] as any,
    price: { totalCostUsd: 0, deliveredRows: 5, costPerFinalRowUsd: 0.0002, unitPricePoints: 40, reservePoints: 200, maxChargePoints: 200, overCap: false } as any,
    quantity: { requested: 5, stage_key: "posts", target: 5, source: "request" },
    compiled: { media: { asked: "reels", basis: "filter", filter: { field: "mediaType", value: "reel" } }, fields: [{ key: "posted_at", path: "createdUtc", status: "card" }, { key: "author", path: "username", status: "card" }, { key: "views", status: "unavailable" }] },
  } as unknown as PricedPlan;
  // E-37a: the real delivered rows when the real CSV exists; otherwise five rows labelled SYNTHETIC (built here, never presented as the customer's file).
  const SYNTHETIC_ROWS = Array.from({ length: 5 }, (_, i) => ({ id: String(3000000000000000000 + i).padStart(19, "0"), text: `SYNTHETIC reel text ${i + 1}`, author: `synthetic_account_${i + 1}`, posted_at: `2026-10-30 13:2${i}`, link: `https://www.instagram.com/reel/SYNTHETIC${i + 1}/`, likes: i + 1, comments: i, views: null, [TOPIC_RELATION_KEY]: ABOUT }));
  const rows = REAL_FILES ? records.map((r) => ({ id: r[13], text: r[0], author: r[1], posted_at: r[2], link: r[3], likes: Number(r[4]), comments: Number(r[5]), views: null, [TOPIC_RELATION_KEY]: r[col("علاقة النص بالموضوع")] })) : SYNTHETIC_ROWS;
  const rec: StageRecord = { found: 5, duplicates: 0, accepted: 5, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 5, acceptedByModel: 0, excludedByReason: {}, stop: "target_reached" };
  const facts: MissionFacts = { requestText: REQUEST, deliveredAt: new Date("2026-11-05T07:32:12Z"), stages: { posts: rec }, reviewStop: null };
  const model = buildMethodology({ plan, layouts: [], rowsByStage: { posts: rows as any }, facts });
  const item = (label: string) => model.items.find((i) => i.label === label)!;

  evidenceIt(`${GAP} the delivered rows carry the mark the real file counted (5 of 5 are about the topic)`, () => {
    expect(rows.every((r) => r[TOPIC_RELATION_KEY] === ABOUT)).toBe(true);
    expect(item("صلة النتائج بالموضوع").values[0]).toBe("النص يتحدث عن الموضوع: ٥ ريلز");
  });

  it("«كيف فُحصت الصلة بطلبك» no longer says that no relevance check was applied while the next item counts the relation of every row", () => {
    const how = item("كيف فُحصت الصلة بطلبك").values.join(" ");
    expect(how).not.toContain("لم يُطبَّق فحص صلة");
    expect(how).toContain("لم يُحذف أي نتيجة بسبب صلتها بالنص");
    expect(how).toContain("علاقة النص بالموضوع");
    // the order the customer reads them in: how it was checked, then the counts, then the relation
    const labels = model.items.map((i) => i.label);
    expect(labels.indexOf("كيف فُحصت الصلة بطلبك")).toBeLessThan(labels.indexOf("صلة النتائج بالموضوع"));
  });

  it("a stage with NO mark column keeps the old honest sentence (no relevance check was applied)", () => {
    const bare = { ...stage, columns: stage.columns.filter((c) => c.key !== TOPIC_RELATION_KEY) };
    const m = buildMethodology({ plan: { ...plan, stages: [bare] as any }, layouts: [], rowsByStage: { posts: rows.map(({ [TOPIC_RELATION_KEY]: _x, ...r }) => r) as any }, facts });
    expect(m.items.find((i) => i.label === "كيف فُحصت الصلة بطلبك")!.values.join(" ")).toContain("لم يُطبَّق فحص صلة بالنص على هذه المرحلة");
  });

  evidenceIt(`${GAP} the export regenerated locally from the same delivered rows (no collection, no provider): every common column equals the delivered CSV cell by cell, ids as text`, async () => {
    const regenRows = records.map((r) => ({ id: r[13], text: r[0], author: r[1], posted_at: utcOfCairo(r[2]), link: r[3], likes: Number(r[4]), comments: Number(r[5]), views: COUNTER_UNAVAILABLE_AR, [TOPIC_RELATION_KEY]: r[col("علاقة النص بالموضوع")] }));
    const out = await buildMissionFiles(plan, { posts: regenRows as any }, facts);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.xlsx as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("الريلز")!;
    const titles = Array.from({ length: sheet.columnCount }, (_, c) => cellText(sheet.getRow(1).getCell(c + 1).value));
    expect(titles.slice(0, 8)).toEqual(header.slice(0, 8));
    expect(titles[titles.length - 1]).toBe("المعرّف");
    for (let r = 0; r < 5; r++) for (let c = 0; c < 8; c++) {
      const got = nl(cellText(sheet.getRow(r + 2).getCell(c + 1).value));
      const want = nl(c === 6 ? "غير متاح" : records[r][c]);
      expect(got, `${sheet.getRow(r + 2).getCell(c + 1).address}`).toBe(want);
    }
    for (let r = 0; r < 5; r++) expect(sheet.getRow(r + 2).getCell(sheet.columnCount).value).toBe(records[r][13]);
  });
});
