import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * G4 WITH ITS REPLIES (live msn_3da66037878465ffbfd5, TikTok, «٥ فيديوهات عن منتخب مصر ومن كل فيديو ١٠ تعليقات»): the live shape. Video 7699049713550593300 showed 25 in its own comment counter and delivered ONE comment, because the comments source gives the top-level comments only and the
 * replies (the rest of the counter) were never fetched. Owner decision: child items are delivered raw and researchers analyse FULL threads, so the replies are fetched too, by the cheapest ranked reply source, and ONLY for a comment whose own reply counter is above 0.
 *
 * The fake world has the live endpoints and shapes: the videos of anyapi.tiktok.search.videos (output.data.videos[]), the comments of tikhub.tiktok.video.comments (data.comments[] with reply_comment_total, data.cursor), and the reply pages of the sources the catalog offers (each in its own shape).
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

const VIDEOS = "anyapi.tiktok.search.videos";
const COMMENTS = "tikhub.tiktok.video.comments";
const TOPIC = "منتخب مصر";
const vid = (i: number) => `77000000000000000${String(i).padStart(2, "0")}`;
const link = (i: number) => `https://www.tiktok.com/@creator${i % 7}/video/${vid(i)}`;
/** The video's own counter (comments and replies together, as the source counts them): video 0 is the one of the live run, 25. */
const OWN_COUNTER = [25, 12, 5, 9, 8, 6, 9, 9];
/** The top-level comments each video gives (the replies each says it has). Video 0: one comment with 24 replies; the source returns 23 of them (one was deleted). */
const COMMENTS_OF: Record<string, number[]> = { [vid(0)]: [24], [vid(1)]: [2, 0, 4], [vid(2)]: [1], [vid(3)]: [0, 0], [vid(4)]: [3, 0], [vid(5)]: [1], [vid(6)]: [0], [vid(7)]: [0] };
const cid = (v: string, k: number) => `${v}-c${k}`;
/** What each comment really gives when its replies are asked for (the live source returned 23 of the 24 counted on the one comment of video 0). */
const REPLIES_GIVEN = (commentId: string, counted: number): number => (commentId === cid(vid(0), 0) ? 23 : counted);
const COUNTER_OF_COMMENT = new Map<string, number>(Object.entries(COMMENTS_OF).flatMap(([v, list]) => list.map((n, k) => [cid(v, k), n] as const)));

const videosPage = () => ({ output: { data: { videos: OWN_COUNTER.map((n, i) => ({ id: vid(i), url: link(i), caption: `${TOPIC} فيديو ${i}`, authorName: `creator${i % 7}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, durationSeconds: 30 })) } } });
const commentsPage = (video: string) => ({ data: { comments: (COMMENTS_OF[video] ?? []).map((replies, k) => ({ cid: cid(video, k), text: `تعليق ${k} على ${TOPIC}`, user: { nickname: `viewer${k}` }, create_time: 1788100000 + k, digg_count: 10 + k, reply_comment_total: replies, comment_language: "ar", is_author_digged: false, cmt_sticker_struct: null })), cursor: (COMMENTS_OF[video] ?? []).length, has_more: 0 } });

/** One page of the replies to a comment, in the shape of whichever reply source the code chose (10 a page). */
function repliesPage(endpoint: string, commentId: string, cursor: unknown) {
  const counted = COUNTER_OF_COMMENT.get(commentId) ?? 0;
  const total = REPLIES_GIVEN(commentId, counted);
  const from = Number(cursor ?? 0) || 0;
  const n = Math.max(0, Math.min(10, total - from));
  const more = from + n < total;
  const rows = Array.from({ length: n }, (_, i) => ({ k: from + i }));
  if (endpoint === "anyapi.tiktok.comment_replies") return { output: { data: { comments: rows.map((r) => ({ id: `${commentId}-r${r.k}`, text: `رد ${r.k} على ${commentId}`, author: `replier${r.k}`, createdUtc: 1788200000 + r.k, likes: r.k })), nextCursor: more ? String(from + n) : null } } };
  return { data: { comments: rows.map((r) => ({ cid: `${commentId}-r${r.k}`, text: `رد ${r.k} على ${commentId}`, user: { nickname: `replier${r.k}` }, create_time: 1788200000 + r.k, digg_count: r.k, reply_comment_total: 0, comment_language: "ar", reply_id: commentId })), cursor: from + n, has_more: more ? 1 : 0 } };
}

const idOfParams = (p: Record<string, unknown>): string => String(p.commentId ?? p.comment_id ?? "");
const dispatch = (o: { endpointId: string; params: unknown }) => {
  const p = o.params as Record<string, unknown>;
  if (o.endpointId === VIDEOS) return tregResult(videosPage(), 0.0005);
  if (o.endpointId === COMMENTS) return tregResult(commentsPage(String(p.aweme_id)), 0.001);
  return tregResult(repliesPage(o.endpointId, idOfParams(p), p.cursor), 0.0009);
};

async function run() {
  return replay({
    request: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات",
    planning: planFlow({
      progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
      calls: [
        { endpoint: VIDEOS, params: { query: TOPIC }, code: "return inputs.call_0001.output.data.videos.map(v => ({ id: String(v.id), link: v.url, caption: v.caption || '', author: v.authorName, posted_at: new Date(v.createdUtc * 1000).toISOString(), views: v.views, likes: v.likes, comments_count: v.comments, shares: v.shares, saves: v.saves, duration_s: v.durationSeconds }))" },
        { endpoint: COMMENTS, params: { aweme_id: vid(1), count: 10 }, code: "return inputs.call_0002.data.comments.map(r => ({ id: String(r.cid), text: r.text || '', author: r.user ? (r.user.nickname || r.user.unique_id) : '', posted_at: new Date(r.create_time * 1000).toISOString(), likes: r.digg_count, replies_count: r.reply_comment_total, language: r.comment_language }))" },
      ],
      plan: (res) => ({
        summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر مع تعليقات كل فيديو.",
        stages: [
          { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "صاحب الفيديو" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }],
            sample_rows: [1, 2].map((i) => ({ id: vid(i), link: link(i), caption: `${TOPIC} فيديو ${i}`, author: `creator${i}`, posted_at: "2026-10-19T09:00:00Z", views: 1000 + i, likes: 50 + i, comments_count: OWN_COUNTER[i], shares: 3 })), measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب"], { text_columns: ["caption"] }), yield_from: firstOutputId(res) },
          { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, { key: "language", title_ar: "لغة التعليق" }],
            sample_rows: [{ text: `تعليق 0 على ${TOPIC}`, author: "viewer0", posted_at: "2026-10-20T09:00:00Z", likes: 10, replies_count: 2, language: "ar" }], measured_by: [callIds(res)[1]] },
        ],
      }),
    }),
    execution: () => [],
    answers: [tregResult(videosPage(), 0.0005), tregResult(commentsPage(vid(1)), 0.001), ...Array.from({ length: 300 }, () => dispatch)] as never,
  });
}

type Call = { endpointId: string; params: Record<string, unknown> };
const callsOf = (r: Awaited<ReturnType<typeof run>>): Call[] => (r.call.mock.calls as Array<[Call]>).map((c) => c[0]);
const isReplySource = (id: string) => /repl/i.test(id);

describe("G4 with its replies, in the live shape", () => {
  it("fetches the replies of every comment that says it has some, with the cheapest ranked reply source, and none for a comment whose reply counter is 0", async () => {
    const r = await run();
    const reads = callsOf(r).filter((c) => isReplySource(c.endpointId));
    expect(reads.length).toBeGreaterThan(0);
    // one source for the whole stage: the cheapest ranked one of the catalog
    expect(new Set(reads.map((c) => c.endpointId)).size).toBe(1);
    const asked = new Set(reads.map((c) => idOfParams(c.params)));
    // the five comments that have replies were asked for; the four with a counter of 0 never were
    expect([...asked].sort()).toEqual([cid(vid(0), 0), cid(vid(1), 0), cid(vid(1), 2), cid(vid(2), 0), cid(vid(4), 0)].sort());
    for (const [id, counter] of COUNTER_OF_COMMENT) if (counter === 0) expect(asked.has(id), id).toBe(false);
  });

  it("delivers the top-level comments AND their replies: 5 videos, 9 comments and 33 replies (23 of the 24 counted on the live video's one comment), and charges for exactly those 47 rows", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 47, expectStatus: "partial" });
    const wb = await readWorkbook(r);
    const titles = wb.worksheets.map((s) => s.name);
    const commentsSheet = wb.worksheets.find((s) => /تعليقات/.test(s.name))!;
    expect(commentsSheet).toBeTruthy();
    const replySheet = wb.worksheets.find((s) => /ردود/.test(s.name));
    expect(replySheet, titles.join("|")).toBeTruthy();
    expect(commentsSheet.rowCount - 1).toBe(9);
    expect(replySheet!.rowCount - 1).toBe(33);
  });

  it("the plan has the replies as a stage of their own under the comments, priced with the plan (the price covers them)", async () => {
    const r = await run();
    const stage = r.plannedPlan.stages.find((s) => /replies/.test(s.key))!;
    expect(stage).toBeTruthy();
    expect(stage.parent_key).toBe("comments");
    expect(stage.deliver).toBe(true);
    expect(stage.engine?.endpoint_id).toMatch(/repl/i);
    expect(r.plannedPlan.price.deliveredRows).toBe(r.plannedPlan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0));
  });
});
