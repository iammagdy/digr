import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { planScopeRows } from "../src/lib/quoteScopeGaps";
import { createChatDb } from "./helpers/chatSession";

/**
 * A Facebook page plan shows the page, not the link. Evidence (the owner's live check): «هات ١٠ بوست من صفحة https://www.facebook.com/youm7» showed the raw
 * link under «موضوع المحتوى». The page plan now shows «الصفحة:» with the handle only; the numbers stay (10 records, 35 points, hold 40). FAKE model and DB.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

async function chat() {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_fc", data: { userId: "user_fc", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  return (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_fc", conversationId: "conv_fc", message, userBalance: 40_000 }) as Promise<any>;
}

describe("the Facebook page plan shows «الصفحة» with the handle only", () => {
  it("the owner's request: the chip reads «الصفحة: youm7», with no link, no scheme and no topic wording", async () => {
    const send = await chat();
    const r = await send("هات ١٠ بوست من صفحة https://www.facebook.com/youm7");
    expect(r.outputType).toBe("propose_plan");
    const chips = planScopeRows(r.planQuote.items);
    const page = chips.find((chip: any) => chip.label === "الصفحة:");
    expect(page).toEqual({ label: "الصفحة:", value: "youm7" });
    expect(chips.some((chip: any) => chip.label === "موضوع المحتوى:")).toBe(false);
    const shown = JSON.stringify(chips);
    expect(shown).not.toMatch(/https?:\/\//);
    expect(shown).not.toContain("facebook.com");
  });

  it("the numbers are unchanged: 10 records, 35 points expected, 40 held", async () => {
    const send = await chat();
    const r = await send("هات ١٠ بوست من صفحة https://www.facebook.com/youm7");
    expect(r.planQuote.items[0].targetVolumeMax).toBe(10);
    expect(r.planQuote.expectedPoints).toBe(35);
    expect(r.planQuote.quotedPoints).toBe(40);
  });

  it("a topic-search plan keeps its topic chip and never shows «الصفحة»", async () => {
    const send = await chat();
    const r = await send("عايز تعليقات عن ترندات الصحة على فيسبوك في مصر آخر ٣ شهور ٢٠ منشور بـ ٥ تعليقات لكل منشور");
    expect(r.outputType).toBe("propose_plan");
    const chips = planScopeRows(r.planQuote.items);
    expect(chips.find((chip: any) => chip.label === "موضوع المحتوى:")?.value).toBe("ترندات الصحة");
    expect(chips.some((chip: any) => chip.label === "الصفحة:")).toBe(false);
  });
});
