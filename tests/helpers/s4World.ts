import { replay, REPLAY_USER } from "./agentReplay";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import type { FakeStep } from "../../agent/src/fakeDriver";
import type { MemoryStore } from "../../agent/src/memoryStore";
import { cid, vid } from "./g4RepliesWorld";

/**
 * S4 WORLD: the live request of 2026-11-02 10:26 Cairo («فيديوهين ... من مصر، مع كل التعليقات والردود»). The planner first samples the CHEAPEST TikTok search (anyapi: NO country input; its videos are from Iraq) and the comments tool, and proposes a plan on it; the catalog
 * has TikTok searches with a country field (tikhub.tiktok.search.videos: `region`). Every shape is the one the catalog schemas describe; every value is invented here, nothing reads a real source.
 */
export const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
export const TOPIC = "الذكاء الاصطناعي";
/** Video 1: 60 comments and 6 replies (counter 66), video 2: 30 comments and 3 replies (counter 33); the replies sit on every tenth comment. */
const thread = (n: number) => Array.from({ length: n }, (_, k) => (k % 10 === 0 ? 1 : 0));
export const COUNTERS = [66, 33, 12, 9];
export const COMMENTS_OF: Record<string, number[]> = { [vid(0)]: thread(60), [vid(1)]: thread(30), [vid(2)]: thread(10), [vid(3)]: thread(8) };
const link = (i: number) => `https://www.tiktok.com/@creator${i}/video/${vid(i)}`;

export interface S4Options {
  /** The comments page says 0 replies for every comment (a source whose counter is empty), while the replies exist. */
  zeroCounters?: boolean;
  /** The model's comments columns have no language column. */
  noLanguage?: boolean;
}

export const flagsOn = (d: never) => { const store = (d as { store: MemoryStore }).store; store.settings.redesign_flags = { social_posts: "test", social_account: "test", social_comments: "test" }; store.userEmails.set(REPLAY_USER, "iam.magdy+1@outlook.com"); return d; };

export async function runS4(o: S4Options = {}) {
  const countryOf = (tool: "anyapi" | "tikhub", i: number) => (tool === "anyapi" ? "IQ" : "EG") + (i >= 0 ? "" : "");
  // the cheapest search: no country input, videos from Iraq
  const anyapiPage = () => ({ output: { data: { videos: COUNTERS.map((n, i) => ({ id: vid(i), url: link(i), caption: `${TOPIC} فيديو ${i}`, authorName: `creator${i}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, country: countryOf("anyapi", i) })) } } });
  // the search with a `region` input: the videos of that country
  const tikhubPage = () => ({ data: { search_item_list: COUNTERS.map((n, i) => ({ id: vid(i), url: link(i), caption: `${TOPIC} فيديو ${i}`, authorName: `creator${i}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, region: countryOf("tikhub", i) })), cursor: 20, has_more: 0 } });
  const commentsPage = (video: string) => ({ data: { comments: (COMMENTS_OF[video] ?? []).map((replies, k) => ({ cid: cid(video, k), text: `تعليق ${k} عن ${TOPIC}`, user: { nickname: `viewer${k}` }, create_time: 1788100000 + k, digg_count: 10 + k, reply_comment_total: o.zeroCounters ? 0 : replies, comment_language: "ar" })), cursor: (COMMENTS_OF[video] ?? []).length, has_more: 0 } });
  const repliesPage = (commentId: string) => ({ output: { data: { comments: [{ id: `${commentId}-r0`, text: `رد على ${commentId}`, author: "replier", createdUtc: 1788200000, likes: 1 }], nextCursor: null } } });
  const hasReply = (commentId: string): boolean => { const [v, k] = commentId.split("-c"); return (COMMENTS_OF[v] ?? [])[Number(k)] === 1; };
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === "tikhub.tiktok.video.comments") return tregResult(commentsPage(String(p.aweme_id)), 0.001);
    if (c.endpointId === "anyapi.tiktok.comment_replies") return tregResult(hasReply(String(p.commentId)) ? repliesPage(String(p.commentId)) : { output: { data: { comments: [], nextCursor: null } } }, 0.0009);
    if (c.endpointId === "tikhub.tiktok.search.videos") return tregResult(tikhubPage(), 0.001);
    if (c.endpointId === "anyapi.tiktok.search.videos") return tregResult(anyapiPage(), 0.0006);
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const videoMap = (call: string, list: string, country: string) => `return inputs.${call}.${list}.map(v => ({ id: String(v.id), link: v.url, caption: v.caption || '', author: v.authorName, posted_at: new Date(v.createdUtc * 1000).toISOString(), views: v.views, likes: v.likes, comments_count: v.comments, shares: v.shares, country: v.${country} }))`;
  const commentsMap = `return inputs.call_0002.data.comments.map(r => ({ id: String(r.cid), text: r.text || '', author: r.user ? r.user.nickname : '', posted_at: new Date(r.create_time * 1000).toISOString(), likes: r.digg_count, replies_count: r.reply_comment_total${o.noLanguage ? "" : ", language: r.comment_language"} }))`;
  const videoColumns = [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "صاحب الفيديو" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "country", title_ar: "الدولة" }];
  const sampleVideos = (country: string) => [0, 1].map((i) => ({ id: vid(i), link: link(i), caption: `${TOPIC} فيديو ${i}`, author: `creator${i}`, posted_at: "2026-10-19T09:00:00Z", views: 1000 + i, likes: 50 + i, comments_count: COUNTERS[i], shares: 3, country }));
  const plan = (endpoint: string, measuredIndex: number, country: string) => (res: Results) => ({
    summary_ar: "ستحصل على فيديوهين من تيك توك عن الذكاء الاصطناعي من مصر، مع تعليقاتهما وردودها.",
    assumptions_ar: ["الأحدث أولًا"],
    stages: [
      { key: "videos", title_ar: "فيديوهات تيك توك عن الذكاء الاصطناعي من مصر", endpoint_id: endpoint, expected_rows: 2, parent_key: null, deliver: true, columns: videoColumns, sample_rows: sampleVideos(country), measured_by: [callIds(res)[measuredIndex]],
        filters: [{ kind: "place", field: "country", fields: ["country"], places: ["EG"], values: ["مصر"] }] },
      { key: "comments", title_ar: "تعليقات كل فيديو مختار", endpoint_id: "tikhub.tiktok.video.comments", expected_rows: 800, parent_key: "videos", per_parent_rows: 400, deliver: true,
        columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, ...(o.noLanguage ? [] : [{ key: "language", title_ar: "لغة التعليق" }])],
        sample_rows: [{ text: `تعليق 0 عن ${TOPIC}`, author: "viewer0", posted_at: "2026-10-20T09:00:00Z", likes: 10, replies_count: 1, ...(o.noLanguage ? {} : { language: "ar" }) }], measured_by: [callIds(res)[1]] },
    ],
  });
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر الفيديوهات", counts: { sources: 3 } } },
    { tool: "catalog_search", args: { words: ["tiktok", "videos"], platform: "tiktok", limit: 5 } },
    // call 0: the cheapest search, no country input
    { tool: "describe_endpoint", args: { id: "anyapi.tiktok.search.videos" } },
    { tool: "treg_call", args: { endpoint_id: "anyapi.tiktok.search.videos", params: { query: TOPIC, sortBy: 2 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[0], "output.data.videos", "country"), files: [callIds(r)[0]] }) },
    // call 1: the comments
    { tool: "describe_endpoint", args: { id: "tikhub.tiktok.video.comments" } },
    { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.video.comments", params: { aweme_id: vid(0), count: 20 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap.replace("call_0002", callIds(r)[1]), files: [callIds(r)[1]] }) },
    // the plan on the cheapest search (no country field)
    { tool: "propose_plan", args: plan("anyapi.tiktok.search.videos", 0, "IQ") },
    // after a refusal for the country: the search with a `region` input, sampled with Egypt
    { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
    { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: TOPIC, region: "EG", count: 20, sort_type: 2 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[2], "data.search_item_list", "region"), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 2, "EG") },
  ];
  return replay({
    request: REQUEST,
    planning: steps,
    execution: () => [],
    deps: flagsOn as never,
    answers: [tregResult(anyapiPage(), 0.0006), tregResult(commentsPage(vid(0)), 0.001), tregResult(tikhubPage(), 0.001), ...Array.from({ length: 600 }, () => dispatch)] as never,
  });
}
