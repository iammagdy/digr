import type { SocialCall, SocialCallOutcome } from "../../src/lib/server/socialAdapter";

/**
 * A FIXTURE of the Facebook keyword search and of the comments of a post, for tests only. Nothing here was read from a provider: the catalog read of 2026-10-23 gives the
 * endpoints, the parameters and the prices (0.02952 USD per search call of the first source, 0.06606 per call of the second, 0.00188 per comments call) and NO rows, so
 * the shape of a row (`url`, `message`, `post_id`, `comment_id`, `text`) is the shape the existing Facebook reader already understands, not a copy of a real answer.
 * The prices are the catalog's, in millionths of a dollar (what a call outcome carries).
 */
export const SEARCH_CALL_MICRO = 29_520;
export const FALLBACK_SEARCH_CALL_MICRO = 66_060;
export const COMMENTS_CALL_MICRO = 1_880;
export const FIXTURE_TOPIC = "الترندات الصحية";

export interface FacebookWorld {
  /** Posts the search can ever list, in order (post 0, 1, 2, ...). */
  postsAvailable: number;
  /** Rows one search call returns (the first source). */
  pageSize?: number;
  /** Which listed posts are about the topic (default: the even ones, half of them). */
  onTopic?: (post: number) => boolean;
  /** Comments one comments call returns for a post (default: ten usable ones). */
  commentsOf?: (post: number) => Array<Record<string, any>>;
  /** The first search source answers with this error (the fallback source answers instead). */
  firstSourceDown?: boolean;
  /** The first search source keeps answering the rows of its first page, with a new cursor each time. */
  repeatsFirstPage?: boolean;
  /** Posts the comments call refuses (a post nobody can read). */
  unreadable?: (post: number) => boolean;
}

export const postUrl = (n: number) => `https://www.facebook.com/healthpage/posts/${n}`;
export const postNumberOf = (url: string): number => Number(/posts\/(\d+)/.exec(String(url))?.[1] ?? -1);

export const fixturePost = (n: number, onTopic: boolean) => ({
  post_id: String(n),
  url: postUrl(n),
  message: onTopic ? `منشور ${n} عن ${FIXTURE_TOPIC} في مصر وأثرها على حياة الناس` : `منشور ${n} عن موضوع آخر تمامًا`,
});

export const fixtureComments = (post: number, count = 10) =>
  Array.from({ length: count }, (_, i) => ({ comment_id: `c_${post}_${i}`, text: `تعليق رقم ${i} على المنشور ${post} طويل بما يكفي ليُقبل`, author: `قارئ ${i}` }));

export type AskedCall = { endpoint: string; params: Record<string, any> };

export function facebookKeywordWorld(world: FacebookWorld) {
  const pageSize = world.pageSize ?? 6;
  const onTopic = world.onTopic ?? ((n: number) => n % 2 === 0);
  const commentsOf = world.commentsOf ?? ((n: number) => fixtureComments(n));
  const asked: AskedCall[] = [];
  const ok = (rows: Array<Record<string, any>>, costMicro: number, nextCursor?: string): SocialCallOutcome => ({
    ok: true, httpStatus: 200, data: { ok: true, rows, ...(nextCursor ? { next_cursor: nextCursor } : {}) }, costMicro, tregCallId: `call_${asked.length}`,
  });
  const call: SocialCall = async (source, params) => {
    asked.push({ endpoint: source.endpointId, params });
    if (source.endpointId === "justoneapi.x.facebook-search-post-v1") {
      if (world.firstSourceDown) return { ok: false, httpStatus: 503, data: null, costMicro: 0, tregCallId: `call_${asked.length}`, errorCode: "provider_down", errorMessageAr: "المصدر لا يستجيب الآن." };
      // a source that repeats itself still moves its cursor forward: the rows are the first page's again, the cursor is new each time
      const requested = Number(params.cursor ?? 0);
      const offset = world.repeatsFirstPage ? 0 : requested;
      const rows = Array.from({ length: Math.max(0, Math.min(pageSize, world.postsAvailable - offset)) }, (_, i) => fixturePost(offset + i, onTopic(offset + i)));
      const next = requested + pageSize < world.postsAvailable ? String(requested + pageSize) : undefined;
      return ok(rows, SEARCH_CALL_MICRO, next);
    }
    if (source.endpointId === "anyapi.facebook.search_posts") {
      const rows = Array.from({ length: Math.min(20, Number(params.limit ?? 20), world.postsAvailable) }, (_, i) => fixturePost(i, onTopic(i)));
      return ok(rows, FALLBACK_SEARCH_CALL_MICRO);
    }
    if (source.endpointId === "scrapecreators.x.v1-facebook-post-comments" || source.endpointId === "treg.facebook.post.comments") {
      const post = postNumberOf(String(params.url ?? ""));
      if (world.unreadable?.(post)) return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: `call_${asked.length}`, errorCode: "not_found", errorMessageAr: "تعذر قراءة المنشور." };
      return ok(commentsOf(post), COMMENTS_CALL_MICRO);
    }
    return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: `call_${asked.length}`, errorCode: "not_served" };
  };
  const searches = () => asked.filter((entry) => /search/.test(entry.endpoint));
  const reads = () => asked.filter((entry) => /comments/.test(entry.endpoint));
  return { call, asked, searches, reads };
}
