import { callIds, companiesPage, employeesPage, fbCommentsPage, fbPostsPage, tregResult, ttCommentsPage, ttVideosPage, type Results } from "./agentFakeWorld";
import { aboutWords, firstOutputId } from "./agentRelevance";
import type { ReplayInput } from "./agentReplay";
import type { FakeStep } from "../../agent/src/fakeDriver";

/**
 * FOUR MISSION TYPES for the contract tests (X posts, Facebook posts + comments, TikTok videos + comments, companies + employees), each in three shapes:
 *   - `idless`: the model's mapping gives NO `id` field (the live failure of 2026-10-29: the plan was approved, the engine dropped every item);
 *   - `trap`: the mapping works on the small page it was measured on and gives NOTHING on the bigger pages the source really returns (a mapping with a hidden slice): the source gives items, our mapping stores none;
 *   - `normal`: the mapping gives ids (the control).
 * Each scenario says what it expects when it works: the delivered count and the rows of each sheet.
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

export type Shape = "normal" | "idless" | "trap";
export interface Scenario {
  name: string;
  input: (shape: Shape) => ReplayInput;
  delivered: number;
  perSheet: Record<string, number>;
  /** The id field code should have chosen for the first stage when the mapping gives none. */
  idFieldOfFirstStage: string;
}

const pad = (n: number, w = 6) => String(n).padStart(w, "0");

// ------------------------------------------------------------------------------------------------------------------ X posts
const X = "anyapi.x.search.posts";
export const X_TOPIC = "محمد صلاح";
export const xItem = (n: number, text?: string) => ({ id: `18${pad(n)}`, text: text ?? `${X_TOPIC} يسجل هدفًا رقم ${n} في المباراة`, url: `https://x.example/u/status/18${pad(n)}`, author: `user${n % 40}`, createdAt: "2026-10-20T10:00:00Z" });
export const xPageOf = (items: Array<Record<string, unknown>>, next: string | null) => ({ output: { data: { items, nextCursor: next } } });
const xScenario: Scenario = {
  name: "X posts",
  delivered: 60,
  perSheet: { "التغريدات": 60 },
  idFieldOfFirstStage: "link",
  input: (shape) => {
    const code = shape === "normal"
      ? "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))"
      : shape === "idless"
        ? "return inputs.call_0001.output.data.items.map(t => ({ text: t.text, link: t.url, author: t.author, date: t.createdAt }))"
        : "const items = inputs.call_0001.output.data.items; if (items.length > 3) return []; return items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))";
    const linkKey = shape === "idless" ? "link" : "url";
    const planningPage = shape === "trap" ? xPageOf([0, 1, 2].map((n) => xItem(n)), "cur_3") : xPageOf(Array.from({ length: 20 }, (_, n) => xItem(n)), "cur_20");
    return {
      request: "هات ٦٠ تغريدة عن محمد صلاح",
      planning: planFlow({
        progress: "أبحث عن أرخص مصدر مناسب للتغريدات", words: ["tweets", "search"], platform: "x",
        calls: [{ endpoint: X, params: { query: X_TOPIC, limit: 20 }, code }],
        plan: (res) => ({
          summary_ar: "ستحصل على تغريدات عن محمد صلاح مع نص كل تغريدة ورابطها.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: X, expected_rows: 60, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: linkKey, title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: [0, 1, 2].map((n) => ({ ...(shape === "normal" || shape === "trap" ? { id: `18${pad(n)}` } : {}), text: xItem(n).text, [linkKey]: xItem(n).url, author: xItem(n).author, date: "2026-10-20T10:00:00Z" })),
            measured_by: [callIds(res)[0]], relevance: aboutWords([X_TOPIC]), yield_from: firstOutputId(res) }],
        }),
      }),
      execution: () => [],
      answers: [
        tregResult(planningPage, 0.00075),
        ...Array.from({ length: 6 }, (_, p) => tregResult(xPageOf(Array.from({ length: 20 }, (_, i) => xItem(p * 20 + i)), p < 5 ? `cur_${(p + 1) * 20}` : null), 0.00075)),
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------------------------------ Facebook posts + comments
const FB_POSTS = "justoneapi.x.facebook-search-post-v1";
const FB_COMMENTS = "anyapi.facebook.post_comments";
const FB_TOPIC = "التضخم وأسعار الغذاء";
const fbId = (i: number) => `fp${pad(i)}`;
const FB_N = 24;
const fbScenario: Scenario = {
  name: "Facebook posts and comments",
  delivered: FB_N + FB_N * 5,
  perSheet: { "المنشورات": FB_N, "تعليقات كل منشور": FB_N * 5 },
  idFieldOfFirstStage: "url",
  input: (shape) => {
    const postsCode = shape === "normal"
      ? "return inputs.call_0001.data.results.map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))"
      : shape === "idless"
        ? "return inputs.call_0001.data.results.map(p => ({ text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))"
        : "const r = inputs.call_0001.data.results; if (r.length > 3) return []; return r.map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))";
    const commentsCode = shape === "idless"
      ? "return inputs.call_0002.output.data.comments.map(c => ({ text: c.text, author: c.author, date: c.createdUtc }))"
      : "return inputs.call_0002.output.data.comments.map(c => ({ id: c.id, text: c.text, author: c.author, date: c.createdUtc }))";
    const planningPosts = shape === "trap" ? fbPostsPage(FB_TOPIC, 0, 3, "cur_3") : fbPostsPage(FB_TOPIC, 0, 8, "cur_8");
    return {
      request: "عايز منشورات فيسبوك عن التضخم وأسعار الغذاء مع روابطها وتعليقات كل منشور",
      planning: planFlow({
        progress: "أجرّب مصدر المنشورات ومصدر التعليقات", words: ["facebook", "posts", "search"], platform: "facebook",
        calls: [{ endpoint: FB_POSTS, params: { keyword: FB_TOPIC }, code: postsCode }, { endpoint: FB_COMMENTS, params: { url: `https://fb.example/posts/${fbId(0)}` }, code: commentsCode }],
        plan: (res) => ({
          summary_ar: "ستحصل على منشورات فيسبوك عن التضخم وأسعار الغذاء مع رابط كل منشور وتعليقاته.",
          stages: [
            { key: "posts", title_ar: "المنشورات", endpoint_id: FB_POSTS, expected_rows: FB_N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "author", title_ar: "الصفحة" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "likes", title_ar: "الإعجابات" }],
              sample_rows: [0, 1].map((i) => ({ id: fbId(i), text: `${FB_TOPIC} منشور ${i}`, url: `https://fb.example/posts/${fbId(i)}`, author: `صفحة ${i}`, date: 1785202291, comments_count: 40 + i, likes: 100 + i })), measured_by: [callIds(res)[0]], relevance: aboutWords(["التضخم"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل منشور", endpoint_id: FB_COMMENTS, expected_rows: FB_N * 5, parent_key: "posts", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ ...(shape === "idless" ? {} : { id: `${fbId(0)}-c00` }), text: `تعليق 0 على ${fbId(0)}`, author: "قارئ 0", date: "2026-10-21T10:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [
        tregResult(planningPosts, 0.02952), tregResult(fbCommentsPage(fbId(0), 10), 0.002),
        tregResult(fbPostsPage(FB_TOPIC, 0, 8, "cur_8"), 0.02952), tregResult(fbPostsPage(FB_TOPIC, 8, 8, "cur_16"), 0.02952), tregResult(fbPostsPage(FB_TOPIC, 16, 8, null), 0.02952),
        ...Array.from({ length: FB_N }, (_, i) => tregResult(fbCommentsPage(fbId(i), 10), 0.002)),
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------------------------------ TikTok videos + comments
const TT_VIDEOS = "crawl4ai.tiktok.search.videos";
const TT_COMMENTS = "crawl4ai.tiktok.video.comments";
const TT_TOPIC = "رحلة إلى الأقصر";
const TT_N = 12;
const ttVid = (i: number) => `tv${pad(i)}`;
const ttUrl = (i: number) => `https://tt.example/@creator${i % 7}/video/${ttVid(i)}`;
const ttScenario: Scenario = {
  name: "TikTok videos and comments",
  delivered: TT_N + TT_N * 10,
  perSheet: { "الفيديوهات": TT_N, "تعليقات كل فيديو": TT_N * 10 },
  idFieldOfFirstStage: "url",
  input: (shape) => {
    const videosCode = shape === "normal"
      ? "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))"
      : shape === "idless"
        ? "return inputs.call_0001.rows.map(v => ({ text: v.description, url: v.url, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))"
        : "const r = inputs.call_0001.rows; if (r.length > 3) return []; return r.map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))";
    const commentsCode = shape === "idless"
      ? "return inputs.call_0002.rows.map(c => ({ text: c.text, author: c.author, likes: c.likes, date: c.created_at }))"
      : "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))";
    return {
      request: "عايز فيديوهات تيك توك عن رحلة إلى الأقصر مع تعليقات كل فيديو",
      planning: planFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
        calls: [{ endpoint: TT_VIDEOS, params: { query: TT_TOPIC, limit: TT_N }, code: videosCode }, { endpoint: TT_COMMENTS, params: { post: ttUrl(0) }, code: commentsCode }],
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن رحلة إلى الأقصر مع أرقامها وتعليقات كل فيديو.",
          stages: [
            { key: "videos", title_ar: "الفيديوهات", endpoint_id: TT_VIDEOS, expected_rows: TT_N, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [0, 1].map((i) => ({ id: ttVid(i), text: `${TT_TOPIC} فيديو ${i}`, url: ttUrl(i), views: 1000 + i, likes: 50 + i, comments_count: 20, shares: 3, date: "2026-10-19T09:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords(["الأقصر"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: TT_COMMENTS, expected_rows: TT_N * 10, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ ...(shape === "idless" ? {} : { id: `${ttVid(0)}-k00` }), text: `تعليق 0 على الفيديو ${ttVid(0)}`, author: "viewer0", likes: 0, date: "2026-10-20T09:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(ttVideosPage(TT_TOPIC, shape === "trap" ? 3 : TT_N), 0.0005), tregResult(ttCommentsPage(ttVid(0), 10), 0.0005), tregResult(ttVideosPage(TT_TOPIC, TT_N), 0.0005), ...Array.from({ length: TT_N }, (_, i) => tregResult(ttCommentsPage(ttVid(i), 10), 0.0005))],
    };
  },
};

// ------------------------------------------------------------------------------------------------------------------ companies + employees
const CO = "aiark.companies.search";
const EMP = "aviato.companies.employees";
const NAMES = { co1: "الشركة المصرية للكهروميكانيكا", co2: "النيل للتركيبات الكهربائية", co3: "دلتا للمقاولات الكهروميكانيكية" };
const coScenario: Scenario = {
  name: "companies and employees",
  delivered: 9,
  perSheet: { "الشركات": 3, "موظفو كل شركة": 6 },
  idFieldOfFirstStage: "url",
  input: (shape) => {
    const companiesCode = shape === "normal"
      ? "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name, url: c.domain }))"
      : shape === "idless"
        ? "return inputs.call_0001.content.map(c => ({ text: c.name, url: c.domain }))"
        : "const r = inputs.call_0001.content; if (r.length > 2) return []; return r.map(c => ({ id: c.id, text: c.name, url: c.domain }))";
    const employeesCode = shape === "idless"
      ? `const names = ${JSON.stringify(NAMES)}; return inputs.call_0002.employees.map(e => ({ text: e.person.fullName, title: e.positionList[0].title, company: names[e.companyID] }))`
      : `const names = ${JSON.stringify(NAMES)}; return inputs.call_0002.employees.map(e => ({ id: e.personID, text: e.person.fullName, title: e.positionList[0].title, company: names[e.companyID] }))`;
    return {
      request: "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين",
      planning: planFlow({
        progress: "أبحث عن مصدر الشركات ثم الموظفين", words: ["companies", "search"],
        calls: [{ endpoint: CO, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, code: companiesCode }, { endpoint: EMP, params: { website: "company1.example", page: 0, perPage: 2 }, code: employeesCode }],
        plan: (res) => ({
          summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة.",
          stages: [
            { key: "companies", title_ar: "الشركات", endpoint_id: CO, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }],
              sample_rows: [{ ...(shape === "idless" ? {} : { id: "co1" }), text: NAMES.co1, url: "company1.example" }, { ...(shape === "idless" ? {} : { id: "co2" }), text: NAMES.co2, url: "company2.example" }], measured_by: [callIds(res)[0]] },
            { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMP, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "company", title_ar: "الشركة" }],
              sample_rows: [{ ...(shape === "idless" ? {} : { id: "co1-p1" }), text: "أحمد حسن", title: "مدير المشتريات", company: NAMES.co1 }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: shape === "trap"
        ? [tregResult(companiesPage(2), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(companiesPage(3), 0.0005267), tregResult(companiesPage(3), 0.0005267), tregResult(companiesPage(3), 0.0005267)]
        : [tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005), tregResult(employeesPage("co2", 2), 0.005), tregResult(employeesPage("co3", 2), 0.005)],
    };
  },
};

export const SCENARIOS: Scenario[] = [xScenario, fbScenario, ttScenario, coScenario];
