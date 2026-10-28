import type { TregCallResult } from "../../src/functions/shared/tregClient";
import { tregResult } from "./agentHarness";
import type { FakeStep } from "../../agent/src/fakeDriver";

/**
 * The FAKE WORLD of the replays: provider answers in the shapes of the real catalog endpoints (their list paths and fields as the catalog snapshot states them) and the transcripts of a fake model
 * that works like the real one should: look at the catalog, describe the endpoint, sample one page, build sample rows by code from the saved page, propose the plan; then, once approved, page
 * through the source, build the rows by code, save them stage by stage and finish. Every value is invented here; nothing reads a real source.
 */
export type Results = Array<{ tool: string; result: Record<string, unknown> }>;

export const callIds = (r: Results): string[] => r.filter((x) => x.tool === "treg_call" && x.result.ok === true).map((x) => String(x.result.call_id));
export const lastOutputId = (r: Results): string => String([...r].reverse().find((x) => x.tool === "run_code" && x.result.output_id)?.result.output_id);
export const lastNextCursor = (r: Results): string | null => {
  const last = [...r].reverse().find((x) => x.tool === "treg_call" && x.result.ok === true);
  return typeof last?.result.next_cursor === "string" ? (last!.result.next_cursor as string) : null;
};

const pad = (n: number, w = 6) => String(n).padStart(w, "0");

// ---------------------------------------------------------------------------- the pages (shapes of the catalog's list paths)
/** anyapi.x.search.posts: output.data.items[], output.data.nextCursor */
export const xPage = (topic: string, offset: number, n: number, next: string | null) => ({ output: { data: { items: Array.from({ length: n }, (_, i) => ({ id: `18${pad(offset + i)}`, text: `${topic} رقم ${offset + i}`, url: `https://x.example/u/status/18${pad(offset + i)}`, author: `user${(offset + i) % 40}`, createdAt: "2026-10-20T10:00:00Z" })), nextCursor: next } } });

/** justoneapi.x.facebook-search-post-v1: data.results[], data.cursor (the dearer anyapi search costs more than the planning budget of one request, so the cheaper one is the one used) */
export const fbPostsPage = (topic: string, offset: number, n: number, next: string | null) => ({ code: 0, data: { results: Array.from({ length: n }, (_, i) => ({ post_id: `fp${pad(offset + i)}`, type: "post", url: `https://fb.example/posts/fp${pad(offset + i)}`, message: `${topic} منشور ${offset + i}`, timestamp: 1785202291, comments_count: 40 + i, reactions_count: 100 + i, author: { name: `صفحة ${(offset + i) % 5}` } })), cursor: next } });
/** anyapi.facebook.post_comments: output.data.comments[] */
export const fbCommentsPage = (postId: string, n: number) => ({ output: { data: { comments: Array.from({ length: n }, (_, i) => ({ id: `${postId}-c${pad(i, 2)}`, text: `تعليق ${i} على ${postId}`, author: `قارئ ${i}`, createdUtc: "2026-10-21T10:00:00Z" })) } } });

/** crawl4ai.tiktok.search.videos: rows[] */
export const ttVideosPage = (topic: string, n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ post_id: `tv${pad(i)}`, url: `https://tt.example/@creator${i % 7}/video/tv${pad(i)}`, description: `${topic} فيديو ${i}`, author: `creator${i % 7}`, stats: { views: 1000 + i, likes: 50 + i, comments: 20, shares: 3 }, created_at: "2026-10-19T09:00:00Z" })) });
/** crawl4ai.tiktok.video.comments: rows[] */
export const ttCommentsPage = (postId: string, n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ comment_id: `${postId}-k${pad(i, 2)}`, post_id: postId, text: `تعليق ${i} على الفيديو ${postId}`, author: `viewer${i}`, likes: i, created_at: "2026-10-20T09:00:00Z" })) });

/** anyapi.instagram.hashtag.posts: output.data.posts[], cursor */
export const igHashtagPage = (tag: string, offset: number, n: number, next: string | null) => ({ output: { data: { posts: Array.from({ length: n }, (_, i) => ({ id: `ig${pad(offset + i)}`, shortcode: `Sc${pad(offset + i)}`, caption: `${tag} صورة ${offset + i}`, likes: 10 + i, comments: 2, createdUtc: "2026-10-18T08:00:00Z", displayUrl: `https://ig.example/p/Sc${pad(offset + i)}` })), nextCursor: next } } });

/** crawl4ai.google.serp.maps: rows[] */
export const mapsSearch = (name: string) => ({ rows: [{ name, place_id: "ChIJplace0001", address: "شارع التحرير، القاهرة", phone: "+20227945000", category: "مطعم", cid: "1234567890" }] });
/** litescrape.google.maps.reviews: reviews[], pagination.next_page_token */
export const mapsReviewsPage = (offset: number, n: number, next: string | null) => ({ reviews: Array.from({ length: n }, (_, i) => ({ review_id: `rv${pad(offset + i)}`, rating: 1 + ((offset + i) % 5), user: { name: `زائر ${offset + i}` }, snippet: `تجربة رقم ${offset + i} في المكان`, iso_date: "2026-10-10T12:00:00Z", likes: i % 4 })), pagination: next ? { next_page_token: next } : {} });

/** aiark.companies.search: content[] */
export const companiesPage = (n: number) => ({ content: Array.from({ length: n }, (_, i) => ({ id: `co${i + 1}`, name: ["الشركة المصرية للكهروميكانيكا", "النيل للتركيبات الكهربائية", "دلتا للمقاولات الكهروميكانيكية"][i] ?? `شركة ${i + 1}`, domain: `company${i + 1}.example`, industry: ["الكهروميكانيكا"], employee_count: 120 + i, location: { country: "مصر" } })), totalElements: n, number: 0, size: n, last: true });
/** aviato.companies.employees: employees[] */
export const employeesPage = (companyId: string, n: number) => ({ employees: Array.from({ length: n }, (_, i) => ({ personID: `${companyId}-p${i + 1}`, companyID: companyId, positionList: [{ title: i === 0 ? "مدير المشتريات" : "مدير العمليات" }], person: { fullName: `${companyId === "co1" ? "أحمد" : companyId === "co2" ? "منى" : "خالد"} ${i === 0 ? "حسن" : "سليم"}`, URLs: { linkedin: `https://www.linkedin.com/in/${companyId}-p${i + 1}` } } })) });
/** blitzapi.people.email.find: all_emails[] (found false when there is none) */
export const emailFound = (email: string) => ({ found: true, email, all_emails: [{ email }] });
export const emailNotFound = () => ({ found: false, all_emails: [] });

// ---------------------------------------------------------------------------------------------------------- transcripts
type Args = Record<string, unknown> | ((r: Results) => Record<string, unknown>);

export interface PlanningFlowOptions {
  progress: string;
  searchWords: string[];
  platform?: string;
  /** The endpoint the sample call goes to, with its params. */
  sample: Array<{ endpoint: string; params: Args }>;
  /** run_code that builds sample rows of the first stage from the first saved page. */
  sampleCode: string;
  sampleFiles?: (r: Results) => string[];
  plan: (r: Results) => { summary_ar: string; stages: unknown[] };
}

/** The planning transcript every scenario shares: progress line, catalog search, describe, one sample call per source, sample rows by code, propose_plan. */
export function planningFlow(o: PlanningFlowOptions): FakeStep[] {
  return [
    { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
    { tool: "catalog_search", args: { words: o.searchWords, ...(o.platform ? { platform: o.platform } : {}), limit: 5 } },
    ...o.sample.flatMap((s): FakeStep[] => [
      { tool: "describe_endpoint", args: { id: s.endpoint } },
      { tool: "treg_call", args: typeof s.params === "function" ? (r: Results) => ({ endpoint_id: s.endpoint, params: (s.params as (r: Results) => Record<string, unknown>)(r) }) : { endpoint_id: s.endpoint, params: s.params } },
    ]),
    { tool: "run_code", args: (r) => ({ code: o.sampleCode, files: o.sampleFiles ? o.sampleFiles(r) : callIds(r).slice(0, 1) }) },
    { tool: "propose_plan", args: (r) => o.plan(r) },
  ];
}

/** `n` calls of one endpoint paged by the cursor the previous answer returned. */
export function pagedCalls(endpoint: string, n: number, params: (cursor: string | null, i: number) => Record<string, unknown>): FakeStep[] {
  return Array.from({ length: n }, (_, i): FakeStep => ({ tool: "treg_call", args: (r) => ({ endpoint_id: endpoint, params: params(i === 0 ? null : lastNextCursor(r), i) }) }));
}

export type { TregCallResult };
export { tregResult };
