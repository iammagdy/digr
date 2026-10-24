import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { formatStructuredClarificationAnswers, validateStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { UNSUPPORTED_PLATFORM_AR } from "../src/lib/socialDiscoveryCard";
import { readFileSync } from "node:fs";
import { createChatDb } from "./helpers/chatSession";

/**
 * The «أخرى» answer of the platform question. Evidence (the owner's live check): after «أخرى» the same question stayed on screen with the free-text field,
 * and a typed «سناب شات» got a generic model sentence. The UI sends the typed text as the answer of the same question (its text as `question`), in one
 * structured message; these tests send exactly that shape through the route's validation and formatting. FAKE model and FAKE database; no provider.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

let seq = 0;
async function chat() {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  const conversationId = `conv_pt_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_pt", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_pt", conversationId, message, userBalance: 40_000 }) as Promise<any>;
  const submitCard = (card: any, values: Record<string, string>) => {
    const answers = card.clarificationItems.map((q: any) => ({ questionId: q.id, question: q.text, value: values[q.id] ?? q.options?.[0] ?? "x" }));
    return send(formatStructuredClarificationAnswers(validateStructuredClarificationAnswers({ type: "clarification_answers", answers })!));
  };
  return { send, submitCard };
}
const SNAP_WORDS = /سناب|snap/i;

describe("a typed platform the service does not serve: one clear sentence, nothing held", () => {
  for (const typed of ["سناب شات", "ماسنجر"]) {
    it(`«${typed}» typed after «أخرى» gets the four-platform sentence, no plan, no card`, async () => {
      const c = await chat();
      const card = await c.send("عايز داتا عن ترندات الصحة في مصر");
      expect(card.outputType).toBe("ask_clarification");
      const r = await c.submitCard(card, { social_platform_required: typed });
      expect(r.outputType).toBe("answer_question");
      expect(r.contentAr).toBe(UNSUPPORTED_PLATFORM_AR);
      for (const name of ["تيك توك", "فيسبوك", "يوتيوب", "منصة X"]) expect(r.contentAr).toContain(name);
      expect(r.contentAr).not.toMatch(SNAP_WORDS);
      expect(r.planQuote).toBeUndefined();
      expect(r.clarificationItems ?? []).toEqual([]);
    });
  }

  it("a served name typed after «أخرى» continues: the next question about the period appears, the unsupported sentence does not", async () => {
    const c = await chat();
    const card = await c.send("عايز داتا عن ترندات الصحة في مصر");
    const r = await c.submitCard(card, { social_platform_required: "فيسبوك" });
    expect(r.contentAr).not.toBe(UNSUPPORTED_PLATFORM_AR);
    expect(r.outputType === "propose_plan" || r.outputType === "ask_clarification").toBe(true);
  });
});

describe("bare «أخرى» with no text: the question keeps its free-text field and is never repeated without it", () => {
  it("a click on «أخرى» opens the field and returns before any save (the client rule, read from its source)", () => {
    const source = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(source).toMatch(/option\.trim\(\) === "أخرى" && current\.allowOther\) \{\s*setDraft\(""\);\s*setCustomInputOpen\(true\);\s*return;\s*\}/);
  });

  it("an «أخرى» value that reaches the server asks again with the free-text field (allowOther, type free)", async () => {
    const c = await chat();
    const card = await c.send("عايز داتا عن ترندات الصحة في مصر");
    const r = await c.submitCard(card, { social_platform_required: "أخرى" });
    const item = r.clarificationItems?.[0];
    expect(item).toBeDefined();
    expect(item.allowOther).toBe(true);
    expect(item.type).toBe("free");
    expect(item.options ?? []).toEqual([]);
  });
});
