import { replay } from "./agentReplay";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import type { FakeStep } from "../../agent/src/fakeDriver";
import { flagsOn } from "./s4World";

/**
 * THE BENCHMARK WORLDS (docs/benchmarks/antigravity-10.md, items 1 to 5), one per request, each with the exact Arabic text. Every shape is the one the catalog schema of the tool states (list path, item fields, inputs); every value is invented here. The fake planner works the way the live
 * planner did (the tools the live missions used, sampled the way they sampled them); what is under test is the code that turns its plan into a request, a promise, a delivery and a file.
 */
export const BENCH_USER_FLAGS = flagsOn;
const WHY = "the cheaper sources return no author or link fields in their catalog description";
export { WHY, callIds, tregResult };
export type { Results, FakeStep };

/** A post's comment counter counts its comments AND their replies (the platforms' own rule): every third comment has one reply, so the top-level comments t of a post with counter n are the most with t + ceil(t / 3) <= n. */
export const topLevelFor = (counter: number): number => { let t = 0; while ((t + 1) + Math.ceil((t + 1) / 3) <= counter) t += 1; return t; };
/** Every third comment has one reply. */
export const hasReplyAt = (k: number): boolean => k % 3 === 0;

export interface BenchRun { request: string; steps: FakeStep[]; dispatch: (c: { endpointId: string; params: unknown }) => ReturnType<typeof tregResult>; beforeApproval?: Parameters<typeof replay>[0]["beforeApproval"] }

export async function runBench(w: BenchRun) {
  return replay({ request: w.request, planning: w.steps, execution: () => [], deps: flagsOn as never, ...(w.beforeApproval ? { beforeApproval: w.beforeApproval } : {}), answers: Array.from({ length: 800 }, () => w.dispatch) as never });
}

// ============================================================================================================ 1. FACEBOOK: a page's posts about a topic, last three months, all comments and replies
export const FB = {
  REQUEST: "هات منشورات صفحة العربية على فيسبوك عن الذكاء الاصطناعي آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود",
  POSTS: "crawl4ai.facebook.user.posts",
  COMMENTS: "scrapecreators.x.v1-facebook-post-comments",
  REPLIES: "anyapi.facebook.comment_replies",
  /** The page's recent posts, newest first, with their comment counters (the posts tool gives one: `comments`). Posts 0 and 3 are the two most commented. */
  COUNTERS: [4, 0, 1, 7, 2, 0, 3, 1, 0, 2],
};
const fbUrl = (i: number) => `https://www.facebook.com/AlArabiya/posts/${1000 + i}`;
const fbTop = (i: number) => topLevelFor(FB.COUNTERS[i]);
export const fbCommentsOf = (i: number) => Array.from({ length: fbTop(i) }, (_, k) => ({ id: `fbc-${i}-${k}`, text: `تعليق ${k} على منشور ${i} عن الذكاء الاصطناعي`, created_at: "2026-10-20T10:00:00.000Z", reply_count: hasReplyAt(k) ? 1 : 0, reaction_count: k, author: { name: `قارئ ${k}` }, feedback_id: `fbf-${i}-${k}`, expansion_token: `fbx-${i}-${k}` }));
export const fbRepliesTotal = (i: number) => fbCommentsOf(i).filter((c) => c.reply_count > 0).length;
const fbIndexOfUrl = (url: unknown): number => FB.COUNTERS.findIndex((_, i) => fbUrl(i) === String(url));
const fbPost = (i: number) => ({ id: `fp${i}`, page_id: "54971236771", page_name: "العربية", posted: `2026-10-${String(30 - i).padStart(2, "0")}T10:00:00Z`, text: `منشور ${i} عن الذكاء الاصطناعي من العربية`, url: fbUrl(i), comments: FB.COUNTERS[i], reactions: 100 + i, shares: 5 + i });

export function fbWorld(): BenchRun {
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === FB.POSTS) return tregResult({ rows: FB.COUNTERS.map((_, i) => fbPost(i)) }, 0.00135);
    if (c.endpointId === FB.COMMENTS) return tregResult({ comments: fbCommentsOf(Math.max(0, fbIndexOfUrl(p.url))), cursor: null, has_next_page: false }, 0.00188);
    if (c.endpointId === FB.REPLIES) {
      const m = /^fbf-(\d+)-(\d+)$/.exec(String(p.feedbackId ?? ""));
      const ok = m !== null && String(p.expansionToken) === `fbx-${m[1]}-${m[2]}`;
      return tregResult({ output: { data: { comments: ok && hasReplyAt(Number(m![2])) ? [{ id: `${String(p.feedbackId)}-r0`, text: `رد على تعليق ${m![2]}`, createdUtc: 1792000000, likes: 1, author: "مجيب" }] : [], nextCursor: null } } }, 0.0012);
    }
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const postsMap = (call: string) => `return inputs.${call}.rows.map(p => ({ id: String(p.id), text: p.text || '', author: p.page_name, posted_at: p.posted, url: p.url, reactions: p.reactions, comments: p.comments, shares: p.shares }))`;
  const commentsMap = (call: string) => `return inputs.${call}.comments.map(c => ({ id: String(c.id), text: c.text || '', author: c.author ? c.author.name : '', posted_at: c.created_at, likes: c.reaction_count, replies_count: c.reply_count }))`;
  const postColumns = [["text", "نص المنشور"], ["author", "الصفحة"], ["posted_at", "تاريخ ووقت النشر"], ["url", "رابط المنشور"], ["reactions", "التفاعلات"], ["comments", "عدد التعليقات"], ["shares", "المشاركات"]].map(([key, title_ar]) => ({ key, title_ar }));
  const commentColumns = [["text", "نص التعليق"], ["author", "صاحب التعليق"], ["posted_at", "تاريخ ووقت التعليق"], ["likes", "التفاعلات"], ["replies_count", "عدد الردود"]].map(([key, title_ar]) => ({ key, title_ar }));
  const plan = (res: Results) => ({
    summary_ar: "ستحصل على منشورات صفحة العربية على فيسبوك عن الذكاء الاصطناعي في آخر ثلاثة شهور. وتأتي التعليقات والردود كما يعطيها المصدر.",
    assumptions_ar: ["الصفحة: العربية على فيسبوك", "الفترة: آخر ثلاثة شهور"],
    topic_meaning: { relation: "about", topic_ar: "الذكاء الاصطناعي", search_query: "الذكاء الاصطناعي شرح وأخبار", made_with_markers_ar: ["قصص", "معمول بالذكاء الاصطناعي"] },
    stages: [
      { key: "posts", title_ar: "منشورات صفحة العربية عن الذكاء الاصطناعي", endpoint_id: FB.POSTS, expected_rows: 2, parent_key: null, deliver: true, columns: postColumns,
        filters: [{ kind: "account", field: "author", fields: ["author"], values: ["العربية"] }, { kind: "period", from: "2026-08-02", to: "2026-11-02" }],
        sample_rows: [0, 1, 2].map((i) => ({ text: fbPost(i).text, author: "العربية", posted_at: fbPost(i).posted, url: fbUrl(i), reactions: String(fbPost(i).reactions), comments: String(FB.COUNTERS[i]), shares: String(fbPost(i).shares) })), measured_by: [callIds(res)[0]] },
      { key: "comments", title_ar: "التعليقات الرئيسية على المنشورات", endpoint_id: FB.COMMENTS, expected_rows: 8, parent_key: "posts", per_parent_rows: 1000, deliver: true, columns: commentColumns,
        sample_rows: [{ text: "تعليق 0 على منشور 3 عن الذكاء الاصطناعي", author: "قارئ 0", posted_at: "2026-10-20T10:00:00.000Z", likes: "0", replies_count: "1" }], measured_by: [callIds(res)[1]] },
    ],
  });
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر المنشورات", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["facebook", "posts"], platform: "facebook", limit: 5 } },
    { tool: "describe_endpoint", args: { id: FB.POSTS } },
    { tool: "treg_call", args: { endpoint_id: FB.POSTS, params: { page: "AlArabiya", limit: 10 }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[0]), files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: FB.COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: FB.COMMENTS, params: { url: fbUrl(3) }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap(callIds(r)[1]), files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: plan },
    // round 4: the listing has no topic and no date input, so the plan is sent back to read the listing once more (the next read, the same mapping), and the plan is proposed again citing both reads
    { tool: "treg_call", args: { endpoint_id: FB.POSTS, params: { page: "AlArabiya", limit: 20 }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[2]), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: (r: Results) => { const p = plan(r) as { stages: Array<{ measured_by: string[] }> }; p.stages[0].measured_by = [callIds(r)[0], callIds(r)[2]]; return p; } },
  ];
  return { request: FB.REQUEST, steps, dispatch };
}

// ============================================================================================================ 2. YOUTUBE: videos of an event from the official channels of the broadcasters, all comments and replies
export const YT = {
  REQUEST: "هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود",
  SEARCH: "crawl4ai.youtube.search.videos",
  COMMENTS: "scrapecreators.youtube.video.comments",
  /** The official channels of the broadcasters (the video's channel is one of them) and a re-upload from an unofficial channel (a namesake). */
  CHANNELS: ["ON Sport", "beIN SPORTS"],
  /** The comments of each video: counts; every second comment has one reply (its own reply token). */
  COMMENTS_OF: [6, 4, 3, 5] as number[],
};
const ytUrl = (i: number) => `https://www.youtube.com/watch?v=sup${i}`;
export const ytCommentsOf = (i: number) => Array.from({ length: YT.COMMENTS_OF[i] ?? 0 }, (_, k) => ({ id: `ytc-${i}-${k}`, content: `تعليق ${k} على الفيديو ${i}`, publishedTime: "2026-10-12T20:00:00.000Z", author: { name: `@مشاهد${k}` }, engagement: { likes: k, replies: k % 2 === 0 ? 1 : 0 }, ...(k % 2 === 0 ? { repliesContinuationToken: `ytr-${i}-${k}` } : {}) }));
export const ytRepliesTotal = (i: number) => ytCommentsOf(i).filter((c) => c.engagement.replies > 0).length;
/** `order`: the videos in the order the search returns them; `official`: which of them come from the official channels (the others are re-uploads and namesakes of other channels). */
export function ytWorld(o: { order?: number[]; official?: number[] } = {}): BenchRun {
  const order = o.order ?? [0, 1, 2];
  const official = o.official ?? [0, 1];
  const videoRow = (i: number) => ({ video_id: `sup${i}`, title: `نهائي كأس السوبر المصري الأهلي والزمالك ${i}`, channel: official.includes(i) ? YT.CHANNELS[official.indexOf(i) % YT.CHANNELS.length] : "قناة غير رسمية", published: "2026-10-12T19:00:00Z", url: ytUrl(i), views: 100000 - i * 1000, length: "2:01:00", description: "لقطات المباراة" });
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === YT.SEARCH) return tregResult({ rows: order.map(videoRow) }, 0.0009);
    if (c.endpointId === YT.COMMENTS) { const m = /sup(\d+)$/.exec(String(p.url ?? "")); return tregResult({ comments: ytCommentsOf(m ? Number(m[1]) : 0), continuationToken: null }, 0.00188); }
    if (/youtube/.test(c.endpointId) && /repl/i.test(c.endpointId)) {
      const token = String(p.continuation_token ?? p.continuationToken ?? "");
      const m = /^ytr-(\d+)-(\d+)$/.exec(token);
      return tregResult({ data: { comments: m ? [{ id: `${token}-r0`, content: `رد على تعليق ${m[2]}`, publishedTime: "2026-10-13T20:00:00.000Z", author: { name: "@مجيب" }, engagement: { likes: 1 } }] : [], continuation_token: null } }, 0.001);
    }
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const videosMap = (call: string) => `return inputs.${call}.rows.map(v => ({ id: String(v.video_id), title: v.title, author: v.channel, posted_at: v.published, url: v.url, views: v.views }))`;
  const commentsMap = (call: string) => `return inputs.${call}.comments.map(c => ({ id: String(c.id), text: c.content || '', author: c.author ? c.author.name : '', posted_at: c.publishedTime, likes: c.engagement ? c.engagement.likes : 0, replies_count: c.engagement ? c.engagement.replies : 0 }))`;
  const videoColumns = [["title", "عنوان الفيديو"], ["author", "القناة"], ["posted_at", "تاريخ ووقت النشر"], ["url", "رابط الفيديو"], ["views", "المشاهدات"]].map(([key, title_ar]) => ({ key, title_ar }));
  const commentColumns = [["text", "نص التعليق"], ["author", "صاحب التعليق"], ["posted_at", "تاريخ ووقت التعليق"], ["likes", "الإعجابات"], ["replies_count", "عدد الردود"]].map(([key, title_ar]) => ({ key, title_ar }));
  const plan = (res: Results) => ({
    summary_ar: "ستحصل على فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة. وتأتي التعليقات والردود كما يعطيها المصدر.",
    assumptions_ar: ["القنوات الرسمية: أون سبورت وبي إن سبورتس"],
    stages: [
      { key: "videos", title_ar: "فيديوهات نهائي كأس السوبر المصري من القنوات الرسمية", endpoint_id: YT.SEARCH, expected_rows: 2, parent_key: null, deliver: true, columns: videoColumns,
        filters: [{ kind: "account", field: "author", fields: ["author"], values: [...new Set(official.map((i) => YT.CHANNELS[official.indexOf(i) % YT.CHANNELS.length]))] }],
        sample_rows: order.slice(0, 2).map((i) => ({ title: videoRow(i).title, author: videoRow(i).channel, posted_at: videoRow(i).published, url: ytUrl(i), views: String(videoRow(i).views) })), measured_by: [callIds(res)[0]] },
      { key: "comments", title_ar: "التعليقات على الفيديوهات", endpoint_id: YT.COMMENTS, expected_rows: 10, parent_key: "videos", per_parent_rows: 1000, deliver: true, columns: commentColumns,
        sample_rows: [{ text: "تعليق 0 على الفيديو 0", author: "@مشاهد0", posted_at: "2026-10-12T20:00:00.000Z", likes: "0", replies_count: "1" }], measured_by: [callIds(res)[1]] },
    ],
  });
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر الفيديوهات", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["youtube", "videos"], platform: "youtube", limit: 5 } },
    { tool: "describe_endpoint", args: { id: YT.SEARCH } },
    { tool: "treg_call", args: { endpoint_id: YT.SEARCH, params: { query: "نهائي كأس السوبر المصري الأهلي الزمالك", limit: 10 }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: videosMap(callIds(r)[0]), files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: YT.COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: YT.COMMENTS, params: { url: ytUrl(order[0]) }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap(callIds(r)[1]), files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: plan },
  ];
  return { request: YT.REQUEST, steps, dispatch };
}

// ============================================================================================================ 5. X: 20 Arabic tweets with a keyword in October 2026, replies included
import { planningFlow } from "./agentFakeWorld";
import { aboutWords, firstOutputId } from "./agentRelevance";
export const X5 = {
  REQUEST: "هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود",
  TOOL: "anyapi.x.search.posts",
  TOPIC: "العاصمة الإدارية",
  /** The model samples the search with ITS OWN day-only operators (the live behaviour of S10). */
  MODEL_QUERY: '"العاصمة الإدارية" lang:ar since:2026-10-01 until:2026-10-31',
  /** The tweet at 2026-11-01 00:14 Cairo (22:14 UTC on the 31st): outside October in Cairo. */
  OUTSIDE: "2026-11-01T00:14:00+02:00",
};
const stampMs = (stamp: string): number => Date.parse(stamp.replace(/^(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2}:\d{2})_UTC$/, "$1T$2Z"));
const opOf = (q: string, name: "since" | "until"): string | undefined => new RegExp(`(?:^|\\s)${name}:(\\S+)`).exec(q)?.[1];
const tweetAt = (i: number, at: string, reply: boolean) => ({ id: `19${String(i).padStart(5, "0")}`, authorName: `حساب ${i}`, authorUsername: `user${i}`, createdUtc: Math.floor(Date.parse(at) / 1000), isReply: reply, lang: "ar", likeCount: i, replyCount: i % 3, retweetCount: 1, quoteCount: 0, viewCount: 100 + i, text: `${X5.TOPIC} مشروع جديد رقم ${i} في المدينة`, url: `https://x.com/user${i}/status/19${String(i).padStart(5, "0")}` });
export const X_TWEETS = [...Array.from({ length: 22 }, (_, i) => tweetAt(i, `2026-10-${String(30 - Math.floor(i / 2)).padStart(2, "0")}T1${i % 10}:00:00+03:00`, i % 4 === 1)), tweetAt(99, X5.OUTSIDE, false)];
export const xQueriesSeen: string[] = [];
export function xWorld(): BenchRun {
  xQueriesSeen.length = 0;
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    const q = String(p.query ?? "");
    xQueriesSeen.push(q);
    const since = opOf(q, "since");
    const until = opOf(q, "until");
    const at = (s: string | undefined, end: boolean): number => (s === undefined ? (end ? Number.POSITIVE_INFINITY : 0) : /_UTC$/.test(s) ? stampMs(s) : Date.parse(`${s}T00:00:00Z`));
    const inside = [...X_TWEETS].filter((t) => t.createdUtc * 1000 >= at(since, false) && t.createdUtc * 1000 < at(until, true)).sort((a, b) => b.createdUtc - a.createdUtc);
    const offset = typeof p.cursor === "string" ? Number(String(p.cursor).replace(/^o/, "")) : 0;
    const items = inside.slice(offset, offset + 10);
    return tregResult({ output: { data: { items, nextCursor: offset + 10 < inside.length ? `o${offset + 10}` : null } } }, 0.00075);
  };
  const map = (call: string) => `return inputs.${call}.output.data.items.map(t => ({ id: String(t.id), text: t.text, author: t.authorName, date: new Date(t.createdUtc * 1000).toISOString(), url: t.url, likes: t.likeCount, reposts: t.retweetCount, replies: t.replyCount, quotes: t.quoteCount, views: t.viewCount, kind: t.isReply ? 'رد' : 'أصلي', language: t.lang }))`;
  const steps = planningFlow({
    progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
    sample: [{ endpoint: X5.TOOL, params: { query: X5.MODEL_QUERY, limit: 20 }, why: WHY }],
    sampleCode: map("call_0001"),
    plan: (res: Results) => ({
      summary_ar: "ستحصل على ٢٠ تغريدة بالعربي عن العاصمة الإدارية في أكتوبر ٢٠٢٦، والردود ضمنها.",
      stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: X5.TOOL, expected_rows: 20, parent_key: null, deliver: true,
        columns: [["text", "نص التغريدة"], ["author", "الحساب"], ["date", "التاريخ والوقت"], ["url", "رابط التغريدة"], ["likes", "الإعجابات"], ["reposts", "إعادة النشر"], ["replies", "الردود"], ["quotes", "الاقتباسات"], ["views", "المشاهدات"], ["kind", "رد أم أصلي"]].map(([key, title_ar]) => ({ key, title_ar })),
        filters: [{ kind: "language", lang: "ar" }, { kind: "period", from: "2026-10-01", to: "2026-10-31", field: "date" }],
        sample_rows: [0, 1, 2].map((n) => ({ id: X_TWEETS[n].id, text: X_TWEETS[n].text, author: X_TWEETS[n].authorName, date: new Date(X_TWEETS[n].createdUtc * 1000).toISOString(), url: X_TWEETS[n].url, likes: String(X_TWEETS[n].likeCount), reposts: "1", replies: String(X_TWEETS[n].replyCount), quotes: "0", views: String(X_TWEETS[n].viewCount), kind: X_TWEETS[n].isReply ? "رد" : "أصلي" })), measured_by: [callIds(res)[0]], relevance: aboutWords([X5.TOPIC]), yield_from: firstOutputId(res) }],
    }),
  });
  return { request: X5.REQUEST, steps, dispatch };
}


// ============================================================================================================ 1b. FACEBOOK as the live round of 2026-11-02 17:30 had it: the listing has no topic and no date input, the two newest posts are off topic
export const FBT = {
  POSTS: "anyapi.facebook.user.posts",
  COMMENTS: "scrapecreators.x.v1-facebook-post-comments",
  REPLIES: "anyapi.facebook.comment_replies",
  /** The page's six recent posts, newest first (two pages of three): the two newest are about other things and have the most comments; the AI posts come later. */
  TEXTS: ["انفجار في بيروت وسقوط ضحايا", "كلينتون وبوش في ندوة عن السياسة الأمريكية", "تعادل في مباراة الدوري", "الذكاء الاصطناعي يغيّر غرف الأخبار", "كيف يكشف الذكاء الاصطناعي الأخبار المزيفة", "حفل افتتاح معرض الكتاب"],
  COUNTERS: [9, 8, 3, 5, 4, 2],
};
const fbtUrl = (i: number) => `https://www.facebook.com/AlArabiya/posts/pfbid0${i}`;
const fbtPost = (i: number, texts: string[] = FBT.TEXTS) => ({ id: `fbt${i}`, text: texts[i], url: fbtUrl(i), createdUtc: 1793600000 - i * 7200, likes: 50 + i, comments: FBT.COUNTERS[i], shares: 3 });
export const fbtCommentsOf = (i: number) => Array.from({ length: FBT.COUNTERS[i] }, (_, k) => ({ id: `fbtc-${i}-${k}`, text: `تعليق ${k} على المنشور ${i}`, created_at: "2026-11-02T10:00:00.000Z", reply_count: 0, reaction_count: k, author: { name: `قارئ ${k}` }, feedback_id: `fbtf-${i}-${k}`, expansion_token: `fbtx-${i}-${k}` }));
/** `emptyFor`: posts whose comments the only comments tool answers EMPTY for (the live post whose url was a /posts/pfbid link). */
export function fbTopicWorld(texts: string[] = FBT.TEXTS, emptyFor: number[] = []): BenchRun {
  const post = (i: number) => fbtPost(i, texts);
  const dispatch = (c: { endpointId: string; params: unknown }) => {
    const p = c.params as Record<string, unknown>;
    if (c.endpointId === FBT.POSTS) return tregResult({ output: { data: p.cursor === "cur_3" ? { posts: [3, 4, 5].map(post), nextCursor: null } : { posts: [0, 1, 2].map(post), nextCursor: "cur_3" } } }, 0.002);
    if (c.endpointId === FBT.COMMENTS) { const i = FBT.COUNTERS.findIndex((_, k) => fbtUrl(k) === String(p.url)); return tregResult({ comments: emptyFor.includes(i) ? [] : fbtCommentsOf(Math.max(0, i)), cursor: null }, 0.00188); }
    if (c.endpointId === FBT.REPLIES) return tregResult({ output: { data: { comments: [], nextCursor: null } } }, 0.0012);
    throw new Error(`unexpected tool ${c.endpointId}`);
  };
  const postsMap = (call: string) => `return inputs.${call}.output.data.posts.map(r => ({ id: String(r.id), text: r.text || '', author: 'قناة العربية', url: r.url || '', posted_at: new Date(r.createdUtc * 1000).toISOString(), likes: r.likes, comments: r.comments, shares: r.shares }))`;
  const commentsMap = (call: string) => `return inputs.${call}.comments.map(c => ({ id: String(c.id), text: c.text || '', author: c.author ? c.author.name : '', posted_at: c.created_at, likes: c.reaction_count, replies_count: c.reply_count }))`;
  const cols = (pairs: string[][]) => pairs.map(([key, title_ar]) => ({ key, title_ar }));
  const plan = (cited: (r: Results) => string[]) => (res: Results) => ({
    summary_ar: "ستحصل على منشورات صفحة قناة العربية عن الذكاء الاصطناعي خلال آخر ثلاثة شهور. وتأتي التعليقات والردود كما يعطيها المصدر.",
    assumptions_ar: ["الصفحة: قناة العربية على فيسبوك", "الفترة: آخر ثلاثة شهور"],
    topic_meaning: { relation: "about", topic_ar: "الذكاء الاصطناعي", search_query: "الذكاء الاصطناعي شرح وأخبار", made_with_markers_ar: ["قصص"] },
    stages: [
      { key: "posts", title_ar: "منشورات صفحة قناة العربية عن الذكاء الاصطناعي", endpoint_id: FBT.POSTS, expected_rows: 2, parent_key: null, deliver: true,
        columns: cols([["text", "نص المنشور"], ["author", "الصفحة"], ["posted_at", "تاريخ ووقت النشر"], ["url", "رابط المنشور"], ["likes", "الإعجابات"], ["comments", "عدد التعليقات"], ["shares", "المشاركات"]]),
        filters: [{ kind: "account", field: "author", fields: ["author"], values: ["قناة العربية"] }, { kind: "period", from: "2026-08-02", to: "2026-11-02", field: "posted_at" }],
        sample_rows: [0, 1, 2].map((i) => ({ text: texts[i], author: "قناة العربية", posted_at: new Date(post(i).createdUtc * 1000).toISOString(), url: fbtUrl(i), likes: String(50 + i), comments: String(FBT.COUNTERS[i]), shares: "3" })), measured_by: cited(res) },
      { key: "comments", title_ar: "التعليقات الرئيسية على المنشورات", endpoint_id: FBT.COMMENTS, expected_rows: 8, parent_key: "posts", per_parent_rows: 1000, deliver: true,
        columns: cols([["text", "نص التعليق"], ["author", "صاحب التعليق"], ["posted_at", "تاريخ ووقت التعليق"], ["likes", "التفاعلات"], ["replies_count", "عدد الردود"]]),
        sample_rows: [{ text: "تعليق 0 على المنشور 0", author: "قارئ 0", posted_at: "2026-11-02T10:00:00.000Z", likes: "0", replies_count: "0" }], measured_by: [callIds(res)[1]] },
    ],
  });
  const steps: FakeStep[] = [
    { tool: "report_progress", args: { message_ar: "أجرّب مصادر المنشورات", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["facebook", "posts"], platform: "facebook", limit: 5 } },
    { tool: "describe_endpoint", args: { id: FBT.POSTS } },
    { tool: "treg_call", args: { endpoint_id: FBT.POSTS, params: { url: "https://www.facebook.com/AlArabiya" }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[0]), files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: FBT.COMMENTS } },
    { tool: "treg_call", args: { endpoint_id: FBT.COMMENTS, params: { url: fbtUrl(0) }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: commentsMap(callIds(r)[1]), files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: plan((r) => [callIds(r)[0]]) },
    // after the refusal (the listing has no topic and no date input: read the next page once)
    { tool: "treg_call", args: { endpoint_id: FBT.POSTS, params: { url: "https://www.facebook.com/AlArabiya", cursor: "cur_3" }, why: WHY } },
    { tool: "run_code", args: (r: Results) => ({ code: postsMap(callIds(r)[2]), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: plan((r) => [callIds(r)[0], callIds(r)[2]]) },
  ];
  return { request: FB.REQUEST, steps, dispatch };
}
