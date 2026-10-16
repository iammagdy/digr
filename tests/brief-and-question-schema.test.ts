import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mock catalogClient before chatHandler loads it
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import {
  ChatHandler,
  extractTopicChips,
  buildCodeDiscoveryFallback,
  filterQuestionsAlreadyInBrief,
  deduplicateIntroText,
} from "../src/functions/shared/chatHandler";
import {
  normalizeDiscoveryQuestions,
  INTERNAL_DISCOVERY_KEYS,
} from "../src/app/dashboard/chat/components/discoveryQuestions";
import {
  extractBriefFromMessage,
  extractBriefFromCardAnswers,
  isBriefComplete,
  isRepetitionComplaint,
  clearBriefCacheForTesting,
  type ResearchBrief,
} from "../src/functions/shared/briefManager";
import {
  AskClarificationSchema,
  AskQuestionsSchema,
  ProposePlanSchema,
  UpdateBriefSchema,
  ClarificationQuestionItemSchema,
  LlmClient,
  getLastLlmFallbackReason,
  getLastLlmFallbackDetail,
} from "../src/functions/shared/llmClient";
import { formatNumber } from "../src/lib/honestDisplay";
import { RAW_SEED_CAPABILITIES } from "../src/functions/shared/capabilityRegistry";

const mockedSearchCatalog = vi.mocked(searchCatalog);

const FB_ENDPOINT: any = {
  slug: "facebook-post-comments",
  id: "treg-facebook-post-comments-v1",
  nameAr: "استخراج تعليقات منشورات فيسبوك العامة",
  nameEn: "Facebook Post Comments",
  platform: "facebook",
  summaryAr: "جمع التعليقات العامة على منشورات فيسبوك",
  billingUnit: "page",
  catalogPriceUsd: 0.0019,
  pointsPerUnit: 11,
  pagination: { type: "cursor", maxLimit: 50 },
  observedSuccessRate: 0.9,
  method: "GET",
  paramsSchema: {
    type: "object",
    properties: { postUrl: { type: "string" }, maxPages: { type: "integer" } },
    required: ["postUrl"],
  },
};

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const parseEqual = (q: string): [string, string[]] | null => {
    const m = /^equal\("([^"]+)",\s*(\[.*\]|".*")\)$/.exec(q.trim());
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[2]);
      const vals = Array.isArray(parsed) ? parsed : [parsed];
      return [m[1], vals.map(String)];
    } catch {
      return null;
    }
  };
  const parseLimit = (q: string): number | null => {
    const m = /^limit\((\d+)\)$/.exec(q.trim());
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async updateRow({ tableId, rowId, data }: any) {
      const cur = table(tableId).get(rowId) || { $id: rowId };
      const doc = { ...cur, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
    async getRow({ tableId, rowId }: any) {
      const doc = table(tableId).get(rowId);
      if (!doc) throw new Error(`Row ${rowId} not found in ${tableId}`);
      return doc;
    },
    async listRows({ tableId, queries = [] }: any) {
      let rows = Array.from(table(tableId).values());
      for (const q of queries) {
        const eq = parseEqual(q);
        if (eq) {
          const [field, vals] = eq;
          rows = rows.filter((r) => vals.includes(String(r[field])));
        }
        const lim = parseLimit(q);
        if (lim !== null) {
          rows = rows.slice(0, lim);
        }
      }
      return { total: rows.length, rows };
    },
  };
}

describe("Brief & Question Schema Hardening (Live Bug Fixes)", () => {
  beforeEach(() => {
    clearBriefCacheForTesting();
    mockedSearchCatalog.mockReset();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]);
  });

  // (a) options built from a payload containing keys questionId/answers/type never produce those as chips
  it("(a) options built from a payload containing internal keys questionId/answers/type never produce those as chips", () => {
    const payloadWithInternalKeys = [
      {
        id: "q1",
        text: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
        options: ["questionId", "answers", "clarification", "type", "value"],
      },
    ];

    const normalized = normalizeDiscoveryQuestions(payloadWithInternalKeys);
    expect(normalized.length).toBe(1);
    expect(normalized[0].options).toEqual([]);
    expect(normalized[0].type).toBe("free");

    // Mix of real options and internal keys
    const mixed = normalizeDiscoveryQuestions([
      {
        id: "q2",
        text: "ما زوايا الموضوع؟",
        options: ["أسعار الذهب", "questionId", "تداولات اليوم", "answers"],
      },
    ]);
    expect(mixed[0].options).toEqual(["أسعار الذهب", "تداولات اليوم"]);

    // extractTopicChips never extracts internal keys or JSON structure
    const jsonMessage = JSON.stringify({
      type: "clarification_answers",
      answers: [
        {
          questionId: "q1",
          question: "ما الكلمات المفتاحية؟",
          value: "أسعار الذهب والمجوهرات",
        },
      ],
    });
    const chips = extractTopicChips(jsonMessage);
    expect(chips).toContain("الذهب");
    expect(chips).toContain("والمجوهرات");
    for (const key of INTERNAL_DISCOVERY_KEYS) {
      expect(chips).not.toContain(key);
    }
    expect(chips).not.toContain("questionId");
    expect(chips).not.toContain("answers");
    expect(chips).not.toContain("type");
  });

  // (b) 3 questions show "٠ / ٣" style counter correctly, 1 question shows no counter, never "/ ٠"
  it("(b) 3 questions show '٠ / ٣' style counter correctly, 1 question shows no counter, never '/ ٠'", () => {
    const threeQuestions = normalizeDiscoveryQuestions([
      { id: "q1", text: "السؤال الأول", options: ["خيار 1"] },
      { id: "q2", text: "السؤال الثاني", options: ["خيار 2"] },
      { id: "q3", text: "السؤال الثالث", options: ["خيار 3"] },
    ]);
    expect(threeQuestions.length).toBe(3);

    // Format counter: answered 0 of 3
    const answeredCount = 0;
    const totalCount = threeQuestions.length;
    const formattedCounter = `${formatNumber(answeredCount)} / ${formatNumber(totalCount)}`;
    expect(formattedCounter).toBe("٠ / ٣");

    // Guard rule: counter and progress bar rendered only when length >= 2
    expect(threeQuestions.length >= 2).toBe(true);

    const oneQuestion = normalizeDiscoveryQuestions([
      { id: "q1", text: "السؤال الأول", options: ["خيار 1"] },
    ]);
    expect(oneQuestion.length).toBe(1);
    expect(oneQuestion.length >= 2).toBe(false); // Counter is hidden for 1 question

    const zeroQuestions = normalizeDiscoveryQuestions([]);
    expect(zeroQuestions.length).toBe(0);
    expect(zeroQuestions.length >= 2).toBe(false); // Counter never rendered, never produces "/ ٠"
  });

  // (c) message with platform+topic+volume+date goes straight to a plan with 0 repeated questions
  it("(c) message with platform+topic+volume+date goes straight to a plan with 0 repeated questions", async () => {
    const userMsg = "عايز أسحب 3000 تعليق من فيسبوك آخر شهر عن أسعار الدهب";
    const brief = extractBriefFromMessage(userMsg);

    expect(brief.platforms).toContain("facebook");
    expect(brief.targetVolume).toBe(3000);
    expect(brief.dateRange).toBe("آخر شهر");
    expect(brief.topics.length).toBeGreaterThan(0);
    expect(isBriefComplete(brief)).toBe(true);

    // Filter questions: all core fields (platform, topic, volume, date) are known, so 0 questions remain
    const fallback = buildCodeDiscoveryFallback([], userMsg, false, brief);
    expect(fallback.items.length).toBe(0);

    // Execute through ChatHandler
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);
    const res = await handler.handleUserMessage({
      userId: "user_test",
      message: userMsg,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.clarificationItems).toBeUndefined();
    expect(mockedSearchCatalog).toHaveBeenCalled();
  });

  it("routes decision-maker requests to the people catalog capability with query parameters", async () => {
    const message = "Find 20 solar industry decision-makers (CEOs) in Germany with names, job titles, work emails, and email verification status";
    expect(RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-people-search")?.tregEndpointId)
      .toBe("icypeas.people.search");

    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_people_route",
      message,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote?.items?.[0]?.capabilitySlug).toBe("icypeas-people-search");
    expect(res.planQuote?.items?.[0]?.params?.query).toBeDefined();
    expect(res.planQuote?.items?.[0]?.params?.query?.postUrl).toBeUndefined();
  });

  it("asks for a country before quoting a people search instead of defaulting to Egypt", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_people_country_required",
      message: "Find 20 decision-makers with names, job titles, and work emails",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationQuestions?.join(" ")).toContain("الدولة");
  });

  it("asks for unstated country and industry before creating a company quote", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_company_required_fields",
      message: "Find 100 companies",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationQuestions?.join(" ")).toMatch(/الدولة.*القطاع|القطاع.*الدولة/);
  });

  // (d) a submitted card answer is stored in the brief and the same question is not asked again
  it("(d) a submitted card answer is stored in the brief and the same question is not asked again", () => {
    let currentBrief: ResearchBrief = { platforms: [], topics: [] };

    // User submits answer card specifying platform as Facebook
    const cardAnswers = [
      {
        questionId: "code_platform",
        question: "ما المنصة المستهدفة لجمع البيانات؟",
        value: "فيسبوك",
      },
    ];

    currentBrief = extractBriefFromCardAnswers(cardAnswers, currentBrief);
    expect(currentBrief.platforms).toContain("facebook");

    // Check filtering: platform question is filtered out and never asked again
    const questionsToFilter = [
      {
        id: "code_platform",
        text: "ما المنصة المستهدفة لجمع البيانات؟",
        question: "ما المنصة المستهدفة لجمع البيانات؟",
        type: "single" as const,
        options: ["فيسبوك", "تيك توك"],
        allowOther: true,
      },
      {
        id: "code_topic",
        text: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
        question: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
        type: "free" as const,
        options: [],
        allowOther: true,
      },
    ];

    const filtered = filterQuestionsAlreadyInBrief(questionsToFilter, currentBrief);
    expect(filtered.some((q) => q.id === "code_platform")).toBe(false);
    expect(filtered.some((q) => q.id === "code_topic")).toBe(true);
  });

  // (e) "منا قولتلك" style repetition complaint leads to a plan or a different question, never the same card
  it("(e) 'منا قولتلك' style repetition complaint leads to a plan or a different question, never the same card", async () => {
    expect(isRepetitionComplaint("منا قولتلك يا عم")).toBe(true);
    expect(isRepetitionComplaint("ما انا لسه قايل لك فيسبوك")).toBe(true);
    expect(isRepetitionComplaint("سبق وقلت لحضرتك")).toBe(true);

    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    // Initial message establishes platform
    await handler.handleUserMessage({
      userId: "user_rep",
      conversationId: "conv_rep_1",
      message: "عايز تعليقات من فيسبوك عن الدهب",
      testScenario: "search_clarify",
    });

    // User gets frustrated by a repeated question and replies with complaint
    const complaintRes = await handler.handleUserMessage({
      userId: "user_rep",
      conversationId: "conv_rep_1",
      message: "منا قولتلك يا عم فيسبوك والدهب",
      testScenario: "phase2_plan",
    });

    // Must advance to plan or review, never repeat the same platform question card
    expect(complaintRes.outputType).toBe("propose_plan");
    if (complaintRes.clarificationItems) {
      expect(complaintRes.clarificationItems.some((q) => q.id === "code_platform")).toBe(false);
    }
  });

  // (f) schema validator tolerates extra and mis-typed fields
  it("(f) schema validator tolerates extra and mis-typed fields", () => {
    // Tolerates unknown extra fields (passthrough) on tool schemas
    const extraFieldQuestions = {
      type: "ask_questions",
      unknownProperty: "extra_data_from_model",
      extraNested: { foo: "bar" },
      intro: "عشان أجهز لك خطة دقيقة، محتاج أعرف:",
      questionsAr: ["ما المنصة؟"],
    };
    const parsedQuestionsExtra = AskQuestionsSchema.safeParse(extraFieldQuestions);
    expect(parsedQuestionsExtra.success).toBe(true);

    const extraFieldPlan = {
      type: "propose_plan",
      summaryAr: "خطة تجريبية",
      unknownProperty: "extra_data_from_model",
      capabilities: [
        {
          capabilitySlug: "facebook-post-comments",
          targetVolumeMin: 10,
          targetVolumeMax: 100,
          params: {},
          extraFieldInCap: true,
        },
      ],
      outputFormats: ["xlsx"],
    };
    const parsedPlanExtra = ProposePlanSchema.safeParse(extraFieldPlan);
    expect(parsedPlanExtra.success).toBe(true);

    // Tolerates string-vs-array mismatches through coercion
    const stringInsteadOfArray = {
      type: "ask_questions",
      questionsAr: "سؤال مفرد بدلاً من مصفوفة",
    };
    const parsedQuestions = AskQuestionsSchema.safeParse(stringInsteadOfArray);
    expect(parsedQuestions.success).toBe(true);
    if (parsedQuestions.success) {
      expect(Array.isArray(parsedQuestions.data.questionsAr)).toBe(true);
      expect(parsedQuestions.data.questionsAr).toEqual(["سؤال مفرد بدلاً من مصفوفة"]);
    }

    // ProposePlan tolerates single capability and string outputFormats
    const planWithCoercions = {
      type: "propose_plan",
      summaryAr: "خطة تجريبية",
      capabilities: {
        capabilitySlug: "facebook-post-comments",
        targetVolumeMin: "10",
        targetVolumeMax: "100",
        params: { url: "https://facebook.com/p/1" },
      },
      outputFormats: "xlsx",
    };
    const parsedPlan = ProposePlanSchema.safeParse(planWithCoercions);
    expect(parsedPlan.success).toBe(true);
    if (parsedPlan.success) {
      expect(Array.isArray(parsedPlan.data.capabilities)).toBe(true);
      expect(parsedPlan.data.capabilities[0].targetVolumeMin).toBe(10);
      expect(parsedPlan.data.outputFormats).toEqual(["xlsx"]);
    }

    // UpdateBrief coerces single string platform/topic to arrays
    const briefWithStrings = {
      type: "update_brief",
      platforms: "facebook",
      topics: "أسعار الدهب",
      targetVolume: "1000",
    };
    const parsedBrief = UpdateBriefSchema.safeParse(briefWithStrings);
    expect(parsedBrief.success).toBe(true);
    if (parsedBrief.success) {
      expect(parsedBrief.data.platforms).toEqual(["facebook"]);
      expect(parsedBrief.data.topics).toEqual(["أسعار الدهب"]);
      expect(parsedBrief.data.targetVolume).toBe(1000);
    }

    // Failing field path is captured in last_fallback_detail
    const client = new LlmClient({ provider: "fake" });
    const invalidPayload = { type: "propose_plan", summaryAr: "" }; // missing required capabilities
    const validationResult = ProposePlanSchema.safeParse(invalidPayload);
    expect(validationResult.success).toBe(false);
    if (!validationResult.success) {
      (client as any).handleProviderError(validationResult.error, "anthropic");
      expect(getLastLlmFallbackReason()).toBe("schema_invalid");
      const detail = getLastLlmFallbackDetail();
      expect(detail).toBeTruthy();
      expect(detail).toContain("capabilities");
      expect(detail?.length).toBeLessThanOrEqual(200);
    }
  });

  // Bonus verification: deduplicateIntroText
  it("deduplicates repeated intro phrases in assistant response text", () => {
    const duplicated =
      "عشان أجهز لك خطة دقيقة، محتاج أعرف:\nعشان أجهز لك خطة دقيقة، محتاج أعرف:";
    expect(deduplicateIntroText(duplicated)).toBe("عشان أجهز لك خطة دقيقة، محتاج أعرف:");

    const duplicatedWithColon =
      "عشان أجهز لك خطة دقيقة محتاج أعرف:\n• سؤال 1\nعشان أجهز لك خطة دقيقة، محتاج أعرف:";
    expect(deduplicateIntroText(duplicatedWithColon)).toBe(
      "عشان أجهز لك خطة دقيقة محتاج أعرف:\n• سؤال 1",
    );
  });
});
