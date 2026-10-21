import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { VOLUME_LIMIT_REASON_AR, volumeLimitStatementAr } from "../src/lib/jobCaps";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

/**
 * Never shrink silently. With 2,000 comments asked, the plan used to say «up to 1,000» (a service ceiling) while the job cap cut
 * the plan to 57 (at the old whole-point price of 9 points a comment). Now: what was asked, what fits one job now, and why in one plain
 * sentence. No cap value is changed here; at the per-record price of 0.275 points a comment the cap (600) holds 1,897 comments, so the
 * service's own ceiling (1,000) is what limits this plan.
 */
const M1_WITH_CAP = "عايز أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya وقناة @SkyNewsArabia على يوتيوب مع كل التعليقات حتى ٢٠٠٠ تعليق";

describe("the volume statement", () => {
  it("says what was asked, what fits now and why, in Arabic digits", () => {
    const text = volumeLimitStatementAr({ askedUnits: 2000, fittedUnits: 57 })!;
    expect(text).toBe("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
    expect(text).toContain(VOLUME_LIMIT_REASON_AR);
    expect(text).not.toMatch(/[0-9]|undefined|null|NaN/);
  });

  it("says nothing when everything asked is held, and never states a zero or a larger fit", () => {
    expect(volumeLimitStatementAr({ askedUnits: 50, fittedUnits: 50 })).toBeNull();
    expect(volumeLimitStatementAr({ askedUnits: 50, fittedUnits: 80 })).toBeNull();
    expect(volumeLimitStatementAr({ askedUnits: 50, fittedUnits: 0 })).toBeNull();
    expect(volumeLimitStatementAr({ askedUnits: 2000, fittedUnits: 57, unitLabelAr: "تعليق" })).toContain("٥٧ تعليق");
  });
});

describe("through the chat handler (model stubbed to throw)", () => {
  const run = async (message: string) => {
    const handler = new ChatHandler(createChatDb() as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    return handler.handleUserMessage({ userId: "u_cap_text", message, userBalance: 100000 }) as Promise<any>;
  };

  it("2,000 comments asked: the text and the quote say 2,000 asked, 1,000 fit (the service's own ceiling), and why; the goal line no longer says «up to 1,000»", async () => {
    const reply = await run(M1_WITH_CAP);
    expect(reply.outputType).toBe("propose_plan");
    const quote = reply.planQuote;
    expect(quote.askedVolumeMax).toBe(2000);
    expect(quote.targetVolumeMax).toBe(1000);
    expect(reply.contentAr).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ١٠٠٠ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
    expect(reply.contentAr).toContain("حتى ١٠٠٠ تعليقاً إجمالاً");
    expect(quote.summaryAr).toContain("١٠٠٠");
  });

  it("the plan numbers: 1,000 comments at 0.275 points each (275 charge), 317 held, the cap still 600", async () => {
    const quote = (await run(M1_WITH_CAP)).planQuote;
    expect(quote).toMatchObject({ targetVolumeMax: 1000, unitPricePoints: 0.275, expectedPoints: 275, quotedPoints: 317, pointsCap: 600, pointsCapConstrained: false });
  });

  it("a request that fits carries no limit sentence and no asked volume", async () => {
    const reply = await run("عايز ٥٠ بوست على إكس عن الغلاء آخر شهر");
    expect(reply.contentAr).not.toContain(VOLUME_LIMIT_REASON_AR);
    expect(reply.planQuote.askedVolumeMax).toBeUndefined();
  });

  it("37,500 X posts: asked 37,500, fits 500 (the service's own ceiling: 59 charge, 68 held), with the reason", async () => {
    const reply = await run("عايز ٣٧٥٠٠ بوست على إكس عن ماتش مصر والمغرب آخر شهر");
    expect(reply.planQuote.askedVolumeMax).toBe(37500);
    expect(reply.planQuote).toMatchObject({ targetVolumeMax: 500, unitPricePoints: 0.11715, expectedPoints: 59, quotedPoints: 68, pointsCap: 600 });
    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٠٠ سجل.");
    expect(reply.contentAr).toContain(VOLUME_LIMIT_REASON_AR);
  });
});

describe("the plan panel", () => {
  const noop = () => {};
  const quote = (extra: Partial<PlanQuoteData> = {}): PlanQuoteData => ({
    quoteId: "q1", summaryAr: "سحب تعليقات", items: [{ capabilitySlug: "social-youtube-comments", params: { channels: ["@a"] }, targetVolumeMin: 1, targetVolumeMax: 57 }],
    targetVolumeMax: 57, unitPricePoints: 9, expectedPoints: 513, quotedPoints: 590, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted", ...extra,
  });
  const render = (q: PlanQuoteData) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: noop, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: noop, onRefresh: async () => {} } as any));

  it("shows the asked volume, the volume that fits and the reason when the plan holds fewer records than asked", () => {
    const html = render(quote({ askedVolumeMax: 2000, requestedVolumeMax: 1000, pointsCapConstrained: true, pointsCap: 600 }));
    expect(html).toContain('data-testid="plan-volume-limit"');
    expect(html).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل.");
    expect(html).toContain("يتحدد الحد بسبب سقف المهمة الحالي.");
  });

  it("falls back to the server's own requested volume when the asked volume is not carried (a restored or edited plan)", () => {
    const html = render(quote({ requestedVolumeMax: 500, pointsCapConstrained: true, pointsCap: 600 }));
    expect(html).toContain("طلبت ٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل.");
  });

  it("shows nothing when the plan holds what was asked", () => {
    const html = render(quote({ requestedVolumeMax: 57 }));
    expect(html).not.toContain('data-testid="plan-volume-limit"');
    expect(html).not.toContain("يتحدد الحد");
  });
});
