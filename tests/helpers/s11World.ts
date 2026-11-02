import { replay, REPLAY_USER } from "./agentReplay";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import type { FakeStep } from "../../agent/src/fakeDriver";
import { flagsOn } from "./s4World";

/**
 * S11, the live test of 2026-11-02 ~15:36 Cairo: «هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.» The live plan: the account's posts by `scrapecreators.instagram.user.posts` (12 posts a page, newest first, a cursor `next_max_id`), the comments by
 * `anyapi.instagram.post.comments` (a post link in, comments out, no reply counter), and the stage titles «أحدث منشورين من حساب الحدث» and «التعليقات الرئيسية على المنشورين». The posts here are invented; the shapes and the titles are the live ones.
 */
export const REQUEST = "هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.";
export const POSTS_TOOL = "scrapecreators.instagram.user.posts";
export const COMMENTS_TOOL = "anyapi.instagram.post.comments";
export const REPLIES_TOOL = "anyapi.instagram.comment_replies";
/** The comment counters of the account's posts, newest first: page one (12 posts) and page two (12 older ones). The two most commented of the 24 are P16 (6) and P6 (4); of page one alone, P6 (4) and P3 (3). */
export const PAGE_ONE = [0, 0, 1, 3, 0, 2, 4, 0, 1, 0, 0, 2];
export const PAGE_TWO = [0, 1, 0, 0, 6, 1, 0, 0, 0, 2, 0, 0];
export const COUNTERS = [...PAGE_ONE, ...PAGE_TWO];
export const code = (i: number) => `P${String(i).padStart(2, "0")}`;
export const postUrl = (i: number) => `https://www.instagram.com/p/${code(i)}/`;
const NEWEST_FIRST_AT = 1793540000;

const post = (i: number) => ({ id: `pk${i}`, code: code(i), url: postUrl(i), caption: `خبر عاجل رقم ${i} من الحدث`, taken_at: NEWEST_FIRST_AT - i * 600, like_count: 10 + i, comment_count: COUNTERS[i], play_count: 100 * (i + 1), product_type: "clips" });
const postsPage = (cursor: unknown) => (cursor === "cur_12" ? { data: { items: Array.from({ length: 12 }, (_, k) => post(12 + k)), next_max_id: "cur_24", more_available: true } } : { data: { items: Array.from({ length: 12 }, (_, k) => post(k)), next_max_id: "cur_12", more_available: true } });
const indexOfUrl = (url: unknown): number => COUNTERS.findIndex((_, i) => postUrl(i) === String(url));
/** A post's counter counts its comments AND their replies (the platforms' own rule): every third comment has one reply, so a post whose counter is n has the most top-level comments t with t + ceil(t / 3) <= n; none carries a reply counter (the source gives none). */
export const topLevelOf = (i: number): number => { let t = 0; while ((t + 1) + Math.ceil((t + 1) / 3) <= COUNTERS[i]) t += 1; return t; };
export const commentsOf = (i: number) => Array.from({ length: topLevelOf(i) }, (_, k) => ({ id: `${code(i)}-c${k}`, text: `تعليق ${k} على ${code(i)}`, user: `viewer${k}`, created_at: NEWEST_FIRST_AT - i * 600 + 60 * (k + 1), likes: k, verified: false }));
const commentsPage = (url: unknown) => ({ output: { data: { comments: commentsOf(Math.max(0, indexOfUrl(url))), nextCursor: null } } });
/** Every third comment has one reply. */
export const hasReply = (commentId: string): boolean => Number(commentId.split("-c")[1]) % 3 === 0;
const repliesPage = (commentId: string) => ({ output: { data: { comments: hasReply(commentId) ? [{ id: `${commentId}-r0`, text: `رد على ${commentId}`, author: "replier", createdUtc: 1793600000, likes: 1 }] : [], nextCursor: null } } });

const dispatch = (c: { endpointId: string; params: unknown }) => {
  const p = c.params as Record<string, unknown>;
  if (c.endpointId === POSTS_TOOL) return tregResult(postsPage(p.next_max_id), 0.002);
  if (c.endpointId === COMMENTS_TOOL) return tregResult(commentsPage(p.url), 0.00144);
  if (c.endpointId === REPLIES_TOOL) return tregResult(repliesPage(String(p.commentId)), 0.0011);
  throw new Error(`unexpected tool ${c.endpointId}`);
};

const postsMap = (call: string) => `return inputs.${call}.data.items.map(p => ({ id: String(p.id), text: p.caption || '', author: 'Al Hadath الحدث', username: 'alhadath', posted_at: new Date(p.taken_at * 1000).toISOString(), url: p.url, likes: p.like_count, comments: p.comment_count, views: p.play_count, kind: 'ريل' }))`;
const commentsMap = (call: string) => `return inputs.${call}.output.data.comments.map(c => ({ id: String(c.id), text: c.text || '', author: c.user, posted_at: new Date(c.created_at * 1000).toISOString(), likes: c.likes, verified: c.verified, language: '' }))`;
const POSTS_COLUMNS = [["text", "النص"], ["author", "الكاتب"], ["username", "اسم المستخدم"], ["posted_at", "التاريخ والوقت"], ["url", "الرابط"], ["likes", "الإعجابات"], ["comments", "التعليقات"], ["views", "المشاهدات"], ["kind", "النوع"]].map(([key, title_ar]) => ({ key, title_ar }));
const COMMENT_COLUMNS = [["text", "النص"], ["author", "الكاتب"], ["posted_at", "التاريخ والوقت"], ["likes", "الإعجابات"], ["verified", "موثق"], ["language", "لغة التعليق"]].map(([key, title_ar]) => ({ key, title_ar }));

export interface S11Options {
  /** After the customer read the card and before they approve. */
  beforeApproval?: Parameters<typeof replay>[0]["beforeApproval"];
}

export async function runS11(o: S11Options = {}) {
  const why = "the cheaper sources return no author or link fields in their catalog description";
  const plan = (measuredPosts: (r: Results) => string[]) => (res: Results) => ({
    summary_ar: "ستحصل على أحدث منشورين من حساب الحدث على إنستجرام مع التعليقات الرئيسية المتاحة على كل منهما.",
    assumptions_ar: ["المنشوران: الأحدث في الحساب، ترتيب من الأحدث إلى الأقدم", "الحساب: الحدث على إنستجرام، وتُؤخذ المنشورات التي تنشرها الصفحة نفسها", "الردود على التعليقات غير متاحة من المصادر المتاحة، فلن تُجلب"],
    stages: [
      { key: "posts", title_ar: "أحدث منشورين من حساب الحدث", endpoint_id: POSTS_TOOL, expected_rows: 2, parent_key: null, deliver: true, columns: POSTS_COLUMNS,
        filters: [{ kind: "account", field: "username", fields: ["username", "author"], values: ["الحدث"] }],
        sample_rows: [0, 1, 2].map((i) => ({ text: post(i).caption, author: "Al Hadath الحدث", username: "alhadath", posted_at: new Date(post(i).taken_at * 1000).toISOString(), url: postUrl(i), likes: String(post(i).like_count), comments: String(COUNTERS[i]), views: String(post(i).play_count), kind: "ريل" })), measured_by: measuredPosts(res) },
      { key: "comments", title_ar: "التعليقات الرئيسية على المنشورين", endpoint_id: COMMENTS_TOOL, expected_rows: 6, parent_key: "posts", per_parent_rows: 1000, deliver: true, columns: COMMENT_COLUMNS,
        sample_rows: [{ text: "يازينب عجلي بهلاك النظام الإيراني", author: "med_jandoubi", posted_at: "2026-11-02T13:33:45.000Z", likes: "0", verified: "false", language: "" }], measured_by: [callIds(res)[1]] },
    ],
  });
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر المنشورات", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["instagram", "posts"], platform: "instagram", limit: 5 } },
    // call 0: the account's posts (page one)
    { tool: "describe_endpoint", args: { id: POSTS_TOOL } },
    { tool: "treg_call", args: { endpoint_id: POSTS_TOOL, params: { handle: "alhadath" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[0]), files: [callIds(r)[0]] }) },
    // call 1: the comments of one post
    { tool: "describe_endpoint", args: { id: COMMENTS_TOOL } },
    { tool: "treg_call", args: { endpoint_id: COMMENTS_TOOL, params: { url: postUrl(3) }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap(callIds(r)[1]), files: [callIds(r)[1]] }) },
    // the plan on ONE page of the account's posts (what the live planner proposed)
    { tool: "propose_plan", args: plan((r) => [callIds(r)[0]]) },
    // after a refusal (the most commented of the account's recent posts need more than one page): the next page, the same mapping, the plan again citing both pages
    { tool: "treg_call", args: { endpoint_id: POSTS_TOOL, params: { handle: "alhadath", next_max_id: "cur_12" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[2]), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: plan((r) => [callIds(r)[0], callIds(r)[2]]) },
  ];
  return replay({
    request: REQUEST,
    planning: steps,
    execution: () => [],
    deps: flagsOn as never,
    ...(o.beforeApproval ? { beforeApproval: o.beforeApproval } : {}),
    answers: Array.from({ length: 600 }, () => dispatch) as never,
  });
}
export { REPLAY_USER };
