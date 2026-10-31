import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { countWorkbookItems, countWorkbookSheets } from "../agent/src/finalize";
import { buildMethodology, METHODOLOGY_TITLE_AR, NOT_RECORDED_AR, platformOfEndpoint, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE «المنهجية» SECTION lives BELOW the summary in the FIRST sheet (never a sheet of its own): the settlement reads the delivered file back with the REAL countWorkbookItems / countWorkbookSheets (every sheet after the first), so a new
 * sheet would be counted as delivered items. These tests open real workbooks with a real reader and prove the counts and the sheet-to-stage mapping are identical with and without the section.
 */
const FIRST_SHEET = "ملخص المهمة";

const tweetsStage = (planned: number) => ({
  key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: planned, planned_rows: planned, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
  columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "created_at", title_ar: "تاريخ النشر" }],
  relevance: { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"], text_columns: ["text"], review: true },
  filters: [{ kind: "language", lang: "ar" }, { kind: "period", days: 30 }],
  engine: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", max_results: 100 }, cursor_param: null, map_code: "return []", map_file_id: "call_0001", parent_binding: null },
});
const planOf = (planned: number, over: Record<string, unknown> = {}): PricedPlan => ({
  summary_ar: "ستحصل على تغريدات عن محمد صلاح.", stages: [tweetsStage(planned)] as any,
  price: { totalCostUsd: 0, deliveredRows: planned, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: planned * 2, maxChargePoints: planned, overCap: false } as any,
  quantity: { requested: planned, stage_key: "tweets", target: planned, source: "request" }, ...over,
});
const tweetRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, text: `تغريدة رقم ${i + 1} عن محمد صلاح`, created_at: new Date(Date.UTC(2026, 9, 1 + (i % 28), 10, i % 60)).toISOString() }));

const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 70, duplicates: 6, accepted: 50, excluded: 14, pending: 0, unchecked: 0, acceptedByRule: 44, acceptedByModel: 6, excludedByReason: { no_term: 5, mention_only: 3, filter_language: 4, filter_reply: 2 }, stop: "target_reached", ...over });
const FACTS: MissionFacts = { requestText: "أريد ٥٠ تغريدة عن محمد صلاح من آخر شهر باللغة العربية", deliveredAt: new Date("2026-10-31T12:00:00Z"), stages: { tweets: record() }, reviewStop: null };

async function load(xlsx: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
/** The text of the first sheet, one line per row (cells joined with « | »): what a person reads. */
function sheetText(sheet: ExcelJS.Worksheet): string[] {
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => { if (!cell.isMerged || cell.address === (cell.master?.address ?? cell.address)) cells.push(String(typeof cell.value === "object" && cell.value && "text" in (cell.value as any) ? (cell.value as any).text : cell.value ?? "")); });
    lines.push(cells.join(" | "));
  });
  return lines;
}
/** Where the methodology starts in the first sheet (the row with its title), or -1. */
const sectionStart = (sheet: ExcelJS.Worksheet): number => { let at = -1; sheet.eachRow({ includeEmpty: true }, (row, n) => { if (at < 0 && row.getCell(1).value === METHODOLOGY_TITLE_AR) at = n; }); return at; };
/** The same workbook WITHOUT the section: its rows are removed from the first sheet (what the file was before this change). */
async function withoutSection(xlsx: Buffer): Promise<Buffer> {
  const wb = await load(xlsx);
  const first = wb.worksheets[0];
  const at = sectionStart(first);
  expect(at).toBeGreaterThan(0);
  // the rows of the section are emptied (ExcelJS' spliceRows keeps merged rows): what is left is the summary as it was before this change
  for (let n = at - 1; n <= first.rowCount; n += 1) first.getRow(n).eachCell({ includeEmpty: true }, (cell) => { cell.value = null; });
  for (const [key, merge] of Object.entries((first as any)._merges as Record<string, { model: { top: number } }>)) if (merge.model.top >= at - 1) delete (first as any)._merges[key];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const mappingOf = (plan: PricedPlan, rows: Record<string, unknown[]>, sheets: number[]): Record<string, number> | null => {
  const withSheet = plan.stages.filter((s) => s.deliver && (rows[s.key] ?? []).length > 0);
  return withSheet.length === sheets.length ? Object.fromEntries(withSheet.map((s, i) => [s.key, sheets[i]])) : null;
};

describe.each([{ name: "50 items", planned: 50, delivered: 50 }, { name: "40 of 50 items", planned: 50, delivered: 40 }])("the settlement read-back with and without the methodology section: $name", ({ planned, delivered }) => {
  it("the REAL countWorkbookItems and countWorkbookSheets give identical numbers, and the sheet-to-stage mapping is identical", async () => {
    const plan = planOf(planned);
    const rows = { tweets: tweetRows(delivered) };
    const facts: MissionFacts = { ...FACTS, stages: { tweets: record({ accepted: delivered, found: delivered + 20, stop: delivered < planned ? "source_exhausted" : "target_reached" }) } };
    const withSection = (await buildMissionFiles(plan, rows, facts)).xlsx;
    const before = await withoutSection(withSection);
    // the section is really there in the one and in the other it is not
    expect(sectionStart((await load(withSection)).worksheets[0])).toBeGreaterThan(0);
    expect(sectionStart((await load(before)).worksheets[0])).toBe(-1);
    // the numbers the settlement is made from
    expect(await countWorkbookItems(withSection)).toBe(delivered);
    expect(await countWorkbookItems(before)).toBe(delivered);
    expect(await countWorkbookSheets(withSection)).toEqual([delivered]);
    expect(await countWorkbookSheets(before)).toEqual([delivered]);
    // the sheet-to-stage mapping runMission builds from them
    expect(mappingOf(plan, rows, (await countWorkbookSheets(withSection))!)).toEqual({ tweets: delivered });
    expect(mappingOf(plan, rows, (await countWorkbookSheets(withSection))!)).toEqual(mappingOf(plan, rows, (await countWorkbookSheets(before))!));
    // every sheet after the first holds exactly the same cells with and without the section
    const a = await load(withSection); const b = await load(before);
    expect(a.worksheets.map((w) => w.name)).toEqual(b.worksheets.map((w) => w.name));
    for (let i = 1; i < a.worksheets.length; i += 1) expect(sheetText(a.worksheets[i])).toEqual(sheetText(b.worksheets[i]));
  });
});

describe("where the section is", () => {
  it("it is inside the first sheet, below the summary and its two closing lines; there is no sheet of its own and the first sheet keeps its name", async () => {
    const wb = await load((await buildMissionFiles(planOf(50), { tweets: tweetRows(50) }, FACTS)).xlsx);
    expect(wb.worksheets.map((w) => w.name)).toEqual([FIRST_SHEET, "التغريدات"]);
    expect(wb.getWorksheet(METHODOLOGY_TITLE_AR)).toBeUndefined();
    const first = wb.worksheets[0];
    const text = sheetText(first);
    // the existing summary is unchanged above: header, one stage row, a blank row, the delivery sentence (row 4) and the note
    expect(text[0]).toBe("المرحلة | الورقة | العدد | المتوقع | ملاحظة");
    expect(String(first.getRow(4).getCell(1).value)).toBe("تم تسليم ٥٠ من ٥٠ تغريدة.");
    expect(sectionStart(first)).toBeGreaterThan(5);
    expect(first.views[0]).toMatchObject({ state: "frozen", ySplit: 1, rightToLeft: true });
  });

  it("nothing in the production code reads the first sheet's rows: only the readers that skip it (finalize.ts) and the customer's own exclusion-file reader (a different workbook) open a workbook", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
    const readers = [...walk("agent/src"), ...walk("src")].filter((p) => /xlsx\.load|readFile\(/.test(readFileSync(p, "utf8")) && /worksheets|getWorksheet/.test(readFileSync(p, "utf8"))).map((p) => p.replace(/\\/g, "/")).sort();
    // finalize.ts skips the first sheet (slice(1)); exclusionFileParser reads the CUSTOMER'S upload; extractionBenchmark reads a workbook of the old chat generator;
    // the invoice assistant's parseFiles reads the ADMIN'S OWN uploaded spreadsheets in memory (never a delivered file, never written back); the builders write, never read
    expect(readers).toEqual(["agent/src/finalize.ts", "src/lib/server/exclusionFileParser.ts", "src/lib/server/extractionBenchmark.ts", "src/lib/server/invoices/chat/parseFiles.ts"]);
    expect(readFileSync("agent/src/finalize.ts", "utf8")).toContain("wb.worksheets.slice(1)");
  });
});

describe("the contents", () => {
  const build = async () => {
    const built = await buildMissionFiles(planOf(50), { tweets: tweetRows(50) }, FACTS);
    const first = (await load(built.xlsx)).worksheets[0];
    const lines = sheetText(first);
    return { first, lines, section: lines.slice(sectionStart(first) - 1) };
  };

  it("holds every fact the brief lists, from the recorded facts", async () => {
    const { section } = await build();
    const text = section.join("\n");
    expect(section[0]).toBe("المنهجية");
    expect(text).toContain("طلبك (بكلماتك) | أريد ٥٠ تغريدة عن محمد صلاح من آخر شهر باللغة العربية");
    expect(text).toContain("المنصات والمصادر المستخدمة | إكس");
    expect(text).toContain("كلمات أو عبارات البحث: «محمد صلاح»");
    expect(text).toContain("الفترة المطلوبة | آخر ٣٠ يومًا");
    expect(text).toMatch(/الفترة التي غطّتها النتائج \| من ٢٠٢٦-١٠-٠١ [٠-٩]{2}:[٠-٩]{2} إلى ٢٠٢٦-١٠-٢٨ [٠-٩]{2}:[٠-٩]{2} \(بتوقيت القاهرة\)/);
    expect(text).toContain("المرشّحات المطبّقة | باللغة العربية فقط؛ آخر ٣٠ يومًا");
    expect(text).toContain("إزالة المكرر | أُزيل ٦ من النتائج المكررة");
    expect(text).toContain("كيف فُحصت الصلة بطلبك");
    expect(text).toContain("قُبل ٤٤ بقاعدة البرنامج و٦ بالمراجعة الآلية");
    // the counts per stage: read (found), left out, delivered
    expect(text).toContain("المرحلة | قُرئ | استُبعد | سُلّم | ملاحظة");
    expect(text).toContain("التغريدات | ٧٠ | ١٤ | ٥٠ | أُزيل ٦ مكررًا");
    expect(text).toContain("استُبعد ٥ لا يذكر الموضوع في نصه؛ ٤ بلغة غير التي حددتها؛ ٣ إشارة عابرة أو رد فارغ؛ ٢ رد على غيره");
    expect(text).toContain("حدود هذا التسليم | لا قيود سُجّلت على هذا التسليم");
    expect(text).toContain("صيغة الاستشهاد المقترحة | ديجر. «محمد صلاح لاعب كرة القدم»: ٥٠ تغريدة، جُمعت من إكس، في الفترة من ٢٠٢٦-١٠-٠١ إلى ٢٠٢٦-١٠-٢٨. تاريخ التسليم: ٣١ أكتوبر ٢٠٢٦.");
  });

  it("says the limits in the card's honest words: a lowered target, a step not served, a source not found, a delivery short of the plan", async () => {
    const plan = planOf(50, { quantity: { requested: 80, stage_key: "tweets", target: 50, reason_ar: "المصدر لا يعطي أكثر من هذا العدد في الطلب الواحد.", source: "request" }, unserved_steps: [{ what_ar: "مديرو كل شركة", reason_ar: "لا مصدر يعطي أسماءهم." }] });
    (plan.stages[0] as any).unresolved_sources = ["حساب غير موجود"];
    const facts: MissionFacts = { ...FACTS, stages: { tweets: record({ accepted: 40, stop: "source_exhausted", excludedByReason: { no_term: 5 } }) } };
    const first = (await load((await buildMissionFiles(plan, { tweets: tweetRows(40) }, facts)).xlsx)).worksheets[0];
    const text = sheetText(first).join("\n");
    expect(text).toContain("العدد المعتمد في الخطة أقل مما طلبت لأن المصدر لا يعطي أكثر من هذا العدد في الطلب الواحد.");
    expect(text).toContain("لم يُنفَّذ: مديرو كل شركة؛ لا مصدر يعطي أسماءهم.");
    expect(text).toContain("لم نجد «حساب غير موجود» بين ما فحصناه قبل عرض الخطة");
    expect(text).toContain("سُلّم ٤٠ من ٥٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب.");
  });

  it("never holds a provider's name, an endpoint id, an internal id, a price, a model's vendor, «صف» or «سجل», and every number is in Arabic-Indic digits", async () => {
    const { section } = await build();
    const lines = section.filter((l) => l.trim() !== "");
    for (const line of lines) {
      const check = checkCustomerText(line, { maxChars: 5000 });
      expect(check.issues, line).toEqual([]);
      expect(check.text, line).toBe(line.replace(/\n/g, " ").replace(/\s+/g, " ").trim());
    }
    const whole = section.join("\n");
    expect(whole).not.toMatch(/anyapi|crawl4ai|contextdev|justoneapi|treg|apify|openai|anthropic|claude|gpt|haiku|sonnet|opus/i);
    expect(whole).not.toMatch(/\b(?:msn|job|res|chg|rel|call|out|quote)_[A-Za-z0-9]+/i);
    expect(whole).not.toMatch(/[$]|usd|دولار/i);
    expect(whole).not.toMatch(/(?<![ء-ي])(?:صف|سجل|صفوف|سجلات)(?![ء-ي])/);
    expect(whole).not.toMatch(/[0-9]/);
    expect(whole).toMatch(/[٠-٩]/);
  });

  it("a fact that was not recorded says «غير مسجّل» (never invented): no facts, no source name, no recorded counts, no date column", async () => {
    const plan = planOf(5);
    const stage = plan.stages[0] as any;
    delete stage.engine; delete stage.relevance; delete stage.filters; stage.endpoint_id = "e"; stage.columns = [{ key: "text", title_ar: "النص" }];
    const rows = { tweets: [{ id: "a", text: "أول" }, { id: "b", text: "ثان" }] };
    const first = (await load((await buildMissionFiles(plan, rows)).xlsx)).worksheets[0];
    const lines = sheetText(first);
    const section = lines.slice(sectionStart(first) - 1);
    const text = section.join("\n");
    for (const label of ["طلبك (بكلماتك)", "المنصات والمصادر المستخدمة", "ما بُحث عنه", "الفترة التي غطّتها النتائج", "إزالة المكرر"]) expect(text).toContain(`${label} | ${NOT_RECORDED_AR}`);
    expect(text).toContain("التغريدات | غير مسجّل | غير مسجّل | ٢ | غير مسجّل");
    expect(text).toContain("جُمعت من غير مسجّل");
    // a stage with no relevance check and no filter says what the plan holds, not a guess
    expect(text).toContain("لم يُطبَّق فحص صلة بالنص على هذه المرحلة");
    expect(text).toContain("لا مرشّحات في خطتك المعتمدة");
    // still Arabic-only and clean
    for (const l of section.filter((x) => x.trim())) expect(checkCustomerText(l, { maxChars: 5000 }).issues, l).toEqual([]);
  });

  it("platform names come from the words of the source's name, never the name itself", () => {
    expect(platformOfEndpoint("anyapi.x.search.posts")).toBe("إكس");
    expect(platformOfEndpoint("x.x.search-posts-all")).toBe("إكس");
    expect(platformOfEndpoint("justoneapi.x.facebook-search-post-v1")).toBe("فيسبوك");
    expect(platformOfEndpoint("contextdev.parse.tiktok-feed")).toBe("تيك توك");
    expect(platformOfEndpoint("crawl4ai.youtube.channel")).toBe("يوتيوب");
    expect(platformOfEndpoint("contextdev.parse.emails")).toBeNull();
    expect(platformOfEndpoint("e")).toBeNull();
  });

  it("the model is a pure function of the plan, the rows and the recorded facts", () => {
    const a = buildMethodology({ plan: planOf(5), layouts: [], rowsByStage: { tweets: tweetRows(5) }, facts: FACTS });
    const b = buildMethodology({ plan: planOf(5), layouts: [], rowsByStage: { tweets: tweetRows(5) }, facts: FACTS });
    expect(a).toEqual(b);
  });
});
