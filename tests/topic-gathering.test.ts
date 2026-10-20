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

  it("in the chat: an honest «not available yet» answer, no model turn, no social platform offered as a source, no plan, nothing charged", async () => {
    const { responses } = await runConversation([STUDIES]);
    const r = responses[0];
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toContain("غير متاح بعد");
    expect(r.contentAr).toContain("الطاقة الشمسية");
    expect(r.contentAr).toContain("ألمانيا");
    // what IS available is listed, and the answer is not a question, a card, a quote or a charge
    expect(r.contentAr).toContain("قوائم الشركات");
    expect(r.contentAr).toContain("صناع القرار");
    expect(r.clarificationQuestions ?? []).toHaveLength(0);
    expect(r.planQuote).toBeUndefined();
    expect(r.contentAr).not.toMatch(GENERIC);
    expect(r.tokensUsed?.costUsd ?? 0).toBe(0);
    // none of the old source options is offered
    for (const option of TOPIC_SOURCE_OPTIONS_AR) expect(r.contentAr).not.toContain(option);
  });

  it("every wording of a studies request gets the same honest answer, and a request for tweets on the same topic still gets a plan", async () => {
    for (const text of ["اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا", "عايز أبحاث عن الذكاء الاصطناعي", "هات مقالات علمية عن الطاقة المتجددة", "عايز مواد علمية عن الطاقة الشمسية في ألمانيا"]) {
      const { responses } = await runConversation([text]);
      expect(responses[0].outputType, text).toBe("answer_question");
      expect(responses[0].contentAr, text).toContain("غير متاح بعد");
    }
    // After the honest answer, the customer's next request is read on its own: tweets on the topic are planned.
    const { responses } = await runConversation([STUDIES, "هات ١٠ تغريدات عن الطاقة الشمسية في ٢٠٢٥"]);
    expect(responses[1].outputType).toBe("propose_plan");
    expect(responses[1].planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    expect(responses[1].planQuote.items[0].params.query).toContain("الطاقة الشمسية");
    expect(responses[1].planQuote.items[0].targetVolumeMax).toBe(10);
  });

  it("when the model answers «suggest_alternative» for a request with a topic, the generic sentence is replaced by the one specific question", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => ({
      output: { type: "suggest_alternative", unsupportedService: "الدراسات الأكاديمية", explanationAr: "غير متاح مباشرة", suggestedAlternativeAr: "منصات التواصل" },
      inputTokens: 500, outputTokens: 40, costUsd: 0.0005, model: "claude-haiku-5-5", promptVersion: "t",
    }));
    // not a studies wording (those are answered by code), so the model is reached
    const res: any = await handler.handleUserMessage({ userId: "u_alt", message: "عايز بيانات استثمارية عن الطاقة الشمسية في ألمانيا", userBalance: 5000 });
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.clarificationQuestions[0]).toContain("الطاقة الشمسية");
    expect(res.contentAr).not.toMatch(GENERIC);
    expect(res.contentAr).not.toContain("اكتب الموضوع أو أرسل رابط");
  });

  it("the short generic prompt remains only as the last resort for a request with no topic", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    const at = source.indexOf("اكتب الموضوع أو أرسل رابط المصدر");
    expect(at).toBeGreaterThan(0);
    // it sits in the `else` branch of the topic check, never as the first answer
    expect(source.slice(Math.max(0, at - 220), at)).toContain("} else {");
  });
});
