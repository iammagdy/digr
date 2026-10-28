import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { callIds, companiesPage, employeesPage, fbCommentsPage, fbPostsPage, tregResult, ttCommentsPage, ttVideosPage, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { createCdnStaleStore } from "./helpers/cdnStaleStore";
import { readSnapshot } from "../agent/src/items/itemStore";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { missionTitleAr } from "../src/lib/agentMission/fileNames";
import { itemNounOfPlan } from "../src/lib/agentMission/itemNoun";
import { moneyLineAr } from "../src/lib/agentMission/moneyText";
import { missionWalletLineAr } from "../src/lib/agentMission/walletLine";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * THE CODE ENGINE ON MISSION TYPES WITH TWO LINKED STAGES (Facebook posts and their comments, TikTok videos and their comments, companies and their employees). The model PLANNED (a fake transcript against fake provider
 * answers, as in the replays); once the customer approved, no model session ran: code paged every source, mapped every page with the plan's proven recipe, checked every item, saved it through the one item store, built the file,
 * read it back and settled from it.
 */
const why = "the cheaper sources return no author or link fields in their catalog description";
const planFlow = (o: { progress: string; words: string[]; platform?: string; calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>; plan: (res: Results) => unknown }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: o.words, ...(o.platform ? { platform: o.platform } : {}), limit: 5 } },
  ...o.calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => o.plan(r) as Record<string, unknown> },
];

/** Everything every mission type must show once it ends: ONE number (the items in the file) everywhere, the same money line on every screen. */
async function assertOneNumber(r: ReplayResult, expected: { delivered: number; perSheet: Record<string, number>; noun: string }) {
  // no model session: code carried the approved plan out
  expect(r.executionDriver.results).toEqual([]);
  expect(r.plannedPlan.stages.every((s) => s.engine !== undefined)).toBe(true);
  assertReplayInvariants(r, { expectDelivered: expected.delivered });
  // the file: the rows of every sheet add up to the delivered count, which is the charge basis
  const wb = await readWorkbook(r);
  let inFile = 0;
  for (const [sheet, n] of Object.entries(expected.perSheet)) { expect(wb.getWorksheet(sheet)!.rowCount - 1, sheet).toBe(n); inFile += n; }
  expect(inFile).toBe(expected.delivered);
  expect(r.mission.delivered_units).toBe(inFile);
  // the item store agrees: every stage's accepted items are the file's rows
  const snap = await readSnapshot(r.store, r.missionId);
  for (const [i, stage] of r.plannedPlan.stages.entries()) {
    const c = snap.counts(stage.key);
    expect(c.found).toBe(c.new + c.duplicates);
    expect(c.new).toBe(c.accepted + c.excluded + c.pending + c.unchecked);
    expect(c.pending + c.unchecked).toBe(0);
    expect(r.finalView.steps[i].savedN, stage.key).toBe(c.accepted);
  }
  // the tracker's final numbers are the file's
  const sheetCounts = Object.values(expected.perSheet);
  r.finalView.steps.filter((s) => s.id.startsWith("stage-")).forEach((s, i) => expect(s.savedN).toBe(sheetCounts[i]));
  // THE SAME MONEY LINE on every screen: the completion panel, the notification, the e-mail, the wallet, «طلباتي»
  const noun = itemNounOfPlan(r.plannedPlan);
  const line = moneyLineAr({ reservedPoints: Number(r.mission.reserved_points), chargedPoints: Number(r.mission.charged_points), delivered: expected.delivered, noun });
  expect(line).toMatch(/^خُصم [٠-٩]+ نقطة مقابل /);
  expect(r.finalView.resultLinesAr[r.finalView.resultLinesAr.length - 1]).toBe(`${line}.`);
  const notice = buildMissionNotice(r.notices[0].kind, r.notices[0].facts, missionTitleAr({ plan: r.plannedPlan, requestText: "" }));
  expect(notice.body).toContain(`${line}.`);
  expect(notice.email!.detail1).toBe(line);
  expect(notice.email!.preheader).toBe(line);
  expect(missionWalletLineAr({ job_id: r.mission.job_id, status: r.mission.status, delivered_units: r.mission.delivered_units, charged_points: r.mission.charged_points, reserved_points: r.mission.reserved_points, plan_public: JSON.parse(JSON.stringify(r.db.rows("missions").find((m) => m.id === r.missionId)!.plan_public)) })).toBe(line);
  expect(expected.noun.length).toBeGreaterThan(0);
}

describe("Facebook posts and the comments of each post", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "anyapi.facebook.post_comments";
  const TOPIC = "التضخم وأسعار الغذاء";
  const PAGE = 8;
  const POSTS_N = 24;
  const postId = (i: number) => `fp${String(i).padStart(6, "0")}`;
  const input = () => ({
    request: "عايز منشورات فيسبوك عن التضخم وأسعار الغذاء مع روابطها وتعليقات كل منشور",
    planning: planFlow({
      progress: "أجرّب مصدر المنشورات ومصدر التعليقات", words: ["facebook", "posts", "search"], platform: "facebook",
      calls: [
        { endpoint: POSTS, params: { keyword: TOPIC }, code: "return inputs.call_0001.data.results.map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))" },
        { endpoint: COMMENTS, params: { url: `https://fb.example/posts/${postId(0)}` }, code: "return inputs.call_0002.output.data.comments.map(c => ({ id: c.id, text: c.text, author: c.author, date: c.createdUtc }))" },
      ],
      plan: (res) => ({
        summary_ar: "ستحصل على منشورات فيسبوك عن التضخم وأسعار الغذاء مع رابط كل منشور وتعليقاته.",
        stages: [
          { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS, expected_rows: POSTS_N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "author", title_ar: "الصفحة" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "likes", title_ar: "الإعجابات" }],
            sample_rows: [0, 1].map((i) => ({ id: postId(i), text: `${TOPIC} منشور ${i}`, url: `https://fb.example/posts/${postId(i)}`, author: `صفحة ${i}`, date: 1785202291, comments_count: 40 + i, likes: 100 + i })), measured_by: [callIds(res)[0]], relevance: aboutWords(["التضخم"]), yield_from: firstOutputId(res) },
          { key: "comments", title_ar: "تعليقات كل منشور", endpoint_id: COMMENTS, expected_rows: POSTS_N * 5, parent_key: "posts", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [{ id: `${postId(0)}-c00`, text: `تعليق 0 على ${postId(0)}`, author: "قارئ 0", date: "2026-10-21T10:00:00Z" }], measured_by: [callIds(res)[1]] },
        ],
      }),
    }),
    execution: () => [],
    answers: [
      tregResult(fbPostsPage(TOPIC, 0, PAGE, "cur_8"), 0.02952),
      tregResult(fbCommentsPage(postId(0), 10), 0.002),
      tregResult(fbPostsPage(TOPIC, 0, PAGE, "cur_8"), 0.02952), tregResult(fbPostsPage(TOPIC, 8, PAGE, "cur_16"), 0.02952), tregResult(fbPostsPage(TOPIC, 16, PAGE, null), 0.02952),
      ...Array.from({ length: POSTS_N }, (_, i) => tregResult(fbCommentsPage(postId(i), 10), 0.002)),
    ],
  });

  it("two linked stages: 24 posts, five comments of each (ten were returned: the five beyond the share are kept, never delivered, never charged); the file, the count, the charge and every text are one number", async () => {
    const r = await replay(input());
    await assertOneNumber(r, { delivered: POSTS_N + POSTS_N * 5, perSheet: { "المنشورات": POSTS_N, "تعليقات كل منشور": POSTS_N * 5 }, noun: "عنصر" });
    expect(r.plannedPlan.stages[1].engine).toMatchObject({ parent_binding: { param: "url", from: "url" }, cursor_param: "cursor" });
    // the engine read 3 pages of posts and one page of comments for each post: nothing more
    expect(r.call.mock.calls.length).toBe(2 + 3 + POSTS_N);
    // every comment is linked to its post
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("تعليقات كل منشور")!;
    expect(sheet.getRow(2).getCell(sheet.columnCount).value).toBeTruthy();
  });

  it("the comments of ONE post cannot be read (two failed calls): that post is skipped, the others are read, the shortfall is the recorded reason (the reading failed), and what was read is what is delivered and charged", async () => {
    const base = input();
    const failing = (n: number) => Array.from({ length: n }, () => tregResult({ error: "upstream error" }, 0, { ok: false, httpStatus: 502, error: "upstream_error" } as never));
    // answers: planning (2), posts (3 pages), then the comments of post 0, 1, 2, then TWO failures for post 3, then post 4 .. 23
    const answers = [...base.answers.slice(0, 5), ...[0, 1, 2].map((i) => tregResult(fbCommentsPage(postId(i), 10), 0.002)), ...failing(2), ...Array.from({ length: POSTS_N - 4 }, (_, k) => tregResult(fbCommentsPage(postId(k + 4), 10), 0.002))];
    const r = await replay({ ...base, answers });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("comments").accepted).toBe((POSTS_N - 1) * 5);
    expect(snap.stage("comments").stop).toBe("failed");
    expect(r.mission.delivered_units).toBe(POSTS_N + (POSTS_N - 1) * 5);
    expect(r.mission.summary_ar).toContain("القراءة من المصدر تعذّرت قبل اكتمال العدد");
    expect(r.mission.summary_ar).not.toContain("هذا كل ما وُجد");
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("تعليقات كل منشور")!.rowCount - 1).toBe((POSTS_N - 1) * 5);
    expect(r.finalView.steps[1]).toMatchObject({ savedN: (POSTS_N - 1) * 5 });
  });

  it("the same mission on a store that serves overwritten objects stale: the same file, the same charge", async () => {
    const r = await replay({ ...input(), makeStore: () => createCdnStaleStore({ staleReads: 6 }) });
    await assertOneNumber(r, { delivered: POSTS_N + POSTS_N * 5, perSheet: { "المنشورات": POSTS_N, "تعليقات كل منشور": POSTS_N * 5 }, noun: "عنصر" });
  });
});

describe("TikTok videos and the comments of each video", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const TOPIC = "رحلة إلى الأقصر";
  const N = 12;
  const vid = (i: number) => `tv${String(i).padStart(6, "0")}`;
  const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;

  it("12 videos, ten comments of each; one number everywhere", async () => {
    const r = await replay({
      request: "عايز فيديوهات تيك توك عن رحلة إلى الأقصر مع تعليقات كل فيديو",
      planning: planFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
        calls: [
          { endpoint: VIDEOS, params: { query: TOPIC, limit: N }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
          { endpoint: COMMENTS, params: { post: url(0) }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن رحلة إلى الأقصر مع أرقامها وتعليقات كل فيديو.",
          stages: [
            { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [0, 1].map((i) => ({ id: vid(i), text: `${TOPIC} فيديو ${i}`, url: url(i), views: 1000 + i, likes: 50 + i, comments_count: 20, shares: 3, date: "2026-10-19T09:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords(["الأقصر"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: N * 10, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: `${vid(0)}-k00`, text: `تعليق 0 على الفيديو ${vid(0)}`, author: "viewer0", likes: 0, date: "2026-10-20T09:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(ttVideosPage(TOPIC, N), 0.0005), tregResult(ttCommentsPage(vid(0), 10), 0.0005), tregResult(ttVideosPage(TOPIC, N), 0.0005), ...Array.from({ length: N }, (_, i) => tregResult(ttCommentsPage(vid(i), 10), 0.0005))],
    });
    await assertOneNumber(r, { delivered: N + N * 10, perSheet: { "الفيديوهات": N, "تعليقات كل فيديو": N * 10 }, noun: "عنصر" });
    expect(r.plannedPlan.stages[1].engine).toMatchObject({ parent_binding: { param: "post", from: "url" }, cursor_param: null });
    expect(r.call.mock.calls.length).toBe(2 + 1 + N);
  });
});

describe("companies and the employees of each company", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const NAMES = { co1: "الشركة المصرية للكهروميكانيكا", co2: "النيل للتركيبات الكهربائية", co3: "دلتا للمقاولات الكهروميكانيكية" };

  it("3 companies, 2 employees of each (a source paged by a page number is read page by page); one number everywhere", async () => {
    const r = await replay({
      request: "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين",
      planning: planFlow({
        progress: "أبحث عن مصدر الشركات ثم الموظفين", words: ["companies", "search"],
        calls: [
          { endpoint: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, code: "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name, url: c.domain }))" },
          { endpoint: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, code: `const names = ${JSON.stringify(NAMES)}; return inputs.call_0002.employees.map(e => ({ id: e.personID, text: e.person.fullName, title: e.positionList[0].title, company: names[e.companyID] }))` },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة.",
          stages: [
            { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }],
              sample_rows: [{ id: "co1", text: NAMES.co1, url: "company1.example" }, { id: "co2", text: NAMES.co2, url: "company2.example" }], measured_by: [callIds(res)[0]] },
            { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "company", title_ar: "الشركة" }],
              sample_rows: [{ id: "co1-p1", text: "أحمد حسن", title: "مدير المشتريات", company: NAMES.co1 }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(employeesPage("co2", 2), 0.005), tregResult(employeesPage("co3", 2), 0.005)],
    });
    await assertOneNumber(r, { delivered: 9, perSheet: { "الشركات": 3, "موظفو كل شركة": 6 }, noun: "عنصر" });
    expect(r.plannedPlan.stages[1].engine).toMatchObject({ parent_binding: { param: "website", from: "url" }, cursor_param: "page" });
    expect(r.call.mock.calls.length).toBe(2 + 1 + 3);
  });
});
