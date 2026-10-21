import { describe, expect, it, vi } from "vitest";
import { parseRelativeWindow, resolveTimeWindow } from "../src/lib/timeWindow";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

const TODAY = new Date("2026-10-21T10:00:00Z");

describe("a month, week or year said in the customer's words is a period, not a missing one", () => {
  const rolling = (phrase: string) => resolveTimeWindow(`٣٠ تعليق تيك توك عن كرة القدم في مصر ${phrase}`, { needsWindow: true, today: TODAY });

  it.each([
    ["خلال الشهر الماضي", "2026-09-21", "2026-10-21", "آخر شهر"],
    ["الشهر الماضي", "2026-09-21", "2026-10-21", "آخر شهر"],
    ["آخر شهر", "2026-09-21", "2026-10-21", "آخر شهر"],
    ["خلال الشهر اللي فات", "2026-09-21", "2026-10-21", "آخر شهر"],
    ["في الشهر الي فات", "2026-09-21", "2026-10-21", "آخر شهر"],
    ["خلال الأسبوع الماضي", "2026-10-14", "2026-10-21", "آخر أسبوع"],
    ["خلال السنة الماضية", "2025-10-21", "2026-10-21", "آخر سنة"],
    ["في العام الماضي", "2025-10-21", "2026-10-21", "آخر سنة"],
  ])("«%s» is the rolling period", (phrase, from, to, label) => {
    const window = rolling(phrase);
    expect(window.status).toBe("resolved");
    if (window.status !== "resolved") return;
    expect(window).toMatchObject({ source: "relative", dateFrom: from, dateTo: to });
    expect(window.labelAr).toContain(label);
  });

  it.each([
    ["هذا الشهر", "2026-10-01", "2026-10-21", "هذا الشهر"],
    ["خلال هذا الشهر", "2026-10-01", "2026-10-21", "هذا الشهر"],
    ["هذه السنة", "2026-01-01", "2026-10-21", "هذه السنة"],
    ["هذا الأسبوع", "2026-10-17", "2026-10-21", "هذا الأسبوع"],
    ["الشهر الحالي", "2026-10-01", "2026-10-21", "هذا الشهر"],
  ])("«%s» is the current calendar period up to today", (phrase, from, to, label) => {
    const window = rolling(phrase);
    expect(window.status).toBe("resolved");
    if (window.status !== "resolved") return;
    expect(window).toMatchObject({ source: "relative", dateFrom: from, dateTo: to });
    expect(window.labelAr).toContain(label);
  });

  it("the phrases that already worked still do", () => {
    expect(parseRelativeWindow("آخر ٣ شهور", TODAY)).toMatchObject({ from: "2026-07-21", to: "2026-10-21" });
    expect(parseRelativeWindow("خلال أسبوعين", TODAY)).toMatchObject({ from: "2026-10-07", to: "2026-10-21" });
  });

  it("a request with no period is still missing, and so are words that only look like one", () => {
    expect(rolling("").status).toBe("missing");
    expect(resolveTimeWindow("عايز تعليقات عن هذا الفيديو الماضي", { needsWindow: true, today: TODAY }).status).toBe("missing");
  });
});

describe("the plan of a request that says «خلال الشهر الماضي»", () => {
  async function plan(message: string) {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    await db.createRow({ tableId: "conversations", rowId: "conv_w", data: { userId: "user_w", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    return handler.handleUserMessage({ userId: "user_w", conversationId: "conv_w", message, userBalance: 5000 });
  }

  it.each(["خلال الشهر الماضي", "الشهر الماضي", "آخر شهر", "هذا الشهر"])("«%s»: the plan shows the period the customer stated, never «لم تحدد فترة»", async (phrase) => {
    const response = await plan(`٣٠ تعليق تيك توك عن كرة القدم في مصر ${phrase}`);
    expect(response.outputType).toBe("propose_plan");
    expect(response.planQuote.window).toBeTruthy();
    expect(response.planQuote.window.source).toBe("relative");
    expect(String(response.planQuote.window.reasonAr || "")).not.toContain("لم تحدد فترة");
    expect(JSON.stringify(response.planQuote)).not.toContain("لم تحدد فترة");
    // the words of the period are not part of the subject
    expect(String(response.planQuote.understoodAr || "")).not.toContain("الماضي");
  });

  it("a request with no period still gets the proposed month, said plainly", async () => {
    const response = await plan("٣٠ تعليق تيك توك عن كرة القدم في مصر");
    expect(response.planQuote.window.source).toBe("default");
    expect(response.planQuote.window.reasonAr).toContain("لم تحدد فترة، فاقترحت آخر شهر");
  });
});
