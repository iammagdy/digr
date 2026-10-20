import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { understandMission, understoodLineAr } from "../src/lib/consultantCopy";
import { socialSubjectText } from "../src/lib/socialTasks";
import { socialTopicForDisplay, topicFromTitle } from "../src/lib/socialTopicDisplay";
import { customerFacingConversationTitle } from "../src/lib/customerFacingConversationTitle";
import { CLARIFICATION_ANSWER_LABELS as L } from "../src/lib/clarificationLabels";
import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";

/**
 * Live QA of 72d0a07, two leaks in the topic:
 *  1. «منتخب مصر الحد الأقصى المطلوب:» inside the quote of the understanding sentence: the stored answer of the cap card («الحد الأقصى
 *     المطلوب: ٥٠٠ تعليق») followed the subject in the text and the subject was read up to the first digit, label included.
 *  2. «كرة» instead of «كرة القدم» in the steps: the plan card read the topic from the CONVERSATION TITLE, which is the plan's summary
 *     cut at fifty characters («... على يوتيوب عن «كرة…»); the plan's own query («كرة القدم») was never looked at first.
 * Also hardened: the request-wide subject reader (used for plan steps of keyword searches) cut the topic at six words, so a request that
 * repeats its topic (the request, then the answer to the topic card) lost «القدم».
 */
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);
const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const CH_Q = "ما أسماء القنوات أو روابطها؟";
const TOPIC_Q = "ما موضوع الفيديوهات التي تريد تعليقاتها؟ سأبحث عن أعلاها مشاهدة بدل القنوات.";
const LABEL_LEAK = /الحد الأقصى|المطلوب\s*:|الفترة المطلوبة|القنوات المطلوبة|موضوع البحث المطلوب/;

async function plan(messages: string[]) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await db.createRow({ tableId: "conversations", rowId: "conv_topic", data: { userId: "user_topic", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  let last: any;
  for (const message of messages) last = await handler.handleUserMessage({ userId: "user_topic", conversationId: "conv_topic", message, userBalance: 5000 });
  return last;
}
const card = (quote: any, conversationTitle: string) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, conversationTitle, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

describe("leak 1: a card answer is never part of the topic in the understanding sentence", () => {
  const CAP = `${L.volume_cap_required}: ٥٠٠ تعليق`;
  it("the exact live case: «... عن منتخب مصر» followed by the stored cap answer", () => {
    const u = understandMission(`عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر ${CAP}`);
    expect(u.subject).toBe("منتخب مصر");
    expect(u.volume).toBe(500);
    const line = understoodLineAr(u)!;
    expect(line).toContain("«منتخب مصر»");
    expect(line).not.toMatch(LABEL_LEAK);
  });

  it("football, a comment target, a channel: every label that can follow the subject is cut, whichever it is", () => {
    const cases: Array<[string, string]> = [
      [`تعليقات يوتيوب عن كرة القدم ${CAP}`, "كرة القدم"],
      [`اجمع تعليقات قناة @aljazeera عن كرة القدم ${CAP}`, "كرة القدم"],
      [`تعليقات يوتيوب عن كرة القدم ${L.social_time_required}: آخر شهر`, "كرة القدم"],
      [`تعليقات يوتيوب عن كرة القدم ${L.social_time_required}: آخر شهر⁣ ${CAP}`, "كرة القدم"],
      [`تعليقات يوتيوب عن كرة القدم ${L.social_channel_required}: @aljazeera⁣ ${CAP}`, "كرة القدم"],
      [`تعليقات تيك توك عن منتخب مصر وكأس العالم ${CAP}`, "منتخب مصر وكأس العالم"],
    ];
    for (const [text, subject] of cases) {
      const u = understandMission(text);
      expect(u.subject, text).toBe(subject);
      expect(understoodLineAr(u), text).not.toMatch(LABEL_LEAK);
    }
  });

  it("through the chat: the plan's understanding sentence carries the topic and nothing else, whether the cap was answered or skipped", async () => {
    for (const cap of [answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"), answer("volume_cap_required", CAP_Q)]) {
      const response = await plan(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", cap]);
      expect(response.outputType).toBe("propose_plan");
      expect(response.planQuote.understoodAr).toContain("«منتخب مصر»");
      expect(response.planQuote.understoodAr).not.toMatch(LABEL_LEAK);
      expect(response.contentAr).not.toMatch(/«[^»]*(?:الحد الأقصى|المطلوب:)[^»]*»/);
    }
  });
});

describe("leak 2: «كرة القدم», never «كرة», in the steps", () => {
  it("the title is the plan's summary cut at fifty characters: it ends with «…» and cuts the topic", () => {
    const summary = "سحب التعليقات من ٣ فيديوهات على يوتيوب عن «كرة القدم»، حتى ٥٧ تعليقاً إجمالاً";
    const title = customerFacingConversationTitle(summary);
    expect(title).toBe("سحب التعليقات من ٣ فيديوهات على يوتيوب عن «كرة…");
    // what the card used to read the topic from
    expect(socialSubjectText(title)).toBe("كرة");
  });

  it("the topic comes from the plan's own parameters first; a cut title is never a source", () => {
    const cut = "سحب التعليقات من ٣ فيديوهات على يوتيوب عن «كرة…";
    expect(socialTopicForDisplay({ params: { query: "كرة القدم" }, conversationTitle: cut })).toBe("كرة القدم");
    expect(socialTopicForDisplay({ params: { subject: "منتخب مصر" }, conversationTitle: cut })).toBe("منتخب مصر");
    expect(socialTopicForDisplay({ params: { topic: "«القهوة»" } })).toBe("القهوة");
    expect(socialTopicForDisplay({ params: {}, conversationTitle: cut })).toBe(""); // unknown, never a half topic
    expect(topicFromTitle(cut)).toBe("");
    expect(socialTopicForDisplay({ params: { url: "https://www.youtube.com/watch?v=abcdefghijk" }, conversationTitle: "تعليقات كرة القدم" })).toBe("كرة القدم");
    expect(socialTopicForDisplay({ params: { query: "https://x.com/a" }, conversationTitle: "كرة القدم" })).toBe("كرة القدم");
    expect(socialTopicForDisplay({ params: { query: "كرة" }, trending: true })).toBe("الفيديوهات الرائجة");
    // a whole title still works when there are no parameters to read
    expect(topicFromTitle("تعليقات كرة القدم في مصر")).toBe("كرة القدم");
  });

  const stepsOf = (html: string) => html.slice(html.indexOf("خطوات التنفيذ"));
  it("the plan card: the steps and the scope chip say «كرة القدم» even when the saved title was cut inside the topic (three flows)", async () => {
    const flows: Array<[string, string[]]> = [
      ["YouTube comments by topic", ["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن كرة القدم", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]],
      ["a mission with the channels skipped", ["أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب مع كل التعليقات", answer("social_channel_required", CH_Q), answer("social_topic_required", TOPIC_Q, "كرة القدم"), answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]],
      ["TikTok comments by topic", ["عايز كل تعليقات فيديوهات تيك توك عن كرة القدم", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]],
    ];
    for (const [label, messages] of flows) {
      const response = await plan(messages);
      expect(response.outputType, label).toBe("propose_plan");
      const savedTitle = customerFacingConversationTitle(response.planQuote.summaryAr);
      expect(savedTitle.endsWith("…"), `${label}: the saved title is cut (${savedTitle})`).toBe(true);
      const html = card(response.planQuote, savedTitle);
      const steps = stepsOf(html);
      expect(steps, label).toContain("حول «كرة القدم»");
      expect(steps, label).toContain("موضوع «كرة القدم»");
      expect(steps, label).not.toMatch(/«كرة»/);
      expect(html, label).not.toMatch(/«كرة»|>كرة</);
    }
  });
});

describe("the request-wide subject reader keeps the whole topic", () => {
  it("a request that repeats its topic in the card answer says it once, with no ranking words, no label and no cut phrase", () => {
    const text = `أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب عن كرة القدم منتخب مصر ${L.social_channel_required}: تخطي⁣ ${L.social_topic_required}: كرة القدم`;
    expect(socialSubjectText(text)).toBe("كرة القدم"); // the answer to the topic card is the topic
    expect(socialSubjectText(`أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب عن كرة القدم منتخب مصر كرة القدم`)).toBe("كرة القدم منتخب مصر");
    expect(socialSubjectText(`أريد أعلى ١٠ فيديوهات مشاهدة عن كرة القدم ${L.volume_cap_required}: ٥٠٠ تعليق ${L.social_time_required}: آخر شهر`)).toBe("كرة القدم");
  });

  it("the words of a longer topic are kept to eight, never ending on the first word of «كرة القدم» or «كأس العالم»", () => {
    expect(socialSubjectText("عن أخبار نادي الأهلي القاهري ونادي الزمالك الجيزة كرة القدم")).toBe("أخبار نادي الأهلي القاهري ونادي الزمالك الجيزة كرة القدم");
    expect(socialSubjectText("عن أحداث الأسبوع في الدوري المصري الممتاز والدوري الإنجليزي كأس العالم")).not.toMatch(/(?:كرة|كأس|دوري)$/);
  });

  it("a topic the customer wrote still works as before: hashtags, plain topics, a country that is part of the topic", () => {
    expect(socialSubjectText("تعليقات عن #كرة_القدم على يوتيوب")).toBe("كرة القدم");
    expect(socialSubjectText("تعليقات يوتيوب كرة القدم")).toBe("كرة القدم");
    expect(socialSubjectText("مباراة مصر والمغرب")).toBe("مباراة مصر والمغرب");
  });
});
