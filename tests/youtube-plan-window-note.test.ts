import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

async function plan(message: string) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_window", data: { userId: "user_window", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  return handler.handleUserMessage({ userId: "user_window", conversationId: "conv_window", message, userBalance: 5000 });
}

describe("a YouTube comments plan says its window is approximate", () => {
  it("the window note carries the sentence, before the customer approves", async () => {
    const response = await plan("٣٠ تعليق يوتيوب عن كرة القدم");
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.window).toBeTruthy();
    expect(response.planQuote.window.noteAr).toContain("تواريخ يوتيوب تقريبية (مثل «منذ ٣ أسابيع»)، لذلك تُطبَّق الفترة عليها بشكل تقريبي.");
    expect(response.planQuote.window.noteAr).not.toMatch(/[A-Za-z]/);
  });

  it("other platforms do not get it", async () => {
    const response = await plan("٣٠ تعليق تيك توك عن كرة القدم");
    expect(response.outputType).toBe("propose_plan");
    expect(String(response.planQuote.window?.noteAr || "")).not.toContain("تواريخ يوتيوب");
  });

  it("a window YouTube's search cannot reach (older than a year) is said plainly, with what to send instead", async () => {
    const response = await plan("٣٠ تعليق يوتيوب عن كرة القدم من ١ يونيو ٢٠٢٤ إلى ٣٠ يونيو ٢٠٢٤");
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.window.noteAr).toContain("ننصح بإرسال روابط الفيديوهات أو اسم القناة");
    expect(response.planQuote.window.noteAr).not.toMatch(/[A-Za-z]/);
  });

  it("the default window (last month) is within the search's reach, so no such warning is shown", async () => {
    const response = await plan("٣٠ تعليق يوتيوب عن كرة القدم");
    expect(String(response.planQuote.window.noteAr)).not.toContain("ننصح بإرسال روابط الفيديوهات");
  });
});
