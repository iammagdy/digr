import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { arabicDateLabel, EXCEL_SHEET_NAME_MAX, missionFileTitleAr, nounOfStageTitle, wordBoundarySheetName } from "../src/lib/agentMission/fileNames";
import { buildMissionFiles, REVIEW_SHEET_AR } from "../agent/src/workbook";
import { closePageLine, customerMissionView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR } from "../src/lib/agentMission/constants";
import { userWillBeEmailed } from "../src/lib/agentMission/emailEligibility";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { replay } from "./helpers/agentReplay";
import { callIds, lastOutputId, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over });
const plan = (stages: unknown[]): PricedPlan => ({ summary_ar: "ستحصل على تغريدات. وتفاصيل أخرى.", stages: stages as any, price: { totalCostUsd: 0, deliveredRows: 1, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 1, overCap: false } });
const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };
const TWEETS = stage({ key: "tweets", title_ar: "التغريدات", columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }], relevance: { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح", "Mohamed Salah"], text_columns: ["text"] } });

describe("the file name is built from the mission: what + count + date, in Arabic", () => {
  it("«هات ٣٠٠ تغريدة عن محمد صلاح» → «تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦» (Arabic-Indic digits, no Latin, no generic title)", () => {
    const title = missionFileTitleAr({ plan: plan([TWEETS]), requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", delivered: 300, date: new Date("2026-10-28T10:00:00Z") });
    expect(title).toBe("تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦");
    expect(title).not.toMatch(/[0-9A-Za-z]/);
    expect(title).not.toContain("نتائج البحث");
  });

  it("with no relevance rule the subject is read from the request («عن ...»); with none at all it is the noun alone; the child stage names the file by its own noun", () => {
    const posts = stage({ key: "posts", title_ar: "المنشورات", columns: [{ key: "text", title_ar: "النص" }] });
    const comments = stage({ key: "comments", title_ar: "تعليقات كل منشور", parent_key: "posts", columns: [{ key: "text", title_ar: "النص" }] });
    const d = new Date("2026-01-05T00:00:00Z");
    expect(missionFileTitleAr({ plan: plan([posts]), requestText: "هات ٣٠ منشور عن التضخم في مصر", delivered: 30, date: d })).toBe("منشورات عن التضخم - ٣٠ - ٥ يناير ٢٠٢٦");
    expect(missionFileTitleAr({ plan: plan([posts, comments]), requestText: "هات ١٠٠ منشور عن الغلاء مع تعليقاتها", delivered: 2100, date: d })).toBe("تعليقات عن الغلاء - ٢٬١٠٠ - ٥ يناير ٢٠٢٦");
    expect(missionFileTitleAr({ plan: plan([stage({ key: "c", title_ar: "الشركات", columns: [{ key: "n", title_ar: "الاسم" }] })]), requestText: "شركات مقاولات في جدة", delivered: 12, date: d })).toBe("شركات - ١٢ - ٥ يناير ٢٠٢٦");
    expect(nounOfStageTitle("الموظفون")).toBe("موظفون");
    expect(arabicDateLabel(new Date("2026-12-31T23:00:00Z"))).toBe("٣١ ديسمبر ٢٠٢٦");
  });

  it("no forbidden character reaches a file name, and the name is never empty or too long", () => {
    const odd = stage({ key: "x", title_ar: "ال/\\:*?\"<>|ملفات", columns: [{ key: "t", title_ar: "ن" }] });
    const t = missionFileTitleAr({ plan: plan([odd]), requestText: "عن " + "كلمة ".repeat(40), delivered: 5, date: new Date("2026-10-28T00:00:00Z") });
    expect(t).not.toMatch(/[\\/:*?"<>|]/);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(100);
  });
});

describe("sheet names are cut at a word boundary within Excel's 31 characters, never in the middle of a word", () => {
  it("the real name that was cut to «التغريدات التي تذكر محمد صلا» now keeps whole words", () => {
    const used = new Set<string>();
    const name = wordBoundarySheetName("التغريدات التي تذكر محمد صلاح لاعب كرة القدم", used, "مرحلة 1");
    expect(name).toBe("التغريدات التي تذكر محمد صلاح");
    expect([...name].length).toBeLessThanOrEqual(EXCEL_SHEET_NAME_MAX);
    expect("التغريدات التي تذكر محمد صلاح لاعب كرة القدم".startsWith(name)).toBe(true);
    // the cut falls between words
    expect("التغريدات التي تذكر محمد صلاح لاعب كرة القدم"[name.length]).toBe(" ");
  });

  it("every title: at most 31 characters, none of [ ] : * ? / \\, unique (a number is added to a duplicate and still fits), a single very long word is the only thing ever cut", () => {
    const used = new Set<string>();
    const titles = ["التغريدات", "التغريدات", "تعليقات كل منشور وردود القرّاء عليه في الأسبوع الأخير", "ا".repeat(50), "[خطأ]: اسم؟ ورقة/عمل*", "", "التغريدات"];
    const names = titles.map((t, i) => wordBoundarySheetName(t, used, `مرحلة ${i + 1}`));
    for (const n of names) { expect([...n].length).toBeLessThanOrEqual(EXCEL_SHEET_NAME_MAX); expect(n).not.toMatch(/[\[\]:*?/\\]/); expect(n.length).toBeGreaterThan(0); }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(names[2]).toBe("تعليقات كل منشور وردود القرّاء");
    expect(names[3]).toBe("ا".repeat(31));
  });
});

describe("no visible apostrophe in the xlsx; the CSV keeps its formula protection", () => {
  const rows = [
    { id: "r1", text: "@mosalah ما شاء الله عليك يا بطل", url: "https://x.example/1", author: "a1" },
    { id: "r2", text: "=HYPERLINK(\"http://bad\") محمد صلاح", url: "https://x.example/2", author: "a2" },
    { id: "r3", text: "-5 درجات في ملعب محمد صلاح", url: "https://x.example/3", author: "a3" },
    { id: "r4", text: "+201001234567", url: "https://x.example/4", author: "a4" },
    { id: "r5", text: "نص عادي عن محمد صلاح", url: "https://x.example/5", author: "a5" },
  ];
  it("124 reply rows used to show «'@» in Excel: a text cell is a plain string, written as typed, and is a string cell (never a formula)", async () => {
    const built = await buildMissionFiles(plan([TWEETS]), { tweets: rows });
    const wb = await load(built.xlsx);
    const sheet = wb.getWorksheet("التغريدات")!;
    const texts = [2, 3, 4, 5, 6].map((r) => sheet.getRow(r).getCell(1).value);
    expect(texts).toEqual(rows.map((r) => r.text));
    for (let r = 2; r <= 6; r += 1) {
      const cell = sheet.getRow(r).getCell(1);
      expect(cell.type, `row ${r}`).toBe(ExcelJS.ValueType.String);
      expect(String(cell.value).startsWith("'")).toBe(false);
    }
    // no cell of any sheet starts with an apostrophe
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") expect(cell.value.startsWith("'"), `${ws.name}!${cell.address}`).toBe(false); })));
    // the xml holds no formula element
    expect((await import("jszip")).default).toBeTruthy();
  });

  it("the CSV marks a text that starts like a formula (= - @) with an apostrophe and leaves a phone number and a normal text alone", async () => {
    const built = await buildMissionFiles(plan([TWEETS]), { tweets: rows });
    const lines = built.csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[1]).toContain("\"'@mosalah");
    expect(lines[2]).toContain("\"'=HYPERLINK");
    expect(lines[3]).toContain("\"'-5 درجات");
    expect(lines[4]).toContain("\"+201001234567\"");
    expect(lines[5]).toContain("\"نص عادي عن محمد صلاح\"");
  });

  it("human columns first and the ids LAST under Arabic headers", async () => {
    const wb = await load((await buildMissionFiles(plan([TWEETS]), { tweets: rows })).xlsx);
    expect((wb.getWorksheet("التغريدات")!.getRow(1).values as unknown[]).slice(1)).toEqual(["نص التغريدة", "رابط التغريدة", "الحساب", "المعرّف"]);
  });
});

describe("the sheet of rows that were left out: for review, clearly not charged", () => {
  it("the excluded rows are on their own sheet with the reason in Arabic; the delivered sheet and the CSV hold none of them; the summary says they were not charged", async () => {
    const excluded = [
      { id: "a1", reason: "no_term" as const, row: { id: "a1", text: "صباح الخير يا جماعة", url: "https://x.example/a1", author: "سعيد محمد الصلاحي" } },
      { id: "n1", reason: "other_person" as const, row: { id: "n1", text: "رحم الله الشهيد محمد صلاح", url: "https://x.example/n1", author: "u" } },
    ];
    const built = await buildMissionFiles(plan([TWEETS]), { tweets: [{ id: "m1", text: "محمد صلاح يسجل هدفًا", url: "https://x.example/m1", author: "f1" }] }, { tweets: excluded });
    const wb = await load(built.xlsx);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "التغريدات", REVIEW_SHEET_AR]);
    const review = wb.getWorksheet(REVIEW_SHEET_AR)!;
    expect((review.getRow(1).values as unknown[]).slice(1)).toEqual(["نص التغريدة", "رابط التغريدة", "الحساب", "سبب الاستبعاد", "المعرّف"]);
    expect(review.getRow(2).getCell(4).value).toBe("لا يذكر الموضوع في نصه (ظهر لأن اسم صاحب الحساب يشبهه)");
    expect(review.getRow(3).getCell(4).value).toBe("عن شخص آخر يحمل الاسم نفسه");
    expect(wb.getWorksheet("التغريدات")!.rowCount).toBe(2);
    expect(built.csv).not.toContain("رحم الله");
    const summary = wb.getWorksheet("ملخص المهمة")!;
    const lastStageRow = (summary.getRow(3).values as unknown[]).slice(1);
    expect(lastStageRow).toEqual(["صفوف استُبعدت لأنها لا تخص طلبك", REVIEW_SHEET_AR, 2, "", "لم تُسلَّم ولم تُحتسب في السعر؛ وُضعت هنا للمراجعة فقط"]);
    // no excluded rows: no review sheet at all
    const clean = await load((await buildMissionFiles(plan([TWEETS]), { tweets: [{ id: "m1", text: "محمد صلاح", url: "https://x.example/m1", author: "f1" }] })).xlsx);
    expect(clean.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "التغريدات"]);
  });
});

describe("a delivered mission carries its download name; the download route uses it", () => {
  it("the Salah replay: the stored files carry «تغريدات عن محمد صلاح - N - date», in both formats, and the review sheet holds what was left out", async () => {
    const SPEC = { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"], context_terms: ["هدف"], text_columns: ["text"] };
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: i % 2 === 0 ? `محمد صلاح يسجل هدفًا جديدًا رقم ${i}` : `كلام آخر لا علاقة له رقم ${i}`, url: `https://x.example/s/t${i}`, author: i % 2 === 0 ? "fan" : "محمد صلاح الصلاحي" }));
    const r = await replay({
      request: "هات ٥ تغريدة عن محمد صلاح",
      planning: [
        { tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: 20 }, why: "the cheaper sources return no author or link fields in their catalog description" } },
        { tool: "run_code", args: { code: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: ["call_0001"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٥ تغريدات عن محمد صلاح لاعب كرة القدم.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 5, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 1), measured_by: [callIds(res)[0], firstOutputId(res)], relevance: SPEC, yield_from: firstOutputId(res) }],
        }) },
      ],
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: 20 } } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت التغريدات التي تخص محمد صلاح فعلًا." } },
      ],
      answers: [tregResult({ output: { data: { items: items(12) } } }, 0.00075), tregResult({ output: { data: { items: items(12) } } }, 0.00075)],
    });
    const files = r.mission.files!;
    const day = new Date().getUTCDate();
    expect(files.map((f) => f.download_name)).toEqual([`تغريدات عن محمد صلاح - ٥ - ${arabicDateLabel(new Date())}.xlsx`, `تغريدات عن محمد صلاح - ٥ - ${arabicDateLabel(new Date())}.csv`]);
    expect(String(day)).toBeTruthy();
    const wb = await load(r.store.files.get(`${r.missionId}/result/result.xlsx`) as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "التغريدات", REVIEW_SHEET_AR]);
    expect(wb.getWorksheet(REVIEW_SHEET_AR)!.rowCount).toBe(1 + 6); // the six tweets whose only link to the name is the author
    // the route names the download from them (and from the plan for a mission delivered before the names were stored)
    const route = readFileSync("src/app/api/jobs/[id]/download/route.ts", "utf8");
    expect(route).toContain("download_name");
    expect(route).toContain("missionFileTitleAr");
  });
});

describe("ONE progress number, and «تقدر تقفل الصفحة» only when it is true", () => {
  const row = (over: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer => ({ id: "msn_p1", status: "executing", question_ar: null, plan_public: { summary_ar: "ستحصل على تغريدات.", stages: [{ key: "t", title_ar: "التغريدات", expected_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { unit_price_points: 0.66, reserve_points: 200, max_charge_points: 200, delivered_rows: 300 }, expected_minutes: 3 }, reserved_points: 200, unit_price_points: 0.66, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-28T10:00:00Z", ...over });
  const at = (s: number) => new Date(Date.parse("2026-10-28T10:00:00Z") + s * 1000).toISOString();
  const ev = (id: number, s: number, counts: Record<string, number>): EventForCustomer => ({ id, kind: "progress", message_ar: "يواصل الوكيل العمل", counts, created_at: at(s) });
  const numbersIn = (v: ReturnType<typeof customerMissionView>) => [v.currentLineAr, ...v.steps.flatMap((s) => [s.countAr, s.detailAr])].filter((x): x is string => Boolean(x));

  it("while the pages are read the panel says «٠ من ٣٠٠» once; the pages are pages, never a second row count like «جُمع ٣٠٠ من ٣٠٠»", () => {
    const events = [ev(1, 10, { pages: 1, rows: 20, planned: 300 }), ev(2, 60, { pages: 15, rows: 300, planned: 300 })];
    const v = customerMissionView({ mission: row(), events, now: Date.parse(at(65)), queue: { ahead: 0, running: 1, workerAlive: true } });
    const lines = numbersIn(v).join(" | ");
    expect(v.steps[0].countAr).toBe("٠ من ٣٠٠");
    expect(lines).not.toContain("جُمع");
    expect(lines).toContain("قُرئت ١٥ صفحة من المصدر");
    // every «N من M» in the panel carries the same N
    const ns = [...lines.matchAll(/([٠-٩٬]+) من ([٠-٩٬]+)/g)].map((m) => m[1]);
    expect(new Set(ns).size).toBe(1);
  });

  it("when the rows are saved the same number moves everywhere together", () => {
    const events = [ev(1, 10, { pages: 15, rows: 300, planned: 300 }), ev(2, 70, { stage: 1, saved: 150, planned: 300 })];
    const v = customerMissionView({ mission: row(), events, now: Date.parse(at(75)), queue: { ahead: 0, running: 1, workerAlive: true } });
    const ns = [...numbersIn(v).join(" | ").matchAll(/([٠-٩٬]+) من ([٠-٩٬]+)/g)].map((m) => m[1]);
    expect(ns.length).toBeGreaterThan(0);
    expect(new Set(ns)).toEqual(new Set(["١٥٠"]));
  });

  it("the close-the-page line needs an approved mission AND a living worker; the e-mail is promised only when one will be sent", () => {
    const alive = { ahead: 0, running: 1, workerAlive: true };
    expect(closePageLine("executing", alive, true)).toBe(AGENT_CLOSE_PAGE_LINE_AR);
    expect(closePageLine("approved", alive, undefined)).toBe(AGENT_CLOSE_PAGE_LINE_AR);
    expect(closePageLine("executing", alive, false)).toBe(AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR);
    expect(AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR).not.toMatch(/إيميل|بريد/);
    expect(closePageLine("executing", { ahead: 0, running: 0, workerAlive: false }, true)).toBeNull();
    expect(closePageLine("executing", null, true)).toBeNull();
    expect(closePageLine("plan_ready", alive, true)).toBeNull();
    expect(closePageLine("planning", alive, true)).toBeNull();
    expect(closePageLine("completed", alive, true)).toBeNull();
    const v = customerMissionView({ mission: row(), events: [], now: Date.parse(at(5)), queue: { ahead: 0, running: 0, workerAlive: false } });
    expect(v.closePageAr).toBeNull();
    expect(v.delayAr).toContain("الخدمة متوقفة مؤقتًا");
  });

  it("who is e-mailed: a real address with the «done» e-mails on; not a guest, not an address-less account, not a customer who switched them off", () => {
    expect(userWillBeEmailed({ email: "a@b.com", user_metadata: {} })).toBe(true);
    expect(userWillBeEmailed({ email: "a@b.com", user_metadata: { prefs: { notif: { done: true } } } })).toBe(true);
    expect(userWillBeEmailed({ email: "a@b.com", user_metadata: { prefs: { notif: { done: false } } } })).toBe(false);
    expect(userWillBeEmailed({ email: "a@b.com", user_metadata: { is_guest: true } })).toBe(false);
    expect(userWillBeEmailed({ email: "", user_metadata: {} })).toBe(false);
    expect(userWillBeEmailed(null)).toBe(false);
  });

  it("the worker runs on its own dyno: the mission is in the worker's hands after approval, not in the browser (the claim, the lease and the heartbeat are server side)", () => {
    const main = readFileSync("agent/src/main.ts", "utf8");
    expect(main).toContain("worker.run()");
    expect(readFileSync("Procfile", "utf8")).toContain("agent/src/main.ts");
  });
});
