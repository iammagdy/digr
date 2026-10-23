import { describe, expect, it } from "vitest";
import { GENERIC_COMMENT_REASON_AR, commentDropReason, genericCommentKind, isGenericComment, isUsableComment } from "../src/lib/server/commentQuality";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { emptyRunningSet, extendRunningSet } from "../src/lib/server/jobRunningSet";
import { summarizeActivityCounts, DATE_EXCLUDED_LABEL } from "../src/lib/activityCounts";
import { dateDropShortfallSentenceAr, emptyAfterDateDropSentenceAr } from "../src/lib/server/dateWindowNotes";

const tiktok = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة القدم", region: "EG" } };
const youtube = { capabilitySlug: "social-youtube-comments", endpointId: "crawl4ai.youtube.video.comments", params: { query: "كرة القدم" } };

describe("generic supplications and blessings: a deterministic rule, narrow on purpose", () => {
  it("«اللهم …» and the blessing formulas are generic", () => {
    for (const text of ["اللهم صل على النبي", "اللهم انصر اخواننا", "  اللهم  ", "ما شاء الله", "ماشاء الله تبارك الله", "سبحان الله", "جزاك الله خيرا", "بارك الله فيك", "الحمد لله", "يارب", "آمين", "تسلم ايدك", "تسلم الايادي", "يسلمو", "ربنا يوفقك", "الله اكبر", "mashallah", "اللهم صل على سيدنا محمد 🌹"]) {
      expect(isGenericComment(text), text).toBe(true);
    }
    expect(genericCommentKind("اللهم صل على النبي")).toBe("supplication");
    expect(genericCommentKind("ما شاء الله")).toBe("reaction");
  });

  it("anything with a word of its own is kept: short real comments, praise words, a plain «شكرا», an emoji (those have their own rule)", () => {
    for (const text of ["ماتش حلو", "جامد اوي", "هدف رائع", "مبروك", "بالتوفيق للمنتخب", "الحكم ظلمنا", "شكرا", "حلو قوي", "افتح التنزيل عليك الله", "الله يخرب بيت الحكم", "ما شاء الله على اللعيبة بتوع الاهلي", "#كرة_القدم", "", "👍", "123", "great goal"]) {
      expect(isGenericComment(text), text).toBe(false);
    }
  });

  it("the older rule is untouched: emoji and very short comments are still dropped by it, real short ones still usable", () => {
    expect(commentDropReason("Wr")).toBe("too_short");
    expect(commentDropReason("👍")).toBe("too_short");
    expect(isUsableComment({ text: "ماتش حلو" })).toBe(true);
    expect(isUsableComment({ text: "حلو" })).toBe(true);
  });

  it("the gate: a generic comment under a topic search is not a match, with a plain Arabic reason; the same words with the topic in them are judged normally", () => {
    for (const context of [tiktok, youtube]) {
      const generic = evaluateResearchRowRelevance({ comment_text: "اللهم صل على النبي", text: "اللهم صل على النبي", video_title: "مباراة كرة القدم" }, context);
      expect(generic).toEqual({ decision: "no_match", reasonAr: GENERIC_COMMENT_REASON_AR });
      expect(generic.reasonAr).not.toMatch(/[A-Za-z0-9]/);
      const topical = evaluateResearchRowRelevance({ comment_text: "اللهم انصر منتخبنا في كرة القدم", text: "اللهم انصر منتخبنا في كرة القدم" }, context);
      expect(topical.decision).toBe("match");
    }
  });

  it("the gate keeps delivering the short real comments the golden tests name", () => {
    for (const comment_text of ["ماتش حلو", "جامد اوي", "هدف رائع", "مبروك", "بالتوفيق للمنتخب"]) expect(evaluateResearchRowRelevance({ comment_text, video_title: "فيديو" }, tiktok).decision, comment_text).toBe("match");
  });

  it("a comments request with no topic filter (a link) is not touched by the rule", () => {
    const byLink = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { url: "https://www.tiktok.com/@u/video/7231337071831321900" } };
    expect(evaluateResearchRowRelevance({ comment_text: "اللهم صل على النبي" }, byLink).reasonAr).not.toBe(GENERIC_COMMENT_REASON_AR);
  });
});

describe("the date-removed rows are counted the same everywhere", () => {
  const step = (received: number, dropped: number | undefined) => ({ rows: [], receivedRows: received, ...(dropped === undefined ? {} : { dateExcludedCount: dropped }) });
  it("the running set adds the rows the window removed, page after page; a chunk from before it was counted leaves the total unknown, never zero", () => {
    let s = extendRunningSet(emptyRunningSet(), 0, step(30, 29), () => null);
    expect(s.dateDropped).toBe(29);
    s = extendRunningSet(s, 1, step(30, 4), () => null);
    expect(s.dateDropped).toBe(33);
    const old = extendRunningSet(s, 2, step(30, undefined), () => null);
    expect(old.dateDropped).toBeUndefined();
    expect(extendRunningSet(old, 3, step(30, 2), () => null).dateDropped).toBeUndefined();
  });

  it("the panel counts «خارج الفترة N» of a page line with the exclusions", () => {
    const counts = summarizeActivityCounts([
      { textAr: `الصفحة ١: استلمنا ٣٠ سجل · الجديد ١ · الإجمالي ١ · ${DATE_EXCLUDED_LABEL} ٢٩` },
      { textAr: `الصفحة ٢: استلمنا ٣٠ سجل · المستلم حتى الآن ٦٠ · الجديد ٢ · الإجمالي ٣ · مكرر أو مستبعد ٣ · ${DATE_EXCLUDED_LABEL} ٢٥` },
    ]);
    expect(counts).toMatchObject({ received: 60, excluded: 57 });
    // a line that is not a page line never adds
    expect(summarizeActivityCounts([{ textAr: `تم استبعاد ٥ سجل بسبب التاريخ ${DATE_EXCLUDED_LABEL} ٥` }]).excluded).toBe(0);
  });

  it("the sentences: totals in Arabic digits, the cause first, the advice only when most rows went", () => {
    expect(dateDropShortfallSentenceAr(10, 7)).toBe("استُبعد ٧ من ١٠ سجلاً وصل لأن تاريخه خارج الفترة التي حددتها أو لأنه بلا تاريخ نشر يمكن التحقق منه، ولا يُحتسب عليك؛ ولعدد أكبر وسّع الفترة.");
    expect(dateDropShortfallSentenceAr(100, 5)).not.toContain("وسّع الفترة");
    expect(dateDropShortfallSentenceAr(10, 0)).toBe("");
    expect(emptyAfterDateDropSentenceAr(30, 29, 0)).toBe("استلمنا ٣٠ سجلاً من المصدر، استُبعد منها ٢٩ لأن تاريخها خارج الفترة التي حددتها أو بلا تاريخ نشر يمكن التحقق منه، وبقي ١ داخل الفترة لكن لم يتحقق في أيٍّ منها موضوع طلبك");
    for (const text of [dateDropShortfallSentenceAr(10, 7), emptyAfterDateDropSentenceAr(30, 29, 2)]) { expect(text).not.toMatch(/[A-Za-z0-9#*]/); expect(text).not.toMatch(/\p{Extended_Pictographic}/u); }
  });
});
