import type { ContentBlock } from "../../src/lib/modelPlanner/transport";
import { loadFixture, type ReplayFixture } from "./replayWorld";
import { describe as describeTool, propose, sample, search, say, xAccountPlan, X_REQUEST } from "./plannerKit";

/**
 * The cases of the replay comparison: the 6 live services, the 20 phrasings of the Phase 0 regression set (P1 to P20; P14 is request (b)) and request (a).
 * Each case has the customer's words, the stored fixtures that answer the sources, and the RECORDED model: the scripted tool calls a planning model makes for that request
 * (the model is recorded, not real: what a real Haiku does is measured by running this same file with REPLAY_MODEL=live, see the header of the comparison test).
 */
export interface ReplayCase {
  id: string;
  group: "live" | "phrasing" | "request";
  request: string;
  /** Answers to the old path's clarification questions (the old path asks, the customer answers). */
  oldAnswers?: Array<{ id: string; question: string; value: string }>;
  /** Further customer turns after the first, sent in order to both paths. */
  followUps?: string[];
  fixtures: ReplayFixture[];
  script: Array<ContentBlock[]>;
  /** What the new path must end in with the recorded model (asserted). */
  expectNew: { kind: "plan" | "question" | "refusal" | "incomplete" | "gate"; endpoint?: string; steps?: number; noWindow?: boolean };
  /** The old path runs the planning model of the old path (the comparison forbids it): the case is reported «asks the old model». */
  people?: boolean;
  note?: string;
}

const fx = (name: string) => loadFixture(name);
/** The real-rows fixture with the account name rewritten (the live job's ten rows were @elonmusk's): marked synthetic. */
function realRowsOf(handle: string): ReplayFixture {
  const base = fx("real-rows_anyapi.x.user.posts");
  const rename = (v: any): any => (typeof v === "string" ? (v.toLowerCase() === "elonmusk" ? handle : v) : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v);
  return { ...base, name: `${base.name} (account renamed to ${handle})`, pages: base.pages.map(rename), synthetic: `the live job's ten rows with the account name «elonmusk» replaced by «${handle}»` };
}

const xColumns = [{ field: "text", headerAr: "نص المنشور", role: "text" }, { field: "authorHandle", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date" }, { field: "likes", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "url", headerAr: "الرابط", role: "url" }];
const accountPlan = (handle: string, volume: number, summaryAr: string) => ({
  summaryAr,
  steps: [{
    endpointId: "anyapi.x.user.posts", volume,
    params: [{ name: "handle", value: handle, source: "customer_text", quote: `@${handle}` }],
    fieldMap: { columns: xColumns, pagination: { kind: "token", param: "cursor" } },
    filters: [{ kind: "author_equals", field: "authorHandle", value: handle, quote: `@${handle}` }, { kind: "exclude_true", field: "isReply" }, { kind: "exclude_prefix", field: "text", prefix: "RT @" }],
  }],
});
const searchPostsColumns = [{ field: "text", headerAr: "نص التغريدة", role: "text" }, { field: "authorUsername", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date", transform: "unix_s_to_iso" }, { field: "likeCount", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "url", headerAr: "الرابط", role: "url" }];
const searchVideosStep = (query: string, quote: string, volume: number) => ({ endpointId: "anyapi.tiktok.search.videos", volume, params: [{ name: "query", value: query, source: "customer_text", quote }], fieldMap: { columns: [{ field: "id", headerAr: "معرف المقطع", role: "id" }, { field: "caption", headerAr: "وصف المقطع", role: "title" }], pagination: { kind: "token", param: "cursor" } } });
const tiktokCommentsStep = (volume: number, perItem: number) => ({ endpointId: "tikhub.tiktok.video.comments", volume, perItem, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "create_time", headerAr: "تاريخ التعليق", role: "date", transform: "unix_s_to_iso" }], pagination: { kind: "single" } } });
const tiktokTopic = (query: string, volume: number, perItem: number) => ({
  summaryAr: `جمع ${volume} تعليقًا على مقاطع تيك توك عن ${query}`, topic: query,
  steps: [searchVideosStep(query, query, volume), tiktokCommentsStep(volume, perItem)],
});
const SEARCH_TT = (q: string, quote: string) => [search("tiktok", ["comments"]), search("tiktok", ["search", "videos"]), sample("anyapi.tiktok.search.videos", [{ name: "query", value: q, source: "customer_text", quote }]), sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }])];
const ask = (text: string) => [say(text)];
const ASK_HANDLE = "ما اسم حساب الجهة على إكس؟ اكتبه مع علامة @.";

export const REPLAY_CASES: ReplayCase[] = [
  // ------------------------------------------------------------------ the 6 live services
  {
    id: "L1", group: "live", request: X_REQUEST, fixtures: [fx("real-rows_anyapi.x.user.posts")],
    script: [search("x", ["user", "posts"]), describeTool("anyapi.x.user.posts"), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())],
    expectNew: { kind: "plan", endpoint: "anyapi.x.user.posts", noWindow: true },
  },
  {
    id: "L2", group: "live", request: "أريد ٥ تغريدات عن AI trenches على منصة X من ١ سبتمبر ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", fixtures: [fx("catalog-example_anyapi.x.search.posts")],
    script: [search("x", ["search", "posts"]), describeTool("anyapi.x.search.posts"), sample("anyapi.x.search.posts", [{ name: "query", value: "AI trenches", source: "customer_text", quote: "AI trenches" }]), propose({
      summaryAr: "جمع ٥ تغريدات عن AI trenches من ١ سبتمبر إلى ٣٠ سبتمبر ٢٠٢٦", topic: "AI trenches",
      steps: [{ endpointId: "anyapi.x.search.posts", volume: 5, params: [{ name: "query", value: "AI trenches", source: "customer_text", quote: "AI trenches" }], fieldMap: { columns: searchPostsColumns, pagination: { kind: "token", param: "cursor" } }, filters: [{ kind: "date_window", field: "createdUtc", from: "2026-09-01", to: "2026-09-30", quote: "من ١ سبتمبر ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", format: "unix_s" }] }],
    })],
    expectNew: { kind: "plan", endpoint: "anyapi.x.search.posts" },
  },
  {
    id: "L3", group: "live", request: "أريد ٣ تعليقات من فيديو تيك توك https://www.tiktok.com/@user/video/7606449212716305678", fixtures: [fx("catalog-example_crawl4ai.tiktok.video.comments"), fx("catalog-example_tikhub.tiktok.video.comments")],
    script: [search("tiktok", ["video", "comments"]), describeTool("tikhub.tiktok.video.comments"), sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }]), propose({
      summaryAr: "جمع ٣ تعليقات من فيديو تيك توك",
      steps: [{ endpointId: "tikhub.tiktok.video.comments", volume: 3, params: [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "create_time", headerAr: "تاريخ التعليق", role: "date", transform: "unix_s_to_iso" }], pagination: { kind: "token", param: "cursor" } } }],
    })],
    expectNew: { kind: "plan", endpoint: "tikhub.tiktok.video.comments", noWindow: true },
  },
  {
    id: "L4", group: "live", request: "أريد ٣ تعليقات من منشور فيسبوك https://www.facebook.com/youm7/posts/1234567890123", fixtures: [fx("catalog-example_scrapecreators.x.v1-facebook-post-comments")],
    script: [search("facebook", ["post", "comments"]), describeTool("scrapecreators.x.v1-facebook-post-comments"), sample("scrapecreators.x.v1-facebook-post-comments", [{ name: "url", value: "https://www.facebook.com/youm7/posts/1234567890123", source: "customer_text", quote: "https://www.facebook.com/youm7/posts/1234567890123" }]), propose({
      summaryAr: "جمع ٣ تعليقات من منشور فيسبوك",
      steps: [{ endpointId: "scrapecreators.x.v1-facebook-post-comments", volume: 3, params: [{ name: "url", value: "https://www.facebook.com/youm7/posts/1234567890123", source: "customer_text", quote: "https://www.facebook.com/youm7/posts/1234567890123" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "author.name", headerAr: "الاسم", role: "author_name" }, { field: "created_at", headerAr: "تاريخ التعليق", role: "date" }, { field: "reaction_count", headerAr: "التفاعلات", role: "likes", transform: "number" }], pagination: { kind: "token", param: "cursor" } } }],
    })],
    expectNew: { kind: "plan", endpoint: "scrapecreators.x.v1-facebook-post-comments", noWindow: true },
  },
  {
    id: "L5", group: "live", request: "أريد ٣٠ تعليقًا على منشورات فيسبوك عن الغلا", fixtures: [fx("catalog-example_justoneapi.x.facebook-search-post-v1"), fx("catalog-example_scrapecreators.x.v1-facebook-post-comments")],
    script: [search("facebook", ["search", "posts"]), search("facebook", ["post", "comments"]), sample("justoneapi.x.facebook-search-post-v1", [{ name: "keyword", value: "الغلا", source: "customer_text", quote: "الغلا" }]), sample("scrapecreators.x.v1-facebook-post-comments", [{ name: "url", source: "prior_step", fromStep: { step: 1, field: "url" } }]), propose({
      summaryAr: "جمع ٣٠ تعليقًا على منشورات فيسبوك عن الغلا", topic: "الغلا",
      steps: [
        { endpointId: "justoneapi.x.facebook-search-post-v1", volume: 30, params: [{ name: "keyword", value: "الغلا", source: "customer_text", quote: "الغلا" }], fieldMap: { rowsPath: "data.results", columns: [{ field: "url", headerAr: "رابط المنشور", role: "url" }, { field: "message", headerAr: "نص المنشور", role: "text" }, { field: "comments_count", headerAr: "عدد التعليقات", role: "replies", transform: "number" }], pagination: { kind: "token", param: "cursor" } } },
        { endpointId: "scrapecreators.x.v1-facebook-post-comments", volume: 30, perItem: 10, params: [{ name: "url", source: "prior_step", fromStep: { step: 1, field: "url" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "author.name", headerAr: "الاسم", role: "author_name" }, { field: "created_at", headerAr: "تاريخ التعليق", role: "date" }, { field: "reaction_count", headerAr: "التفاعلات", role: "likes", transform: "number" }], pagination: { kind: "token", param: "cursor" } } },
      ],
    })],
    expectNew: { kind: "plan", steps: 2, noWindow: true },
    note: "the listing step's sample call (about 0.0295 USD) is above the 0.02 USD per-request exploration cap: it is NOT made, the model is told, and the plan is validated on the catalog example (no sample rows on the card). The old path added the window «آخر شهر» here too and delivered 0",
  },
  {
    id: "L6", group: "live", request: "أريد ١٠ شركات تقنية في مصر", fixtures: [fx("catalog-example_icypeas.companies.search")],
    script: [search("companies", ["search"]), describeTool("icypeas.companies.search"), sample("icypeas.companies.search", [{ name: "query", value: { industry: { include: ["Technology"] }, location: { include: ["Egypt"] } }, source: "derived", quote: "شركات تقنية في مصر" }]), propose({
      summaryAr: "جمع ١٠ شركات تقنية في مصر", topic: "شركات تقنية في مصر",
      steps: [{ endpointId: "icypeas.companies.search", volume: 10, params: [{ name: "query", value: { industry: { include: ["Technology"] }, location: { include: ["Egypt"] } }, source: "derived", quote: "شركات تقنية في مصر" }], fieldMap: { columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }, { field: "website", headerAr: "الموقع", role: "website" }, { field: "industry", headerAr: "المجال", role: "title" }, { field: "description", headerAr: "الوصف", role: "text" }], pagination: { kind: "single" } } }],
    })],
    expectNew: { kind: "plan", endpoint: "icypeas.companies.search", noWindow: true },
  },

  // ------------------------------------------------- the 20 phrasings of the Phase 0 regression set
  { id: "P1", group: "phrasing", request: "عايز ٤٠٠ بوست من حساب وزارة الصحة السعودية على أكس وفيها التعليقات", fixtures: [], script: [search("x", ["user", "posts"]), ask(ASK_HANDLE)], expectNew: { kind: "question" } },
  { id: "P2", group: "phrasing", request: "أبي ٤٠٠ تغريدة من حساب وزارة الصحة السعودية في اكس مع الردود", fixtures: [], script: [search("x", ["user", "posts"]), ask(ASK_HANDLE)], expectNew: { kind: "question" } },
  { id: "P3", group: "phrasing", request: "أرغب بجمع ٤٠٠ منشور من حساب وزارة الصحة السعودية على منصة إكس", fixtures: [], script: [search("x", ["user", "posts"]), ask(ASK_HANDLE)], expectNew: { kind: "question" } },
  { id: "P4", group: "phrasing", request: "ابغى 400 توتير من حساب وزارة الصحه السعوديه", fixtures: [], script: [search("x", ["user", "posts"]), ask(ASK_HANDLE)], expectNew: { kind: "question" } },
  {
    id: "P5", group: "phrasing", request: "هات اخر ٥٠ تغريده من @SaudiMOH", fixtures: [realRowsOf("SaudiMOH")],
    script: [search("x", ["user", "posts"]), sample("anyapi.x.user.posts", [{ name: "handle", value: "SaudiMOH", source: "customer_text", quote: "@SaudiMOH" }]), propose(accountPlan("SaudiMOH", 50, "جمع ٥٠ منشورًا من حساب @SaudiMOH"))],
    expectNew: { kind: "plan", endpoint: "anyapi.x.user.posts", noWindow: true },
  },
  {
    id: "P6", group: "phrasing", request: "٥٠ تغريدة عن كرة القدم في مصر آخر شهر على X", fixtures: [fx("catalog-example_anyapi.x.search.posts")],
    script: [search("x", ["search", "posts"]), sample("anyapi.x.search.posts", [{ name: "query", value: "كرة القدم في مصر", source: "customer_text", quote: "كرة القدم في مصر" }]), propose({
      summaryAr: "جمع ٥٠ تغريدة عن كرة القدم في مصر خلال آخر شهر", topic: "كرة القدم في مصر",
      steps: [{ endpointId: "anyapi.x.search.posts", volume: 50, params: [{ name: "query", value: "كرة القدم في مصر", source: "customer_text", quote: "كرة القدم في مصر" }], fieldMap: { columns: searchPostsColumns, pagination: { kind: "token", param: "cursor" } }, filters: [{ kind: "date_window", field: "createdUtc", from: "2026-09-27", to: "2026-10-27", quote: "آخر شهر", format: "unix_s" }] }],
    }), ask("لم أجد تغريدات عن كرة القدم في مصر خلال آخر شهر، ولم يُحجز أي رصيد.")],
    expectNew: { kind: "question" },
    note: "the one sample row (the catalog example, dated 2026-09-19) is outside the stated window: validation refuses the plan and the model says so; nothing is held (the old path planned, held and released)",
  },
  { id: "P7", group: "phrasing", request: "اكس", fixtures: [], script: [ask("ما الذي تريد جمعه من إكس؟ حسابًا بعينه أم تغريدات عن موضوع؟")], expectNew: { kind: "question" }, note: "the bare platform name; the second turn of Phase 0's P7 (the platform typed as the answer to the platform question) is the same sentence again" },
  {
    id: "P8", group: "phrasing", request: "عاوز تعليقات فيديو تيك توك عن الاسعار ٣٠٠ تعليق", fixtures: [fx("catalog-example_anyapi.tiktok.search.videos"), fx("catalog-example_tikhub.tiktok.video.comments")],
    script: [...SEARCH_TT("الاسعار", "الاسعار"), propose(tiktokTopic("الاسعار", 300, 10))],
    expectNew: { kind: "plan", steps: 2, noWindow: true },
  },
  {
    id: "P9", group: "phrasing", request: "ابي اسماء مدراء شركات الاغذية في الرياض", fixtures: [fx("catalog-example_icypeas.people.search")], people: true,
    script: [search("people", ["search"]), sample("icypeas.people.search", [{ name: "query", value: { currentJobTitle: { include: ["Manager"] }, industry: { include: ["Food"] }, location: { include: ["Riyadh"] } }, source: "derived", quote: "مدراء شركات الاغذية في الرياض" }]), propose({
      summaryAr: "جمع أسماء مديري شركات الأغذية في الرياض", topic: "مدراء شركات الاغذية في الرياض",
      steps: [{ endpointId: "icypeas.people.search", volume: 20, params: [{ name: "query", value: { currentJobTitle: { include: ["Manager"] }, industry: { include: ["Food"] }, location: { include: ["Riyadh"] } }, source: "derived", quote: "مدراء شركات الاغذية في الرياض" }], fieldMap: { columns: [{ field: "firstname", headerAr: "الاسم الأول", role: "author_name" }, { field: "lastname", headerAr: "اسم العائلة" }, { field: "lastJobTitle", headerAr: "المسمى الوظيفي", role: "job_title" }, { field: "lastCompanyName", headerAr: "الشركة", role: "company" }, { field: "profileUrl", headerAr: "رابط الملف", role: "url" }], pagination: { kind: "single" } } }],
    })],
    expectNew: { kind: "plan", endpoint: "icypeas.people.search", noWindow: true },
    note: "the volume is not stated by the customer: the recorded model chose 20; a real one may ask",
  },
  {
    id: "P10", group: "phrasing", request: "شركات مقاولات في جدة مع ايميلاتهم", fixtures: [fx("catalog-example_icypeas.companies.search"), fx("catalog-example_tomba.companies.emails.list")],
    script: [search("companies", ["search"]), search("companies", ["emails", "domain"]), sample("icypeas.companies.search", [{ name: "query", value: { industry: { include: ["Construction"] }, location: { include: ["Jeddah"] } }, source: "derived", quote: "شركات مقاولات في جدة" }]), sample("tomba.companies.emails.list", [{ name: "domain", source: "prior_step", fromStep: { step: 1, field: "website" } }]), propose({
      summaryAr: "جمع شركات المقاولات في جدة مع بريد كل شركة", topic: "شركات مقاولات في جدة",
      steps: [
        { endpointId: "icypeas.companies.search", volume: 10, params: [{ name: "query", value: { industry: { include: ["Construction"] }, location: { include: ["Jeddah"] } }, source: "derived", quote: "شركات مقاولات في جدة" }], fieldMap: { columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }, { field: "website", headerAr: "الموقع", role: "website", transform: "domain" }], pagination: { kind: "single" } } },
        { endpointId: "tomba.companies.emails.list", volume: 10, perItem: 1, params: [{ name: "domain", source: "prior_step", fromStep: { step: 1, field: "website" } }], fieldMap: { columns: [{ field: "data.organization.organization", headerAr: "اسم الشركة", role: "company" }, { field: "data.organization.website_url", headerAr: "الموقع", role: "website" }], pagination: { kind: "single" } } },
      ],
    }), propose({
      summaryAr: "جمع شركات المقاولات في جدة مع بريد كل شركة", topic: "شركات مقاولات في جدة",
      steps: [
        { endpointId: "icypeas.companies.search", volume: 10, params: [{ name: "query", value: { industry: { include: ["Construction"] }, location: { include: ["Jeddah"] } }, source: "derived", quote: "شركات مقاولات في جدة" }], fieldMap: { columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }, { field: "website", headerAr: "الموقع", role: "website", transform: "domain" }], pagination: { kind: "single" } } },
        { endpointId: "tomba.companies.emails.list", volume: 10, perItem: 1, params: [{ name: "domain", source: "prior_step", fromStep: { step: 1, field: "website" } }], fieldMap: { columns: [{ field: "organization.organization", headerAr: "اسم الشركة", role: "company" }, { field: "organization.website_url", headerAr: "الموقع", role: "website" }], pagination: { kind: "single" } } },
      ],
    })],
    expectNew: { kind: "plan", steps: 2, noWindow: true },
  },
  { id: "P11", group: "phrasing", request: "وظايف شاغره في الرياض", fixtures: [fx("catalog-example_blitzapi.jobs.search")], script: [search("jobs", ["search"]), ask("هذه الخدمة غير متاحة حاليًا؛ ولم يُحجز أي رصيد.")], expectNew: { kind: "refusal" }, note: "the recorded model declines (the old path ran a jobs source on 22 Oct); a real model may plan it" },
  { id: "P12", group: "phrasing", request: "اعطني تعليقات اخر ٥ بوستات في صفحة اليوم السابع فيسبوك", fixtures: [], script: [search("facebook", ["page", "posts"]), ask("ما رابط صفحة اليوم السابع على فيسبوك؟")], expectNew: { kind: "question" } },
  {
    id: "P13", group: "phrasing", request: "اريد ١٠٠ تعليق يوتيوب على فيديو https://www.youtube.com/watch?v=dQw4w9WgXcQ", fixtures: [fx("catalog-example_crawl4ai.youtube.video.comments")],
    script: [search("youtube", ["video", "comments"]), sample("crawl4ai.youtube.video.comments", [{ name: "video", value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", source: "customer_text", quote: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]), propose({
      summaryAr: "جمع ١٠٠ تعليق من فيديو على يوتيوب",
      steps: [{ endpointId: "crawl4ai.youtube.video.comments", volume: 100, params: [{ name: "video", value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", source: "customer_text", quote: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }], fieldMap: { rowsPath: "rows", columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "author", headerAr: "الكاتب", role: "author_name" }, { field: "likes", headerAr: "الإعجابات", role: "likes", transform: "number" }], pagination: { kind: "single" } } }],
    })],
    expectNew: { kind: "plan", endpoint: "crawl4ai.youtube.video.comments", noWindow: true },
  },
  {
    id: "P14", group: "request", request: "ابغى بيانات انستقرام لحساب فلان", fixtures: [],
    script: [search("instagram", ["user", "profile"]), propose({ summaryAr: "بيانات حساب", steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "fulan", source: "customer_text", quote: "فلان" }], fieldMap: { columns: [{ field: "username", headerAr: "الحساب" }] } }] }), ask("ما اسم الحساب على إنستغرام الذي تريد بياناته؟ اكتبه مع علامة @.")],
    expectNew: { kind: "question" },
    note: "request (b): the recorded model first invents an account from «فلان» (the validator sends that back), then asks one question",
  },
  { id: "P15", group: "phrasing", request: "٥ آلاف تعليق", fixtures: [], script: [ask("من أي منصة أو أي رابط تريد التعليقات؟")], expectNew: { kind: "question" } },
  { id: "P16", group: "phrasing", request: "خمسين تغريده", fixtures: [], script: [ask("ما اسم الحساب أو الموضوع الذي تريد تغريداته على إكس؟")], expectNew: { kind: "question" } },
  { id: "P17", group: "phrasing", request: "اجمع لي كل التغريدات عن الغلا", fixtures: [], script: [ask("كم تغريدة تريد عن الغلا؟")], expectNew: { kind: "question" } },
  { id: "P18", group: "phrasing", request: X_REQUEST, followUps: ["اوافق وابدأ"], fixtures: [realRowsOf("elonmusk")], script: [search("x", ["user", "posts"]), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())], expectNew: { kind: "gate" }, note: "two turns: the plan, then the approval typed in words" },
  { id: "P19", group: "phrasing", request: X_REQUEST, followUps: ["غلط الملف ناقص ايميلات"], fixtures: [realRowsOf("elonmusk")], script: [search("x", ["user", "posts"]), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())], expectNew: { kind: "gate" }, note: "two turns: a plan is on the table, then the complaint about a file" },
  { id: "P20", group: "phrasing", request: "كلمنا عن اسعاركم", fixtures: [], script: [ask("أخبرني بالبيانات التي تريدها، وسأعدّ لك خطة مع السعر قبل حجز أي رصيد.")], expectNew: { kind: "question" }, note: "no code gate answers this on either path: the old path asks its own model, the new path reaches the planner (a price is never stated by the model)" },

  // ------------------------------------------------------------------ request (a)
  {
    id: "A", group: "request", request: "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر", fixtures: [fx("catalog-example_anyapi.tiktok.search.videos"), fx("catalog-example_tikhub.tiktok.video.comments")],
    script: [...SEARCH_TT("كرة السلة في مصر", "كرة السلة في مصر"), propose(tiktokTopic("كرة السلة في مصر", 30, 10))],
    expectNew: { kind: "plan", steps: 2, noWindow: true }, note: "request (a): the old path added «آخر شهر» and delivered 0",
  },
];
