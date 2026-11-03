import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { checkDeliveryContract, parseDeliveredLine, type ContractInput } from "../src/lib/agentMission/foundation/deliveryContract";
import { APPROX_DATES_KEY, DATE_PRECISION_TITLE_AR } from "../src/lib/agentMission/relativeDates";
import { loadOverview } from "../src/lib/agentMission/adminActions";
import { MISSION_INTERNAL_COUNT_KEYS } from "../src/lib/agentMission/constants";
import { isInternalEvent } from "../src/lib/agentMission/eventText";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * ROUND 14, PART A: THE DELIVERY CONTRACT, rule by rule, on made-up deliveries (the replay of the stored live missions is tests/round14-contract-replay.test.ts). Each rule finds what it must, names the exact text expected, completes only the DESCRIPTION, and never removes a row, changes a value or blocks the file.
 */
const col = (key: string, title_ar: string) => ({ key, title_ar });
const stage = (o: Record<string, unknown>): PricedStage => ({ endpoint_id: "e", parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [col("text", "نص")], ...o }) as unknown as PricedStage;
const planOf = (stages: PricedStage[], extra: Record<string, unknown> = {}): PricedPlan => ({ summary_ar: "x", stages, price: { deliveredRows: stages.reduce((n, s) => n + s.planned_rows, 0) }, ...extra }) as unknown as PricedPlan;
const base = (plan: PricedPlan, over: Partial<ContractInput> = {}): ContractInput => ({ plan, rowsByStage: { posts: [{ id: "a" }, { id: "b" }, { id: "c" }] }, sheets: [], limitLines: [], numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 0 }, now: Date.parse("2026-11-03T12:00:00Z"), ...over });

describe("R1: one promised number", () => {
  const plan = planOf([stage({ key: "posts", title_ar: "المنشورات", expected_rows: 3, planned_rows: 3 })]);
  it("every surface says the same Y: no violation", () => {
    expect(checkDeliveryContract(base(plan, { numbers: { card: 537, file: 537, chat: 537, notice: 537, orders: 537, fileDelivered: 464, deliveredRows: 464 } }))).toEqual([]);
  });
  it("the live Facebook defect: the card said 537, the file, the chat, the notice and the orders page 620 — four violations, each with the two numbers", () => {
    const v = checkDeliveryContract(base(plan, { numbers: { card: 537, file: 620, chat: 620, notice: 620, orders: 620, fileDelivered: 464, deliveredRows: 464 } }));
    expect(v.map((x) => x.rule)).toEqual(["R1", "R1", "R1", "R1"]);
    expect(v[0]).toMatchObject({ expected: "٥٣٧ (الخطة قبل الاعتماد)", found: "٦٢٠ (الملف)" });
  });
  it("the delivered X must equal the data rows of the file", () => {
    const v = checkDeliveryContract(base(plan, { numbers: { card: null, file: 10, chat: 10, notice: 10, orders: 10, fileDelivered: 12, deliveredRows: 10 } }));
    expect(v).toHaveLength(1);
    expect(v[0].expected).toBe("١٠ صفًا في الملف");
  });
  it("«تم تسليم X من Y» is read in Arabic-Indic digits and with the thousands mark", () => {
    expect(parseDeliveredLine("تم تسليم ٤٦٤ من ١٬٧٩٣ عنصرًا.")).toEqual({ x: 464, y: 1793 });
    expect(parseDeliveredLine("لا شيء")).toBeNull();
  });
});

describe("R2..R4 through the real workbook: the description is completed, nothing else changes", () => {
  // a comments stage that asked 5 per video; the videos carry no counter; 2 were delivered for the first video, 5 for the second; the plan is NOT a compiled one, so no engine line was written for the gap
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", expected_rows: 2, planned_rows: 2, columns: [col("text", "عنوان الفيديو"), col("published", "تاريخ النشر")], relative_dates: true });
  const comments = stage({ key: "comments", title_ar: "التعليقات", expected_rows: 10, planned_rows: 10, parent_key: "videos", per_parent_rows: 5, columns: [col("text", "نص التعليق")] });
  // a compiled plan: the completion is the compiled path's (an old-path plan is checked and reported, never completed: its files stay byte for byte what they were)
  const plan = planOf([videos, comments], { compiled: { by: "compiler", platform: "youtube", promises: {} } });
  const rows = {
    videos: [{ id: "v1", text: "فيديو ١", published: "2026-10-30" }, { id: "v2", text: "فيديو ٢", published: "2026-10-01T10:00:00Z" }],
    comments: [...[1, 2].map((i) => ({ id: `c1_${i}`, parent_id: "v1", text: `تعليق ${i}` })), ...[1, 2, 3, 4, 5].map((i) => ({ id: `c2_${i}`, parent_id: "v2", text: `تعليق ${i}` }))],
  };
  const read = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as never); return wb; };
  const textsOf = (wb: ExcelJS.Workbook) => { const out: string[] = []; wb.worksheets[0].eachRow((r) => r.eachCell((c) => { if (typeof c.value === "string") out.push(c.value); })); return out; };
  it("R2: the first video gave 2 of the 5 asked; no line says so, so the contract names it and (in delivery) adds the line", async () => {
    const seen = await buildMissionFiles(plan, rows, undefined, undefined, { completeContract: false });
    const r2 = seen.contract.violations.filter((v) => v.rule === "R2");
    expect(r2.length).toBeGreaterThan(0);
    expect(r2[0].expected).toContain("الفيديو رقم ١");
    expect(r2[0].expected).toContain("٥");
    expect(r2[0].expected).toContain("٢");
    const done = await buildMissionFiles(plan, rows);
    expect(done.contract.completed.some((c) => c.kind === "limit_line")).toBe(true);
    const lines = textsOf(await read(done.xlsx)).join("\n");
    expect(lines).toContain("الفيديو رقم ١");
    expect(lines).not.toContain("لا قيود سُجّلت على هذا التسليم");
  });
  it("R3: a day with no time of day from a stage dated relatively, with no mark, is completed as «تقريبي» (column and count), the date cell untouched", async () => {
    const seen = await buildMissionFiles(plan, rows, undefined, undefined, { completeContract: false });
    expect(seen.contract.violations.some((v) => v.rule === "R3" && v.expected.includes("تقريبي"))).toBe(true);
    const done = await buildMissionFiles(plan, rows);
    const wb = await read(done.xlsx);
    const sheet = wb.getWorksheet("الفيديوهات")!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((c) => headers.push(String(c.value)));
    expect(headers).toContain(DATE_PRECISION_TITLE_AR);
    const at = headers.indexOf(DATE_PRECISION_TITLE_AR) + 1;
    expect([2, 3].map((r) => String(sheet.getRow(r).getCell(at).value))).toEqual(["تقريبي", "دقيق"]);
    expect(textsOf(wb).join("\n")).toContain("١ من ٢ تاريخًا تقريبيًا");
  });
  it("NEVER a filter: the rows and the values of the file are the same with and without the completion; the delivery is never blocked", async () => {
    const without = await buildMissionFiles(plan, rows, undefined, undefined, { completeContract: false });
    const withIt = await buildMissionFiles(plan, rows);
    const dump = async (b: Buffer) => { const wb = await read(b); return wb.worksheets.slice(1).map((s) => { const out: unknown[] = []; s.eachRow((r) => out.push((r.values as unknown[]).length)); return [s.name, out.length]; }); };
    expect((await dump(withIt.xlsx)).map(([n, c]) => [n, c])).toEqual((await dump(without.xlsx)).map(([n, c]) => [n, c]));
    expect(withIt.xlsx.length).toBeGreaterThan(1000);
    expect(JSON.stringify(rows)).toContain("تعليق 1");
  });
  it("R4: a request that set a source, a period, a language, a country and a topic needs the five mark columns on the parent sheet; a sheet with none gets five violations, a blank mark cell is filled from the row", async () => {
    const compiled = planOf([stage({ key: "posts", title_ar: "المنشورات", expected_rows: 1, planned_rows: 1, columns: [col("text", "نص المنشور")] })], { compiled: { by: "compiler", platform: "facebook", promises: { posts: { type: "exact", n: 1 } }, conditions: { named: true, period: true, language: true, country: true, topic: true } } });
    const built = await buildMissionFiles(compiled, { posts: [{ id: "p1", text: "منشور" }] }, undefined, undefined, { completeContract: false });
    const r4 = built.contract.violations.filter((v) => v.rule === "R4");
    expect(r4.map((v) => v.expected)).toEqual(["عمود «المصدر المسمّى» في ورقة «المنشورات»", "عمود «ضمن الفترة المطلوبة» في ورقة «المنشورات»", "عمود «لغة النص» في ورقة «المنشورات»", "عمود «علاقة النص بالموضوع» في ورقة «المنشورات»", "عمود «الدولة» في ورقة «المنشورات»"]);
    // no condition set: no violation
    const plain = planOf([stage({ key: "posts", title_ar: "المنشورات", expected_rows: 1, planned_rows: 1, columns: [col("text", "نص المنشور")] })], { compiled: { by: "compiler", platform: "facebook", promises: { posts: { type: "exact", n: 1 } }, conditions: { named: false, period: false, language: false, country: false, topic: false } } });
    expect((await buildMissionFiles(plain, { posts: [{ id: "p1", text: "منشور" }] }, undefined, undefined, { completeContract: false })).contract.violations.filter((v) => v.rule === "R4")).toEqual([]);
  });
  it("a row that carries the approximate mark but whose sheet lacks the precision column: R3 names it with the completion", () => {
    const p = planOf([stage({ key: "c", title_ar: "التعليقات", expected_rows: 1, planned_rows: 1, columns: [col("text", "نص"), col("posted_at", "تاريخ ووقت التعليق")] })]);
    const v = checkDeliveryContract(base(p, { rowsByStage: { c: [{ id: "a", text: "x", posted_at: "2025-12-03", [APPROX_DATES_KEY]: ["posted_at"] }] }, sheets: [{ stageKey: "c", title: "التعليقات", headers: ["نص", "تاريخ ووقت التعليق"], rows: [{ id: "a", parentId: null, cells: { "نص": "x", "تاريخ ووقت التعليق": "2025-12-03" } }] }] }));
    expect(v.some((x) => x.rule === "R3" && x.fix?.kind === "precision")).toBe(true);
  });
});

describe("an old-path plan is checked and reported, never completed (flags off: the file is byte for byte what it was)", () => {
  it("the same delivery with no compiled mark: violations are found, nothing is completed", async () => {
    const videos = stage({ key: "videos", title_ar: "الفيديوهات", expected_rows: 2, planned_rows: 2 });
    const comments = stage({ key: "comments", title_ar: "التعليقات", expected_rows: 10, planned_rows: 10, parent_key: "videos", per_parent_rows: 5 });
    const built = await buildMissionFiles(planOf([videos, comments]), { videos: [{ id: "v1", text: "ف" }, { id: "v2", text: "ف" }], comments: [{ id: "c1", parent_id: "v1", text: "ت" }] });
    expect(built.contract.violations.length).toBeGreaterThan(0);
    expect(built.contract.completed).toEqual([]);
  });
});

describe("the worker's record and the admin's section", () => {
  it("the six internal keys are internal events (the customer never sees them)", () => {
    for (const k of ["adm_contract", "adm_r1", "adm_r2", "adm_r3", "adm_r4", "adm_completed"]) expect(MISSION_INTERNAL_COUNT_KEYS).toContain(k);
    expect(isInternalEvent({ counts: { adm_flag: 1, adm_contract: 1, adm_r2: 2 } })).toBe(true);
  });
  it("loadOverview (read only) lists the last contract events: mission id, rules, what was completed; other internal events are not listed", async () => {
    const events = [
      { mission_id: "msn_a", message_ar: "علامة داخلية للمشرف: ملف صُحّح وصفه تلقائيًا؛ ما اكتمل: سطر في الحدود: الفيديو رقم ١", counts: { adm_flag: 1, adm_contract: 1, adm_r1: 0, adm_r2: 1, adm_r3: 0, adm_r4: 0, adm_completed: 1 }, created_at: "2026-11-03T15:00:00Z" },
      { mission_id: "msn_b", message_ar: "علامة أخرى", counts: { adm_flag: 1, adm_store: 3 }, created_at: "2026-11-03T14:00:00Z" },
    ];
    const builder = (data: unknown): any => { const b: any = { select: () => b, eq: () => b, order: () => b, limit: () => b, maybeSingle: () => b, then: (r: (x: unknown) => void) => r({ data, error: null }) }; return b; };
    const client = { from: (t: string) => builder(t === "mission_events" ? events : t.includes("settings") ? null : []) };
    const o = await loadOverview(client, Date.parse("2026-11-03T16:00:00Z"));
    expect(o.contractEvents).toEqual([{ mission_id: "msn_a", message_ar: events[0].message_ar, created_at: "2026-11-03T15:00:00Z", r1: 0, r2: 1, r3: 0, r4: 0, completed: 1 }]);
  });
});
