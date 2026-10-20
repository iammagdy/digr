import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

describe("«all …» through the chat carries a cap", () => {
  it("through the chat (model stubbed to throw): the question comes after the period, and a stated cap goes to the plan", async () => {
    const run = (message: string) => {
      const handler = new ChatHandler(createChatDb() as any);
      (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
      return handler.handleUserMessage({ userId: "u_cap", message, userBalance: 5000 }) as Promise<any>;
    };
    const noPeriod = await run("عايز كل المنشورات عن القهوة على إكس");
    expect(noPeriod.clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    const noCap = await run("عايز كل المنشورات عن القهوة على إكس آخر شهر");
    expect(noCap.outputType).toBe("ask_clarification");
    expect(noCap.clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    expect(noCap.clarificationItems[0].options).toEqual(["٥٠٠ سجل", "١٠٠٠ سجل", "٢٠٠٠ سجل", "٥٠٠٠ سجل"]);
    const withCap = await run("عايز كل المنشورات عن القهوة على إكس آخر شهر حتى ٣٠ منشور");
    expect(withCap.outputType).toBe("propose_plan");
    expect(withCap.planQuote.targetVolumeMax).toBeLessThanOrEqual(30);
  });
});
