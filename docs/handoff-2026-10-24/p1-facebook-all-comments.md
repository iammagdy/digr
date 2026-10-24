# Handoff note (2026-10-24): p1-facebook-all-comments

Kept in its own file so the parallel PRs of this session do not conflict in docs/HANDOFF.md; fold it into HANDOFF.md after merging.

## 000000. Facebook keyword comments take ALL comments (branch `claude/fb-all-comments`, from main `2548785`, owner decision 2026-10-24)

- Diger collects data; it does not judge what people write. For `social-facebook-keyword-comments` judgment applies to the PARENT post only (the post-level topic review is unchanged). The comments of an adopted post are delivered as they are. Only these are left out: an empty or whitespace comment, an exact repeat under one post (`repeatKey`), and a comment that is only a link (`facebookCommentDropReason` in `src/lib/server/commentQuality.ts`, used by the adapter's `countsAsComment` and by the gate).
- No longer applied to this service: the pleasantry rule (`isPureWellWish`, kept in the code for other callers and its own tests), the supplication/reaction rule, the three-letter minimum and the ad/phone rule. Consequence the owner chose: an ad text or spam that is a comment is delivered and charged like any other.
- «Why fewer rows» (`keywordShortfallReasonAr`): the pleasantry part is gone; it still says posts approved, posts read, posts the source gave too few comments for, comments the source did not return, posts with no delivered comment, and how many empty or link-only comments were left out.
- Money unchanged: charge = ceil(delivered unique matching units x 12.925), never above the hold. The 11 comments of the live run are all delivered: ceil(11 x 12.925) = 143.
- TikTok, YouTube, X and the company services are untouched.

---

