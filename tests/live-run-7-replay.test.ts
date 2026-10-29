import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { missionDownloadName } from "../src/lib/agentMission/fileNames";
import { placeVerdict } from "../src/lib/agentMission/places";

/**
 * REPLAY OF THE LIVE RETEST OF 2026-10-29 17:41-17:59 CAIRO (after #293, test account). The plans below are the ones in `missions.plan` (read with SELECT): the model kept the TikTok videos as an intermediate stage («deliver: false») and gave the
 * comments 5 rows in all; the companies plan had one stage and an unserved managers' step. Once approved, code carried the plan out with data shaped like the rows the live sources returned.
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


describe("TikTok: «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات» (live: the card said 5 comments in all, 4 were delivered and the videos were not delivered as a sheet)", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const vid = (i: number) => `tv${pad(i)}`;
  const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;
  const video = (i: number) => ({ post_id: vid(i), url: url(i), description: `منتخب مصر في المباراة رقم ${i}`, author: `creator${i % 7}`, stats: { views: 1000 + i, likes: 50 + i, comments: 40, shares: 3 }, created_at: "2026-10-27T09:00:00Z" });
  const page = { rows: Array.from({ length: 8 }, (_, i) => video(i)) };
  const commentsPage = (parent: string) => ({ rows: kids(parent, 10).map((c) => ({ comment_id: c.id, post_id: parent, text: c.text, author: c.author, likes: 0, created_at: "2026-10-28T09:00:00Z" })) });
  const request = "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";
  const columnsOf = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
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
          summary_ar: "ستحصل على تعليقات فيديوهات تيك توك عن منتخب مصر.",
          // THE LIVE PLAN: the videos are an intermediate stage, the comments 5 in all with 10 per video
          stages: [
            { key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: false, columns: columnsOf(["text", "وصف الفيديو"], ["author", "الناشر"], ["date", "تاريخ النشر"], ["views", "المشاهدات"], ["likes", "الإعجابات"], ["comments_count", "عدد التعليقات"], ["shares", "المشاركات"], ["url", "رابط الفيديو"]),
              sample_rows: [{ id: vid(0), text: "منتخب مصر في المباراة رقم 0", author: "creator0", date: "2026-10-27T09:00:00Z", views: 1000, likes: 50, comments_count: 40, shares: 3, url: url(0) }], measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب مصر"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل فيديو من الفيديوهات عن منتخب مصر", endpoint_id: COMMENTS, expected_rows: 5, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: columnsOf(["text", "نص التعليق"], ["author", "الكاتب"], ["likes", "الإعجابات"], ["date", "التاريخ"]),
              sample_rows: [{ id: `${vid(0)}-c1`, text: "تعليق رقم 1 على الفيديو", author: "قارئ 1", likes: 0, date: "2026-10-28T09:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(commentsPage(vid(0)), 0.0005), tregResult(page, 0.0005), ...[0, 1, 2, 3, 4].map((i) => tregResult(commentsPage(vid(i)), 0.0005))],
    });
  }

  it("the card: the customer's 5 is the number of VIDEOS (delivered as their own sheet) and the comments are 5 x 10 = 50", async () => {
    const r = await run();
    expect(r.plannedPlan.quantity).toMatchObject({ requested: 5, target: 5, stage_key: "videos" });
    expect(r.plannedPlan.stages.map((s) => [s.key, s.deliver, s.planned_rows])).toEqual([["videos", true, 5], ["comments", true, 50]]);
    expect(r.plannedPlan.stages[1].per_parent_rows).toBe(10);
    expect(r.planView.stages.map((s) => s.rows)).toEqual([5, 50]);
    expect(r.planView.totalRows).toBe(55);
  });

  it("delivered: five videos and fifty comments, ten from each video, the videos in their own sheet", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 55 });
    expect(await childrenPerParent(r, "comments", "videos")).toEqual([10, 10, 10, 10, 10]);
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("فيديوهات تيك توك عن منتخب مصر")!.rowCount).toBe(6);
  });
});

describe("Companies: «عايز ٣ شركات مقاولات في مصر بدون جهات حكومية» (live: a government research centre and the armed forces' engineering authority were delivered; one city cell was «al qahirah», one empty)", () => {
  const COMPANIES = "tomba.companies.search.reveal";
  const co = (name: string, site: string, city: string, description = "") => ({ id: site, name, website_url: site, country: "EG", city, company_size: "51-200", industry: "Construction", description });
  const page = { companies: [
    co("Red Sea Construction", "redseaconstruction.com", "al qahirah", "General contracting and building works"),
    co("Construction and Project Management Research Institute", "hbrc.edu.eg", "Giza", "Research on building materials"),
    co("Egyptian Armed Forces Engineering Authority", "mod.gov.eg", "Cairo", "Engineering works for the armed forces"),
    co("Orascom Construction", "orascom.com", "Cairo", "Engineering and construction"),
    co("The Arab Contractors", "arabcont.example.com", "", "Contracting company"),
    co("Hassan Allam Contracting", "hassanallam.example.com", "Giza", "Contractors"),
  ] };
  const request = "عايز ٣ شركات مقاولات في مصر بدون جهات حكومية";
  const columns = [["name", "اسم الشركة"], ["city", "المدينة"], ["country", "الدولة"], ["website", "الموقع الإلكتروني"], ["description", "نبذة عن الشركة"]].map(([key, title_ar]) => ({ key, title_ar }));
  async function run() {
    return replay({
      request,
      planning: planFlow({
        progress: "أبحث عن شركات المقاولات", words: ["companies", "search"],
        calls: [{ endpoint: COMPANIES, params: { query: "construction", page: 1 }, code: "return inputs.call_0001.companies.map(c => ({ id: c.id, name: c.name, website: 'https://' + c.website_url, country: c.country, city: c.city || '', description: c.description }))" }],
        plan: (res) => ({
          summary_ar: "ستحصل على شركات مقاولات مصرية مع موقعها ونبذة عنها.",
          stages: [{ key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns,
            sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG", city: "Cairo", description: "Engineering and construction" }], measured_by: [callIds(res)[0], firstOutputId(res)] }],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(page, 0.0005)],
    });
  }

  it("the card says it plainly («دون الجهات الحكومية والعسكرية») and the plan carries the filter, built by code from the request", async () => {
    const r = await run();
    const filter = r.plannedPlan.stages[0].filters?.find((f) => f.kind === "exclude_government");
    expect(filter).toBeTruthy();
    expect(filter!.enabled).not.toBe(false);
    expect(filter!.fields).toEqual(expect.arrayContaining(["website", "name"]));
    expect(r.planView.assumptionsAr).toContain("دون الجهات الحكومية والعسكرية.");
  });

  it("delivered: three private companies; the research centre (.edu.eg) and the armed forces' authority (.gov.eg) are excluded with their reason", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 3 });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.acceptedRows("companies").map((x) => String(x.name))).toEqual(["Red Sea Construction", "Orascom Construction", "The Arab Contractors"]);
    expect(snap.counts("companies").excludedByReason.filter_government).toBe(2);
  });

  it("the city cells are Arabic and none is empty: «al qahirah» → «القاهرة», «Cairo» → «القاهرة», an empty one says the source did not state it", async () => {
    const r = await run();
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.acceptedRows("companies").map((x) => String(x.city))).toEqual(["القاهرة", "القاهرة", "غير مذكورة في المصدر"]);
    expect(snap.acceptedRows("companies").map((x) => String(x.country))).toEqual(["مصر", "مصر", "مصر"]);
  });
});
