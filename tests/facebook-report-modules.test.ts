import { describe, expect, it } from "vitest";
import {
  FACEBOOK_PAGE_REGISTRY, FACEBOOK_REPORT_ENABLED, normalizeAr, publisherOf, registryProblems, reportCoverage, selectPages, topicAreasOf, type FacebookPageEntry,
} from "../src/lib/facebookReport/registry";
import { coveredPeriod, emptyWindowStats, filterPostsByWindow, postVerdict, windowBoundsMs } from "../src/lib/facebookReport/window";
import { applyPublisherCap, balancedSelection, checkPublisherShare, concentrationOf, effectiveShare, publisherCap } from "../src/lib/facebookReport/publishers";
import { HEALTH_AXES, GENERAL_AXIS_ID, placeByRules } from "../src/lib/facebookReport/axes";
import { cleanComments } from "../src/lib/facebookReport/comments";
import { shortfallSentenceAr } from "../src/lib/facebookReport/shortfall";
import {
  FACEBOOK_REPORT_COST_USD_PER_COMMENT, MEASURED, blendedCostPerPost, costPerCommentAllIn, costPerDeliveredComment, jobArithmetic, reportUnitPricePoints,
} from "../src/lib/facebookReport/cost";
import { FACEBOOK_REPORT_SLUG, REPORT_MAX_COMMENTS, REPORT_MAX_POSTS } from "../src/lib/facebookReport/constants";
import { FACEBOOK_JOB_CEILINGS } from "../src/lib/facebookCeilings";
import { chargeForUnits, recordUnitPricePoints, reserveForUnits } from "../src/lib/recordPricing";
import type { ReportComment, ReportPost } from "../src/lib/facebookReport/types";

const post = (publisherKey: string, publishedAtMs: number | null, extra: Partial<ReportPost> = {}): ReportPost => ({
  key: `${publisherKey}/${publishedAtMs}/${Math.random()}`, url: "https://www.facebook.com/x/posts/1", text: "منشور", publisher: publisherKey, publisherKey,
  source: "page", publishedAtMs, reactions: 1, comments: 1, shares: 0, contentType: "text", ...extra,
});

describe("the page registry", () => {
  it("is clean: unique ids, plain Page addresses, ISO countries, Arabic names, no personal profile or group", () => {
    expect(registryProblems()).toEqual([]);
    expect(registryProblems([{ ...FACEBOOK_PAGE_REGISTRY[0], url: "https://www.facebook.com/profile.php?id=1" }])).not.toEqual([]);
    expect(registryProblems([{ ...FACEBOOK_PAGE_REGISTRY[0], url: "https://www.facebook.com/groups/abc" }])).not.toEqual([]);
  });
  it("seeds the owner's audit: five usable Egyptian health Pages and the Ministry flagged invalid, the gate follows the owner's review flags", () => {
    expect(FACEBOOK_PAGE_REGISTRY.map((entry) => entry.id)).toEqual([
      "eg_health_el_consolto", "eg_health_drug_authority", "eg_health_medical_syndicate", "eg_health_cairo24", "eg_health_masrawy", "eg_health_mohp",
    ]);
    expect(FACEBOOK_PAGE_REGISTRY.filter((entry) => entry.status === "ok")).toHaveLength(5);
    expect(FACEBOOK_PAGE_REGISTRY.find((entry) => entry.id === "eg_health_mohp")?.status).toBe("invalid");
    // the review flag is the owner's to set (one line per Page); the gate is exactly «some usable Page is reviewed» (see facebook-report-gate.test.ts)
    expect(FACEBOOK_PAGE_REGISTRY.every((entry) => typeof entry.ownerReviewed === "boolean")).toBe(true);
    expect(FACEBOOK_REPORT_ENABLED).toBe(FACEBOOK_PAGE_REGISTRY.some((entry) => entry.ownerReviewed && entry.status === "ok"));
    expect(FACEBOOK_PAGE_REGISTRY.every((entry) => entry.country === "EG")).toBe(true);
    // the two doctors of the audit were personal profiles: none of the listed addresses is a person
    expect(FACEBOOK_PAGE_REGISTRY.some((entry) => /profile\.php|\/people\//.test(entry.url))).toBe(false);
  });
  it("uses a Page only for its own country and topic: Egypt gets the Egyptian health Pages, another country gets none, no country gets none", () => {
    const egypt = selectPages({ country: "EG", topic: "الترندات الصحية" });
    expect(egypt.usable.map((entry) => entry.id)).toHaveLength(5);
    expect(egypt.skipped.map((entry) => entry.id)).toEqual(["eg_health_mohp"]);
    expect(selectPages({ country: "SA", topic: "الترندات الصحية" }).usable).toHaveLength(0);
    expect(selectPages({ country: null, topic: "الترندات الصحية" }).usable).toHaveLength(0);
    expect(selectPages({ country: "EG", topic: "أسعار العقارات" }).usable).toHaveLength(0);
    // a Page of another country in the registry is never used for Egypt
    const mixed: FacebookPageEntry[] = [...FACEBOOK_PAGE_REGISTRY, { ...FACEBOOK_PAGE_REGISTRY[0], id: "sa_health_x", nameAr: "صحة السعودية", country: "SA", url: "https://www.facebook.com/sahealth" }];
    expect(selectPages({ country: "EG", topic: "الصحة" }, mixed).usable.map((entry) => entry.id)).not.toContain("sa_health_x");
    expect(selectPages({ country: "SA", topic: "الصحة" }, mixed).usable.map((entry) => entry.id)).toEqual(["sa_health_x"]);
  });
  it("coverage: Egypt health is covered by five Pages; the topic words are read with the Arabic prefixes («الصحية», «للصحة»)", () => {
    expect(reportCoverage({ country: "EG", topic: "الترندات الصحية" })).toEqual({ covered: true, usablePages: 5 });
    expect(reportCoverage({ country: "EG", topic: "الموضة" }).covered).toBe(false);
    expect(topicAreasOf("الترندات الصحية")).toEqual(["health"]);
    expect(topicAreasOf("أخبار للصحة والأدوية")).toEqual(["health"]);
    expect(topicAreasOf("كرة القدم")).toEqual([]);
  });
  it("one publisher is counted once: a Page read by id and the same Page found by the search under another spelling share a key", () => {
    const byId = publisherOf("whatever", "eg_health_el_consolto");
    const bySearch = publisherOf("El Consolto", undefined);
    expect(byId.key).toBe(bySearch.key);
    expect(byId.name).toBe("الكونسلتو الطبي");
    expect(publisherOf("صفحة غير مسجلة", undefined).key).not.toBe(byId.key);
    expect(normalizeAr("الصِّحَّةُ")).toBe(normalizeAr("الصحه"));
  });
});

describe("the exact window (the reference run held 305 posts, 35 outside the window it claimed)", () => {
  const FROM = "2026-07-24";
  const TO = "2026-10-23";
  const { startMs, endMs } = windowBoundsMs(FROM, TO);
  it("keeps whole days inclusive at both ends and nothing a millisecond outside", () => {
    expect(postVerdict({ publishedAtMs: startMs }, FROM, TO)).toBe("inside");
    expect(postVerdict({ publishedAtMs: endMs }, FROM, TO)).toBe("inside");
    expect(postVerdict({ publishedAtMs: startMs - 1 }, FROM, TO)).toBe("outside");
    expect(postVerdict({ publishedAtMs: endMs + 1 }, FROM, TO)).toBe("outside");
    expect(postVerdict({ publishedAtMs: null }, FROM, TO)).toBe("undated");
  });
  it("the 305-post reference fixture: 270 inside, 35 outside (30 older, 5 newer), the boundary posts decide by the rule, nothing undated is kept", () => {
    const day = 86_400_000;
    const inside = Array.from({ length: 268 }, (_, i) => post("a", startMs + (i % 90) * day + 3_600_000));
    const boundary = [post("a", startMs), post("a", endMs)];
    const older = Array.from({ length: 30 }, (_, i) => post("a", startMs - (i + 1) * day));
    const newer = Array.from({ length: 5 }, (_, i) => post("a", endMs + (i + 1) * day));
    const all = [...inside, ...boundary, ...older, ...newer];
    expect(all).toHaveLength(305);
    const stats = emptyWindowStats(FROM, TO);
    const kept = filterPostsByWindow([...all, post("a", null)], FROM, TO, stats);
    expect(kept).toHaveLength(270);
    expect(stats.outside).toBe(35);
    expect(stats.undated).toBe(1);
    expect(stats.seen).toBe(306);
    expect(kept.every((p) => (p.publishedAtMs as number) >= startMs && (p.publishedAtMs as number) <= endMs)).toBe(true);
  });
  it("the covered period is the real oldest and newest day of the delivered posts", () => {
    expect(coveredPeriod([])).toEqual({ from: null, to: null, days: 0 });
    expect(coveredPeriod([post("a", Date.parse("2026-08-02T10:00:00Z")), post("a", Date.parse("2026-10-20T23:00:00Z"))])).toEqual({ from: "2026-08-02", to: "2026-10-20", days: 80 });
  });
});

describe("the per-publisher cap (20%)", () => {
  const mk = (key: string, n: number) => Array.from({ length: n }, (_, i) => post(key, 1_700_000_000_000 + i * 1000));
  it("the 74% case of the owner's file fails the check, and the cap brings it under 20% with the surplus counted", () => {
    const set = [...mk("consolto", 225), ...mk("b", 20), ...mk("c", 20), ...mk("d", 20), ...mk("e", 19)];
    expect(set).toHaveLength(304);
    const before = checkPublisherShare(set);
    expect(before.ok).toBe(false);
    expect(before.top?.share).toBeGreaterThan(0.73);
    const { kept, dropped, droppedByPublisher } = applyPublisherCap(set);
    expect(checkPublisherShare(kept).ok).toBe(true);
    expect(concentrationOf(kept)[0].share).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(dropped).toBe(set.length - kept.length);
    expect(droppedByPublisher.consolto).toBeGreaterThan(150);
  });
  it("the share can only be met with five publishers: with fewer the effective share is an equal split and the cap is never above it", () => {
    expect(effectiveShare(5)).toBeCloseTo(0.2);
    expect(effectiveShare(4)).toBeCloseTo(0.25);
    expect(effectiveShare(10)).toBeCloseTo(0.2);
    expect(publisherCap(100)).toBe(20);
    expect(publisherCap(3)).toBe(1);
  });
  it("a balanced selection takes every publisher before any twice and never exceeds the target or the share", () => {
    const set = [...mk("a", 80), ...mk("b", 80), ...mk("c", 80), ...mk("d", 80), ...mk("e", 80)];
    const chosen = balancedSelection(set, 100);
    expect(chosen).toHaveLength(100);
    expect(concentrationOf(chosen).every((row) => row.posts === 20)).toBe(true);
    expect(balancedSelection(set, 3)).toHaveLength(applyPublisherCap(balancedSelection(set, 3)).kept.length);
  });
});

describe("posts go to health axes by words, comments are never judged", () => {
  it("a digestive post is not filed under the heart, even with the word «القلب»; a real heart post is", () => {
    expect(placeByRules("حرقان القلب وارتجاع المريء بعد الأكل: الأسباب والعلاج").axis).toBe("digestive");
    expect(placeByRules("أعراض الجلطة القلبية وأمراض القلب وقسطرة القلب: متى تذهب للطوارئ").axis).toBe("heart");
    // a word that only contains the letters is not the word
    expect(placeByRules("انقلب الحال وتقلب الجو اليوم").axis).toBe(GENERAL_AXIS_ID);
  });
  it("a text with nothing of the health words is «general» and ambiguous (it goes to the model or to the budget rule), and the axes are the owner's eight", () => {
    const placement = placeByRules("مباراة اليوم في الدوري");
    expect(placement.axis).toBe(GENERAL_AXIS_ID);
    expect(placement.ambiguous).toBe(true);
    expect(HEALTH_AXES).toHaveLength(8);
  });
  it("comment hygiene removes only an empty comment, an exact duplicate and a bare link; short comments, emoji and off-topic comments stay", () => {
    const c = (text: string, commentId?: string, author = "س"): ReportComment => ({ postKey: "p1", commentId, author, text, publishedAtMs: null, reactions: 0, replies: 0 });
    const result = cleanComments([
      c("ربنا يشفيه", "1"), c("❤️", "2"), c("   ", "3"), c("https://example.com/x", "4"), c("ربنا يشفيه", "1"), c("مين الدكتور ده؟", "5"), c("لا علاقة لي بالموضوع", "6"),
      c("نفس النص", undefined, "ص"), c("نفس النص", undefined, "ص"),
    ]);
    expect(result.kept.map((x) => x.text)).toEqual(["ربنا يشفيه", "❤️", "مين الدكتور ده؟", "لا علاقة لي بالموضوع", "نفس النص"]);
    expect(result).toMatchObject({ empty: 1, linkOnly: 1, duplicates: 2 });
  });
});

describe("the shortfall sentence", () => {
  const facts = { pagesBrowsed: 5, pagesSkipped: 1, postsFound: 120, postsOutsideWindow: 20, postsUndated: 2, postsRequested: 100, postsDelivered: 75, commentsRequested: 500, commentsDelivered: 330, commentsNotReturned: 40 };
  it("says what fell short and why, once, in Arabic digits, with no vendor, no id and no English", () => {
    const text = shortfallSentenceAr(facts) as string;
    expect(text).toMatch(/^تصفّحنا/);
    expect(text).toContain("٧٥");
    expect(text).toContain("٣٣٠");
    expect(text).toContain("لا يُحتسب عليك إلا ما سُلّم فعلًا");
    expect(text).not.toMatch(/[A-Za-z0-9]/);
    expect(text.split("\n")).toHaveLength(1);
  });
  it("is null when everything asked for was delivered", () => {
    expect(shortfallSentenceAr({ ...facts, postsDelivered: 100, commentsDelivered: 500 })).toBeNull();
  });
});

describe("cost, price and the money rules of the report capability", () => {
  it("the price lives in one place: 0.00055 USD a delivered comment, 3.025 points, ASSUMED until a run measures the new mix", () => {
    expect(FACEBOOK_REPORT_COST_USD_PER_COMMENT).toBe(0.00055);
    expect(recordUnitPricePoints(FACEBOOK_REPORT_SLUG)).toBe(3.025);
    expect(reportUnitPricePoints()).toBe(3.025);
  });
  it("the cost basis reproduces from the owner's measured run (M), with the blended figure at the search cap", () => {
    expect(MEASURED.totalSpendUsd.value).toBe(0.9619);
    expect(costPerCommentAllIn()).toBeCloseTo(0.000549, 6);
    expect(blendedCostPerPost(0.15)).toBeGreaterThan(0.0005);
    expect(costPerDeliveredComment(5, 0.15)).toBeCloseTo(0.000496, 5);
    // the price is the dearer of the two, rounded up
    expect(FACEBOOK_REPORT_COST_USD_PER_COMMENT).toBeGreaterThanOrEqual(Math.max(costPerCommentAllIn(), costPerDeliveredComment(5)));
  });
  it("300 posts × 5 comments = 1,500 comments: charge 4,538 and reserve 5,219; 100 posts × 20 comments is cut to the 1,500-comment ceiling", () => {
    const job = jobArithmetic(300, 5);
    expect(job.comments).toBe(1500);
    expect(job.chargePoints).toBe(4538);
    expect(job.reservePoints).toBe(5219);
    expect(chargeForUnits(1500, 3.025)).toBe(4538);
    expect(reserveForUnits(1500, 3.025)).toBe(5219);
    const wide = jobArithmetic(100, 20);
    expect(wide.comments).toBe(REPORT_MAX_COMMENTS);
    expect(wide.posts).toBe(75);
    expect(wide.chargePoints).toBe(4538);
  });
  it("the ceilings are the Facebook ones, one constant each, unchanged: 300 posts and 1,500 comments", () => {
    expect(REPORT_MAX_POSTS).toBe(300);
    expect(REPORT_MAX_COMMENTS).toBe(1500);
    expect(FACEBOOK_JOB_CEILINGS).toMatchObject({ posts: 300, comments: 1500 });
  });
  it("charge = ceil(delivered × 3.025) and never above the reserve for any delivered count up to the volume (properties)", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 5000; i++) {
      const volume = 1 + Math.floor(rnd() * 1500);
      const delivered = Math.floor(rnd() * (volume + 1));
      const charge = chargeForUnits(delivered, 3.025);
      expect(charge).toBe(Math.ceil((delivered * 3025) / 1000));
      expect(charge).toBeLessThanOrEqual(reserveForUnits(volume, 3.025));
    }
    expect(chargeForUnits(0, 3.025)).toBe(0);
  });
  it("the margin on the dearest case (one comment a post, the search at its cap) is stated, never hidden, and positive at the measured basis", () => {
    const job = jobArithmetic(300, 5);
    expect(job.marginAtBasis).toBeGreaterThan(0);
    expect(job.worstCostPerComment).toBeGreaterThan(job.expectedCostUsd / job.comments);
  });
});
