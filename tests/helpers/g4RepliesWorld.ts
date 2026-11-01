import { replay, REPLAY_USER } from "./agentReplay";
import { editPlanForCustomer } from "../../src/lib/agentMission/customerActions";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import { aboutWords, firstOutputId } from "./agentRelevance";
import type { FakeStep } from "../../agent/src/fakeDriver";

/**
 * THE G4 WORLD WITH REPLIES (live msn_3da66037878465ffbfd5, TikTok, «٥ فيديوهات عن منتخب مصر ومن كل فيديو ١٠ تعليقات»), shared by the replies tests. The live endpoints and shapes: the videos of anyapi.tiktok.search.videos (output.data.videos[]), the comments of
 * tikhub.tiktok.video.comments (data.comments[] with reply_comment_total, data.cursor), and the reply pages of the sources the catalog offers (each in its own shape). Every value is invented here; nothing reads a real source.
 */
export const VIDEOS = "anyapi.tiktok.search.videos";
export const COMMENTS = "tikhub.tiktok.video.comments";
export const TOPIC = "منتخب مصر";
export const vid = (i: number) => `77000000000000000${String(i).padStart(2, "0")}`;
export const link = (i: number) => `https://www.tiktok.com/@creator${i % 7}/video/${vid(i)}`;
export const cid = (v: string, k: number) => `${v}-c${k}`;

export interface World {
  /** The video's own counter (comments and replies together, as the source counts them). */
  ownCounter: number[];
  /** The top-level comments each video gives: the replies each says it has. */
  commentsOf: Record<string, number[]>;
  /** How many replies a comment really gives when they are asked for. */
  given: (commentId: string, counted: number) => number;
}

/** The live shape: video 0 is the one of the live run (counter 25): ONE top-level comment with 24 replies, of which the source returns 23 (one was deleted). */
export const LIVE_WORLD: World = {
  ownCounter: [25, 12, 5, 9, 8, 6, 9, 9],
  commentsOf: { [vid(0)]: [24], [vid(1)]: [2, 0, 4], [vid(2)]: [1], [vid(3)]: [0, 0], [vid(4)]: [3, 0], [vid(5)]: [1], [vid(6)]: [0], [vid(7)]: [0] },
  given: (commentId, counted) => (commentId === cid(vid(0), 0) ? 23 : counted),
};

/** Every video gives its ten comments, each says it has two replies and the source returns one of them: the top-level delivery is COMPLETE and the replies come in below the estimate. */
export const FULL_WORLD: World = {
  ownCounter: [30, 30, 30, 30, 30, 30, 30, 30],
  commentsOf: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [vid(i), Array.from({ length: 10 }, () => 2)])),
  given: (_c, counted) => Math.max(0, counted - 1),
};

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

export const idOfParams = (p: Record<string, unknown>): string => String(p.commentId ?? p.comment_id ?? "");

export async function runG4(world: World = LIVE_WORLD, options: { sampleWithCounter?: boolean; /** The replies read for each comment (default here: the cap of 50; the product default is 10). */ repliesPerComment?: number } = {}) {
  const counterOf = new Map<string, number>(Object.entries(world.commentsOf).flatMap(([v, list]) => list.map((n, k) => [cid(v, k), n] as const)));
  const videosPage = () => ({ output: { data: { videos: world.ownCounter.map((n, i) => ({ id: vid(i), url: link(i), caption: `${TOPIC} فيديو ${i}`, authorName: `creator${i % 7}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, durationSeconds: 30 })) } } });
  const commentsPage = (video: string) => ({ data: { comments: (world.commentsOf[video] ?? []).map((replies, k) => ({ cid: cid(video, k), text: `تعليق ${k} على ${TOPIC}`, user: { nickname: `viewer${k}` }, create_time: 1788100000 + k, digg_count: 10 + k, reply_comment_total: replies, comment_language: "ar", is_author_digged: false, cmt_sticker_struct: null })), cursor: (world.commentsOf[video] ?? []).length, has_more: 0 } });
  /** One page of the replies to a comment, in the shape of whichever reply source the code chose (10 a page). */
  const repliesPage = (endpoint: string, commentId: string, cursor: unknown) => {
    const total = world.given(commentId, counterOf.get(commentId) ?? 0);
    const from = Number(cursor ?? 0) || 0;
    const n = Math.max(0, Math.min(10, total - from));
    const more = from + n < total;
    const rows = Array.from({ length: n }, (_, i) => from + i);
    if (endpoint === "anyapi.tiktok.comment_replies") return { output: { data: { comments: rows.map((k) => ({ id: `${commentId}-r${k}`, text: `رد ${k} على ${commentId}`, author: `replier${k}`, createdUtc: 1788200000 + k, likes: k })), nextCursor: more ? String(from + n) : null } } };
    return { data: { comments: rows.map((k) => ({ cid: `${commentId}-r${k}`, text: `رد ${k} على ${commentId}`, user: { nickname: `replier${k}` }, create_time: 1788200000 + k, digg_count: k, reply_comment_total: 0, comment_language: "ar", reply_id: commentId })), cursor: from + n, has_more: more ? 1 : 0 } };
  };
  const dispatch = (o: { endpointId: string; params: unknown }) => {
    const p = o.params as Record<string, unknown>;
    if (o.endpointId === VIDEOS) return tregResult(videosPage(), 0.0005);
    if (o.endpointId === COMMENTS) return tregResult(commentsPage(String(p.aweme_id)), 0.001);
    return tregResult(repliesPage(o.endpointId, idOfParams(p), p.cursor), 0.0009);
  };
  const counterMap = "replies_count: r.reply_comment_total, ";
  return replay({
    request: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات",
    planning: planFlow({
      progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
      calls: [
        { endpoint: VIDEOS, params: { query: TOPIC }, code: "return inputs.call_0001.output.data.videos.map(v => ({ id: String(v.id), link: v.url, caption: v.caption || '', author: v.authorName, posted_at: new Date(v.createdUtc * 1000).toISOString(), views: v.views, likes: v.likes, comments_count: v.comments, shares: v.shares, saves: v.saves, duration_s: v.durationSeconds }))" },
        { endpoint: COMMENTS, params: { aweme_id: vid(1), count: 10 }, code: `return inputs.call_0002.data.comments.map(r => ({ id: String(r.cid), text: r.text || '', author: r.user ? (r.user.nickname || r.user.unique_id) : '', posted_at: new Date(r.create_time * 1000).toISOString(), likes: r.digg_count, ${options.sampleWithCounter === false ? "" : counterMap}language: r.comment_language }))` },
      ],
      plan: (res) => ({
        summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر مع تعليقات كل فيديو.",
        stages: [
          { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "صاحب الفيديو" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }],
            sample_rows: [1, 2].map((i) => ({ id: vid(i), link: link(i), caption: `${TOPIC} فيديو ${i}`, author: `creator${i}`, posted_at: "2026-10-19T09:00:00Z", views: 1000 + i, likes: 50 + i, comments_count: world.ownCounter[i], shares: 3 })), measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب"], { text_columns: ["caption"] }), yield_from: firstOutputId(res) },
          { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, ...(options.sampleWithCounter === false ? [] : [{ key: "replies_count", title_ar: "عدد الردود" }]), { key: "language", title_ar: "لغة التعليق" }],
            sample_rows: [{ text: `تعليق 0 على ${TOPIC}`, author: "viewer0", posted_at: "2026-10-20T09:00:00Z", likes: 10, ...(options.sampleWithCounter === false ? {} : { replies_count: 2 }), language: "ar" }], measured_by: [callIds(res)[1]] },
        ],
      }),
    }),
    execution: () => [],
    answers: [tregResult(videosPage(), 0.0005), tregResult(commentsPage(vid(1)), 0.001), ...Array.from({ length: 400 }, () => dispatch)] as never,
    // CHANGED (golden run round 2, owner decision: the default is ten replies per comment): these replays are about whole threads (the live video's one comment carries 24 replies), so the customer raises the number per comment to the cap of fifty in the plan editor before approving
    beforeApproval: async ({ client, missionId }) => { if (options.repliesPerComment !== 10) { const r = await editPlanForCustomer(client, { id: missionId, userId: REPLAY_USER, edits: { stages: [{ key: "comments", replies_per_comment: options.repliesPerComment ?? 50 }] } }); void r; /* a plan with no replies stage (no counter in the sample) has nothing to edit */ } },
  });
}

export type G4Result = Awaited<ReturnType<typeof runG4>>;
type Call = { endpointId: string; params: Record<string, unknown> };
export const callsOf = (r: G4Result): Call[] => (r.call.mock.calls as Array<[Call]>).map((c) => c[0]);
export const isReplySource = (id: string) => /repl/i.test(id);
