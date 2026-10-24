import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { resolveTimeWindow } from "../src/lib/timeWindow";
import { createChatDb } from "./helpers/chatSession";

/**
 * The four request flows that read a period through the shared period and scope readers (companies, X posts, Facebook keyword comments, TikTok comments): the same request with
 * the period written as digits («آخر ٣ شهور») and in words («آخر ثلاثة شهور») must give the SAME three-month window, the count the customer wrote, and a topic that does not carry
 * the period's words. (Before the shared fix, the words were not read as a period: X asked for one, Facebook and TikTok planned «آخر شهر», companies planned no window, and the
 * topic kept «ثلاثة شهور».) No model, no provider, no SQL.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

const threeMonths = () => resolveTimeWindow("آخر ٣ شهور", { needsWindow: true }) as { status: "resolved"; dateFrom: string; dateTo: string };

async function plan(message: string) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_flow", data: { userId: "user_flow", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  return (await handler.handleUserMessage({ userId: "user_flow", conversationId: "conv_flow", message, userBalance: 40_000 })) as any;
}

const FLOWS: Array<{ flow: string; request: (period: string) => string; slug: string; volume: number; unitNote?: string }> = [
  { flow: "companies", request: (p) => `عايز ٥٠ شركة برمجيات في مصر ${p}`, slug: "icypeas-companies-search", volume: 50 },
  { flow: "X posts", request: (p) => `عايز ٢٠٠ تغريدة عن الذكاء الاصطناعي على إكس ${p}`, slug: "social-x-posts", volume: 200 },
  { flow: "Facebook keyword comments", request: (p) => `عايز ٣٠٠ منشور على فيسبوك عن الترندات الصحية مع ٥ تعليقات لكل منشور في مصر ${p}`, slug: "social-facebook-keyword-comments", volume: 1500 },
  { flow: "TikTok comments", request: (p) => `عايز ٢٠٠ تعليق على فيديوهات تيك توك عن الدوري المصري ${p}`, slug: "social-tiktok-comments", volume: 200 },
];

describe("the period written as digits or as words: same window, same count, clean topic, in every flow", () => {
  it("the three-month window is the one the readers resolve from the digits (a fixed length, never «آخر شهر»)", () => {
    const window = threeMonths();
    expect(window.status).toBe("resolved");
    const days = Math.round((Date.parse(window.dateTo) - Date.parse(window.dateFrom)) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(89);
    expect(days).toBeLessThanOrEqual(92);
  });

  for (const { flow, request, slug, volume } of FLOWS) {
    for (const [label, period] of [["digits", "آخر ٣ شهور"], ["words", "آخر ثلاثة شهور"]] as const) {
      it(`${flow}, period in ${label}: item ${slug}, ${volume} records, the three-month window, no period word in the topic`, async () => {
        const r = await plan(request(period));
        expect(r.outputType).toBe("propose_plan");
        expect(r.planQuote.items).toHaveLength(1);
        const item = r.planQuote.items[0];
        expect(item.capabilitySlug).toBe(slug);
        expect(item.targetVolumeMax).toBe(volume);
        const window = threeMonths();
        expect([item.params.dateFrom, item.params.dateTo]).toEqual([window.dateFrom, window.dateTo]);
        // the topic the customer sees between «» and the text sent to the source carry none of the period's words
        const quoted = [...String(r.contentAr).matchAll(/«([^»]*)»/g)].map((m) => m[1]).join(" ");
        expect(quoted).not.toMatch(/ثلاثة|ثلاث|شهور|شهر/);
        for (const key of ["query", "topic", "subject"]) if (typeof item.params[key] === "string") expect(item.params[key]).not.toMatch(/ثلاثة|ثلاث|شهور|شهر/);
      });
    }
  }
});
