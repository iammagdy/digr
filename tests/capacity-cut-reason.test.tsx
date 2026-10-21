import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { CAPACITY_LIMITED_REASON_AR } from "../src/lib/jobCaps";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";

const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const quote = (extra: Record<string, unknown> = {}) => ({
  quoteId: "q1", summaryAr: "تعليقات تيك توك عن كرة القدم", itemCount: 1,
  items: [{ capabilitySlug: "social-tiktok-comments", params: { query: "كرة القدم", region: "EG", dateFrom: "2026-09-20", dateTo: "2026-10-20" }, targetVolumeMin: 1, targetVolumeMax: 7 }],
  targetVolumeMax: 7, unitPricePoints: 6, expectedPoints: 42, quotedPoints: 49, isAffordable: true, userBalance: 1236, outputFormats: ["xlsx"],
  expiresAt: future(), status: "quoted", askedVolumeMax: 30, requestedVolumeMax: 30, ...extra,
});
const render = (q: any) => renderToStaticMarkup(createElement(PlanQuoteCard, {
  quote: q, locked: false, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 1236, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
} as any));

describe("a count cut by the live capacity says why, in one plain sentence", () => {
  it("the card: what fits now, then why and what to do; no advice to reduce the count", () => {
    const html = render(quote({ capacityConstrained: true }));
    expect(html).toContain('data-testid="plan-volume-limit"');
    expect(html).toContain("طلبت ٣٠ سجل، والذي تتسع له سعة الاستخراج المتاحة الآن ٧ سجل");
    expect(html).toContain("سعة المصدر المتاحة الآن محدودة، ونوصي بإعادة المحاولة لاحقًا.");
    expect(html).not.toContain("يمكنك تقليل العدد أكثر إذا أردت");
    expect(CAPACITY_LIMITED_REASON_AR).not.toMatch(/[A-Za-z0-9]|مزود|مزوّد|دولار|USD/);
  });

  it("a cut by the points cap keeps its own sentences and does not claim a capacity reason", () => {
    const html = render(quote({ capacityConstrained: false, pointsCapConstrained: true, pointsCap: 600, requestedVolumeMax: 1000, askedVolumeMax: 2000, targetVolumeMax: 57 }));
    expect(html).toContain("يمكنك تقليل العدد أكثر إذا أردت");
    expect(html).not.toContain("سعة المصدر المتاحة الآن محدودة");
  });

  it("a plan that was not cut says nothing about capacity", () => {
    expect(render(quote({ askedVolumeMax: 7, requestedVolumeMax: 7 }))).not.toContain("سعة المصدر المتاحة الآن محدودة");
  });
});

describe("the plan text of a request the live capacity cut", () => {
  afterEach(() => resetProviderBalanceCacheForTesting());

  it("states the cut count and the reason; the old «لضمان دقة وسرعة التنفيذ» line is gone; nothing in Latin letters", async () => {
    // 0.001 USD budget (0.0009 safe) holds 18 comments at 0.00005 USD each, below the 30 asked
    setProviderBalanceForTesting(0.001);
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    await db.createRow({ tableId: "conversations", rowId: "conv_cap", data: { userId: "user_cap", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    const response = await handler.handleUserMessage({ userId: "user_cap", conversationId: "conv_cap", message: "٣٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.capacityConstrained).toBe(true);
    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
    const text = String(response.contentAr || "");
    expect(text).toContain("سبب الحد: سعة المصدر المتاحة الآن محدودة، ونوصي بإعادة المحاولة لاحقًا.");
    expect(text).not.toContain("لضمان دقة وسرعة التنفيذ");
    expect(text).not.toContain("تنبيه السعة");
    expect(text).not.toMatch(/مزود|مزوّد|USD|دولار/);
  });
});
