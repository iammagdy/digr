import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { defaultCapFittedLineAr, defaultCapLineAr, defaultVolumeStatementAr } from "../src/lib/planDefaults";

/**
 * Live QA of 72d0a07: a count the plan chose because the customer skipped the question read «طلبت ٥٠٠ سجل» on the plan card, as if it
 * were the customer's choice. Every path that applies a default now labels it as a default, on the plan card and in the message, and
 * a number the customer wrote is still «طلبت». Everything runs through the real chat handler with the model stubbed to throw.
 */
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);
const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const RECORDS_CAP_Q = "ما الحد الأقصى لعدد السجلات الذي تريده؟";
const TIME_Q = "ما الفترة الزمنية التي تهمّك؟";
const DEFAULT_LINE_COMMENTS = "العدد المطلوب: ٥٠٠ تعليق (قيمة افتراضية لأنك لم تحدد عددًا)";
const DEFAULT_LINE_RECORDS = "العدد المطلوب: ٥٠٠ سجل (قيمة افتراضية لأنك لم تحدد عددًا)";

async function conversation(messages: string[]) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_defaults", data: { userId: "user_defaults", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const responses: any[] = [];
  for (const message of messages) responses.push(await handler.handleUserMessage({ userId: "user_defaults", conversationId: "conv_defaults", message, userBalance: 5000 }));
  return responses;
}
const planOf = (responses: any[]) => responses.find((r) => r.outputType === "propose_plan");
const card = (quote: any) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

/** The card of a plan whose count is a default: the default sentence, never «طلبت». */
function expectLabelledOnCard(plan: any, defaultLine: string) {
  expect(plan.planQuote.defaultCap).toMatchObject({ units: 500 });
  const html = card(plan.planQuote);
  expect(html).toContain('data-testid="plan-default-volume"');
  expect(html).toContain(defaultLine);
  expect(html).toContain("وتقدر تعدّله من الخطة");
  expect(html).not.toContain("طلبت ٥٠٠");
  expect(html).not.toContain("طلبك الكامل (٥٠٠");
  expect(html).not.toContain("تم ضبط العدد من ٥٠٠");
  expect(html).not.toContain('data-testid="plan-volume-limit"');
  // and the message carries the same sentence
  expect(plan.contentAr).toContain(defaultLine);
  expect(plan.contentAr).not.toContain("طلبت ٥٠٠");
}

describe("the sentences", () => {
  it("the default line, the fitted line, and the whole statement for the card", () => {
    expect(defaultCapLineAr("comments", 500)).toBe("العدد المطلوب: ٥٠٠ تعليق (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(defaultCapLineAr("records", 500)).toContain("٥٠٠ سجل (قيمة افتراضية");
    expect(defaultCapLineAr("videos", 10)).toContain("١٠ فيديو (قيمة افتراضية");
    const cut = defaultVolumeStatementAr({ noun: "comments", defaultUnits: 500, fittedUnits: 57, quotedPoints: 590, pointsCap: 600 });
    expect(cut).toBe(`${defaultCapLineAr("comments", 500)} ${defaultCapFittedLineAr({ noun: "comments", fittedUnits: 57, quotedPoints: 590, pointsCap: 600 })}`);
    expect(cut).toContain("لكن الطلب الواحد يتسع الآن لـ٥٧ تعليق بحجز ٥٩٠ نقطة ضمن سقف ٦٠٠ نقطة");
    expect(cut).not.toContain("طلبت");
    expect(defaultVolumeStatementAr({ noun: "records", defaultUnits: 500, fittedUnits: 500, quotedPoints: 100, pointsCap: 600 })).toBe(defaultCapLineAr("records", 500));
  });
});

describe("every path that applies a default labels it on the plan card and in the message", () => {
  it("YouTube comments of videos found by a topic, the cap skipped", async () => {
    const plan = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q)]));
    expect(plan.planQuote.defaultCap.noun).toBe("comments");
    expectLabelledOnCard(plan, DEFAULT_LINE_COMMENTS);
  });

  it("TikTok comments of videos found by a topic, the cap skipped", async () => {
    const plan = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على تيك توك عن منتخب مصر", answer("volume_cap_required", CAP_Q)]));
    expect(plan.planQuote.defaultCap.noun).toBe("comments");
    expectLabelledOnCard(plan, DEFAULT_LINE_COMMENTS);
  });

  it("X posts, the cap skipped", async () => {
    const plan = planOf(await conversation(["كل تغريدات مباراة مصر والمغرب في كأس العالم وردودها", answer("volume_cap_required", RECORDS_CAP_Q)]));
    expect(plan.planQuote.defaultCap.noun).toBe("records");
    expectLabelledOnCard(plan, DEFAULT_LINE_RECORDS);
  });

  it("TikTok videos with no count: the plan's small sample is a labelled default, not the customer's number", async () => {
    const plan = planOf(await conversation(["عايز فيديوهات تيك توك عن القهوة", answer("social_time_required", TIME_Q)]));
    expect(plan.planQuote.items[0].capabilitySlug).toBe("social-tiktok-videos");
    expect(plan.planQuote.defaultCap).toEqual({ noun: "videos", units: 10 });
    const html = card(plan.planQuote);
    expect(html).toContain('data-testid="plan-default-volume"');
    expect(html).toContain("العدد المطلوب: ١٠ فيديو (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(html).not.toContain("طلبت ١٠");
    expect(plan.contentAr).toContain("العدد المطلوب: ١٠ فيديو (قيمة افتراضية لأنك لم تحدد عددًا)");
  });

  it("TikTok videos with a count the customer wrote: no default label", async () => {
    const written = planOf(await conversation(["عايز ٢٠ فيديو تيك توك عن القهوة", answer("social_time_required", TIME_Q)]));
    expect(written.planQuote.defaultCap).toBeUndefined();
    expect(written.planQuote.targetVolumeMax).toBe(20);
    const english = planOf(await conversation(["عايز 30 فيديو تيك توك عن القهوة", answer("social_time_required", TIME_Q)]));
    expect(english.planQuote.defaultCap).toBeUndefined();
    expect(english.planQuote.targetVolumeMax).toBe(30);
  });

  it("a channels mission, the cap skipped", async () => {
    const plan = planOf(await conversation(["أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب مع كل التعليقات", "@aljazeera و@alarabiya و@skynews", answer("volume_cap_required", CAP_Q)]));
    expect(plan.planQuote.defaultCap.noun).toBe("comments");
    expectLabelledOnCard(plan, DEFAULT_LINE_COMMENTS);
  });

  it("a mission with the channels skipped (videos found by a topic), the cap skipped", async () => {
    const plan = planOf(await conversation([
      "أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب مع كل التعليقات",
      answer("social_channel_required", "ما أسماء القنوات أو روابطها؟"),
      answer("social_topic_required", "ما موضوع الفيديوهات التي تريد تعليقاتها؟ سأبحث عن أعلاها مشاهدة بدل القنوات.", "منتخب مصر"),
      answer("volume_cap_required", CAP_Q),
    ]));
    expect(plan).toBeTruthy();
    expect(plan.planQuote.defaultCap.noun).toBe("comments");
    expectLabelledOnCard(plan, DEFAULT_LINE_COMMENTS);
  });
});

describe("a number the customer chose is still «طلبت»", () => {
  it("a count written in the request, and a count tapped on the cap card, are the customer's", async () => {
    const written = planOf(await conversation(["عايز ٥٠٠ منشور على إكس عن الغلاء آخر شهر"]));
    expect(written.planQuote.defaultCap).toBeUndefined();
    const html = card(written.planQuote);
    expect(html).not.toContain('data-testid="plan-default-volume"');
    expect(html).not.toContain("قيمة افتراضية");

    // a count tapped on the cap card that is larger than one job holds: the card says «طلبت» (30,000 asked, 15,810 held)
    setProviderBalanceForTesting(10);
    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٣٠٠٠٠ تعليق")]));
    resetProviderBalanceCacheForTesting();
    expect(tapped.planQuote.defaultCap).toBeUndefined();
    const tappedHtml = card(tapped.planQuote);
    expect(tappedHtml).toContain("طلبت ٣٠٠٠٠");
    expect(tappedHtml).not.toContain("قيمة افتراضية");
    expect(tapped.contentAr).not.toContain("قيمة افتراضية");
  });
});
