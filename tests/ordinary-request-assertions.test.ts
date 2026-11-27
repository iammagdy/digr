import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting } from "../src/functions/shared/providerSpend";
import { isStandaloneResearchRequest } from "../src/functions/shared/requestScope";
import { understandMission } from "../src/lib/consultantCopy";
import { createChatDb } from "./helpers/chatSession";

/**
 * THREE ORDINARY ASSERTIONS that lived only in the Facebook topic report's chat test (deleted by DT-20261126-wl4-ph1b, tests-only notes of that PR). None of them is about the report: they pin how ORDINARY requests are read.
 * The model is never asked here (a fake that throws); the database is the fake chat database.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

describe("ordinary request reading (moved from the deleted facebook-report-chat test)", () => {
  it("a per-post phrase alone is a bare answer to a question, not a full request; a long request that carries it is a full request", () => {
    expect(isStandaloneResearchRequest("٢٠ تعليق لكل منشور")).toBe(false);
    expect(isStandaloneResearchRequest("عايز تعليقات عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور")).toBe(true);
  });
  it("a request that gives its period first and no count at all is not a 3-record request; a stated count is read", () => {
    for (const text of ["آخر ٣ شهور تعليقات عن الترندات الصحية على فيسبوك", "آخر ثلاثة شهور تعليقات منشورات الترندات الصحية على فيسبوك", "خلال ٣٠ يوم تعليقات عن الدوري على تيك توك"]) {
      expect(understandMission(text).volume, text).toBeNull();
    }
    expect(understandMission("٣٠٠ تعليق عن الدوري آخر ٣ شهور على تيك توك").volume).toBe(300);
  });
  it("a Facebook request asks for the post topic or the Page, with no YouTube words", async () => {
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
    await db.createRow({ tableId: "conversations", rowId: "conv_ord", data: { userId: "user_ord", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    const r: any = await handler.handleUserMessage({ userId: "user_ord", conversationId: "conv_ord", message: "عايز تعليقات من فيسبوك", userBalance: 40_000 });
    const text = JSON.stringify([r.contentAr, r.clarificationItems]);
    expect(text).not.toMatch(/الفيديوهات أو اسم القناة/);
    expect(text).toMatch(/المنشورات|الصفحة/);
  });
});
