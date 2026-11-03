import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { checkDeliveryContract, MARK_UNAVAILABLE_AR, type ContractInput } from "../src/lib/agentMission/foundation/deliveryContract";
import { MARKS_KEY, markVerdict } from "../src/lib/agentMission/rawMarks";
import { textKeyOf } from "../src/lib/agentMission/contract";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * ROUND 17, items 1 and 2 (live round 14, msn_ce01cccb652036e91ca4: «هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات»).
 *  1. THE SELECTION DID NOT REGRESS. The stored plan: the pool was 24 posts of ONE HOUR (20:05 to 21:12 Cairo); chosen counters 4 and 3, spares 3 and 2 (the plan ranks by the counter, so the pool's highest counter was 4). Round 11's mission
 *     msn_97cdab58dc82fc2039ed (real pages, committed) was the same two pages (24 posts) of ONE HOUR too, and the same code gives 20 and 18 on it. The pool's depth is the gateway's two samples of a listing (untouched); what differed is the hour of the day.
 *     What was missing is the card saying it: the highest counter of what was read.
 *  2. The posts of the named account read «غير متاح من المصدر» in «المصدر المسمّى»: the card did not map the post's author and the compiler wrote no verdict for a listing read by the account's handle.
 */
const IG = cardOf("scrapecreators.instagram.user.posts")!;
const COMMENTS = cardOf("anyapi.instagram.post.comments")!;
const REQUEST = "هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات.";
const askAt = (iso: string) => buildAsk(REQUEST, null, Date.parse(iso));

// THE STORED PLAN OF msn_ce01cccb652036e91ca4 (read-only SELECT of missions.plan): the two chosen posts and the two spares, with their own ids, times and counters
const STORED = [
  { pk: "4022415994952724959", code: "DfSfgkmAbHf", text: "مشاهد خاصة توثق توغل دورية إسرائيلية", likes: 43, views: 5824, comments: 4, at: "2026-11-03T18:10:04.000Z" },
  { pk: "4022436074906273073", code: "DfSkExggUUx", text: "تهديد بوجود قنبلة على سفينة سياحية", likes: 44, views: 7565, comments: 3, at: "2026-11-03T18:49:59.000Z" },
  { pk: "4022431142615933005", code: "DfSi8_9F2BN", text: "البيت الأبيض ينشر صورة للرئيس الأميركي", likes: 80, views: null, comments: 3, at: "2026-11-03T18:39:46.000Z" },
  { pk: "4022437355251992768", code: "DfSkXZ7DojA", text: "السيسي: أمن واستقرار السعودية والدول الخليجية", likes: 19, views: 1333, comments: 2, at: "2026-11-03T18:52:29.000Z" },
];
// the other 20 posts of the pool: the stored plan only proves each had a counter of 2 or less (they ranked below the spares); their ids, texts and times are made up
const FILLER = Array.from({ length: 20 }, (_, i) => ({ pk: `90000000000000000${String(i).padStart(2, "0")}`, code: `Fill${String(i).padStart(2, "0")}aaaaaa`, text: `منشور ${i}`, likes: i, views: 100 + i, comments: i < 3 ? 2 : i < 8 ? 1 : 0, at: new Date(Date.parse("2026-11-03T18:05:00Z") + i * 3 * 60_000).toISOString() }));
const item = (r: { pk: string; code: string; text: string; likes: number; views: number | null; comments: number; at: string }, username: string | null) => ({ pk: r.pk, code: r.code, caption: { text: r.text }, taken_at: Math.floor(Date.parse(r.at) / 1000), like_count: r.likes, play_count: r.views, comment_count: r.comments, ...(username === null ? {} : { user: { username } }) });
const pages = (rows: typeof STORED, username: string | null) => [{ callId: "call_0001", page: { items: rows.slice(0, 12).map((r) => item(r, username)), next_max_id: "web:x" } }, { callId: "call_0002", page: { items: rows.slice(12).map((r) => item(r, username)) } }];
const commentsPage = { output: { data: { comments: [{ id: "c1", text: "تعليق", user: { username: "u" } }], nextCursor: null } } };
const compile = (rows: typeof STORED, username: string | null, askIso = "2026-11-03T19:12:25Z") => {
  const r = compilePlan({ ask: askAt(askIso), pool: { card: IG, params: { handle: "alhadath" }, pages: pages(rows, username) }, exposure: () => ({ callId: "call_0003", page: commentsPage, failed: false }), capabilityOf: () => null });
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const pool24 = [...STORED, ...FILLER];

describe("1. the selection: the pool's own counters decide, and the card says the highest one", () => {
  it("the stored plan of msn_ce01...: the two highest counters of the pool (4 and 3) are chosen, the next two (3 and 2) are the spares, on a pool of 24 posts", () => {
    const r = compile(pool24, "alhadath");
    expect(r.chosen).toEqual([STORED[0].pk, STORED[1].pk]);
    expect(r.spares).toEqual([STORED[2].pk, STORED[3].pk]);
    const counters = (r.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((x) => x.comments);
    expect(counters).toEqual([4, 3]);
  });
  it("the same code on the REAL pages of round 11's mission (msn_97cdab58..., two pages, 24 posts of one hour) chooses 20 and 18: nothing in the selection changed, the hour of the day did", () => {
    const real = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/msn_97cdab58dc82fc2039ed/raw/call_000${n}.json`, import.meta.url), "utf8"));
    const r = compilePlan({ ask: askAt("2026-11-03T13:34:59Z"), pool: { card: IG, params: { handle: "alhadath" }, pages: [{ callId: "call_0001", page: real(1) }, { callId: "call_0002", page: real(2) }] }, exposure: () => ({ callId: "call_0003", page: real(3), failed: false }), capabilityOf: () => null });
    if (!r.ok) throw new Error(r.reason);
    expect((r.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((x) => x.comments)).toEqual([20, 18]);
    expect(r.plan.notes_ar!.find((n) => n.startsWith("اخترنا الأكثر تعليقًا"))).toContain("من آخر ٢٤ منشورًا");
  });
  it("the card says the highest counter of what was read, and that no older post was read (so a pool of one busy hour is seen as such before approval)", () => {
    const line = compile(pool24, "alhadath").plan.notes_ar!.find((n) => n.startsWith("اخترنا الأكثر تعليقًا"))!;
    expect(line).toContain("من آخر ٢٤ منشورًا");
    expect(line).toContain("أعلى عدّاد تعليقات بين ما قرأناه ٤");
    expect(line).toContain("ولم نقرأ منشورات أقدم منها");
    expect(line).not.toMatch(/instagram|anyapi|scrapecreators|USD|\$/i);
  });
});

describe("2. the named-source mark of a listing read by the account's handle", () => {
  const stage = (plan: PricedPlan): PricedStage => plan.stages[0];
  it("the posts sheet maps the account of each post («صاحب الحساب»)", () => {
    const rows = stage(compile(pool24, "alhadath").plan).pinned_rows as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.author === "alhadath")).toBe(true);
    expect(stage(compile(pool24, "alhadath").plan).columns.some((c) => c.key === "author" && c.title_ar === "صاحب الحساب")).toBe(true);
  });
  it("a post whose author is the named account is «مطابق» (no mismatch text), another account's post is «غير مطابق», and ONLY a post with no author at all is «غير متاح من المصدر»", () => {
    const own = stage(compile(pool24, "alhadath").plan).pinned_rows as Array<Record<string, unknown>>;
    expect(own.map((r) => r.named_source)).toEqual(["", ""]);
    const other = stage(compile(pool24, "someoneelse").plan).pinned_rows as Array<Record<string, unknown>>;
    expect(other.map((r) => r.named_source)).toEqual(["المصدر المسمّى: غير مطابق", "المصدر المسمّى: غير مطابق"]);
    const none = stage(compile(pool24, null).plan).pinned_rows as Array<Record<string, unknown>>;
    expect(none.map((r) => r.named_source)).toEqual([MARK_UNAVAILABLE_AR, MARK_UNAVAILABLE_AR]);
  });
  it("an account written as a link is read by its last part", () => {
    const r = compilePlan({ ask: buildAsk("هات منشورين من https://www.instagram.com/alhadath/ مع كل التعليقات", null, Date.parse("2026-11-03T19:12:25Z")), pool: { card: IG, params: { handle: "alhadath" }, pages: pages(pool24, "alhadath") }, exposure: () => ({ callId: "call_0003", page: commentsPage, failed: false }), capabilityOf: () => null });
    if (!r.ok) throw new Error(r.reason);
    expect((r.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((x) => x.named_source)).toEqual(["", ""]);
  });

  const sheetOf = async (plan: PricedPlan, rows: Array<Record<string, unknown>>, complete: boolean) => {
    const parent = plan.stages[0];
    const marked = rows.map((r) => ({ ...r, [MARKS_KEY]: markVerdict(parent.filters, r, { textKey: textKeyOf(parent, Object.keys(r)), now: Date.parse("2026-11-03T19:20:00Z") }) }));
    const built = await buildMissionFiles(plan, { posts: marked, comments: [] }, undefined, undefined, { completeContract: complete });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as never);
    const ws = wb.worksheets.find((w) => /منشور/.test(w.name))!;
    const head = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const body: string[][] = [];
    ws.eachRow((row, n) => { if (n > 1) body.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ""))); });
    return { head, body, built };
  };
  it("THE LIVE FILE: both posts of the named account read «مطابق» in the posts sheet, which also has «صاحب الحساب»; the delivery contract finds no R4 violation and completes no mark (the only completions are the comments' gap lines of this made-up delivery, which has none)", async () => {
    const plan = compile(pool24, "alhadath").plan;
    const { head, body, built } = await sheetOf(plan, plan.stages[0].pinned_rows as Array<Record<string, unknown>>, true);
    const mark = head.indexOf("المصدر المسمّى");
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(head).toContain("صاحب الحساب");
    expect(body.map((r) => r[mark])).toEqual(["مطابق", "مطابق"]);
    expect(built.contract.violations.filter((v) => v.rule === "R4")).toEqual([]);
    expect(built.contract.completed.filter((c) => c.kind !== "limit_line")).toEqual([]);
  });
  it("a post with no author at all says «غير متاح من المصدر» and that is not a violation", async () => {
    const plan = compile(pool24, null).plan;
    const { head, body, built } = await sheetOf(plan, plan.stages[0].pinned_rows as Array<Record<string, unknown>>, false);
    expect(body.map((r) => r[head.indexOf("المصدر المسمّى")])).toEqual([MARK_UNAVAILABLE_AR, MARK_UNAVAILABLE_AR]);
    expect(built.contract.violations.filter((v) => v.rule === "R4")).toEqual([]);
  });
});

describe("R4 of the delivery contract: «غير متاح من المصدر» beside a row that HAS an author cannot recur, on any platform", () => {
  const mk = (platform: string, source: string, row: Record<string, unknown>, cell: string): ContractInput => {
    const parent = { key: "posts", title_ar: "المنشورات", endpoint_id: "e", parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [{ key: "text", title_ar: "النص" }], expected_rows: 1, planned_rows: 1 } as unknown as PricedStage;
    const plan = { summary_ar: "x", stages: [parent], price: {}, compiled: { by: "compiler", platform, promises: {}, conditions: { named: true, period: false, language: false, country: false, topic: false }, source_text: source } } as unknown as PricedPlan;
    return { plan, rowsByStage: { posts: [{ id: "p1", ...row }] }, sheets: [{ stageKey: "posts", title: "المنشورات", headers: ["النص", "المصدر المسمّى"], rows: [{ id: "p1", parentId: null, cells: { "النص": "x", "المصدر المسمّى": cell } }] }], limitLines: [], numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 1 }, now: Date.parse("2026-11-03T12:00:00Z") };
  };
  const r4 = (i: ContractInput) => checkDeliveryContract(i).filter((v) => v.rule === "R4");
  it("Instagram: the row's account is the named handle: the cell must be «مطابق»", () => {
    const v = r4(mk("instagram", "alhadath", { author: "alhadath" }, MARK_UNAVAILABLE_AR));
    expect(v).toHaveLength(1);
    expect(v[0].fix).toMatchObject({ kind: "mark", header: "المصدر المسمّى", value: "مطابق" });
  });
  it("Facebook: the row's page is not the named one: «غير مطابق»; the same row with the page's name in Arabic words is «مطابق»", () => {
    expect(r4(mk("facebook", "قناة العربية", { author: "صفحة أخرى" }, MARK_UNAVAILABLE_AR))[0].fix).toMatchObject({ value: "غير مطابق" });
    expect(r4(mk("facebook", "قناة العربية", { author: "العربية" }, MARK_UNAVAILABLE_AR))[0].fix).toMatchObject({ value: "مطابق" });
  });
  it("TikTok and X: an author or a username counts the same", () => {
    expect(r4(mk("tiktok", "@somebody", { username: "somebody" }, MARK_UNAVAILABLE_AR))[0].fix).toMatchObject({ value: "مطابق" });
    expect(r4(mk("x", "somebody", { author: "other" }, MARK_UNAVAILABLE_AR))[0].fix).toMatchObject({ value: "غير مطابق" });
  });
  it("a row that carries NO author keeps «غير متاح من المصدر» (it is true), and a filled cell is never touched", () => {
    expect(r4(mk("instagram", "alhadath", {}, MARK_UNAVAILABLE_AR))).toEqual([]);
    expect(r4(mk("instagram", "alhadath", { author: "alhadath" }, "مطابق"))).toEqual([]);
  });
});
