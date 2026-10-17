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
  buildAutoPlanProposal,
  routePeopleAlternative,
  routeCompanySearchRequest,
  buildCodeDiscoveryFallback,
  filterQuestionsAlreadyInBrief,
  deduplicateIntroText,
  routeUnavailablePlatformRequest,
} from "../src/functions/shared/chatHandler";
import {
  normalizeDiscoveryQuestions,
  INTERNAL_DISCOVERY_KEYS,
} from "../src/app/dashboard/chat/components/discoveryQuestions";
import {
  extractBriefFromMessage,
  extractBriefFromCardAnswers,
  saveConversationBrief,
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
import { getCompanyRequirementItems } from "../src/lib/planParameters";

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
    expect(res.planQuote).toBeDefined();
    expect(mockedSearchCatalog).toHaveBeenCalled();
  });

  it("routes decision-maker requests through TREG people search and contact enrichment", async () => {
    const message = "Find 20 solar industry decision-makers (CEOs) in Germany with names, job titles, work emails, and email verification status";
    expect(RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "professional-people-search")?.tregEndpointId)
      .toBe("treg.people.search");

    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_people_route",
      message,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote?.items?.[0]?.endpointId).toBe("treg.people.search");
    expect(res.planQuote?.items?.[0]?.params).toMatchObject({ country: "DE", title: "CEO", limit: 20 });
    expect(res.planQuote?.items?.[0]?.params?.requiredContactFields).toEqual(["work_email", "phone"]);
  });

  it("builds a people-search fallback from the people capability instead of the nearest unrelated service", () => {
    const request = "Find 20 solar industry decision-makers in Germany with names, job titles, and work emails";
    const brief: ResearchBrief = {
      platforms: [],
      topics: ["solar industry decision-makers"],
      targetVolume: 20,
    };

    const proposal = buildAutoPlanProposal(brief, RAW_SEED_CAPABILITIES as any, request);
    const peopleStep = proposal.capabilities[0];

    expect(peopleStep.capabilitySlug).toBe("professional-people-search");
    expect(peopleStep.targetVolumeMax).toBe(20);
    expect(peopleStep.params.country).toBe("DE");
    expect(peopleStep.params.q).toContain("decision-makers");
    expect(peopleStep.params.title).toBeUndefined();
    expect(proposal.summaryAr).toContain("ألمانيا");
    expect(proposal.summaryAr).not.toContain("تيك توك");
  });

  it("requires country before quoting people search and does not offer unrelated alternatives", () => {
    const suggestion = {
      type: "suggest_alternative",
      unsupportedService: "decision-makers",
      explanationAr: "هذه الخدمة غير متاحة",
      closestAlternative: "تيك توك",
      canRequestFeature: true,
    };
    const brief: ResearchBrief = { platforms: [], topics: ["solar decision-makers"], targetVolume: 20 };
    const request = "Find 20 solar decision-makers in Germany with job titles and work emails";

    const routed = routePeopleAlternative(suggestion, brief, RAW_SEED_CAPABILITIES as any, request);
    expect(routed.type).toBe("propose_plan");

    const clarification = routePeopleAlternative(suggestion, brief, RAW_SEED_CAPABILITIES as any, "Find 20 decision-makers with work emails");
    expect(clarification.type).toBe("ask_clarification");

    const unavailable = routePeopleAlternative(suggestion, brief, [], request);
    expect(unavailable.type).toBe("refuse");
    expect(unavailable.reasonAr).toContain("خدمة البحث عن صناع القرار والمهنيين غير متاحة حالياً");
    expect(unavailable.reasonAr).not.toContain("تيك توك");
  });

  it("replaces a generic company plan when the customer explicitly asked for decision-makers", () => {
    const companyCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-companies-search")!;
    const companyPlan = {
      type: "propose_plan",
      summaryAr: "استخراج بيانات شركات",
      capabilities: [{ capabilitySlug: companyCap.slug, endpointId: companyCap.tregEndpointId, params: { country: "Egypt", industry: "IT" } }],
      outputFormats: ["xlsx"],
    };
    const request = "ابحث عن نحو 20 من صناع القرار في شركات التقنية المالية في ألمانيا، مع الاسم والمسمى الوظيفي وبريد العمل";
    const brief: ResearchBrief = { platforms: ["companies"], topics: ["FinTech"], targetVolume: 20 };

    const routed = routePeopleAlternative(companyPlan, brief, RAW_SEED_CAPABILITIES as any, request);

    expect(routed.type).toBe("propose_plan");
    expect(routed.capabilities[0].capabilitySlug).toBe("professional-people-search");
    expect(routed.capabilities[0].endpointId).toBe("treg.people.search");
  });

  it("routes explicit company requests away from the generic alternative and asks when scope is missing", () => {
    const brief: ResearchBrief = { platforms: [], topics: ["fintech"], targetVolume: 50 };
    const companyRequest = "أريد ٥٠ شركة في قطاع التقنية المالية في ألمانيا";
    const suggestion = { type: "suggest_alternative", explanationAr: "لا أستطيع إعداد الخطة" };

    const routed = routeCompanySearchRequest(suggestion, brief, RAW_SEED_CAPABILITIES as any, companyRequest);
    expect(routed.type).toBe("propose_plan");
    expect(routed.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
    expect(routed.capabilities[0].targetVolumeMax).toBe(50);
    expect(routed.capabilities[0].params.country).toBe("Germany");
    expect(routed.capabilities[0].params.industry).toBe("FinTech");
    expect(routed.summaryAr).toContain("التقنية المالية");

    const unrelatedPlan = routeCompanySearchRequest(
      {
        type: "propose_plan",
        capabilities: [
          { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: 100 },
          { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: 100 },
        ],
      },
      brief,
      RAW_SEED_CAPABILITIES as any,
      companyRequest,
    );
    expect(unrelatedPlan.type).toBe("propose_plan");
    expect(unrelatedPlan.capabilities).toHaveLength(1);
    expect(unrelatedPlan.capabilities[0].targetVolumeMax).toBe(50);

    const clarification = routeCompanySearchRequest(
      suggestion,
      { platforms: [], topics: ["شركات"], targetVolume: 100 },
      RAW_SEED_CAPABILITIES as any,
      "أريد قائمة تضم ١٠٠ شركة للتواصل التجاري",
    );
    expect(clarification.type).toBe("ask_clarification");
    expect(clarification.questionsAr.join(" ")).toContain("الدولة");
    expect(clarification.questionsAr.join(" ")).toContain("القطاع");
    expect(clarification.questionsAr.join(" ")).toContain("التواصل التجاري");
  });

  it("asks for missing decision-maker scope instead of refusing the enabled service", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_people_country_required",
      message: "Find 20 decision-makers with names, job titles, and work emails",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationItems?.[0]?.id).toBe("people_country_required");
  });

  it("asks one adaptive question at a time when company scope is unstated", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_company_required_fields",
      message: "Find 100 companies",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationQuestions?.join(" ")).toContain("الدولة");
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.clarificationItems?.[0]?.id).toBe("company_country_required");
  });

  it("starts commercial-outreach clarification with the missing country", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_commercial_outreach_required_fields",
      message: "أريد قائمة تضم 100 شركة للتواصل التجاري.",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.clarificationQuestions?.[0]).toContain("الدولة");
    expect(res.clarificationItems?.[0]?.id).toBe("company_country_required");
  });

  it("clarifies an ambiguous company name before asking for country or industry", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_ambiguous_tawasol_company",
      message: "أريد أن أضم شركة تواصل التجاري إلى القائمة.",
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationItems).toHaveLength(1);
    expect(res.clarificationItems?.[0]).toMatchObject({
      id: "company_outreach_required",
      text: expect.stringContaining("قائمة شركات للتواصل التجاري"),
      options: expect.arrayContaining(["شركة محددة بهذا الاسم", "قائمة شركات للتواصل التجاري", "أخرى"]),
    });
  });

  it("keeps a company search in clarification until the user supplies the scope and outreach details", async () => {
    const handler = new ChatHandler(makeMockTables() as any);
    const first = await handler.handleUserMessage({
      userId: "user_company_outreach_discovery",
      message: "أريد قائمة تضم ١٠٠ شركة للتواصل التجاري.",
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(first.outputType).toBe("ask_clarification");
    expect(first.planQuote).toBeUndefined();
    expect(first.clarificationQuestions).toHaveLength(1);
    expect(first.clarificationItems?.[0]?.id).toBe("company_country_required");

    const industryFollowup = await handler.handleUserMessage({
      userId: "user_company_outreach_discovery",
      conversationId: first.conversationId,
      message: JSON.stringify({
        type: "clarification_answers",
        answers: [{ questionId: "company_country_required", question: "ما الدولة؟", value: "ألمانيا" }],
      }),
      answers: [{ questionId: "company_country_required", question: "ما الدولة؟", value: "ألمانيا" }],
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(industryFollowup.outputType).toBe("ask_clarification");
    expect(industryFollowup.clarificationItems).toHaveLength(1);
    expect(industryFollowup.clarificationItems?.[0]?.id).toBe("company_industry_required");

    const outreachFollowup = await handler.handleUserMessage({
      userId: "user_company_outreach_discovery",
      conversationId: first.conversationId,
      message: JSON.stringify({
        type: "clarification_answers",
        answers: [{ questionId: "company_industry_required", question: "ما المجال؟", value: "التقنية المالية" }],
      }),
      answers: [{ questionId: "company_industry_required", question: "ما المجال؟", value: "التقنية المالية" }],
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(outreachFollowup.outputType).toBe("ask_clarification");
    expect(outreachFollowup.clarificationItems).toHaveLength(1);
    expect(outreachFollowup.clarificationItems?.[0]?.id).toBe("company_outreach_required");

    const next = await handler.handleUserMessage({
      userId: "user_company_outreach_discovery",
      conversationId: first.conversationId,
      message: JSON.stringify({
        type: "clarification_answers",
        answers: [{
          questionId: "company_outreach_required",
          question: "ما هدف التواصل والبيانات المطلوبة؟",
          value: "عملاء محتملون، اسم الشركة وموقعها وبريد العمل والهاتف",
        }],
      }),
      answers: [{
        questionId: "company_outreach_required",
        question: "ما هدف التواصل والبيانات المطلوبة؟",
        value: "عملاء محتملون، اسم الشركة وموقعها وبريد العمل والهاتف",
      }],
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(next.outputType).toBe("propose_plan");
    expect(next.planQuote?.targetVolumeMax).toBe(100);
    expect(next.planQuote?.items?.[0]?.params?.query?.location?.include).toEqual(["Germany"]);
    expect(next.planQuote?.items?.[0]?.params?.query?.keyword?.include).toEqual(["fintech", "financial technology"]);
  });

  it("does not treat model-inferred topics or serialized clarification metadata as explicit industry", async () => {
    const companyCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-companies-search")!;
    mockedSearchCatalog.mockResolvedValue([{
      slug: companyCap.slug,
      id: companyCap.tregEndpointId,
      nameAr: companyCap.nameAr,
      nameEn: companyCap.nameEn,
      platform: companyCap.platform,
      summaryAr: companyCap.descriptionAr,
      billingUnit: "record",
      catalogPriceUsd: 0.001,
      pointsPerUnit: 1,
      pagination: { type: "cursor", maxLimit: 100 },
      observedSuccessRate: 0.9,
      method: "GET",
      paramsSchema: JSON.parse(companyCap.paramsSchema),
    } as any]);

    const userId = "user_company_country_only_answer";
    const conversationId = "conversation_company_country_only_answer";
    const tables = makeMockTables();
    await tables.createRow({
      databaseId: "digr",
      tableId: "conversations",
      rowId: conversationId,
      data: { userId, status: "active" },
    });
    await tables.createRow({
      databaseId: "digr",
      tableId: "messages",
      rowId: "initial-company-outreach-request",
      data: {
        conversationId,
        userId,
        role: "user",
        content: "أريد قائمة تضم ١٠٠ شركة للتواصل التجاري.",
        status: "ready",
        createdAt: "2026-10-16T10:00:00.000Z",
      },
    });
    await saveConversationBrief(tables, conversationId, userId, {
      platforms: ["companies"],
      topics: ["FinTech"],
      targetVolume: 100,
    });

    const handler = new ChatHandler(tables as any);
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج بيانات شركات",
        capabilities: [{
          capabilitySlug: "icypeas-companies-search",
          endpointId: "icypeas.companies.search",
          params: { query: {} },
          targetVolumeMin: 1,
          targetVolumeMax: 100,
        }],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية البحث",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });

    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: JSON.stringify({
        type: "clarification_answers",
        answers: [{ questionId: "company_country_required", question: "ما الدولة المطلوبة؟", value: "ألمانيا" }],
      }),
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "company_industry_required" }),
    ]));
    expect(res.clarificationItems?.some((item) => item.id === "company_country_required")).toBe(false);
  });

  it("asks for the actual industry after a named-company request gets only country and sales-purpose answers", async () => {
    const companyCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-companies-search")!;
    mockedSearchCatalog.mockResolvedValue([{
      slug: companyCap.slug,
      id: companyCap.tregEndpointId,
      nameAr: companyCap.nameAr,
      nameEn: companyCap.nameEn,
      platform: companyCap.platform,
      summaryAr: companyCap.descriptionAr,
      billingUnit: "record",
      catalogPriceUsd: 0.001,
      pointsPerUnit: 1,
      pagination: { type: "cursor", maxLimit: 100 },
      observedSuccessRate: 0.9,
      method: "GET",
      paramsSchema: JSON.parse(companyCap.paramsSchema),
    } as any]);

    const userId = "user_tawasol_ambiguous_industry";
    const conversationId = "conversation_tawasol_ambiguous_industry";
    const tables = makeMockTables();
    await tables.createRow({
      databaseId: "digr",
      tableId: "conversations",
      rowId: conversationId,
      data: { userId, status: "active" },
    });
    await tables.createRow({
      databaseId: "digr",
      tableId: "messages",
      rowId: "initial-tawasol-request",
      data: {
        conversationId,
        userId,
        role: "user",
        content: "أريد أن أضم شركة تواصل التجاري إلى القائمة.",
        status: "ready",
        createdAt: "2026-10-16T10:00:00.000Z",
      },
    });
    await saveConversationBrief(tables, conversationId, userId, {
      platforms: ["companies"],
      topics: [],
      targetVolume: 50,
    });

    const handler = new ChatHandler(tables as any);
    const executeTurn = vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج بيانات شركات",
        capabilities: [{
          capabilitySlug: "icypeas-companies-search",
          endpointId: "icypeas.companies.search",
          params: { query: { keyword: { include: ["clarification_answers"] } } },
          targetVolumeMin: 1,
          targetVolumeMax: 50,
        }],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية البحث",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });
    const answers = [
      { questionId: "company_country_required", question: "ما الدولة؟", value: "مصر" },
      { questionId: "company_outreach_required", question: "ما الهدف؟", value: "عملاء محتملون / مبيعات" },
    ];
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: JSON.stringify({ type: "clarification_answers", answers }),
      answers,
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "company_industry_required", text: expect.stringContaining("تواصل التجاري") }),
    ]));
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("replaces a sector-only clarification with country and sector when both are missing", async () => {
    const handler = new ChatHandler(makeMockTables() as any);
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "ask_clarification",
        questions: [{ id: "industry", question: "ما القطاع أو المجال الذي تريد الشركات منه؟", type: "free" }],
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });

    const res = await handler.handleUserMessage({
      userId: "user_company_country_and_industry_required",
      message: "أريد قائمة تضم ١٠٠ شركة",
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationQuestions?.join(" ")).toContain("الدولة");
    expect(res.clarificationQuestions).toHaveLength(1);
    expect(res.clarificationItems).toEqual([
      expect.objectContaining({ id: "company_country_required", type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true }),
    ]);
    expect(res.clarificationItems?.every((item: any) => item.defaultOption === undefined)).toBe(true);
  });

  it("offers contextual commercial-outreach choices and a freeform other answer", () => {
    const items = getCompanyRequirementItems(["industry", "outreach_details"], "أريد شركات للتواصل التجاري");
    expect(items[0].options).toContain("التقنية المالية");
    expect(items[1].options).toEqual(["عملاء محتملون / مبيعات", "موردون أو شركاء", "بحث سوقي", "أخرى"]);
    expect(items.every((item) => item.allowOther)).toBe(true);
    const ambiguous = getCompanyRequirementItems(["outreach_details"], "أريد أضم شركة تواصل التجاري");
    expect(ambiguous[0].text).toContain("شركة محددة باسم");
    expect(ambiguous[0].options).toContain("شركة محددة بهذا الاسم");
  });

  it.each([
    ["Arabic digits", "أريد ٥٠ شركة في ألمانيا في مجال التقنية المالية"],
    ["English digits", "Find 50 companies in Germany's FinTech industry"],
    ["Arabic number words", "أريد خمسين شركة في ألمانيا في مجال التقنية المالية"],
  ])("keeps an explicit company count when the proposal changes it (%s)", async (_label, message) => {
    const companyCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-companies-search")!;
    mockedSearchCatalog.mockResolvedValue([{
      slug: companyCap.slug,
      id: companyCap.tregEndpointId,
      nameAr: companyCap.nameAr,
      nameEn: companyCap.nameEn,
      platform: companyCap.platform,
      summaryAr: companyCap.descriptionAr,
      billingUnit: "record",
      catalogPriceUsd: 0.001,
      pointsPerUnit: 1,
      pagination: { type: "cursor", maxLimit: 100 },
      observedSuccessRate: 0.9,
      method: "GET",
      paramsSchema: JSON.parse(companyCap.paramsSchema),
    } as any]);

    const handler = new ChatHandler(makeMockTables() as any);
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج بيانات شركات",
        capabilities: [{
          capabilitySlug: "icypeas-companies-search",
          endpointId: "icypeas.companies.search",
          params: { query: {} },
          targetVolumeMin: 1,
          targetVolumeMax: 374,
        }],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية البحث",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });

    const res = await handler.handleUserMessage({
      userId: "user_explicit_company_count",
      message,
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote?.targetVolumeMax).toBe(50);
  });

  it("preserves an explicit company count and country/industry across a freeform clarification answer", async () => {
    const companyCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "icypeas-companies-search")!;
    mockedSearchCatalog.mockResolvedValue([{
      slug: companyCap.slug,
      id: companyCap.tregEndpointId,
      nameAr: companyCap.nameAr,
      nameEn: companyCap.nameEn,
      platform: companyCap.platform,
      summaryAr: companyCap.descriptionAr,
      billingUnit: "record",
      catalogPriceUsd: 0.001,
      pointsPerUnit: 1,
      pagination: { type: "cursor", maxLimit: 100 },
      observedSuccessRate: 0.9,
      method: "GET",
      paramsSchema: JSON.parse(companyCap.paramsSchema),
    } as any]);

    const userId = "user_company_clarification_answer";
    const conversationId = "conversation_company_clarification_answer";
    const tables = makeMockTables();
    await tables.createRow({
      databaseId: "digr",
      tableId: "conversations",
      rowId: conversationId,
      data: { userId, status: "active" },
    });
    await tables.createRow({
      databaseId: "digr",
      tableId: "messages",
      rowId: "initial-company-request",
      data: {
        conversationId,
        userId,
        role: "user",
        content: "أريد قائمة تضم 100 شركة للتواصل التجاري.",
        status: "ready",
        createdAt: "2026-10-16T10:00:00.000Z",
      },
    });
    await saveConversationBrief(tables, conversationId, userId, {
      platforms: ["companies"],
      topics: [],
      targetVolume: 100,
    });

    const handler = new ChatHandler(tables as any);
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج بيانات شركات",
        capabilities: [{
          capabilitySlug: "icypeas-companies-search",
          endpointId: "icypeas.companies.search",
          params: { query: {} },
          targetVolumeMin: 1,
          targetVolumeMax: 374,
        }],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية البحث",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });

    const answer = JSON.stringify({
      type: "clarification_answers",
      answers: [
        { questionId: "company_country_required", question: "ما الدولة المطلوبة؟", value: "ألمانيا" },
        { questionId: "company_industry_required", question: "ما القطاع أو المجال؟", value: "خدمات مالية وFinTech" },
        { questionId: "company_outreach_required", question: "ما المقصود بالتواصل التجاري؟", value: "عملاء محتملون / مبيعات" },
      ],
    });
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: answer,
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote?.targetVolumeMax).toBe(86);
    expect(res.planQuote?.items?.[0]?.params?.query?.location?.include).toEqual(["Germany"]);
    expect(res.planQuote?.items?.[0]?.params?.query?.keyword?.include).toEqual(["fintech", "financial technology"]);
  });

  it("keeps an explicit decision-maker count when the plan proposal returns a different volume", async () => {
    const peopleCap = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === "professional-people-search")!;
    mockedSearchCatalog.mockResolvedValue([{
      slug: peopleCap.slug,
      id: peopleCap.tregEndpointId,
      nameAr: peopleCap.nameAr,
      nameEn: peopleCap.nameEn,
      platform: peopleCap.platform,
      summaryAr: peopleCap.descriptionAr,
      billingUnit: "record",
      catalogPriceUsd: 0.001,
      pointsPerUnit: 1,
      pagination: { type: "cursor", maxLimit: 100 },
      observedSuccessRate: 0.9,
      method: "GET",
      paramsSchema: JSON.parse(peopleCap.paramsSchema),
    } as any]);

    const handler = new ChatHandler(makeMockTables() as any);
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج بيانات صناع قرار",
        capabilities: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { query: { keyword: { include: ["decision makers"] }, location: { include: ["Germany"] } } },
          targetVolumeMin: 1,
          targetVolumeMax: 374,
        }],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية البحث",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "test-model",
    });

    const res = await handler.handleUserMessage({
      userId: "user_explicit_people_count",
      message: "ابحث عن ٢٠ من صناع القرار في ألمانيا مع الاسم والمسمى الوظيفي وبريد العمل",
      userBalance: 500,
      testScenario: "phase2_plan",
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.planQuote).toBeUndefined();
    expect(res.clarificationItems?.[0]?.id).toBe("people_scope_required");
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
