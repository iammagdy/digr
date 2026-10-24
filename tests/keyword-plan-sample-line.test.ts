import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";

/**
 * The Facebook keyword card says, in one line, that the comments come from a sample of the newest posts and that the amount is for what is delivered. Text only:
 * the numbers of the card do not change, and no other card carries the line.
 */
const SAMPLE_LINE = "عينة من أحدث المنشورات، والحساب على المسلَّم فقط";
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

async function plan(message: string) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_sample", data: { userId: "user_sample", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  return (await handler.handleUserMessage({ userId: "user_sample", conversationId: "conv_sample", message, userBalance: 40_000 })) as any;
}

describe("the keyword card carries the sample sentence, and only that card", () => {
  it("a Facebook keyword plan says it is a sample of the newest posts, with the numbers unchanged", async () => {
    const r = await plan("هات ١٠٠ بوست عن ترندات الصحة على فيسبوك في مصر آخر ٣ شهور وكل بوست معاه ٥ تعليقات");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].capabilitySlug).toBe("social-facebook-keyword-comments");
    expect(r.planQuote.items[0].targetVolumeMax).toBe(500);
    expect(r.planQuote.quotedPoints).toBe(7432);
    expect(r.planQuote.expectedPoints).toBe(6463);
    expect(r.contentAr).toContain(SAMPLE_LINE);
    expect(r.contentAr).toContain("١٠٠ منشور");
    expect(r.contentAr).not.toMatch(/[A-Za-z]/);
  });
  it("a TikTok comments plan does not carry the line", async () => {
    const r = await plan("عايز ٢٠٠ تعليق على فيديوهات تيك توك عن الدوري المصري آخر ٣ شهور");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].capabilitySlug).toBe("social-tiktok-comments");
    expect(r.contentAr).not.toContain(SAMPLE_LINE);
  });
});
