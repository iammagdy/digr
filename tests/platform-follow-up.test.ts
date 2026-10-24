import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { platformFollowUpStateAr, UNSUPPORTED_PLATFORM_AR } from "../src/lib/socialDiscoveryCard";
import { PLATFORM_OTHER_QUESTION_AR, PLATFORM_QUESTION_AR, typedAnswerLabelFor } from "../src/lib/consultantCopy";
import { CLARIFICATION_ANSWER_LABELS } from "../src/lib/clarificationLabels";

/**
 * «أخرى» on the platform question. Evidence (the owner's live check): the platform question came back with the same wording after «أخرى», and the answer
 * was recorded without moving on. Fix: «أخرى» asks ONE free-text follow-up with its own wording; a name this service does not read gets one honest sentence,
 * no plan and no hold. Snapchat is named by the platform detector but no service of ours reads it. FAKE database and FAKE model; no provider.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

class Chat {
  private db: any = createChatDb();
  private handler = new ChatHandler(this.db);
  constructor() { (this.handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); }); }
  async start() {
    await this.db.createRow({ tableId: "conversations", rowId: "conv_pf", data: { userId: "user_pf", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    return this;
  }
  send(message: string): Promise<any> { return this.handler.handleUserMessage({ userId: "user_pf", conversationId: "conv_pf", message, userBalance: 40_000 }) as Promise<any>; }
  answer(questionId: string, value: string): Promise<any> {
    return this.send(JSON.stringify({ type: "clarification_answers", answers: [{ question: questionId, questionId, value }] }));
  }
}
const questionOf = (r: any) => (r.clarificationItems ?? [])[0];
const TEXT = (r: any) => [r.contentAr, ...((r.clarificationItems ?? []).flatMap((q: any) => [q.text, ...(q.options ?? [])]))].join(" \n ");
const REQUEST = "عايز داتا عن ترندات الصحة في مصر";

describe("«أخرى» moves the flow on: one free-text follow-up, never the same question twice", () => {
  it("the platform question offers Facebook next to the others", async () => {
    const c = await new Chat().start();
    const r = await c.send(REQUEST);
    expect(questionOf(r).id).toBe("social_platform_required");
    expect(questionOf(r).options).toContain("فيسبوك");
  });

  it("«أخرى» as the answer: the next prompt is the follow-up, its wording differs from the platform question, and it has no option list", async () => {
    const c = await new Chat().start();
    const first = questionOf(await c.send(REQUEST));
    const r = await c.answer("social_platform_required", "أخرى");
    const next = questionOf(r);
    expect(next.id).toBe("social_platform_other_required");
    expect(next.text).not.toBe(first.text);
    expect(next.text).toBe(PLATFORM_OTHER_QUESTION_AR);
    expect(next.options ?? []).toEqual([]);
    expect(TEXT(r)).not.toContain("على أي منصة تريد البحث؟");
  });

  it("«أخرى» typed as a message (no card) moves on the same way", async () => {
    const c = await new Chat().start();
    await c.send(REQUEST);
    const r = await c.send("أخرى");
    expect(questionOf(r).id).toBe("social_platform_other_required");
    expect(TEXT(r)).not.toContain("على أي منصة تريد البحث؟");
  });

  it("a name this service does not read (Snapchat is seen by the detector as a platform) gets ONE honest sentence: no plan, no hold, nothing charged", async () => {
    const c = await new Chat().start();
    await c.send(REQUEST);
    await c.answer("social_platform_required", "أخرى");
    const r = await c.answer("social_platform_other_required", "سناب شات");
    expect(r.outputType).toBe("answer_question");
    expect(r.planQuote).toBeUndefined();
    expect(r.contentAr).toBe(UNSUPPORTED_PLATFORM_AR);
    expect(r.contentAr).toContain("المنصات المتاحة");
    expect(r.contentAr).toContain("تيك توك");
    expect(r.contentAr).toContain("فيسبوك");
    expect(r.contentAr).toContain("يوتيوب");
    expect(r.contentAr).toContain("إكس");
    expect(r.contentAr).not.toMatch(/[A-Za-z]/);
    expect(r.contentAr).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the typed name of an unsupported platform is answered the same way (typed, not a card answer)", async () => {
    const c = await new Chat().start();
    await c.send(REQUEST);
    await c.send("أخرى");
    const r = await c.send("سناب شات");
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(UNSUPPORTED_PLATFORM_AR);
  });

  it("a supported name typed after «أخرى» carries on: the platform is known and the next question is not the platform one", async () => {
    const c = await new Chat().start();
    await c.send(REQUEST);
    await c.answer("social_platform_required", "أخرى");
    const r = await c.answer("social_platform_other_required", "فيسبوك");
    expect(r.contentAr).not.toBe(UNSUPPORTED_PLATFORM_AR);
    expect(TEXT(r)).not.toContain("على أي منصة تريد البحث؟");
    expect((r.clarificationItems ?? []).map((q: any) => q.id)).not.toContain("social_platform_required");
  });
});

describe("the follow-up state reads the labelled answers, with no state kept anywhere", () => {
  it("«asked» after the bare answer, «answered» after the name, null for a plain request or a named platform", () => {
    const asked = `${REQUEST} ${CLARIFICATION_ANSWER_LABELS.social_platform_required}: أخرى`;
    const answered = `${asked} ${CLARIFICATION_ANSWER_LABELS.social_platform_other_required}: سناب شات`;
    expect(platformFollowUpStateAr(asked)).toBe("asked");
    expect(platformFollowUpStateAr(answered)).toBe("answered");
    expect(platformFollowUpStateAr(REQUEST)).toBeNull();
    expect(platformFollowUpStateAr(`${asked} ${CLARIFICATION_ANSWER_LABELS.social_platform_other_required}: فيسبوك`)).toBeNull();
  });

  it("the typed answer to the follow-up is labelled with it, and the platform question's typed answer with its label", () => {
    expect(typedAnswerLabelFor(`سؤال\n${PLATFORM_OTHER_QUESTION_AR}`)).toBe(CLARIFICATION_ANSWER_LABELS.social_platform_other_required);
    expect(typedAnswerLabelFor(`سؤال\n${PLATFORM_QUESTION_AR}`)).toBe(CLARIFICATION_ANSWER_LABELS.social_platform_required);
  });
});
