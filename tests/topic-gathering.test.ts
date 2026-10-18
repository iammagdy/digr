import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { extractBriefFromMessage } from "../src/functions/shared/briefManager";
import { detectTopicGathering, hasTopicResearchService, TOPIC_SOURCE_OPTIONS_AR } from "../src/functions/shared/topicGathering";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { createChatDb, runConversation } from "./helpers/chatSession";

const STUDIES = "اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا";
const GENERIC = /محتاج أعرف المنصة|اكتب الموضوع|أرسل رابط/;

describe("3. a studies request with a topic and a country gets a specific question", () => {
  it("detects the topic, the country and the noun the customer used", () => {
    expect(detectTopicGathering(STUDIES)).toEqual({ noun: "دراسات", topic: "الطاقة الشمسية", countryAr: "ألمانيا" });
    expect(detectTopicGathering("هات ١٠ مقالات علمية عن الذكاء الاصطناعي في الطب")).toMatchObject({ noun: "مقالات علمية", topic: "الذكاء الاصطناعي في الطب" });
    expect(detectTopicGathering("ابحث لي عن أبحاث حول التغير المناخي في أفريقيا خلال آخر سنة")?.topic).toBe("التغير المناخي في أفريقيا");
  });

  it("does not take over requests that belong to another service", () => {
    for (const text of ["هات ١٠ تغريدات عن كرة السلة", "عايز ٥ شركات طاقة في مصر", "اجمع أخبار عن الكرة من تيك توك", "هات ١٠ مديرين في شركات الطاقة", "اجمع دراسات", "هات تعليقات من https://youtube.com/watch?v=x"]) {
      expect(detectTopicGathering(text), text).toBeNull();
    }
  });

  it("the deterministic question names the topic and country and offers real sources, in Arabic only", () => {
    const q = getDeterministicDiscoveryQuestion(STUDIES, extractBriefFromMessage(STUDIES), APPROVED_CAPABILITY_CATALOG);
    expect(q.id).toBe("topic_source_required");
    expect(q.text).toContain("الطاقة الشمسية");
    expect(q.text).toContain("ألمانيا");
    expect(q.text).toContain("دراسات");
    expect(q.text).not.toMatch(GENERIC);
    expect(q.text).not.toMatch(/[A-Za-z]/);
    expect(q.options).toEqual(TOPIC_SOURCE_OPTIONS_AR);
    expect(q.options.join(" ")).not.toMatch(/[A-Za-z]/);
  });

  it("when a topic-research service exists the question is skipped and the model plans", () => {
    const withService: any[] = [...APPROVED_CAPABILITY_CATALOG, { slug: "topic-news-academic-research", platform: "web", category: "web" }];
    expect(hasTopicResearchService(withService)).toBe(true);
    expect(hasTopicResearchService(APPROVED_CAPABILITY_CATALOG)).toBe(false);
    expect(getDeterministicDiscoveryQuestion(STUDIES, extractBriefFromMessage(STUDIES), withService)).toBeNull();
  });

  it("in the chat: one specific question with no model turn, never the generic sentence", async () => {
    const { responses } = await runConversation([STUDIES]);
    const r = responses[0];
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationQuestions).toHaveLength(1);
    expect(r.clarificationQuestions![0]).toContain("الطاقة الشمسية");
    expect(r.clarificationQuestions![0]).toContain("ألمانيا");
    expect(r.contentAr).not.toMatch(GENERIC);
    expect(r.tokensUsed?.costUsd ?? 0).toBe(0);
  });

  it("answering with a source continues to the one remaining question, then to a plan built from the original topic", async () => {
    const source = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "topic_source_required", question: "من أي مصدر؟", value: "منشورات من منصة إكس" }] });
    const when = JSON.stringify({ type: "clarification_answers", answers: [{ questionId: "social_time_required", question: "ما الفترة؟", value: "آخر شهر" }] });
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    // The model only announces a plan; the plan must then come from the brief the answers built (code path).
    (handler as any).llm.executeTurn = vi.fn(async () => ({ output: { type: "answer_question", answerAr: "هجهز لك خطة دلوقتي" }, inputTokens: 500, outputTokens: 20, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t" }));
    await db.createRow({ tableId: "conversations", rowId: "c_topic", data: { userId: "u_topic", title: "x", status: "active", totalTokens: 0 } });
    const send = (message: string) => handler.handleUserMessage({ userId: "u_topic", conversationId: "c_topic", message, userBalance: 5000 });
    const first = await send(STUDIES);
    const second = await send(source);
    const third = await send(when);
    expect(first.outputType).toBe("ask_clarification");
    expect(second.outputType).toBe("ask_clarification");
    expect(second.clarificationQuestions).toEqual(["ما الفترة الزمنية التي تريد البحث فيها؟"]);
    expect(third.outputType).toBe("propose_plan");
    expect(third.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    expect(third.planQuote.items[0].params.query).toContain("الطاقة الشمسية");
    expect(third.planQuote.items[0].targetVolumeMax).toBe(10);
  });
});
