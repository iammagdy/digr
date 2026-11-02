import { readFileSync } from "node:fs";
import { replay, REPLAY_USER } from "./agentReplay";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import type { FakeStep } from "../../agent/src/fakeDriver";
import type { MemoryStore } from "../../agent/src/memoryStore";

/**
 * S6 WORLD, built from the FACTS OF THE LIVE MISSION of 2026-11-02 ~12:23 Cairo (tests/fixtures/live/msn_6066498b-live.json: rows per call, the cursor chain and the duplicates of the stored calls and progress events; the page TEXT is in storage and is invented here).
 * Video V1 has the counter 329 and the comments tool gives it 8 pages [19, 20, 20, 20, 20, 20, 20, 7] with a cursor chain «20 ... 140» and 7 repeated ids; video V2 has the counter 163 and gives 11 comments in one page. 87 replies exist (55 + 32).
 */
export const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/live/msn_6066498b-live.json", import.meta.url), "utf8")) as {
  request: string;
  videos: Array<{ label: string; counter: number; commentCalls: { rowsPerCall: number[]; cursors: Array<string | null>; duplicateRowsInPage: Record<string, number>; savedComments: number }; repliesDelivered: number }>;
  delivered: { videos: number; comments: number; replies: number; total: number };
};
export const REQUEST = FIXTURE.request;
const vid = (i: number) => `76049541163049976${String(i).padStart(2, "0")}`;
const link = (i: number) => `https://www.tiktok.com/@creator${i}/video/${vid(i)}`;

/** The unique comment ids of each video, in the order the pages give them (the duplicates the saves show are repeated ids). */
function streamOf(i: number): { pages: string[][]; unique: string[] } {
  const calls = FIXTURE.videos[i].commentCalls;
  const pages: string[][] = [];
  let n = 0;
  calls.rowsPerCall.forEach((size, p) => {
    const dup = Number(calls.duplicateRowsInPage[String(p)] ?? 0);
    const repeated = dup > 0 ? pages[p - 1].slice(-dup) : [];
    pages.push([...repeated, ...Array.from({ length: size - repeated.length }, () => `${vid(i)}-c${n++}`)]);
  });
  return { pages, unique: pages.flat().filter((id, k, a) => a.indexOf(id) === k) };
}
/** Reply counters: V1 55 comments with one reply each; V2 eleven comments with 32 replies in all. */
const V2_REPLIES = [4, 4, 4, 3, 3, 3, 3, 3, 3, 2, 0];
const repliesOf = (commentId: string): number => {
  const [v, k] = commentId.split("-c");
  const i = [0, 1].find((x) => v === vid(x)) ?? 0;
  const at = streamOf(i).unique.indexOf(commentId);
  void k;
  return i === 0 ? (at >= 0 && at < 55 ? 1 : 0) : V2_REPLIES[at] ?? 0;
};

export interface S6Options {
  /** The next tool (crawl4ai, the tool the planner sampled) gives these extra comments for each video beyond what the first tool gave (0: it gives nothing more: the source really ends). */
  extraFromNextTool?: number;
  /** The model's comments columns have no language column (as in the live plan), and the text column is called «comments». */
  noLanguage?: boolean;
}
export const flagsOn = (d: never) => { const store = (d as { store: MemoryStore }).store; store.settings.redesign_flags = { social_posts: "test", social_account: "test", social_comments: "test" }; store.userEmails.set(REPLAY_USER, "iam.magdy+1@outlook.com"); return d; };

export async function runS6(o: S6Options = {}) {
  const searchPage = () => ({ data: { search_item_list: FIXTURE.videos.map((v, i) => ({ id: vid(i), url: link(i), caption: `الذكاء الاصطناعي فيديو ${i}`, authorName: `creator${i}`, createdUtc: 1788000000 + i, views: 1000 + i, likes: 50 + i, comments: v.counter, shares: 3, saves: 1, region: "EG" })), cursor: 20, has_more: 0 } });
  const rowOf = (id: string, k: number) => ({ cid: id, text: `تعليق ${k} عن الذكاء الاصطناعي`, user: { nickname: `viewer${k}` }, create_time: 1788100000 + k, digg_count: 10 + k, reply_comment_total: repliesOf(id), comment_language: "ar" });
  const tikhubPage = (video: string, cursor: unknown) => {
    const i = FIXTURE.videos.findIndex((_, x) => vid(x) === video);
    const calls = FIXTURE.videos[i].commentCalls;
    const p = cursor === undefined || cursor === null ? 0 : calls.cursors.indexOf(String(cursor));
    const ids = streamOf(i).pages[Math.max(0, p)] ?? [];
    const last = p >= calls.rowsPerCall.length - 1;
    return { data: { comments: ids.map((id, k) => rowOf(id, k)), cursor: last ? 0 : Number(calls.cursors[p + 1]), has_more: last ? 0 : 1 } };
  };
  /** The next tool: every unique comment of the first tool and `extraFromNextTool` more, up to the limit asked for. */
  const crawlPage = (post: string, limit: number) => {
    const i = FIXTURE.videos.findIndex((_, x) => post.includes(vid(x)));
    const base = streamOf(i).unique;
    const ids = [...base, ...Array.from({ length: o.extraFromNextTool ?? 0 }, (_, k) => `${vid(i)}-x${k}`)].slice(0, limit);
    return { rows: ids.map((id, k) => ({ comment_id: id, post_id: vid(i), text: `تعليق ${k} عن الذكاء الاصطناعي`, created_at: "2026-10-20T09:00:00Z", likes: 10 + k, replies: repliesOf(id), author: `viewer${k}`, liked_by_creator: false, language: "ar" })) };
  };
  const repliesPage = (commentId: string) => ({ output: { data: { comments: Array.from({ length: repliesOf(commentId) }, (_, k) => ({ id: `${commentId}-r${k}`, text: `رد ${k}`, author: "replier", createdUtc: 1788200000 + k, likes: k })), nextCursor: null } } });
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === "tikhub.tiktok.search.videos") return tregResult(searchPage(), 0.001);
    if (c.endpointId === "tikhub.tiktok.video.comments") return tregResult(tikhubPage(String(p.aweme_id), p.cursor), 0.001);
    if (c.endpointId === "crawl4ai.tiktok.video.comments") return tregResult(crawlPage(String(p.post), Number(p.limit ?? 50)), 0.0005);
    if (c.endpointId === "anyapi.tiktok.comment_replies") return tregResult(repliesPage(String(p.commentId)), 0.0009);
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const TEXT = "comments";
  const videoColumns = [{ key: "link", title_ar: "رابط الفيديو" }, { key: "caption", title_ar: "وصف الفيديو" }, { key: "author", title_ar: "صاحب الفيديو" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "country", title_ar: "الدولة" }];
  const commentColumns = [{ key: TEXT, title_ar: "التعليق" }, { key: "author", title_ar: "صاحب التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "replies_count", title_ar: "عدد الردود" }, ...(o.noLanguage === false ? [{ key: "language", title_ar: "لغة التعليق" }] : [])];
  const sample = streamOf(0).unique.slice(0, 50);
  const plan = (res: Results) => ({
    summary_ar: "ستحصل على فيديوهين من تيك توك عن الذكاء الاصطناعي من مصر، مع تعليقاتهما وردودها.",
    assumptions_ar: ["الأحدث أولًا"],
    stages: [
      { key: "videos", title_ar: "فيديوهات تيك توك عن الذكاء الاصطناعي من مصر", endpoint_id: "tikhub.tiktok.search.videos", expected_rows: 2, parent_key: null, deliver: true, columns: videoColumns,
        sample_rows: FIXTURE.videos.map((v, i) => ({ id: vid(i), link: link(i), caption: `الذكاء الاصطناعي فيديو ${i}`, author: `creator${i}`, posted_at: "2026-10-19T09:00:00Z", views: 1000 + i, likes: 50 + i, comments_count: v.counter, shares: 3, country: "EG" })), measured_by: [callIds(res)[0]],
        filters: [{ kind: "place", field: "country", fields: ["country"], places: ["EG"], values: ["مصر"] }] },
      { key: "comments", title_ar: "تعليقات كل فيديو مختار", endpoint_id: "crawl4ai.tiktok.video.comments", expected_rows: 800, parent_key: "videos", per_parent_rows: 400, deliver: true, columns: commentColumns,
        sample_rows: [{ [TEXT]: "تعليق 0 عن الذكاء الاصطناعي", author: "viewer0", posted_at: "2026-10-20T09:00:00Z", likes: 10, replies_count: 1 }], measured_by: [callIds(res)[1]] },
    ],
  });
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر الفيديوهات", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["tiktok", "videos"], platform: "tiktok", limit: 5 } },
    { tool: "describe_endpoint", args: { id: "tikhub.tiktok.search.videos" } },
    { tool: "treg_call", args: { endpoint_id: "tikhub.tiktok.search.videos", params: { keyword: "الذكاء الاصطناعي شرح وأخبار" /* CHANGED (S8): the request says «عن»: the search words carry that meaning */, region: "EG", count: 20, sort_type: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.search_item_list.map(v => ({ id: String(v.id), link: v.url, caption: v.caption || '', author: v.authorName, posted_at: new Date(v.createdUtc * 1000).toISOString(), views: v.views, likes: v.likes, comments_count: v.comments, shares: v.shares, country: v.region }))`, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: "crawl4ai.tiktok.video.comments" } },
    { tool: "treg_call", args: { endpoint_id: "crawl4ai.tiktok.video.comments", params: { post: vid(0), limit: 50 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.rows.map(c => ({ id: String(c.comment_id), ${TEXT}: c.text || '', author: c.author, posted_at: c.created_at, likes: c.likes, replies_count: ${sample.length > 15 ? "c.replies" : "0"} }))`, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: plan },
  ];
  return replay({
    request: REQUEST,
    planning: steps,
    execution: () => [],
    deps: flagsOn as never,
    answers: [tregResult(searchPage(), 0.001), tregResult(crawlPage(vid(0), 50), 0.0005), ...Array.from({ length: 900 }, () => dispatch)] as never,
  });
}
