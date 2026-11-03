import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { buildMissionFiles } from "../agent/src/workbook";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import { replayGateway } from "./helpers/replayGateway";

/**
 * LIVE FINDINGS D2, D3, D4 (3 Nov 2026, msn_2dfcf9cc113dff442711: 2 TikTok videos, «٢٠ تعليق من كل فيديو مع ردودهم»; delivered 63).
 *   D2: the comments sheet had no «لغة النص» column (the videos sheet has it).
 *   D3: the site said «تم تسليم ٦٣ من ٦٦ عنصرًا», the file's first sheet «تم تسليم ٦٣ من ٦٣ عنصرًا».
 *   D4: the file said «عداد الفيديو ٢٨٦، سُلّم ٢٠ تعليقًا و٦ ردود؛ والفرق لم يعطِه المصدر»: a per-video limit of 20 compared with the whole video counter.
 *
 * THE DATA. The raw pages of the live mission are in storage, which this session does not read; the SAME tools' real pages are the anonymised M12 pages in tests/fixtures/live/missions
 * (the plan is compiled by planByCompiler on them, as the foundation replay does), and the delivered rows are M12's real anonymised rows cut to the live shape: the first 20 comments of
 * each of the 2 videos (the customer's number per video), and the replies the stored run read for those comments (20), against the reply counters those 40 comments carry (28): a
 * source that gave fewer replies than the counters say, as the live one did (counters 24, delivered 21).
 */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const rows = (stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/rows/${stage}.json`, import.meta.url), "utf8"));

async function textsOf(xlsx: Buffer): Promise<{ sheets: string[]; byName: Record<string, string[][]> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const byName: Record<string, string[][]> = {};
  wb.eachSheet((ws) => {
    const out: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const cells: string[] = []; row.eachCell({ includeEmpty: true }, (c) => { const v = c.value; cells.push(v === null || v === undefined ? "" : typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : String(v)); }); out.push(cells); });
    byName[ws.name] = out;
  });
  return { sheets: wb.worksheets.map((w) => w.name), byName };
}

describe("D2 to D4 on the compiled TikTok plan of the live shape", () => {
  let planned: CompiledPlanning;
  let plan: PricedPlan;
  let rowsByStage: Record<string, Array<Record<string, unknown>>>;
  let judged: PricedPlan;
  let counters = 0;
  beforeAll(async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M12, catalog, store, "msn_live_d");
    planned = await planByCompiler({ mission: { id: "msn_live_d", request_text: REQUEST, answer_text: null, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
    if (planned.kind !== "plan") throw new Error(`no plan: ${planned.reason}`);
    plan = planned.plan;
    const videos = rows("videos").map((r) => ({ ...r }));
    const all = rows("comments");
    const comments = videos.flatMap((v) => all.filter((c) => c.parent_id === v.id).slice(0, 20));
    const commentIds = new Set(comments.map((c) => String(c.id)));
    const replies = rows("comments_replies").filter((r) => commentIds.has(String(r.parent_id)));
    counters = comments.reduce((n, c) => n + (Number(c.replies_count) || 0), 0);
    rowsByStage = { videos, comments, comments_replies: replies };
    // the order the run applies before it writes the file (agent/src/runMission.ts): promise caps, the reported plan, the replies judged against the counters of the delivered comments
    let p = withPromiseCaps(plan);
    p = reportedPlan(p, Object.fromEntries(p.stages.map((s) => [s.key, rowsByStage[s.key].length])));
    judged = withRepliesJudged(p, rowsByStage, () => true);
  }, 120_000);

  it("the live shape is real: 2 videos, 40 comments (20 each), 20 replies read against reply counters of 28", () => {
    expect(rowsByStage.videos).toHaveLength(2);
    expect(rowsByStage.comments).toHaveLength(40);
    expect(rowsByStage.comments_replies).toHaveLength(20);
    expect(counters).toBe(28);
    expect(plan.stages.find((s) => s.key === "comments")!.per_parent_rows).toBe(20);
    expect(judged.stages.find((s) => s.key === "comments_replies")!.planned_rows).toBe(28);
  });

  it("D2: the compiled comments and replies stages carry the language of the text, named as the videos sheet's mark, «لغة النص»", () => {
    for (const key of ["comments", "comments_replies"]) {
      const cols = plan.stages.find((s) => s.key === key)!.columns;
      expect(cols.map((c) => c.title_ar), key).toContain("لغة النص");
    }
  });

  it("D2: the comments sheet of the file has the «لغة النص» column, filled for every comment and every reply (the source's own code, else the text's script: nothing removed)", async () => {
    const built = await buildMissionFiles(judged, rowsByStage);
    const { byName } = await textsOf(built.xlsx);
    const sheetName = Object.keys(byName).find((n) => /تعليق/.test(n))!;
    const [head, ...body] = byName[sheetName];
    const at = head.indexOf("لغة النص");
    expect(at, `columns: ${head.join(" | ")}`).toBeGreaterThanOrEqual(0);
    expect(body.length).toBe(60);
    expect(body.every((r) => ["العربية", "لغة أخرى", "غير محددة"].includes(r[at]))).toBe(true);
    // the reply-or-original mark of a thread sheet is the workbook's own «نوع التعليق» («تعليق» / «رد»): one name on this sheet, not two for the same fact
    const kind = head.indexOf("نوع التعليق");
    expect(kind).toBeGreaterThanOrEqual(0);
    expect(head.filter((h) => h === "رد أم أصلي")).toHaveLength(0);
    expect(body.filter((r) => r[kind] === "رد")).toHaveLength(20);
    expect(body.filter((r) => r[kind] === "تعليق")).toHaveLength(40);
  });

  it("D3: the site and the file state the same promised number and the same delivered number", async () => {
    const delivered = 2 + 40 + 20;
    const mission = { id: "msn_live_d", status: "completed", question_ar: null, plan_public: customerPlanView(judged), reserved_points: 328, unit_price_points: 4.317, delivered_units: delivered, charged_points: 272, summary_ar: null, files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-11-03T07:11:32Z" };
    const site = customerMissionView({ mission, events: [] }).resultLinesAr.find((l) => /^تم تسليم/.test(l))!;
    const built = await buildMissionFiles(judged, rowsByStage, undefined, undefined, { repliesJudged: true });
    const { byName } = await textsOf(built.xlsx);
    const file = Object.values(byName).flat().map((r) => r[0]).find((t) => /^تم تسليم/.test(t))!;
    expect(site).toBe("تم تسليم ٦٢ من ٧٠ عنصرًا.");
    expect(file).toBe(site);
  });

  it("D3: with no judged replies (a plan with no open replies) the file's sentence is exactly what it was", async () => {
    const built = await buildMissionFiles(judged, rowsByStage);
    const { byName } = await textsOf(built.xlsx);
    const file = Object.values(byName).flat().map((r) => r[0]).find((t) => /^تم تسليم/.test(t))!;
    expect(file).toBe("تم تسليم ٦٢ من ٦٢ عنصرًا.");
  });

  it("D3 with the EXACT live numbers (msn_2dfcf9cc113dff442711: plan 2 + 40 + 24 = 66, delivered 2 + 40 + 21 = 63; reply counters 24): the site and the file both say «٦٣ من ٦٦»", async () => {
    // the live record (SELECT on mission_events): plan event rows 66; result event delivered 63, stage rows 2 / 40 / 21; the plan's replies promise 24 counted from 40 comments
    const videos = rowsByStage.videos.map((r) => ({ ...r }));
    const comments = rowsByStage.comments.map((c, i) => ({ ...c, replies_count: i < 24 ? 1 : 0 }));
    const replies = Array.from({ length: 21 }, (_, i) => ({ ...rowsByStage.comments_replies[0], id: `live_r_${i}`, parent_id: String((comments[i] as Record<string, unknown>).id) }));
    const live = { videos, comments, comments_replies: replies };
    let p = withPromiseCaps(plan);
    p = reportedPlan(p, Object.fromEntries(p.stages.map((s) => [s.key, live[s.key as keyof typeof live].length])));
    const j = withRepliesJudged(p, live, () => true);
    expect(j.stages.find((s) => s.key === "comments_replies")!.planned_rows).toBe(24);
    const mission = { id: "msn_2dfcf9cc113dff442711", status: "completed", question_ar: null, plan_public: customerPlanView(j), reserved_points: 328, unit_price_points: 4.317, delivered_units: 63, charged_points: 272, summary_ar: null, files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-11-03T07:11:32Z" };
    const site = customerMissionView({ mission, events: [] }).resultLinesAr.find((l) => /^تم تسليم/.test(l))!;
    const built = await buildMissionFiles(j, live, undefined, undefined, { repliesJudged: true });
    const { byName } = await textsOf(built.xlsx);
    const file = Object.values(byName).flat().map((r) => r[0]).find((t) => /^تم تسليم/.test(t))!;
    expect(site).toBe("تم تسليم ٦٣ من ٦٦ عنصرًا.");
    expect(file).toBe(site);
    // and the gap line: replies by the counters of the delivered comments (24) against the 21 delivered
    const lines = Object.values(byName).flat().flat().filter((t) => typeof t === "string" && /^الفيديو رقم/.test(t));
    expect(lines.join("\n")).toMatch(/ردود التعليقات المسلّمة بحسب عدّاداتها/);
    expect(lines.join("\n")).not.toMatch(/عداد الفيديو/);
  });

  it("D4: the gap is stated against what was asked: comments asked and delivered per video, replies by the reply counters of the delivered comments, never the whole video counter", async () => {
    const built = await buildMissionFiles(judged, rowsByStage, undefined, undefined, { repliesJudged: true });
    const { byName } = await textsOf(built.xlsx);
    const all = Object.values(byName).flat().flat().filter((t) => typeof t === "string");
    const gapLines = all.filter((t) => /والفرق لم يعطِه المصدر/.test(t));
    expect(gapLines.length).toBeGreaterThan(0);
    // none compares the per-video number with the video's own counter (which counts every comment and every reply)
    for (const l of gapLines) expect(l).not.toMatch(/عداد الفيديو|١٬١٦٧|١٬٠٨٤/);
    // per video: the reply counters of ITS delivered comments against the replies delivered for them (the real counts of the stored rows)
    rowsByStage.videos.forEach((v, i) => {
      const mine = rowsByStage.comments.filter((c) => c.parent_id === v.id);
      const counters = mine.reduce((n, c) => n + (Number(c.replies_count) || 0), 0);
      const got = rowsByStage.comments_replies.filter((r) => mine.some((c) => c.id === r.parent_id)).length;
      const line = all.find((t) => t.startsWith(`الفيديو رقم ${toAr(i + 1)}:`) && /والفرق لم يعطِه المصدر/.test(t));
      if (got < counters) {
        expect(line, `video ${i + 1}`).toBeDefined();
        expect(line).toContain(`ردود التعليقات المسلّمة بحسب عدّاداتها ${nounRepliesAr(counters)} وسُلّم منها ${nounRepliesAr(got)}`);
        // the 20 comments asked of each video were delivered: no gap is claimed for the comments
        expect(line).not.toMatch(/طلبت/);
      } else expect(line).toBeUndefined();
    });
    // the sum of the counters of the 40 delivered comments is 28 and the replies delivered 20: the gap exists and is told in replies
    expect(gapLines.join("\n")).toMatch(/ردود التعليقات المسلّمة/);
  });

  it("D4: a video that gave fewer comments than asked says so against the asked number (20), not against its counter", async () => {
    const dropped = new Set(rowsByStage.comments.filter((c) => c.parent_id === rowsByStage.videos[0].id).slice(0, 5).map((c) => String(c.id)));
    const short = { ...rowsByStage, comments: rowsByStage.comments.filter((c) => !dropped.has(String(c.id))), comments_replies: rowsByStage.comments_replies.filter((r) => !dropped.has(String(r.parent_id))) };
    const built = await buildMissionFiles(judged, short, undefined, undefined, { repliesJudged: true });
    const { byName } = await textsOf(built.xlsx);
    const text = Object.values(byName).flat().flat().filter((t) => typeof t === "string" && t.startsWith("الفيديو رقم ١:") && /والفرق لم يعطِه المصدر/.test(t)).join("\n");
    expect(text).toContain("طلبت ٢٠ تعليقًا وسُلّم ١٥ تعليقًا");
    expect(text).not.toMatch(/عداد الفيديو/);
  });
});

const toAr = (n: number): string => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
/** «٥ ردود», «٢٠ ردًا», «ردان», «رد واحد»: the way the file counts replies (agent/src/threadCounters.ts countAr). */
const nounRepliesAr = (n: number): string => (n === 1 ? "رد واحد" : n === 2 ? "ردان" : n >= 3 && n <= 10 ? `${toAr(n)} ردود` : `${toAr(n)} ردًا`);
