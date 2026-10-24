import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import SubmittedCard from "../src/app/dashboard/topup/SubmittedCard";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { calculateCapabilityQuote, DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { countAr, planCountLineAr, planCountPartsAr } from "../src/lib/planCounts";
import { fitNoticeAr, fitPostsAndComments, pairRoleOf } from "../src/lib/planFit";
import { priceVsHoldLineAr } from "../src/lib/planExplanation";
import { planScopeRows } from "../src/lib/quoteScopeGaps";
import { cleanSocialTopicAr, searchTextNeedsCleaning } from "../src/lib/socialTasks";
import { chargeForUnits, recordUnitPricePoints, reserveForUnits } from "../src/lib/recordPricing";
import { CREDIT_KIND_LABEL_AR } from "../src/lib/creditKinds";
import { TOPUP_REQUEST_LABEL_AR, walletDisplayText } from "../src/lib/walletText";
import { settlementEventAr } from "../src/lib/releaseWording";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { POST_APPROVAL_TAB_AR, postApprovalMessageAr } from "../src/lib/postApproval";
import { jobStartedNotice } from "../src/lib/server/jobNotices";
import { buildLivePreviewSample } from "../src/lib/liveJobView";
import { ensurePostLinkColumn, previewColumns } from "../src/lib/customerResultColumns";
import { CALL_CAP_NOTE_AR, evaluateProviderCallCap } from "../src/lib/server/providerCallCaps";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";

/**
 * One batch: health-trends plan consistency and its fit, price versus hold, the wallet wording, the run message, the live preview digits,
 * the stall guard for a source that repeats itself, and the spread of a topic search over videos. No model, no provider, no SQL.
 */
const HEALTH_REQUEST = "عايز ٥٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر";

describe("1. one count everywhere: the posts and comments of a plan are never summed into a number that matches neither", () => {
  it("countAr and planCountLineAr: each service with its own noun, one service keeps «حتى N سجل»", () => {
    expect(countAr(1, "posts")).toBe("منشور واحد");
    expect(countAr(2, "comments")).toBe("تعليقين");
    expect(countAr(4, "posts")).toBe("٤ منشورات");
    expect(countAr(40, "comments")).toBe("٤٠ تعليقًا");
    expect(planCountLineAr([{ capabilitySlug: "icypeas-companies-search", targetVolumeMax: 5 }])).toBe("حتى ٥ سجلات");
    expect(planCountLineAr([{ capabilitySlug: "facebook-post-search", targetVolumeMax: 4 }, { capabilitySlug: "facebook-post-comments", targetVolumeMax: 40 }])).toBe("حتى ٤ منشورات و٤٠ تعليقًا");
    // the comments come last whatever the order the plan was written in
    expect(planCountPartsAr([{ capabilitySlug: "facebook-post-comments", targetVolumeMax: 40 }, { capabilitySlug: "facebook-post-search", targetVolumeMax: 4 }])).toBe("٤ منشورات و٤٠ تعليقًا");
  });

  it("the roles of the pair are read from the service's own id", () => {
    expect(pairRoleOf({ capabilitySlug: "facebook-post-search" })).toBe("posts");
    expect(pairRoleOf({ capabilitySlug: "facebook-post-comments" })).toBe("comments");
    expect(pairRoleOf({ capabilitySlug: "social-tiktok-comments" })).toBeNull();
    expect(pairRoleOf({ capabilitySlug: "social-x-posts" })).toBeNull();
  });
});

describe("the health-trends request: topic text stays clean", () => {
  it("the subject and the place the customer named, nothing else", () => {
    expect(cleanSocialTopicAr(HEALTH_REQUEST)).toBe("الترندات الصحية في مصر");
    expect(searchTextNeedsCleaning(HEALTH_REQUEST)).toBe(true);
    expect(searchTextNeedsCleaning("٥٠ بوست عن الصحة")).toBe(true);
    expect(searchTextNeedsCleaning("الترندات الصحية في مصر")).toBe(false);
    expect(searchTextNeedsCleaning("health trends")).toBe(false);
  });
});

describe("the fit of posts and their comments (the 550-to-600 case: 50 posts + 500 comments, post 8 and comment 11 points)", () => {
  const items = [
    { capabilitySlug: "facebook-post-search", targetVolumeMax: 50, unitPricePoints: 8 },
    { capabilitySlug: "facebook-post-comments", targetVolumeMax: 500, unitPricePoints: 11 },
  ];

  it("keeps the comments per post the customer asked for and the most posts the reserve under 600 holds: 4 posts, 40 comments (never 4 posts beside 44 comments)", () => {
    const fit = fitPostsAndComments(items, 600, 0.15)!;
    expect(fit.volumes).toEqual([4, 40]);
    expect(fit.asked).toEqual([50, 500]);
    expect(fit.reduced).toBe(true);
    expect(fit.reason).toBe("cap");
    expect(fit.perPost).toBe(10);
    const hold = reserveForUnits(4, 8) + reserveForUnits(40, 11);
    expect(hold).toBe(543);
    expect(hold).toBeLessThanOrEqual(600);
    // one post more would not fit
    expect(reserveForUnits(5, 8) + reserveForUnits(50, 11)).toBeGreaterThan(600);
  });

  it("a request that already fits is not touched, and a pair in the other order is read the same way", () => {
    expect(fitPostsAndComments([{ ...items[0], targetVolumeMax: 3 }, { ...items[1], targetVolumeMax: 30 }], 600, 0.15)).toMatchObject({ reduced: false, volumes: [3, 30], reason: null });
    expect(fitPostsAndComments([items[1], items[0]], 600, 0.15)!.volumes).toEqual([40, 4]);
  });

  it("the service's own ceilings apply even when the money fits: 300 posts and 1,500 comments at most", () => {
    const cheap = [{ capabilitySlug: "facebook-post-search", targetVolumeMax: 400, unitPricePoints: 1 }, { capabilitySlug: "facebook-post-comments", targetVolumeMax: 4000, unitPricePoints: 0.1 }];
    const fit = fitPostsAndComments(cheap, 600, 0.15)!;
    expect(fit.reason).toBe("ceiling");
    expect(fit.volumes[0]).toBeLessThanOrEqual(300);
    expect(fit.volumes[1]).toBeLessThanOrEqual(1500);
    expect(fit.volumes[1]).toBe(fit.volumes[0] * 10);
  });

  it("is only for one Facebook posts service plus one Facebook comments service", () => {
    expect(fitPostsAndComments([items[0]], 600, 0.15)).toBeNull();
    expect(fitPostsAndComments([items[0], { ...items[0] }], 600, 0.15)).toBeNull();
    expect(fitPostsAndComments([{ capabilitySlug: "social-x-posts", targetVolumeMax: 5, unitPricePoints: 1 }, items[1]], 600, 0.15)).toBeNull();
  });

  it("the sentence says what was asked, what the plan holds, the comments per post and why, from the numbers only", () => {
    const text = fitNoticeAr({ items: [{ capabilitySlug: "facebook-post-search", targetVolumeMax: 4 }, { capabilitySlug: "facebook-post-comments", targetVolumeMax: 40 }], asked: [50, 500], reason: "cap", pointsCap: 600, perPost: 10 });
    expect(text).toBe("طلبت ٥٠ منشورًا و٥٠٠ تعليقًا، وتم تقليل الطلب إلى ٤ منشورات و٤٠ تعليقًا (حتى ١٠ تعليقات لكل منشور) ليناسب حدّ الطلب الواحد (حجز لا يتجاوز ٦٠٠ نقطة)، وليس رصيدك. يمكنك طلب الباقي في طلب منفصل.");
    expect(text).not.toMatch(/[A-Za-z0-9]/);
  });
});

describe("the quote of the health-trends plan: one size, priced by the one shared rule, the hold under the cap of 600", () => {
  const caps: any[] = [
    {
      id: "facebook-post-search", slug: "facebook-post-search", platform: "facebook", category: "facebook", nameAr: "بحث منشورات", nameEn: "Facebook Post Search", descriptionAr: "x",
      unitCostUsd: 0.0014, maxRows: 5000, enabled: true, paramsSchema: "{}", tregEndpointId: "internal-facebook-post-search", tregMethod: "GET", pricingUnit: "item",
    },
    {
      id: "facebook-post-comments", slug: "facebook-post-comments", platform: "facebook", category: "facebook", nameAr: "تعليقات منشورات", nameEn: "Facebook Post Comments", descriptionAr: "x",
      unitCostUsd: 0.00188, customerPriceUsdPerItem: 0.0019, maxRows: 500, enabled: true, paramsSchema: "{}", tregEndpointId: "internal-facebook-post-comments", tregMethod: "GET", pricingUnit: "item",
    },
  ];
  const db = () => ({ from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })) })), insert: vi.fn(async (doc: any) => ({ data: doc, error: null })) })) });
  const plan = (posts: number, comments: number) => ({
    summaryAr: "خطة تجريبية بأعداد قديمة ٥٠ منشور و٥٠٠ تعليق",
    items: [
      { capabilitySlug: "facebook-post-search", params: { query: "الترندات الصحية في مصر" }, targetVolumeMin: 1, targetVolumeMax: posts },
      { capabilitySlug: "facebook-post-comments", params: { postUrl: "https://www.facebook.com/post/1" }, targetVolumeMin: 1, targetVolumeMax: comments },
    ],
    outputFormats: ["xlsx"],
  } as any);
  const quote = (posts: number, comments: number) => createAndSaveManagedQuote(db() as any, { conversationId: "conv-health", userId: "user-health", plan: plan(posts, comments), userBalance: 5000, capabilities: caps, pricingSettings: DEFAULT_PRICING_SETTINGS });

  it("the legacy whole-point rule prices these two services (post 8, comment 11): a different capability from the page-link service, which carries a per-record cost", async () => {
    const q = await quote(50, 500);
    expect(q.items.map((i: any) => i.unitPricePoints)).toEqual([8, 11]);
    // the page-link posts service: cost per delivered record 0.000627 USD x 5,500 = 3.4485 -> 3.45 (a different slug, a measured-basis rule)
    expect(recordUnitPricePoints("social-facebook-posts")).toBeCloseTo(3.4485, 4);
    expect(recordUnitPricePoints("facebook-post-search")).toBeNull();
  });

  it("50 posts + 500 comments become 4 posts + 40 comments, the hold is 543 and never above 600, the charge is ceil(delivered x price)", async () => {
    const q = await quote(50, 500);
    expect(q.items.map((i: any) => i.targetVolumeMax)).toEqual([4, 40]);
    expect(q.quotedPoints).toBe(543);
    expect(q.quotedPoints).toBeLessThanOrEqual(600);
    expect(q.expectedPoints).toBe(4 * 8 + 40 * 11);
    expect(q.pointsCapConstrained).toBe(true);
    expect(q.requestedVolumeMax).toBe(550);
    expect(q.fit).toMatchObject({ reason: "cap", asked: [50, 500], perPost: 10 });
    expect(q.fit!.noticeAr).toContain("طلبت ٥٠ منشورًا و٥٠٠ تعليقًا، وتم تقليل الطلب إلى ٤ منشورات و٤٠ تعليقًا");
    // never above the reserve, whatever is delivered
    for (const delivered of [0, 3, 40, 44]) {
      expect(Math.min(q.quotedPoints, chargeForUnits(delivered, 8) + chargeForUnits(delivered * 10, 11))).toBeLessThanOrEqual(q.quotedPoints);
    }
  });

  it("a plan that fits keeps its numbers and carries no reduction sentence", async () => {
    const q = await quote(3, 30);
    expect(q.items.map((i: any) => i.targetVolumeMax)).toEqual([3, 30]);
    expect(q.fit).toBeUndefined();
    expect(q.pointsCapConstrained).toBe(false);
  });

  it("the card shows the SAME count in the title, the scope chip and the sentence: no «حتى ٤٨ سجل» beside «حتى ٤ سجل»", async () => {
    const q = await quote(50, 500);
    const data = {
      quoteId: q.quoteId, summaryAr: q.summaryAr, items: q.items, targetVolumeMax: q.targetVolumeMax, unitPricePoints: q.unitPricePoints, expectedPoints: q.expectedPoints,
      quotedPoints: q.quotedPoints, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"], volumeLimitLineAr: q.fit!.noticeAr, pointsCapConstrained: true,
      expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(), status: "quoted",
    } as PlanQuoteData;
    const html = renderToStaticMarkup(createElement(PlanQuoteCard, {
      quote: data, conversationTitle: "الترندات الصحية في مصر", locked: false, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1,
      onTopupShort: () => {}, onRefresh: async () => {},
    } as any));
    const line = planCountLineAr(q.items);
    expect(line).toBe("حتى ٤ منشورات و٤٠ تعليقًا");
    expect(html.split(line).length - 1).toBeGreaterThanOrEqual(2); // the title and the scope chip
    expect(planScopeRows(q.items as any, "الترندات الصحية في مصر").find((chip) => chip.label === "العدد المطلوب:")?.value).toBe(line);
    expect(html).not.toContain("٤٨ سجل");
    expect(html).not.toContain("٤٤ سجل");
    expect(html).not.toMatch(/حتى ٤ سجل/);
    expect(html).toContain("طلبت ٥٠ منشورًا و٥٠٠ تعليقًا");
    expect(html).toContain("وليس رصيدك");
    // the hold is said ONCE, inside the one price-and-hold sentence (the separate «الحجز المؤقت: …» line is gone)
    expect(html).toContain("والحجز المؤقت ٥٤٣ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده");
    expect(html.split("٥٤٣ نقطة").length - 1).toBe(1);
  });
});

describe("9. the companies card: the price and the hold are two numbers, said apart", () => {
  it("5 companies at 3.168 points: the price is ceil(5 x 3.168) = 16, the hold is ceil(5 x 3.168 x 1.15) = 19 (the buffer on the hold only)", () => {
    const unit = recordUnitPricePoints("icypeas-companies-search")!;
    expect(unit).toBeCloseTo(3.168, 6);
    const q = calculateCapabilityQuote(5, 0.000576, 1000, DEFAULT_PRICING_SETTINGS, "icypeas-companies-search");
    expect(q.expectedPoints).toBe(16);
    expect(q.quotedPoints).toBe(19);
    expect(chargeForUnits(5, unit)).toBe(16);
    expect(reserveForUnits(5, unit, 0.15)).toBe(19);
    const line = priceVsHoldLineAr({ targetVolumeMax: 5, unitPricePoints: unit, expectedPoints: 16, quotedPoints: 19 });
    expect(line).toBe("السعر التقديري ١٦ نقطة (٥ × ٣٫١٧ نقطة، ويُقرَّب لأعلى)، ويُخصم منه فقط ما يُسلَّم فعلًا. والحجز المؤقت ١٩ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده، ولا يُخصم الاحتياطي.");
    expect(line).not.toMatch(/[A-Za-z0-9]/);
  });

  it("the card prints that line before the unit price and the balance verdict (the cap and hold lines are merged into it)", () => {
    const html = renderToStaticMarkup(createElement(PlanQuoteCard, {
      quote: {
        quoteId: "q_c5", summaryAr: "٥ شركات", items: [{ capabilitySlug: "icypeas-companies-search", params: { query: { location: { include: ["Egypt"] }, industry: { include: ["Construction"] } } }, targetVolumeMin: 1, targetVolumeMax: 5 }],
        targetVolumeMax: 5, unitPricePoints: 3.168, expectedPoints: 16, quotedPoints: 19, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"],
        expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(), status: "quoted",
      } as PlanQuoteData,
      locked: false, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
    } as any));
    expect(html).toContain('data-testid="plan-price-vs-hold"');
    expect(html).toContain("السعر التقديري ١٦ نقطة");
    expect(html).toContain("والحجز المؤقت ١٩ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده");
    expect(html.indexOf("plan-price-vs-hold")).toBeLessThan(html.indexOf("plan-unit-price"));
    expect(html.indexOf("plan-price-vs-hold")).toBeLessThan(html.indexOf("plan-balance-verdict"));
    expect(html).not.toContain("plan-cap-line");
    expect(html).not.toContain("plan-hold-line");
  });
});

describe("5 and 6. wallet wording", () => {
  it("a released hold is «حجز مؤقت مُحرَّر», everywhere it is shown, never «تحرير حجز» and never «استرداد»", () => {
    expect(CREDIT_KIND_LABEL_AR.release).toBe("حجز مؤقت مُحرَّر");
    for (const stored of ["تحرير حجز مؤقت", "تحرير الحجز المؤقت", "تحرير الحجز المؤقت كاملًا لفشل الاستخراج"]) {
      const shown = walletDisplayText(stored);
      expect(shown).toContain("حجز مؤقت مُحرَّر");
      expect(shown).not.toMatch(/تحرير|استرداد/);
    }
  });

  it("the top-up requests list carries a clean Arabic label, not the stored reference (rcpt_…)", () => {
    expect(TOPUP_REQUEST_LABEL_AR).toBe("طلب شحن عبر إنستاباي");
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("{TOPUP_REQUEST_LABEL_AR} · {formatDate");
    expect(page).not.toContain("title={t.reference}");
    const html = renderToStaticMarkup(createElement(SubmittedCard, {
      topup: { $id: "t1", amountEgp: 100, status: "pending", reference: "rcpt_0a1b2c3d4e5f", createdAt: "2026-10-23T10:00:00.000Z", senderName: "ا", senderPhone: "010", receiptFileId: "f1" } as any,
      creditValue: 0.1, onBack: () => {}, onContinue: () => {},
    } as any));
    expect(html).not.toContain("rcpt_");
    expect(html).not.toContain("الرقم المرجعي");
  });

  it("the activity line says what the ledger records: the WHOLE hold released, then the charge of what was delivered; never «the remainder only»", () => {
    expect(settlementEventAr({ reservedPoints: 14, chargedPoints: 6 }, toArabicDigits)).toBe("حُرّر الحجز المؤقت كاملًا (١٤ نقطة)، ثم خُصم ثمن ما سُلّم فقط (٦ نقاط)، فيبقى في رصيدك ٨ نقاط من هذا الحجز.");
    expect(settlementEventAr({ reservedPoints: 14, chargedPoints: 0 }, toArabicDigits)).toBe("حُرّر الحجز المؤقت كاملًا (١٤ نقطة) ولم يُخصم أي رصيد.");
    expect(settlementEventAr({ reservedPoints: 14, chargedPoints: 99 }, toArabicDigits)).toContain("فيبقى في رصيدك ٠ نقطة"); // a charge is never above the hold
    for (const text of [settlementEventAr({ reservedPoints: 135, chargedPoints: 4 }, toArabicDigits)]) {
      expect(text).not.toMatch(/استرداد|متبقية|[A-Za-z0-9]/);
    }
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).not.toContain("متبقية تلقائياً لرصيدك");
  });
});

describe("7. the run message: while the page drives the job the only guidance is «أبقِ الصفحة مفتوحة حتى تكتمل المهمة»", () => {
  it("no notification promise before it, in the message or in the start notice", () => {
    expect(POST_APPROVAL_TAB_AR).toBe("جاري سحب البيانات. أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(postApprovalMessageAr(undefined)).toBe(POST_APPROVAL_TAB_AR);
    expect(postApprovalMessageAr("tab")).not.toMatch(/إشعار|سيصلك|سنخبرك/);
    for (const driver of ["tab", undefined] as const) {
      const body = jobStartedNotice({ targetVolumeMax: 1500, driver }).body;
      expect(body).toContain("أبقِ الصفحة مفتوحة حتى تكتمل المهمة");
      expect(body).not.toMatch(/إشعار|سيصلك|سنخبرك/);
    }
  });
});

describe("8. the live preview: Arabic-Indic digits in dates and numbers, and a link column on a Facebook table", () => {
  it("an ISO date, a date with a time, a number and «3 weeks ago» are shown in Arabic-Indic digits; a comment's own words are left as written", () => {
    const rows = [
      { text: "تعليق عن 5 مباريات", published_at: "2026-10-20T14:05:09Z", likes_count: 1234 },
      { text: "تعليق ثانٍ", published_at: "2026-10-21", likes_count: 7 },
      { text: "تعليق ثالث", published_at: "3 weeks ago", likes_count: 0 },
    ];
    const sample = buildLivePreviewSample(rows, ["text", "published_at", "likes_count"], false)!;
    const flat = sample.rows.flat();
    expect(flat).toContain("٢٠٢٦-١٠-٢٠T١٤:٠٥:٠٩Z");
    expect(flat).toContain("٢٠٢٦-١٠-٢١");
    expect(flat).toContain("١٢٣٤");
    expect(flat).toContain("٧");
    expect(flat).toContain("منذ ٣ أسابيع");
    expect(flat).toContain("تعليق عن 5 مباريات");
    for (const cell of flat.filter((c) => /^\d{4}-/.test(c) || /^\d+$/.test(c))) throw new Error(`a Latin-digit date or number in the preview: ${cell}`);
  });

  it("a Facebook posts table keeps the post's link column; the other tables keep their columns", () => {
    const columns = ["id", "text", "author_name", "published_at", "likes_count", "url"];
    const shown = previewColumns(columns, false);
    expect(shown).not.toContain("url");
    expect(ensurePostLinkColumn(shown, columns, "facebook")).toContain("url");
    expect(ensurePostLinkColumn(shown, columns, "Facebook").filter((c) => c === "url")).toHaveLength(1);
    expect(ensurePostLinkColumn(shown, columns, "x")).toEqual(shown);
    expect(ensurePostLinkColumn(shown, ["id", "text"], "facebook")).toEqual(shown); // no link in the data: nothing to add
    // a comments table already shows the post's link (video_url): nothing is added twice
    const commentColumns = ["id", "comment_text", "video_url", "url"];
    expect(ensurePostLinkColumn(previewColumns(commentColumns, false), commentColumns, "facebook")).toEqual(previewColumns(commentColumns, false));
  });
});

describe("3. the stall guard: a source that repeats itself is not asked again and again", () => {
  const base = { acceptedThisPage: 0, targetMax: 10, pageSize: 3, kind: "feed" as const, deliveredTotal: 3, pagesDone: 3 };

  it("a page made only of rows already delivered, right after a page with nothing new, stops with its own honest reason (any job size)", () => {
    expect(evaluateProviderCallCap({ ...base, priorBatchUnits: [3, 0], pageRepeatedOnly: true })).toBe("source_repeats");
    // a large job waited for a third empty page before; a repeat now stops at the second
    expect(evaluateProviderCallCap({ ...base, targetMax: 400, pageSize: 20, priorBatchUnits: [3, 0], pageRepeatedOnly: true })).toBe("source_repeats");
    expect(evaluateProviderCallCap({ ...base, targetMax: 400, pageSize: 20, priorBatchUnits: [3, 0], pageRepeatedOnly: false })).toBeNull();
  });

  it("ONE repeated page after a page with new rows is still allowed (a source may repeat a page and go on)", () => {
    expect(evaluateProviderCallCap({ ...base, priorBatchUnits: [3], pageRepeatedOnly: true, pagesDone: 2 })).toBeNull();
    expect(evaluateProviderCallCap({ ...base, priorBatchUnits: [null], pageRepeatedOnly: true, pagesDone: 2 })).toBeNull(); // an unreadable page never counts as empty
  });

  it("a page with new rows is never a repeat, whatever the flag says", () => {
    expect(evaluateProviderCallCap({ ...base, acceptedThisPage: 2, priorBatchUnits: [3, 0], pageRepeatedOnly: true })).toBeNull();
  });

  it("the customer is told, in Arabic only, that the source has nothing new and that only what was delivered is charged", () => {
    const note = CALL_CAP_NOTE_AR.source_repeats;
    expect(note).toContain("المصدر لا يحتوي على عناصر جديدة أخرى");
    expect(note).toContain("لم يُحتسب عليك إلا ما سُلّم");
    expect(note).toContain("حُرّر الباقي من الحجز المؤقت");
    expect(note).not.toMatch(/[A-Za-z]|استرداد/);
  });

  it("the worker wires the flag from the page's own duplicate count and says the note first", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("pageRepeatedOnly: trackRunningSet && currentStep > 0 && rowsBeforeDedupe > 0 && duplicateExcludedCount >= rowsBeforeDedupe");
    expect(worker).toContain('callCapReason === "source_repeats"');
  });
});

describe("4. TikTok topic comments come from several videos when the source has them", () => {
  const NOW = Date.parse("2026-10-23T12:00:00Z");
  const ok = (rows: Array<Record<string, any>>): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows }, costMicro: 1000, tregCallId: "call" });
  const video = (n: number) => ({ aweme_id: `70000000000000${String(n).padStart(4, "0")}`, desc: `فيديو رقم ${n} عن كرة السلة` });
  const input = (params: Record<string, any>) => ({
    jobId: "job_d", userId: "u", step: 0, endpointId: "tikhub.tiktok.video.comments", capabilitySlug: "social-tiktok-comments", method: "POST" as const, params,
    paginationStrategy: "cursor" as const, cursor: null, pageSize: 50, remainingNeeded: 50, targetVolumeMax: 50, deliveredSoFar: 0,
  });
  const harness = (adoptPerPage: number[]) => {
    const searches: number[] = [];
    const judged: string[][] = [];
    const call: SocialCall = async (source, params) => {
      if (source.endpointId.includes(".search.")) {
        const offset = Number(params.offset ?? params.cursor ?? 0);
        searches.push(offset);
        return ok(Array.from({ length: 10 }, (_, i) => video(offset + i)));
      }
      return ok([{ comment_id: `c_${String(params.aweme_id ?? params.video_id ?? params.url ?? Math.random())}`, text: "تعليق مفيد عن الموضوع كله" }]);
    };
    let page = 0;
    const videoSelector = async (refs: any[]) => {
      judged.push(refs.map((ref) => String(ref.title)));
      const take = adoptPerPage[Math.min(page, adoptPerPage.length - 1)];
      page += 1;
      return { adopted: refs.slice(0, take) };
    };
    return { call, videoSelector, searches, judged };
  };

  it("one adopted video on the first page: ONE more page of results is judged (by the same review) before any comment is read", async () => {
    const h = harness([1, 4]);
    await runSocialChunk(input({ query: "كرة السلة", videoCount: 10 }) as any, { call: h.call, now: () => NOW, videoSelector: h.videoSelector });
    expect(h.searches).toEqual([0, 10]);
    expect(h.judged).toHaveLength(2);
    expect(h.judged[0]).toHaveLength(10);
    expect(h.judged[1]).toHaveLength(10);
    // a video the first page showed is never judged again
    expect(h.judged[1].every((title) => !h.judged[0].includes(title))).toBe(true);
  });

  it("never more than ONE extra page, even when still too few videos are adopted", async () => {
    const h = harness([1, 0, 0]);
    await runSocialChunk(input({ query: "كرة السلة", videoCount: 10 }) as any, { call: h.call, now: () => NOW, videoSelector: h.videoSelector });
    expect(h.searches).toHaveLength(2);
    expect(h.judged).toHaveLength(2);
  });

  it("five videos adopted on the first page: no extra page is searched", async () => {
    const h = harness([5]);
    await runSocialChunk(input({ query: "كرة السلة", videoCount: 10 }) as any, { call: h.call, now: () => NOW, videoSelector: h.videoSelector });
    expect(h.searches).toEqual([0]);
    expect(h.judged).toHaveLength(1);
  });

  it("nothing adopted on the first page keeps the old rule (the wider search), not the extra page", async () => {
    const h = harness([0]);
    const out = await runSocialChunk(input({ query: "كرة السلة", videoCount: 10 }) as any, { call: h.call, now: () => NOW, videoSelector: h.videoSelector });
    expect(out.emptyReason).toBe("no_relevant_videos");
  });
});
