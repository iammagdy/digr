import { vi } from "vitest";

/**
 * A FAKE Context.dev (and Firecrawl): the documented request and answer shapes (docs.context.dev, read 2026-10-28), no network. `answers` maps a parser name to the `parsed.data` (or a failure) to return;
 * `credits` is what the answer reports in key_metadata.credits_consumed (undefined: the answer carries none, so the gateway records the documented base credit as an ESTIMATE).
 */
export interface FakeParseAnswer { data?: unknown; fail?: { error_code: string; message?: string }; credits?: number | null; httpStatus?: number }

export function fakeContextDev(options: { parse?: (parser: string, url: string, body: any) => FakeParseAnswer; people?: (body: any) => { results: unknown[]; next_cursor?: string | null; credits?: number | null }; search?: (body: any) => unknown[]; scrape?: (url: string) => { markdown: string; credits?: number | null } } = {}) {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: input, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const respond = (json: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => json }) as unknown as Response;
    const meta = (credits?: number | null) => (credits === undefined || credits === null ? {} : { key_metadata: { credits_consumed: credits, credits_remaining: 900 } });
    if (input.endsWith("/web/scrape") && body?.formats?.parse) {
      const parser = body.parseParams?.parser as string;
      const a = options.parse?.(parser, body.url, body) ?? { fail: { error_code: "NOT_FOUND" } };
      if (a.httpStatus && a.httpStatus >= 400) return respond({ error: "x" }, a.httpStatus);
      if (a.fail) return respond({ url: body.url, parsed: { type: parser, requested: true, success: false, data: null, error_code: a.fail.error_code, message: a.fail.message ?? "failed" }, request_id: "req-1", ...meta(a.credits) });
      return respond({ url: body.url, parsed: { type: parser, requested: true, success: true, data: a.data }, request_id: "req-1", ...meta(a.credits) });
    }
    if (input.endsWith("/web/scrape")) {
      const r = options.scrape?.(body.url) ?? { markdown: "" };
      return respond({ url: body.url, markdown: { requested: true, success: true, data: r.markdown }, ...meta(r.credits ?? 1) });
    }
    if (input.endsWith("/people/search")) {
      const r = options.people?.(body) ?? { results: [] };
      return respond({ results: r.results, next_cursor: r.next_cursor ?? null, request_id: "req-p", ...meta(r.credits) });
    }
    if (input.endsWith("/web/search") || input.endsWith("/search")) {
      const hits = options.search?.(body) ?? [];
      return respond({ results: hits, data: { web: hits }, creditsUsed: 2, ...meta(1) });
    }
    return respond({ error: "unknown" }, 404);
  });
  return { fetchFn, requests };
}

/** Documented shapes of the parsers' `parsed.data`. */
export const igPost = (i: number, tag: string) => ({ id: `ig${i}`, shortcode: `Sc${i}`, url: `https://www.instagram.com/p/Sc${i}/`, type: "image", posted_at: "2026-10-18T08:00:00Z", caption: `${tag} صورة ${i}`, hashtags: [tag], owner: { id: `o${i % 5}`, username: `user${i % 5}` }, like_count: 10 + i, comment_count: 2 + (i % 3), view_count: null, thumbnail_url: null, video_url: null });
export const igFeed = (tag: string, n: number) => ({ posts: Array.from({ length: n }, (_, i) => igPost(i, tag)) });
export const mapsPlace = (name: string) => ({ results: [{ place_id: "ChIJplace0001", name, rating: 4.4, number_of_reviews: 1830, website: "https://abutarek.example", google_maps_url: "https://www.google.com/maps/place/?q=place_id:ChIJplace0001", google_reviews_url: "https://search.google.com/local/reviews?placeid=ChIJplace0001", google_phone: "+20227945000", address: "شارع التحرير، القاهرة", city: "القاهرة", google_category: ["مطعم"] }] });
export const mapsReviews = (n: number) => ({ reviews: Array.from({ length: n }, (_, i) => ({ id: `rv${i}`, rating: 1 + (i % 5), date: "قبل شهر", isoDate: "2026-09-20T12:00:00Z", snippet: `تجربة رقم ${i} في المكان`, likes: i % 4, user: { name: `زائر ${i}`, link: `https://www.google.com/maps/contrib/${i}` }, link: `https://www.google.com/maps/reviews/rv${i}`, language: "ar", details: {} })), featureId: "0x1:0x2", cid: "123", sort: "newest" });
export const ttFeed = (n: number) => ({ videos: Array.from({ length: n }, (_, i) => ({ id: `7${String(i).padStart(6, "0")}`, url: `https://www.tiktok.com/@creator${i % 4}/video/7${String(i).padStart(6, "0")}`, type: "video", posted_at: "2026-10-19T09:00:00Z", caption: `رحلة إلى الأقصر فيديو ${i}`, hashtags: ["الأقصر"], author: { id: `a${i % 4}`, username: `creator${i % 4}`, nickname: `صانع ${i % 4}`, is_verified: false }, view_count: 1000 + i, like_count: 50 + i, comment_count: 30, share_count: 3, save_count: 1, repost_count: 0 })) });
export const emailsOf = (list: string[]) => ({ emails: list.map((email) => ({ email })) });
export const phonesOf = (list: string[]) => ({ phone_numbers: list.map((phone) => ({ phone })) });
export const linksOf = (list: Array<[string, string | null]>) => ({ links: list.map(([url, text]) => ({ url, text })) });
