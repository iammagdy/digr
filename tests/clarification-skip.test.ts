import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runConversation } from "./helpers/chatSession";
import { formatClarificationMessageForAssistant, formatStructuredClarificationAnswers, skippedQuestionIdsFromHistory } from "../src/functions/shared/clarification";
import { scopeRequestText } from "../src/functions/shared/requestScope";
import { scrubPlaceholderPhrases } from "../src/lib/customerScrub";
import { customerFacingAssistantCopy } from "../src/lib/customerFacingAssistantCopy";
import { customerFacingConversationTitle } from "../src/lib/customerFacingConversationTitle";
import { getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";

/**
 * QA of the live account: a clarification answer (typed, a chosen option, or «skip») must never become the subject, goal or
 * understanding; a skipped question is never shown again with the same card; what the customer already stated (the platform) is
 * never asked twice; no placeholder phrase reaches a customer-visible field.
 */
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);

const TARGET_Q = "ما موضوع الفيديوهات أو اسم القناة التي تريد تعليقاتها؟ ويمكنك لصق رابط فيديو بدل ذلك.";
const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const TIME_Q = "ما الفترة الزمنية التي تهمّك؟";
const CHANNELS_Q = "ما أسماء القنوات أو روابطها؟";

const PLACEHOLDER = /لم يحدد المستخدم|لم يختر المستخدم|اطلب منه الاختيار|ولا تفترض|إجابة\s*»|undefined|null|NaN|Failed to fetch/;
const visible = (r: any) => [r.contentAr, r.planQuote?.summaryAr, r.clarificationIntro, ...(r.clarificationQuestions || [])].filter(Boolean).join(" \n ");

describe("the live YouTube conversation, replayed offline", () => {
  it("the platform given in the second message is never asked again, no question text becomes the subject, and the plan is clean", async () => {
    const { responses } = await runConversation([
      "عايز كل تعليقات فيديوهات قناة الفيفا الرسمية عن منتخب مصر",
      "كل تعليقات ٣ فيديوهات على يوتيوب",
      answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق"),
      answer("social_time_required", TIME_Q, "آخر ٣ شهور"),
    ]);
    expect(responses[0].clarificationItems.map((q: any) => q.id)).toEqual(["social_platform_required"]);
    expect(responses[1].clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    expect(responses[2].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(responses[3].outputType).toBe("propose_plan");
    for (const r of responses.slice(1)) {
      // the chat sentence is the understanding line, then the question on its own last line; only the understanding must be clean
      const prose = [String(r.contentAr || "").split("\n")[0], r.planQuote?.summaryAr].filter(Boolean).join(" ");
      expect(visible(r)).not.toMatch(PLACEHOLDER);
      expect(prose).not.toContain("ما رابط الفيديو");
      expect(prose).not.toContain("ما الحد الأقصى لعدد");
      expect(prose).not.toContain("ما الفترة الزمنية");
      expect(visible(r)).toContain("منتخب مصر");
    }
    expect(responses.flatMap((r: any) => (r.clarificationItems || []).map((q: any) => q.id)).filter((id: string) => id === "social_platform_required")).toHaveLength(1);
    expect(responses[3].planQuote.summaryAr).toContain("«منتخب مصر»");
  });

  it("the same card is not shown twice in a row when the same answer is sent again (a card clicked twice)", async () => {
    const { responses } = await runConversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق"),
      answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق"),
    ]);
    expect(responses[1].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(responses[2].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    for (const r of responses) expect(visible(r)).not.toMatch(PLACEHOLDER);
  });
});

describe("«كل التعليقات» of N videos without a link", () => {
  it("asks ONE question that offers a topic or a channel name, not a mandatory link, and not the platform", async () => {
    const { responses } = await runConversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب"]);
    expect(responses[0].clarificationItems).toHaveLength(1);
    expect(responses[0].clarificationItems[0].id).toBe("social_comment_target_required");
    expect(responses[0].clarificationItems[0].text).toBe(TARGET_Q);
    expect(responses[0].clarificationItems[0].text).toContain("موضوع");
    expect(responses[0].clarificationItems[0].text).toContain("اسم القناة");
    expect(responses[0].contentAr).not.toContain("على أي منصة");
  });

  it("a typed topic is accepted and moves on to the next different question", async () => {
    const { responses } = await runConversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب", "منتخب مصر"]);
    expect(responses[1].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(visible(responses[1])).toContain("منتخب مصر");
    expect(visible(responses[1])).not.toMatch(PLACEHOLDER);
  });

  it("skip: never the same card again; one plain sentence asks for typed text, and a typed topic then goes on", async () => {
    const { responses } = await runConversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب",
      answer("social_comment_target_required", TARGET_Q),
      "منتخب مصر",
    ]);
    expect(responses[1].outputType).toBe("answer_question");
    expect(responses[1].clarificationItems ?? []).toHaveLength(0);
    expect(responses[1].contentAr).toContain("اكتب موضوع الفيديوهات أو اسم القناة");
    expect(responses[1].contentAr).not.toMatch(PLACEHOLDER);
    expect(responses[2].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(visible(responses[2])).toContain("«منتخب مصر»");
  });
});

describe("the big-mission template (channels, top videos by views, all comments)", () => {
  const TEMPLATE = "أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات تيك توك مع كل التعليقات";

  it("the platform stated is not asked; the channels are asked once; the understanding sentence carries no question text", async () => {
    const { responses } = await runConversation([TEMPLATE]);
    expect(responses[0].clarificationItems.map((q: any) => q.id)).toEqual(["social_channel_required"]);
    expect(responses[0].contentAr).toContain("تيك توك");
    expect(responses[0].contentAr).not.toContain("على أي منصة");
    expect(visible(responses[0])).not.toMatch(PLACEHOLDER);
  });

  it("skipping the channels does not show the same card or a refusal: one different question (the topic), then typed channel names go on to the cap", async () => {
    const { responses } = await runConversation([
      TEMPLATE,
      answer("social_channel_required", CHANNELS_Q),
      "@aljazeera و@alarabiya و@skynews",
    ]);
    expect(responses[1].outputType).toBe("ask_clarification");
    expect(responses[1].clarificationItems.map((q: any) => q.id)).toEqual(["social_topic_required"]);
    expect(responses[1].clarificationItems.map((q: any) => q.id)).not.toContain("social_channel_required");
    expect(responses[1].contentAr).not.toContain("لا أستطيع");
    expect(responses[2].clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    for (const r of responses) expect(visible(r)).not.toMatch(PLACEHOLDER);
    expect(visible(responses[2])).not.toContain("ما أسماء القنوات");
  });
});

describe("skipping a question that has a stated default", () => {
  it("the period: the plan goes ahead and says plainly that no period limits the results", async () => {
    const { responses } = await runConversation([
      "عايز ١٠٠ تغريدة عن الغلاء على إكس",
      answer("social_time_required", TIME_Q),
    ]);
    expect(responses[0].clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(responses[1].outputType).toBe("propose_plan");
    expect(responses[1].contentAr).toContain("لم تحدّد فترة، فلن نقيّد النتائج بتاريخ");
    expect(responses[1].planQuote.items[0].params).not.toHaveProperty("dateFrom");
    expect(visible(responses[1])).not.toMatch(PLACEHOLDER);
  });

  it("the cap: the plan goes ahead and the job's own limit applies", async () => {
    const { responses } = await runConversation([
      "عايز كل المنشورات عن القهوة على إكس آخر شهر",
      answer("volume_cap_required", "ما الحد الأقصى لعدد السجلات الذي تريده؟"),
    ]);
    expect(responses[0].clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    expect(responses[1].outputType).toBe("propose_plan");
    expect(visible(responses[1])).not.toMatch(PLACEHOLDER);
  });

  it("skipping the platform when it was never stated: one plain sentence asking to type it, never the same card", async () => {
    const { responses } = await runConversation([
      "عايز كل تعليقات فيديوهات قناة الفيفا الرسمية عن منتخب مصر",
      answer("social_platform_required", "على أي منصة تريد البحث؟"),
    ]);
    expect(responses[0].clarificationItems.map((q: any) => q.id)).toEqual(["social_platform_required"]);
    expect(responses[1].outputType).toBe("answer_question");
    expect(responses[1].contentAr).toContain("اكتب اسمها في رسالتك");
    expect(responses[1].clarificationItems ?? []).toHaveLength(0);
  });
});

describe("the pieces", () => {
  it("many card answers never push the stated request out of the scope", () => {
    const priors = [
      "عايز كل تعليقات ٣ فيديوهات عن منتخب مصر على يوتيوب",
      "الفترة المطلوبة: آخر ٣ شهور", "الحد الأقصى المطلوب: ٢٠٠٠ تعليق", "الحد الأقصى المطلوب: ٢٠٠٠ تعليق",
      "الحد الأقصى المطلوب: ٢٠٠٠ تعليق", "الحد الأقصى المطلوب: ٢٠٠٠ تعليق", "الحد الأقصى المطلوب: ٢٠٠٠ تعليق",
    ];
    const scope = scopeRequestText(priors, "الحد الأقصى المطلوب: ٢٠٠٠ تعليق");
    expect(scope).toContain("يوتيوب");
    expect(scope).toContain("منتخب مصر");
  });

  it("a message that only names the platform of the request before it completes that request", () => {
    expect(scopeRequestText(["عايز كل تعليقات فيديوهات قناة الفيفا الرسمية عن منتخب مصر"], "كل تعليقات ٣ فيديوهات على يوتيوب")).toContain("منتخب مصر");
    // a new request with its own subject does not inherit the old one
    expect(scopeRequestText(["عايز كل تعليقات فيديوهات قناة الفيفا الرسمية عن منتخب مصر"], "عايز ١٠٠ تغريدة عن الغلاء على إكس")).not.toContain("منتخب مصر");
  });

  it("skipped questions are read from the stored answers; a later value clears the skip; malformed answers skip nothing", () => {
    const skip = answer("social_time_required", TIME_Q);
    const value = answer("social_time_required", TIME_Q, "آخر شهر");
    expect([...skippedQuestionIdsFromHistory(["hello", skip])]).toEqual(["social_time_required"]);
    expect([...skippedQuestionIdsFromHistory([skip, value])]).toEqual([]);
    expect([...skippedQuestionIdsFromHistory(['{"type":"clarification_answers","answers":'])]).toEqual([]);
  });

  it("the model-facing rewrite of a skipped answer never tells anyone to ask the same question again", () => {
    const text = formatClarificationMessageForAssistant(answer("social_comment_target_required", TARGET_Q));
    expect(text).not.toContain("لم يحدد المستخدم");
    expect(text).not.toContain("اسأله عنها");
    expect(text).toContain("لا تكرر السؤال نفسه");
  });

  it("the discovery question honours the skipped set directly", () => {
    const brief: any = { platforms: [], topics: [], notes: "" };
    const first = getDeterministicDiscoveryQuestion("عايز كل تعليقات ٣ فيديوهات على يوتيوب", brief, [], {});
    expect(first.id).toBe("social_comment_target_required");
    const skipped = getDeterministicDiscoveryQuestion("عايز كل تعليقات ٣ فيديوهات على يوتيوب", brief, [], { skipped: new Set(["social_comment_target_required"]) });
    expect(skipped.plain).toBe(true);
    expect(skipped.id).not.toBe("social_comment_target_required");
  });

  it("placeholders are scrubbed from text shown to the customer, including old stored messages and titles", () => {
    expect(scrubPlaceholderPhrases("الهدف: سحب التعليقات عن «لم يحدد المستخدم إجابة ما تريد»، بحد أقصى ٥٠")).toBe("الهدف: سحب التعليقات، بحد أقصى ٥٠");
    expect(scrubPlaceholderPhrases("سحب المنشورات على منصة إكس عن «مباراة مصر والمغرب في كأس العالم إجابة»")).toBe("سحب المنشورات على منصة إكس عن «مباراة مصر والمغرب في كأس العالم»");
    expect(scrubPlaceholderPhrases("فهمت أنك تريد المحتوى عن «ما رابط الفيديو أو المنشور الذي تريد تعليقاته؟» على يوتيوب.")).not.toContain("ما رابط");
    expect(customerFacingAssistantCopy("لم يحدد المستخدم إجابة ما نريد. أعددت لك الخطة.")).toBe("أعددت لك الخطة.");
    expect(customerFacingConversationTitle("سحب التعليقات من فيديوهات يوتيوب عن «لم يحدد…")).toBe("سحب التعليقات من فيديوهات يوتيوب");
    expect(scrubPlaceholderPhrases("خطة عادية عن «منتخب مصر»")).toBe("خطة عادية عن «منتخب مصر»");
  });

  it("the card: a typed answer to the only question goes straight on, and the number box accepts Arabic digits", () => {
    const card = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(card).toContain('onComplete([{ questionId: current.id, question: current.text, value }])');
    expect(card).not.toContain('"number"');
    expect(card).toContain('type="text" inputMode=');
  });
});
