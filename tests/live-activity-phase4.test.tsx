import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  formatActivityStep,
  formatCurrentPostProgress,
  formatItemsCollectedProgress,
  formatPointsSpentVsReserved,
  formatCapReachedMessage,
  sanitizeActivityError,
  sanitizeActivityText,
  deriveLiveActivitySnapshot,
  estimateRemainingSecondsFromBatches,
  ThrottledActivityEmitter,
} from "../src/functions/shared/liveActivityFeed";

describe("Phase 4: Live Activity Feed (Arabic & Points Only, Throttled Updates, Cap Stops)", () => {
  it("estimates remaining time from measured cumulative batch timestamps and waits for enough samples", () => {
    const events = [
      { kind: "progress", count: 100, createdAt: "2026-10-16T10:00:00.000Z" },
      { kind: "progress", count: 200, createdAt: "2026-10-16T10:00:10.000Z" },
    ];
    expect(estimateRemainingSecondsFromBatches(events, 200, 400)).toBe(20);
    expect(estimateRemainingSecondsFromBatches(events.slice(0, 1), 100, 400)).toBeNull();
    expect(estimateRemainingSecondsFromBatches(events, 400, 400)).toBeNull();
  });

  it("formats current step, current post, items collected, and points spent vs reserved in Arabic and points only", () => {
    expect(formatActivityStep("search_posts")).toBe("البحث عن المنشورات...");
    expect(formatActivityStep("collect_comments")).toBe("جمع التعليقات...");

    expect(formatCurrentPostProgress(3, 84, "نقاش حول قائمة المنقولات")).toBe(
      "المنشور 3 من 84: نقاش حول قائمة المنقولات"
    );
    expect(formatItemsCollectedProgress(10, 306)).toBe("تم جلب 10 تعليقات - الإجمالي 306");
    expect(formatPointsSpentVsReserved(38, 450)).toBe("المستهلك 38 نقطة من 450");

    // Scrubs any accidental provider name or dollar figure
    const dirty = "تجاوز الطلب سقف التكلفة ($0.01 USD) لدى TREG / TikHub";
    const clean = sanitizeActivityText(dirty);
    expect(clean).not.toContain("$");
    expect(clean).not.toMatch(/usd|treg|tikhub/i);
  });

  it("replaces internal job diagnostics with customer-safe Arabic error messages", () => {
    expect(sanitizeActivityError("مزود البيانات الحقيقي معطل حالياً في البيئة (TREG_LIVE!=true)."))
      .toBe("الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
    expect(sanitizeActivityError("تعذر معالجة مدخلات الطلب لدى المزود (422): icypeas.companies.search Parameter url is required"))
      .toBe("تعذر معالجة تفاصيل الطلب. راجع المعلومات المطلوبة وحاول مجدداً.");
    expect(sanitizeActivityError("خطأ من icypeas.companies.search أثناء المعالجة"))
      .toBe("الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
    expect(sanitizeActivityError("تم بلوغ الحد اليومي لمزود البيانات ($0.80 USD)."))
      .toBe("الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
    expect(sanitizeActivityError("المصدر مشغول حالياً (429 Rate Limit)."))
      .toBe("تعذر إكمال البحث حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
  });

  it("throttles page progress updates to at most every 2-3 seconds and emits one summary event per post (never one DB row per page)", async () => {
    let fakeTime = 1_000_000;
    const writtenEvents: Array<{ textAr: string; count: number; kind: string }> = [];

    const emitter = new ThrottledActivityEmitter({
      minIntervalMs: 2500,
      maxPostsCap: 84,
      reservedPointsCap: 450,
      nowFn: () => fakeTime,
      writeEventFn: (evt) => {
        writtenEvents.push(evt);
      },
    });

    await emitter.emitStep("search_posts");
    expect(writtenEvents).toHaveLength(1);
    expect(writtenEvents[0].textAr).toBe("البحث عن المنشورات...");

    // Simulate 5 rapid pagination pages within 1.5 seconds -> should NOT emit 5 DB rows!
    for (let page = 1; page <= 5; page++) {
      fakeTime += 300; // +300ms per page (1500ms total < 2500ms throttle)
      const res = await emitter.recordPageBatch(10, 2);
      expect(res.emitted).toBe(false);
    }
    expect(writtenEvents).toHaveLength(1);
    expect(emitter.getTotalItems()).toBe(50);

    // Advance clock past 2.5s window -> next page batch emits once
    fakeTime += 1500; // now +3000ms since step emit
    const throttledRes = await emitter.recordPageBatch(10, 2);
    expect(throttledRes.emitted).toBe(true);
    expect(writtenEvents).toHaveLength(2);
    expect(writtenEvents[1].textAr).toContain("تم جلب 10 تعليقات - الإجمالي 60");
    expect(writtenEvents[1].textAr).toContain("المستهلك 12 نقطة من 450");

    // Emit one summary event for a post
    const postSummary = await emitter.emitPostSummary({
      postIndex: 3,
      totalPosts: 84,
      titleOrUrl: "https://facebook.com/posts/12345",
      postCommentsFetched: 10,
      postPointsDelta: 26,
    });
    expect(postSummary.emitted).toBe(true);
    expect(writtenEvents[writtenEvents.length - 1].textAr).toContain(
      "المنشور 3 من 84: https://facebook.com/posts/12345"
    );
    expect(writtenEvents[writtenEvents.length - 1].textAr).toContain("المستهلك 38 نقطة من 450");
  });

  it("stops cleanly at the post cap or points cap with a clear Arabic message", async () => {
    const events: string[] = [];
    const postCapEmitter = new ThrottledActivityEmitter({
      maxPostsCap: 3,
      reservedPointsCap: 450,
      writeEventFn: (e) => {
        events.push(e.textAr);
      },
    });

    const r1 = await postCapEmitter.emitPostSummary({
      postIndex: 3,
      totalPosts: 3,
      titleOrUrl: "منشور أخير",
      postCommentsFetched: 15,
      postPointsDelta: 10,
    });
    expect(r1.capReached).toBe("post_cap");
    expect(postCapEmitter.isStoppedByCap()).toBe("post_cap");
    expect(events[events.length - 1]).toBe(formatCapReachedMessage("post_cap", 3));

    // Subsequent calls do not emit after cap is reached
    const afterCap = await postCapEmitter.emitPostSummary({
      postIndex: 4,
      totalPosts: 3,
      titleOrUrl: "منشور إضافي",
      postCommentsFetched: 10,
    });
    expect(afterCap.emitted).toBe(false);

    // Points cap check
    const pointsEvents: string[] = [];
    const pointsCapEmitter = new ThrottledActivityEmitter({
      maxPostsCap: 50,
      reservedPointsCap: 100,
      writeEventFn: (e) => {
        pointsEvents.push(e.textAr);
      },
    });
    const pRes = await pointsCapEmitter.recordPageBatch(20, 100);
    expect(pRes.capReached).toBe("points_cap");
    expect(pointsEvents[pointsEvents.length - 1]).toBe(formatCapReachedMessage("points_cap", 100));
  });

  it("derives live activity snapshot for ActivityTimeline with current step, current post, items collected, points spent vs reserved, and cap message", () => {
    const snapshot = deriveLiveActivitySnapshot({
      status: "running",
      rowsCollected: 306,
      chargedCredits: 38,
      reservedCredits: 450,
      events: [
        {
          textAr: "جمع التعليقات...",
          kind: "progress",
          createdAt: "2026-10-11T10:00:00Z",
        },
        {
          textAr: "المنشور 3 من 84: مناقشة قضايا الأسرة — تم جلب 10 تعليقات - الإجمالي 306",
          count: 306,
          kind: "progress",
          createdAt: "2026-10-11T10:00:03Z",
        },
        {
          textAr: formatCapReachedMessage("post_cap", 84),
          count: 306,
          kind: "info",
          createdAt: "2026-10-11T10:00:06Z",
        },
      ],
    });

    expect(snapshot.currentStepAr).toBe("جمع التعليقات...");
    expect(snapshot.currentPostIndex).toBe(3);
    expect(snapshot.totalPosts).toBe(84);
    expect(snapshot.lastBatchComments).toBe(10);
    expect(snapshot.totalItemsCollected).toBe(306);
    expect(snapshot.spentPoints).toBe(38);
    expect(snapshot.reservedPoints).toBe(450);
    expect(snapshot.capReached?.kind).toBe("post_cap");

    const timelineSource = readFileSync("src/app/dashboard/chat/components/ActivityTimeline.tsx", "utf-8");
    expect(timelineSource).toContain("deriveLiveActivitySnapshot");
    expect(timelineSource).toContain("مصروف ${formatAr(spent)} من ${formatAr(reserved)}");
    expect(timelineSource).toContain("sanitizeActivityText");
  });
});
