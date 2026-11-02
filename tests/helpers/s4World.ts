import { replay, REPLAY_USER } from "./agentReplay";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import type { FakeStep } from "../../agent/src/fakeDriver";
import { readFileSync } from "node:fs";
import type { MemoryStore } from "../../agent/src/memoryStore";
import { cid, vid } from "./g4RepliesWorld";

/**
 * S4 WORLD: the live request of 2026-11-02 10:26 Cairo («فيديوهين ... من مصر، مع كل التعليقات والردود»). The planner first samples the CHEAPEST TikTok search (anyapi: NO country input; its videos are from Iraq) and the comments tool, and proposes a plan on it; the catalog
 * has TikTok searches with a country field (tikhub.tiktok.search.videos: `region`). Every shape is the one the catalog schemas describe; every value is invented here, nothing reads a real source.
 */
export const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
export const TOPIC = "الذكاء الاصطناعي";
/** CHANGED (S8): the request says «عن الذكاء الاصطناعي» (about), so the search words carry that meaning: the model of these worlds samples the search with the topic and explainer wording, as the code now asks. */
export const QUERY = "الذكاء الاصطناعي شرح وأخبار";
/** Video 1: 60 comments and 6 replies (counter 66), video 2: 30 comments and 3 replies (counter 33); the replies sit on every tenth comment. */
const thread = (n: number) => Array.from({ length: n }, (_, k) => (k % 10 === 0 ? 1 : 0));
export const COUNTERS = [66, 33, 12, 9];
/** The newest results (the model's own sort in the live test): brand-new videos with 5 and 1 comments (counters 5 and 1). */
export const NEWEST = [{ i: 4, n: 5 }, { i: 5, n: 1 }];
/** S7: global English videos the most-liked order returns, and the Egyptian Arabic results of the default order (not sorted by comments). */
export const ENGLISH = [{ i: 10, n: 3553, us: true }, { i: 11, n: 1560, us: true }, { i: 12, n: 900, us: true }, { i: 13, n: 700, us: true }, { i: 14, n: 20 }];
const FIXV = JSON.parse(readFileSync(new URL("../fixtures/live/msn_5851abc9-videos.json", import.meta.url), "utf8")) as { videos: Array<{ id: string; synthetic: boolean; comments: number; text: string }> };
/** S8: the stored videos as search results (ids vid(20 + k)): the stories, and the explainers the meaning-carrying query brings. */
export const STORIES = FIXV.videos.filter((v) => !v.synthetic).map((v, k) => ({ i: 20 + k, n: v.comments, text: v.text }));
export const EXPLAINERS = FIXV.videos.filter((v) => v.synthetic).map((v, k) => ({ i: 30 + k, n: v.comments, text: v.text }));
export const RELEVANT = [{ i: 2, n: 12 }, { i: 0, n: 66 }, { i: 3, n: 9 }, { i: 1, n: 33 }];
export const COMMENTS_OF: Record<string, number[]> = { [vid(0)]: thread(60), [vid(1)]: thread(30), [vid(2)]: thread(10), [vid(3)]: thread(8), [vid(4)]: [1, 0, 0, 0], [vid(5)]: [0], [vid(30)]: thread(50), [vid(31)]: thread(30) };
const link = (i: number) => `https://www.tiktok.com/@creator${i}/video/${vid(i)}`;

export interface S4Options {
  /** The comments page says 0 replies for every comment (a source whose counter is empty), while the replies exist. */
  zeroCounters?: boolean;
  /** The model's comments columns have no language column. */
  noLanguage?: boolean;
  /** S5: the search returns the most-liked videos for sort_type 1 and the newest (counters 5 and 1) otherwise; the planner first samples the newest, as in the live test. */
  sortAware?: boolean;
  /** S7: the live test of 13:06: the most-liked order of the search gives global English videos (counters 3,553 and 1,560) whatever the region input says; the default order gives the Egyptian Arabic ones (counters 12, 66, 9, 33 in that order). */
  conditions?: boolean;
  /** S8: the stored videos of the 13:35 mission (AI-generated drama stories with #قصص_بالذكاء_الاصطناعي) come back for the plain topic search; the search with explainer and news wording also brings videos that talk ABOUT the topic. */
  topicStories?: boolean;
  /** S9: the live mission of 14:19: two videos whose counters are far above 150 (400 and 380), 150 comments each in the source with reply counters that sum to 40 in all (20 comments each have one reply). */
  live9?: boolean;
  /** Runs after the customer read the card and before they approve (the plan editor). */
  beforeApproval?: Parameters<typeof replay>[0]["beforeApproval"];
}

// S9: 150 comments per video, 20 of them with one reply: the reply counters of the 300 comments sum to 40
const LIVE9_THREAD = Array.from({ length: 150 }, (_, k) => (k % 7 === 0 && k < 140 ? 1 : 0));
export const LIVE9_COUNTERS = [400, 380, 12, 9];

export const flagsOn = (d: never) => { const store = (d as { store: MemoryStore }).store; store.settings.redesign_flags = { social_posts: "test", social_account: "test", social_comments: "test" }; store.userEmails.set(REPLAY_USER, "iam.magdy+1@outlook.com"); return d; };

export async function runS4(o: S4Options = {}) {
  const counters = o.live9 ? LIVE9_COUNTERS : COUNTERS;
  const commentsOf: Record<string, number[]> = o.live9 ? { ...COMMENTS_OF, [vid(0)]: LIVE9_THREAD, [vid(1)]: LIVE9_THREAD } : COMMENTS_OF;
  // the cheapest search returns videos of every country (the first two are Iraqi; one of the sample is Egyptian, so the card's promise is not refused for lack of evidence); the search with a region input returns Egyptian videos only
  const countryOf = (tool: "anyapi" | "tikhub", i: number) => (tool === "anyapi" ? (i < 2 ? "IQ" : "EG") : "EG");
  // the cheapest search: no country input, videos from Iraq
  const anyapiPage = () => ({ output: { data: { videos: counters.map((n, i) => ({ id: vid(i), url: link(i), caption: `${TOPIC} فيديو ${i}`, authorName: `creator${i}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, country: countryOf("anyapi", i) })) } } });
  // the search with a `region` input: the videos of that country
  type Item = { i: number; n: number; us?: boolean; text?: string };
  const searchList = (sortType: unknown, keyword?: unknown): Item[] => (o.topicStories ? (String(keyword ?? "").includes("شرح") ? [...EXPLAINERS, ...STORIES.slice(0, 2)] : STORIES) : o.conditions ? (Number(sortType) === 1 ? ENGLISH : Number(sortType) === 2 ? NEWEST : RELEVANT) : o.sortAware && Number(sortType) !== 1 ? NEWEST : counters.map((n, i) => ({ i, n })));
  const tikhubPage = (sortType?: unknown, keyword?: unknown) => ({ data: { search_item_list: searchList(sortType, keyword).map(({ i, n, us, text }: Item) => ({ id: vid(i), url: link(i), caption: text ?? (us ? `AI cartoon video ${i}` : `${TOPIC} فيديو ${i}`), authorName: `creator${i}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: n, shares: 3, saves: 1, region: us ? "US" : countryOf("tikhub", i) })), cursor: 20, has_more: 0 } });
  const commentsPage = (video: string) => ({ data: { comments: (commentsOf[video] ?? []).map((replies, k) => ({ cid: cid(video, k), text: `تعليق ${k} عن ${TOPIC}`, user: { nickname: `viewer${k}` }, create_time: 1788100000 + k, digg_count: 10 + k, reply_comment_total: o.zeroCounters ? 0 : replies, comment_language: "ar" })), cursor: (commentsOf[video] ?? []).length, has_more: 0 } });
  const repliesPage = (commentId: string) => ({ output: { data: { comments: [{ id: `${commentId}-r0`, text: `رد على ${commentId}`, author: "replier", createdUtc: 1788200000, likes: 1 }], nextCursor: null } } });
  const hasReply = (commentId: string): boolean => { const [v, k] = commentId.split("-c"); return (commentsOf[v] ?? [])[Number(k)] === 1; };
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === "tikhub.tiktok.video.comments") return tregResult(commentsPage(String(p.aweme_id)), 0.001);
    if (c.endpointId === "anyapi.tiktok.comment_replies") return tregResult(hasReply(String(p.commentId)) ? repliesPage(String(p.commentId)) : { output: { data: { comments: [], nextCursor: null } } }, 0.0009);
    if (c.endpointId === "tikhub.tiktok.search.videos") return tregResult(tikhubPage(p.sort_type, p.keyword), 0.001);
    if (c.endpointId === "anyapi.tiktok.search.videos") return tregResult(anyapiPage(), 0.0006);
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const videoMap = (call: string, list: string, country: string) => `return inputs.${call}.${list}.map(v => ({ id: String(v.id), link: v.url, caption: v.caption || '', author: v.authorName, posted_at: new Date(v.createdUtc * 1000).toISOString(), views: v.views, likes: v.likes, comments_count: v.comments, shares: v.shares, country: v.${country} }))`;
  const commentsMap = `return inputs.call_0002.data.comments.map(r => ({ id: String(r.cid), text: r.text || '', author: r.user ? r.user.nickname : '', posted_at: new Date(r.create_time * 1000).toISOString(), likes: r.digg_count, replies_count: r.reply_comment_total${o.noLanguage ? "" : ", language: r.comment_language"} }))`;
  const videoColumns = [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "صاحب الفيديو" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "country", title_ar: "الدولة" }];
  const sampleVideos = (country: string, list: Array<{ i: number; n: number; us?: boolean; text?: string }> = counters.map((n, i) => ({ i, n }))) => list.slice(0, 2).map(({ i, n, us, text }) => ({ id: vid(i), link: link(i), caption: text ?? (us ? `AI cartoon video ${i}` : `${TOPIC} فيديو ${i}`), author: `creator${i}`, posted_at: "2026-10-19T09:00:00Z", views: 1000 + i, likes: 50 + i, comments_count: n, shares: 3, country }));
  const plan = (endpoint: string, measuredIndex: number, country: string, list?: Array<{ i: number; n: number; us?: boolean; text?: string }>) => (res: Results) => ({
    summary_ar: "ستحصل على فيديوهين من تيك توك عن الذكاء الاصطناعي من مصر، مع تعليقاتهما وردودها.",
    assumptions_ar: ["الأحدث أولًا"],
    stages: [
      { key: "videos", title_ar: "فيديوهات تيك توك عن الذكاء الاصطناعي من مصر", endpoint_id: endpoint, expected_rows: 2, parent_key: null, deliver: true, columns: videoColumns, sample_rows: sampleVideos(country, list), measured_by: [callIds(res)[measuredIndex]],
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
    { tool: "treg_call", args: { endpoint_id: "anyapi.tiktok.search.videos", params: { query: QUERY, sortBy: 2 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[0], "output.data.videos", "country"), files: [callIds(r)[0]] }) },
    // call 1: the comments
    { tool: "describe_endpoint", args: { id: "tikhub.tiktok.video.comments" } },
    { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.video.comments", params: { aweme_id: vid(0), count: 20 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap.replace("call_0002", callIds(r)[1]), files: [callIds(r)[1]] }) },
    ...(o.topicStories ? [
      // S8: the model samples the plain topic (the stories come back), the code asks for the meaning in the query, the model samples again with it (explainers come back) and cites both samples
      { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: TOPIC, region: "EG", count: 20, sort_type: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[2], "data.search_item_list", "region"), files: [callIds(r)[2]] }) },
      { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 2, "EG", STORIES) },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[3], "data.search_item_list", "region"), files: [callIds(r)[3]] }) },
      { tool: "propose_plan", args: (r: Results) => { const p = plan("tikhub.tiktok.search.videos", 3, "EG", [...EXPLAINERS, ...STORIES.slice(0, 2)])(r) as { stages: Array<{ measured_by: string[] }> }; p.stages[0].measured_by = [callIds(r)[2], callIds(r)[3]]; return p; } },
    ] as FakeStep[] : o.conditions ? [
      // S7: the default order (Egyptian Arabic results), then the most-liked order the code asks for (global English videos): the planning budget allows these two samples of the source; the plan cites both
      { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 0 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[2], "data.search_item_list", "region"), files: [callIds(r)[2]] }) },
      { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 2, "EG", RELEVANT) },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[3], "data.search_item_list", "region"), files: [callIds(r)[3]] }) },
      { tool: "propose_plan", args: (r: Results) => { const p = plan("tikhub.tiktok.search.videos", 3, "US", ENGLISH)(r) as { stages: Array<{ measured_by: string[] }> }; p.stages[0].measured_by = [callIds(r)[2], callIds(r)[3]]; return p; } },
    ] as FakeStep[] : o.sortAware ? [
      // S5: the model samples the search with the country and ITS OWN sort (newest), as in the live test; the plan is refused (most engaged is the default for comments); it samples the most-liked sort and proposes again
      { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 2 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[2], "data.search_item_list", "region"), files: [callIds(r)[2]] }) },
      { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 2, "EG", NEWEST) },
      { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[3], "data.search_item_list", "region"), files: [callIds(r)[3]] }) },
      { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 3, "EG") },
    ] as FakeStep[] : [
    // the plan on the cheapest search (no country field)
    { tool: "propose_plan", args: plan("anyapi.tiktok.search.videos", 0, "IQ") },
    // after a refusal for the country: the search with a `region` input, sampled with Egypt
    { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
    // (sampled in the most-liked order from the start: S5 sends a plan sampled in another order back, which the S4 tests are not about)
    { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: QUERY, region: "EG", count: 20, sort_type: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: videoMap(callIds(r)[2], "data.search_item_list", "region"), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: plan("tikhub.tiktok.search.videos", 2, "EG") },
    ] as FakeStep[]),
  ];
  return replay({
    request: REQUEST,
    planning: steps,
    execution: () => [],
    deps: flagsOn as never,
    ...(o.beforeApproval ? { beforeApproval: o.beforeApproval } : {}),
    answers: [tregResult(anyapiPage(), 0.0006), tregResult(commentsPage(vid(0)), 0.001), ...Array.from({ length: 600 }, () => dispatch)] as never,
  });
}
