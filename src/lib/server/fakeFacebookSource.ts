/**
 * A deterministic Facebook source for the PREVIEW pressure test (the fake provider guard): the posts of a vetted Page (newest first, one a day, from today) and the comments of a post.
 * Used only when the fake provider mode is active, which is never the live site. It serves the Page-posts and the comments sources of the topic report; the keyword search answers
 * «not served» (the report's search supplement then simply finds nothing). Costs are zero. Pure.
 */
import type { SocialCall, SocialCallOutcome } from "./socialAdapter";

const DAY_MS = 86_400_000;
const POSTS_PER_PAGE = 60;
const POSTS_PER_CALL = 3;
const COMMENTS_PER_POST = 25;
const COMMENTS_PER_CALL = 10;
const TEXTS = [
  "أعراض الجلطة القلبية وأمراض القلب: متى تذهب للطوارئ",
  "حقن التخسيس واوزمبيك: ماذا يقول الأطباء",
  "نواقص الأدوية وأسعار الأدوية وبدائل الدواء",
  "لقاح الانفلونزا ومصل الانفلونزا للكبار",
  "ارتجاع المريء وحرقان المعدة والقولون",
];

const slugOf = (url: string): string => /facebook\.com\/([^/?#]+)/.exec(url)?.[1] ?? "page";

export function createFakeFacebookCall(now: () => number = Date.now): SocialCall {
  let calls = 0;
  const ok = (rows: Array<Record<string, any>>, next: string | null): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows, ...(next ? { next_cursor: next } : {}) }, costMicro: 0, tregCallId: `fakefb${++calls}` });
  return async (source, params): Promise<SocialCallOutcome> => {
    if (source.endpointId === "anyapi.facebook.user.posts") {
      const slug = slugOf(String(params.url ?? ""));
      const offset = Number(params.cursor ?? 0);
      const rows = Array.from({ length: Math.max(0, Math.min(POSTS_PER_CALL, POSTS_PER_PAGE - offset)) }, (_, i) => {
        const n = offset + i;
        return {
          post_id: `${slug}_${n}`, url: `https://www.facebook.com/${slug}/posts/${n}`, message: TEXTS[n % TEXTS.length], createdUtc: new Date(now() - (n + 1) * DAY_MS).toISOString(),
          reaction_count: 20 + n, comment_count: 8, share_count: 2,
        };
      });
      return ok(rows, offset + POSTS_PER_CALL < POSTS_PER_PAGE ? String(offset + POSTS_PER_CALL) : null);
    }
    if (source.endpointId === "scrapecreators.x.v1-facebook-post-comments") {
      const url = String(params.url ?? "");
      const offset = Number(params.cursor ?? 0);
      const rows = Array.from({ length: Math.max(0, Math.min(COMMENTS_PER_CALL, COMMENTS_PER_POST - offset)) }, (_, i) => ({
        comment_id: `c_${slugOf(url)}_${url.slice(-6)}_${offset + i}`, text: `تعليق رقم ${offset + i} على المنشور`, author: `قارئ ${offset + i}`, created_time: new Date(now() - 3_600_000).toISOString(), reactions: i % 4, reply_count: 0,
      }));
      return ok(rows, offset + COMMENTS_PER_CALL < COMMENTS_PER_POST ? String(offset + COMMENTS_PER_CALL) : null);
    }
    return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: `fakefb${++calls}`, errorCode: "fake_provider_not_served", errorMessageAr: "هذا المصدر غير متاح في وضع الاختبار." };
  };
}
