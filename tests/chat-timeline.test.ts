import { describe, expect, it } from "vitest";
import { buildChatTimeline, type ChatTimelineItem } from "../src/lib/chatTimeline";

interface Message extends ChatTimelineItem {
  planQuote?: { quoteId: string };
}

describe("chat timeline", () => {
  it("keeps the first request, plan and later customer turn chronological while deduplicating messages and job errors", () => {
    const error = "تعذر بدء البحث بعد عدة محاولات. أُعيدت النقاط المحجوزة إلى رصيدك.";
    const messages: Message[] = [
      { id: "customer-1", role: "user", content: "طلب البحث الأول", createdAt: "2026-10-17T10:00:00Z" },
      { id: "assistant-1", role: "assistant", content: "هذه خطة البحث", createdAt: "2026-10-17T10:01:00Z" },
      { id: "plan-1", role: "assistant", content: "تفاصيل الخطة", planQuote: { quoteId: "q1" }, createdAt: "2026-10-17T10:02:00Z" },
      { id: "customer-1", role: "user", content: "نسخة مكررة من الطلب", createdAt: "2026-10-17T10:00:00Z" },
      { id: "customer-2", role: "user", content: "رسالة لاحقة", createdAt: "2026-10-17T10:05:00Z" },
    ];
    const timeline = buildChatTimeline(messages, {
      jobId: "j1",
      status: "failed",
      errorAr: error,
      updatedAt: "2026-10-17T10:04:00Z",
      events: [
        { id: "event-error-1", kind: "error", textAr: error, createdAt: "2026-10-17T10:04:00Z" },
        { id: "event-error-2", kind: "error", textAr: error, createdAt: "2026-10-17T10:04:01Z" },
      ],
    });

    expect(timeline.map((item) => item.id)).toEqual([
      "customer-1", "assistant-1", "plan-1", "job_error_j1", "customer-2",
    ]);
    expect(timeline[0].content).toBe("طلب البحث الأول");
    expect(timeline[2]).toMatchObject({ planQuote: { quoteId: "q1" } });
    expect(timeline.filter((item) => item.content === error)).toHaveLength(1);
    expect(timeline.at(-1)?.content).toBe("رسالة لاحقة");
  });

  it("moves an existing duplicate failure message to the job's terminal time and shows it once", () => {
    const error = "انتهى البحث وأُعيد الرصيد المحجوز.";
    const timeline = buildChatTimeline([
      { id: "plan", role: "assistant", content: "الخطة", createdAt: "2026-10-17T10:01:00Z" },
      { id: "error-old", role: "assistant", content: error, createdAt: "2026-10-17T10:00:00Z" },
      { id: "error-copy", role: "assistant", content: error, createdAt: "2026-10-17T10:00:01Z" },
      { id: "later", role: "user", content: "رسالة أخرى", createdAt: "2026-10-17T10:03:00Z" },
    ], {
      jobId: "j2", status: "failed", errorAr: error, updatedAt: "2026-10-17T10:02:00Z",
    });

    expect(timeline.map((item) => item.id)).toEqual(["plan", "error-old", "later"]);
    expect(timeline[1].createdAt).toBe("2026-10-17T10:02:00Z");
  });
});
