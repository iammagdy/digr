import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { missionDownloadName } from "../src/lib/agentMission/fileNames";
import { placeVerdict } from "../src/lib/agentMission/places";

/**
 * REPLAY OF THE LIVE RUN OF 2026-10-29 16:17-16:39 CAIRO (six compound missions, test account), with data shaped like the rows the live sources returned (the real rows live in the item store's objects, which SQL cannot read: the shapes and counts
 * below are the ones in mission_calls / mission_events). The model planned (a fake transcript); once approved, code carried the plan out.
 *  - TikTok: five videos, ten comments each: the source gave 10, 6, 10, 10 and 5 comments. No filter removed one; the old shortfall sentence blamed the LANGUAGE rule (it counted the one video the language rule left out).
 *  - Facebook: five posts, ten comments each: the model wrote 7 comments in all, the first post gave all 7, and the other four posts were never read.
 *  - Companies: three companies with two managers each: the plan dropped the managers, and the execution delivered nothing (a country field that holds the code «EG» was no evidence of Egypt).
 */
const why = "the cheaper sources return no author or link fields in their catalog description";
const pad = (n: number, w = 6) => String(n).padStart(w, "0");
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

/** Comments as a source gives them: Arabic and English mixed, off the topic, an emoji; `n` of them for one parent. */
const kids = (parent: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${parent}-c${i}`, text: i % 3 === 0 ? `great video number ${i}` : i % 3 === 1 ? `تعليق رقم ${i} على الفيديو` : "👍", author: `قارئ ${i}` }));
/** The delivered comments of each parent, in the order the parents were read. */
async function childrenPerParent(r: Awaited<ReturnType<typeof replay>>, childKey: string, parentKey: string): Promise<number[]> {
  const snap = await readSnapshot(r.store, r.missionId);
  const children = snap.acceptedRows(childKey);
  return snap.acceptedRows(parentKey).map((p) => children.filter((c) => String(c.parent_id) === String(p.id)).length);
}

describe("TikTok: five videos, ten comments each (the source gave 10, 6, 10, 10 and 5)", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const vid = (i: number) => `tv${pad(i)}`;
  const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;
  const video = (i: number) => ({ post_id: vid(i), url: url(i), description: i === 1 ? `Egypt national team highlights ${i} منتخب مصر` : `منتخب مصر في المباراة رقم ${i}`, author: `creator${i % 7}`, stats: { views: 1000 + i, likes: 50 + i, comments: 40, shares: 3 }, created_at: "2026-10-27T09:00:00Z" });
  const page = { rows: Array.from({ length: 8 }, (_, i) => video(i)) };
  // the videos the engine takes: tv0, then tv2..tv5 (tv1 is English: the language rule leaves it out, a PARENT rule)
  const taken = [0, 2, 3, 4, 5];
  const available: Record<string, number> = { [vid(0)]: 10, [vid(2)]: 6, [vid(3)]: 10, [vid(4)]: 10, [vid(5)]: 5 };
  const commentsPage = (parent: string) => ({ rows: kids(parent, available[parent] ?? 10).map((c) => ({ comment_id: c.id, post_id: parent, text: c.text, author: c.author, likes: 0, created_at: "2026-10-28T09:00:00Z" })) });
  const request = "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";

  async function run() {
    return replay({
      request,
      planning: planFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
        calls: [
          { endpoint: VIDEOS, params: { query: "منتخب مصر", limit: 20 }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, author: v.author, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
          { endpoint: COMMENTS, params: { post: url(0), limit: 10 }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر وتعليقات كل فيديو.",
          assumptions_ar: ["المقصود: المنتخب الوطني المصري لكرة القدم."],
          stages: [
            { key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "الناشر" }, { key: "date", title_ar: "تاريخ النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "url", title_ar: "رابط الفيديو" }],
              sample_rows: [{ id: vid(0), text: "منتخب مصر في المباراة رقم 0", author: "creator0", date: "2026-10-27T09:00:00Z", views: 1000, likes: 50, comments_count: 40, shares: 3, url: url(0) }], measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب مصر"]), yield_from: firstOutputId(res), filters: [{ kind: "language", lang: "ar" }] },
            // the model's own estimate: 20 comments and 5 per video; the customer's number is 10 per video
            { key: "comments", title_ar: "تعليقات على فيديوهات منتخب مصر", endpoint_id: COMMENTS, expected_rows: 20, parent_key: "videos", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "الكاتب" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "تاريخ التعليق" }],
              sample_rows: [{ id: `${vid(0)}-c1`, text: "تعليق رقم 1 على الفيديو", author: "قارئ 1", likes: 0, date: "2026-10-28T09:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(commentsPage(vid(0)), 0.0005), tregResult(page, 0.0005), ...taken.map((i) => tregResult(commentsPage(vid(i)), 0.0005))],
    });
  }

  it("the card: 5 videos and 5 x 10 comments (not the model's 20); the language is stated for the VIDEOS only and the comments are said to come as they are", async () => {
    const r = await run();
    expect(r.plannedPlan.stages[1]).toMatchObject({ planned_rows: 50, per_parent_rows: 10 });
    expect(r.planView.stages.map((s) => s.rows)).toEqual([5, 50]);
    expect(r.planView.assumptionsAr).toContain("اللغة العربية فقط تُطبَّق على الفيديوهات وحدها، أما التعليقات فتُسلَّم كما هي.");
    expect(r.planView.assumptionsAr).not.toContain("باللغة العربية فقط.");
    expect(r.planView.notesAr).toContain("تُجمع التعليقات كما هي على كل فيديو، دون تصفية.");
    // no filter, no rule on the children
    expect(r.plannedPlan.stages[1].filters?.some((f) => f.kind === "language") ?? false).toBe(false);
    expect(r.plannedPlan.stages[1].relevance).toBeUndefined();
  });

  it("delivered: every comment the source gave (41 of the 50 asked), none removed by any filter; the shortfall says the videos had fewer comments, never the language", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 5 + 41, expectStatus: "partial" });
    const snap = await readSnapshot(r.store, r.missionId);
    const comments = snap.counts("comments");
    expect(comments).toMatchObject({ accepted: 41, excluded: 0, pending: 0 });
    expect(Object.keys(comments.excludedByReason)).toEqual([]);
    expect(await childrenPerParent(r, "comments", "videos")).toEqual([10, 6, 10, 10, 5]);
    // the English video was left out as a PARENT by the language rule: that is the one the old sentence counted
    expect(snap.counts("videos").excludedByReason.filter_language).toBe(1);
    // the English comments and the emoji are in the file (raw)
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("تعليقات على فيديوهات منتخب مصر")!;
    const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const textColumn = headers.findIndex((h) => h === "نص التعليق");
    expect(textColumn).toBeGreaterThan(0);
    const texts: string[] = [];
    sheet.eachRow((row, n) => { if (n > 1) texts.push(String(row.getCell(textColumn).value)); });
    expect(texts.some((t) => /^great video number/.test(t))).toBe(true);
    expect(texts.some((t) => t === "👍")).toBe(true);
    // the words the customer reads
    const summary = String(r.mission.summary_ar);
    expect(summary).toContain("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
    expect(summary).not.toMatch(/اللغة|لغة/);
    expect(r.notices[0].facts.shortfallClauseAr).toBe("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
  });
});

describe("Facebook: five posts, ten comments each (the live plan said «حتى ٧», and every post but the first was never read)", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "anyapi.facebook.post_comments";
  const TOPIC = "غلاء الأسعار";
  const fp = (i: number) => `fp${pad(i)}`;
  const postsPage = { code: 0, data: { results: Array.from({ length: 5 }, (_, i) => ({ post_id: fp(i), type: "post", url: `https://fb.example/posts/${fp(i)}`, message: `${TOPIC} في مصر منشور رقم ${i}`, timestamp: 1785202291, comments_count: i === 1 ? 5 : 160 + i, reactions_count: 100 + i, author: { name: `صفحة ${i}` } })), cursor: null } };
  const availablePerPost = [10, 5, 10, 10, 10];
  const commentsFor = (post: string, i: number) => ({ output: { data: { comments: kids(post, availablePerPost[i]).map((c) => ({ id: c.id, text: c.text, author: c.author, createdUtc: "2026-10-21T10:00:00Z" })) } } });
  const planCalls = [
    { endpoint: POSTS, params: { keyword: TOPIC }, code: "return inputs.call_0001.data.results.map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))" },
    { endpoint: COMMENTS, params: { url: `https://fb.example/posts/${fp(0)}` }, code: "return inputs.call_0002.output.data.comments.map(c => ({ id: c.id, text: c.text, author: c.author, date: c.createdUtc }))" },
  ];
  const stages = (res: Results, commentsRows: number, commentsPer: number, title: string) => [
    { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "author", title_ar: "الصفحة" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "likes", title_ar: "الإعجابات" }],
      sample_rows: [{ id: fp(0), text: `${TOPIC} في مصر منشور رقم 0`, url: `https://fb.example/posts/${fp(0)}`, author: "صفحة 0", date: 1785202291, comments_count: 160, likes: 100 }], measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) },
    { key: "comments", title_ar: title, endpoint_id: COMMENTS, expected_rows: commentsRows, parent_key: "posts", per_parent_rows: commentsPer, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "date", title_ar: "التاريخ والوقت" }],
      sample_rows: [{ id: `${fp(0)}-c1`, text: "تعليق رقم 1 على الفيديو", author: "قارئ 1", date: "2026-10-21T10:00:00Z" }], measured_by: [callIds(res)[1]] },
  ];
  const answers = [tregResult(postsPage, 0.02952), tregResult(commentsFor(fp(0), 0), 0.002), tregResult(postsPage, 0.02952), ...availablePerPost.map((_, i) => tregResult(commentsFor(fp(i), i), 0.002))];

  it("the live request: the model wrote 7 comments in all; the card carries 50 (5 x 10), EVERY post is read, and the delivery is 10, 5, 10, 10, 10 comments (the post with five has five)", async () => {
    const r = await replay({
      request: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات",
      planning: planFlow({ progress: "أجرّب مصدر المنشورات ومصدر التعليقات", words: ["facebook", "posts", "search"], platform: "facebook", calls: planCalls, plan: (res) => ({ summary_ar: "ستحصل على بوستات فيسبوك عن غلاء الأسعار وتعليقات كل بوست.", stages: stages(res, 7, 10, "تعليقات كل بوست من البوستات المختارة") }) }),
      execution: () => [],
      answers,
    });
    expect(r.plannedPlan.stages[1]).toMatchObject({ planned_rows: 50, per_parent_rows: 10 });
    expect(r.planView.stages.map((s) => s.rows)).toEqual([5, 50]);
    expect(JSON.stringify(r.planView)).not.toContain("حتى ٧");
    assertReplayInvariants(r, { expectDelivered: 5 + 45, expectStatus: "partial" });
    expect(await childrenPerParent(r, "comments", "posts")).toEqual([10, 5, 10, 10, 10]);
    // every post's comments were requested in the execution (the live run made ONE comments call)
    const executionCalls = r.call.mock.calls.filter((c) => (c[0] as { endpoint_id?: string })?.endpoint_id === COMMENTS || JSON.stringify(c).includes(COMMENTS));
    expect(executionCalls.length).toBeGreaterThanOrEqual(1 + 5);
    expect(String(r.mission.summary_ar)).toContain("لأن بعض المنشورات عليها تعليقات أقل من العدد المطلوب لكل منشور");
    expect(String(r.mission.summary_ar)).not.toMatch(/اللغة|لغة/);
  });

  it("a lower total for the comments (the request gives no number per post): the total is shared out, four from each of the five posts, never all of it from the first", async () => {
    const r = await replay({
      request: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر مع تعليقاتها",
      planning: planFlow({ progress: "أجرّب مصدر المنشورات ومصدر التعليقات", words: ["facebook", "posts", "search"], platform: "facebook", calls: planCalls, plan: (res) => ({ summary_ar: "ستحصل على بوستات فيسبوك عن غلاء الأسعار وتعليقات كل بوست.", stages: stages(res, 20, 10, "تعليقات كل بوست من البوستات المختارة") }) }),
      execution: () => [],
      answers,
    });
    expect(r.plannedPlan.stages[1]).toMatchObject({ planned_rows: 20, per_parent_rows: 10 });
    assertReplayInvariants(r, { expectDelivered: 5 + 20 });
    expect(await childrenPerParent(r, "comments", "posts")).toEqual([4, 4, 4, 4, 4]);
  });
});

describe("Companies: three companies and their managers (the plan dropped the managers silently and the execution delivered nothing)", () => {
  const COMPANIES = "aiark.companies.search";
  // a source asked for Egypt answers its country as the ISO CODE, with English names, and a city only for some
  const co = (name: string, site: string, country: string, city = "") => ({ id: site, name, website_url: site, country, city, company_size: "51-200", industry: "Construction" });
  const page = { content: [
    co("Yourwebsite Ltd", "yourwebsite.lu", "LU"),
    co("Egytic Sports", "egytic.example.com", "EG"),
    co("Orascom Construction", "orascom.com", "EG", "Cairo"),
    co("The Arab Contractors", "arabcont.example.com", "EG"),
    co("Hassan Allam Contracting", "hassanallam.example.com", "EG"),
    co("Nile Contracting Group", "nilegroup.example.com", "EG"),
  ] };
  const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";

  async function run() {
    return replay({
      request,
      planning: planFlow({
        progress: "أبحث عن شركات المقاولات", words: ["companies", "search"],
        calls: [{ endpoint: COMPANIES, params: { page: 1, size: 6 }, code: "return inputs.call_0001.content.map(c => ({ id: c.id, name: c.name, website: 'https://' + c.website_url, country: c.country, city: c.city || '', size: c.company_size }))" }],
        plan: (res) => ({
          summary_ar: "ستحصل على شركات مقاولات مصرية مع بياناتها العامة.",
          unserved_steps: [{ reason_ar: "المصادر المتاحة لا تعطي أسماء المديرين لكل شركة بدقة" }],
          stages: [{ key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع الإلكتروني" }, { key: "city", title_ar: "المدينة" }, { key: "size", title_ar: "حجم الشركة" }],
            sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG", city: "Cairo", size: "51-200" }], measured_by: [callIds(res)[0], firstOutputId(res)] }],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(page, 0.0005)],
    });
  }

  it("the card says BEFORE approval that the managers' step is not in the plan and why", async () => {
    const r = await run();
    expect(r.planView.unservedAr).toEqual(["لم تُضَف إلى الخطة خطوة «المديرين لكل شركة»: المصادر المتاحة لا تعطي أسماء المديرين لكل شركة بدقة. يمكنك اعتماد باقي الخطة كما هي، أو تعديل طلبك قبل الاعتماد."]);
    expect(r.plannedPlan.stages).toHaveLength(1);
  });

  it("the execution delivers the three contractors of Egypt (country «EG» and the English sector words are evidence); the company of another country and the sports company are not delivered", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 3 });
    const snap = await readSnapshot(r.store, r.missionId);
    const names = snap.acceptedRows("companies").map((x) => String(x.name));
    expect(names).toEqual(["Orascom Construction", "The Arab Contractors", "Hassan Allam Contracting"]);
    expect(snap.counts("companies").excludedByReason.filter_place).toBe(1);
    expect(names.join(" ")).not.toMatch(/Yourwebsite|Egytic/);
    // the relevance rule was built from the FIRST clause of the request: the managers' clause left «ومن» and «اتنين» out of the sector words
    expect(JSON.stringify(r.plannedPlan.stages[0].relevance?.terms)).not.toMatch(/ومن|اتنين/);
    expect(r.plannedPlan.stages[0].relevance?.terms).toContain("مقاولات");
    // the file's name carries the subject
    expect(missionDownloadName({ kind: "xlsx", plan: r.plannedPlan, requestText: request, deliveredUnits: 3, date: "2026-10-29T13:30:00Z" })).toBe("شركات مقاولات - ٣ - ٢٩ أكتوبر ٢٠٢٦.xlsx");
  });

  it("a country field that holds only the ISO code is evidence of that country; another code is another country; a state field is not read as a country", () => {
    const f = ["city", "website", "country"];
    expect(placeVerdict(["EG"], { country: "EG", city: "", website: "https://x.com" }, f)).toBe("pass");
    expect(placeVerdict(["EG"], { country: "EGY", city: "", website: "https://x.com" }, f)).toBe("pass");
    expect(placeVerdict(["EG"], { country: "LU", city: "", website: "https://x.com" }, f)).toBe("other_place");
    expect(placeVerdict(["EG"], { country: "", city: "", website: "https://x.com" }, f)).toBe("no_evidence");
    // a city request: the code alone says the country, not the city
    expect(placeVerdict(["EG:cairo"], { country: "EG", city: "", website: "https://x.com" }, f)).toBe("no_evidence");
    expect(placeVerdict(["CA"], { state: "CA", website: "https://x.com" }, ["state", "website"])).toBe("no_evidence");
  });
});
