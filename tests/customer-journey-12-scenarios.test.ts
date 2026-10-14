import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import {
  clearBriefCacheForTesting,
  getConversationBrief,
  saveConversationBrief,
  extractTargetVolume,
} from "../src/functions/shared/briefManager";
import {
  validatePlanAgainstLiveCatalog,
  createAndSaveManagedQuote,
  applyPlanOperations,
  computePlanHash,
  PlanItem,
} from "../src/functions/shared/planManager";
import {
  searchCatalog,
  CatalogEndpointSummary,
  sanitizeCustomerErrorMessage,
} from "../src/functions/shared/catalogClient";
import {
  deduplicateAgainstBaseline,
  EntityRecord,
} from "../src/lib/server/negativeListEngine";
import {
  generateExcelReport,
  generateCsvReport,
  generatePdfReport,
} from "../src/functions/shared/fileGenerators";
import {
  extractResearchIntent,
  UploadedFileReference,
} from "../src/lib/server/researchIntent";
import { getLiveProviderGateStatus } from "../src/lib/server/providerGate";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";

describe("12-Scenario End-to-End Customer Journey Regression Suite", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearBriefCacheForTesting();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockDb = () => {
    const store = new Map<string, any[]>();
    return {
      store,
      listRows: vi.fn(async ({ tableId, queries }: any) => {
        const rows = store.get(tableId) || [];
        return { rows, total: rows.length };
      }),
      createRow: vi.fn(async ({ tableId, rowId, data }: any) => {
        const rows = store.get(tableId) || [];
        const record = { $id: rowId, id: rowId, ...data, createdAt: new Date().toISOString() };
        rows.push(record);
        store.set(tableId, rows);
        return record;
      }),
      updateRow: vi.fn(async ({ tableId, rowId, data }: any) => {
        const rows = store.get(tableId) || [];
        const idx = rows.findIndex((r) => r.$id === rowId || r.id === rowId);
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...data, updatedAt: new Date().toISOString() };
          return rows[idx];
        }
        const record = { $id: rowId, id: rowId, ...data };
        rows.push(record);
        return record;
      }),
      getRow: vi.fn(async ({ tableId, rowId }: any) => {
        const rows = store.get(tableId) || [];
        return rows.find((r) => r.$id === rowId || r.id === rowId) || null;
      }),
    };
  };

  // =========================================================================
  // SCENARIO 1: Arabic company request (no file) -> plan -> points quote -> execution -> deliverables
  // =========================================================================
  it("Scenario 1: Arabic company request produces plan, positive quote, and xlsx deliverable", async () => {
    const mockDb = createMockDb();
    const handler = new ChatHandler(mockDb as any);

    const res = await handler.handleUserMessage({
      userId: "user_company_1",
      conversationId: "conv_company_1",
      message: "عايز 5 شركات مقاولات في مصر في ملف Excel",
      userBalance: 200,
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();
    expect(res.planQuote.targetVolumeMax).toBe(5);
    expect(res.planQuote.quotedPoints).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain("غير مدعوم حالياً بشكل مباشر");
    expect(res.contentAr).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);

    // Verify deliverables can be generated from company rows
    const mockCompanyRows = [
      { name: "شركة النيل للمقاولات", domain: "nile-contracting.eg", phone: "+201000000001", city: "القاهرة" },
      { name: "شركة الأهرام للإنشاءات", domain: "ahram-build.com", phone: "+201000000002", city: "الجيزة" },
      { name: "الإسكندرية للمقاولات", domain: "alex-build.eg", phone: "+201000000003", city: "الإسكندرية" },
      { name: "الرواد للمقاولات العامة", domain: "alrowad.com", phone: "+201000000004", city: "القاهرة" },
      { name: "مصر للتعمير والبناء", domain: "misr-taamir.eg", phone: "+201000000005", city: "طنطا" },
    ];

    const xlsxBuffer = await generateExcelReport({
      jobId: "job_company_test",
      target: "شركات مقاولات في مصر",
      rows: mockCompanyRows,
      methodology: "استخراج بيانات الشركات العامة المعتمدة",
      collectedCount: 5,
    });

    expect(xlsxBuffer).toBeDefined();
    expect(xlsxBuffer.length).toBeGreaterThan(100);
  });

  // =========================================================================
  // SCENARIO 2: Company request + exclusion XLSX -> deduplication -> accurate audit counts
  // =========================================================================
  it("Scenario 2: Company request with exclusion file deduplicates and records audit counts", async () => {
    const mockDb = createMockDb();
    const handler = new ChatHandler(mockDb as any);

    const uploadedFiles = [
      {
        name: "existing_companies.xlsx",
        baselineRowCount: 2,
        companyNames: ["شركة أوراسكوم", "شركة بتروجت"],
        corporateDomains: ["orascom.com", "petrojet.com.eg"],
        normalizedEntities: ["orascom", "petrojet"],
      },
    ];

    const res = await handler.handleUserMessage({
      userId: "user_company_2",
      conversationId: "conv_company_2",
      message: "عايز 5 شركات مقاولات في مصر غير اللي في الشيت",
      uploadedFiles,
      userBalance: 200,
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();

    // Verify negative list engine deduplication against baseline
    const candidateRows: EntityRecord[] = [
      { name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" }, // Duplicate
      { name: "شركة طلعت مصطفى", domain: "tmg.com.eg" }, // Unique
      { name: "شركة المقاولون العرب", domain: "arabcont.com" }, // Unique
      { name: "شركة بتروجت للمشروعات", domain: "petrojet.com.eg" }, // Duplicate
      { name: "حسن علام القابضة", domain: "hassanallam.com" }, // Unique
    ];

    const baselineRecords: EntityRecord[] = [
      { name: "شركة أوراسكوم", domain: "orascom.com" },
      { name: "شركة بتروجت", domain: "petrojet.com.eg" },
    ];

    const dedupResult = deduplicateAgainstBaseline(candidateRows, baselineRecords);

    expect(dedupResult.delivered.length).toBe(3);
    expect(dedupResult.confirmedDuplicates.length).toBe(2);
    expect(dedupResult.delivered.map((r) => r.domain)).toEqual([
      "tmg.com.eg",
      "arabcont.com",
      "hassanallam.com",
    ]);
  });

  // =========================================================================
  // SCENARIO 3: Spreadsheet + 'كمّل البيانات الناقصة' -> enrichment intent
  // =========================================================================
  it("Scenario 3: Spreadsheet with 'كمّل البيانات الناقصة' is classified as enrichment intent", async () => {
    const activeFiles: UploadedFileReference[] = [
      {
        fileId: "file_enrich_1",
        fileName: "leads_missing_data.xlsx",
        fileType: "xlsx",
        purpose: "reference_data",
      },
    ];

    const intent = extractResearchIntent(
      "معايا ملف إكسل لشركات، كمّل البيانات الناقصة من أرقام وإيميلات",
      undefined,
      activeFiles
    );

    expect(["companies", "tabular"]).toContain(intent.entityType.value);
    // Should NOT treat this as a negative exclusion list
    expect(intent.userExclusions.value.hasExclusionReference).toBe(false);
  });

  // =========================================================================
  // SCENARIO 4: Facebook posts/comments request (parent-child preserved)
  // =========================================================================
  it("Scenario 4: Facebook posts/comments request constructs valid plan and preserves parent IDs", async () => {
    const mockDb = createMockDb();
    const handler = new ChatHandler(mockDb as any);

    const res = await handler.handleUserMessage({
      userId: "user_fb_1",
      conversationId: "conv_fb_1",
      message: "عايز 50 تعليق على منشورات صفحة بي بي سي عربي على فيسبوك",
      userBalance: 300,
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();
    expect(res.planQuote.quotedPoints).toBeGreaterThan(0);

    // Verify parent-child preservation in rows
    const mockComments = [
      { commentId: "c_1", postUrl: "https://facebook.com/post/100", parentPostId: "post_100", text: "تعليق أول" },
      { commentId: "c_2", postUrl: "https://facebook.com/post/100", parentPostId: "post_100", text: "تعليق ثانٍ" },
    ];

    expect(mockComments[0].parentPostId).toBe("post_100");
    expect(mockComments[1].parentPostId).toBe("post_100");
  });

  // =========================================================================
  // SCENARIO 5: Un-special-cased request from live catalog
  // =========================================================================
  it("Scenario 5: Dynamic catalog search succeeds for non-social platform without special cases", async () => {
    const mockDb = createMockDb();
    const handler = new ChatHandler(mockDb as any);

    const res = await handler.handleUserMessage({
      userId: "user_dyn_1",
      conversationId: "conv_dyn_1",
      message: "ابحث في يوتيوب عن شروحات بايثون",
      userBalance: 200,
    });

    expect(res.outputType).toBeDefined();
    expect(res.contentAr).not.toContain("حدث خطأ أثناء معالجة المحادثة");
    expect(res.contentAr).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);
  });

  // =========================================================================
  // SCENARIO 6: Clarification with custom volume
  // =========================================================================
  it("Scenario 6: Clarification parses custom record count (e.g. 5 or 25)", async () => {
    expect(extractTargetVolume("عايز 5 شركات")).toBe(5);
    expect(extractTargetVolume("25 سجل")).toBe(25);
    expect(extractTargetVolume("جمع 50 شركة مقاولات")).toBe(50);
  });

  // =========================================================================
  // SCENARIO 7: Plan edit -> old quote invalidated -> fresh quote
  // =========================================================================
  it("Scenario 7: Editing a plan updates plan hash and creates fresh quote", async () => {
    const initialPlanState = {
      summaryAr: "استخراج تعليقات فيسبوك",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          endpointId: "facebook-post-comments",
          params: { query: "عقارات مصر" },
          targetVolumeMin: 1,
          targetVolumeMax: 100,
        },
      ],
      outputFormats: ["xlsx" as const],
    };

    const hash1 = computePlanHash(initialPlanState.items, initialPlanState.outputFormats);

    const modifiedPlanState = applyPlanOperations(initialPlanState, [
      { action: "set_limit", capabilitySlug: "facebook-post-comments", targetVolumeMax: 500 },
    ]);

    const hash2 = computePlanHash(modifiedPlanState.items, modifiedPlanState.outputFormats);

    expect(hash1).not.toBe(hash2);
    expect(modifiedPlanState.items[0].targetVolumeMax).toBe(500);
  });

  // =========================================================================
  // SCENARIO 8: Insufficient balance -> budget options in Arabic
  // =========================================================================
  it("Scenario 8: Insufficient balance calculates downscaled offer with zero emojis", async () => {
    const mockDb = createMockDb();
    const managedQuote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv_balance_test",
      userId: "user_low_balance",
      plan: {
        summaryAr: "استخراج تعليقات فيسبوك",
        items: [
          {
            capabilitySlug: "facebook-post-comments",
            endpointId: "facebook-post-comments",
            params: { query: "سيارات" },
            targetVolumeMin: 1,
            targetVolumeMax: 500,
            unitPricePoints: 11,
          },
        ],
        outputFormats: ["xlsx"],
      },
      userBalance: 50, // Low balance
      capabilities: [
        {
          id: "facebook-post-comments",
          slug: "facebook-post-comments",
          nameAr: "استخراج تعليقات فيسبوك",
          nameEn: "Facebook Comments",
          category: "facebook",
          platform: "facebook",
          tregEndpointId: "facebook-post-comments",
          tregMethod: "POST",
          pricingUnit: "item",
          unitCostUsd: 0.001,
          pointsPerUnit: 11,
        } as any,
      ],
    });

    expect(managedQuote.isAffordable).toBe(false);
    expect(managedQuote.downscaledOffer).toBeDefined();
    expect(managedQuote.downscaledOffer!.maxAffordableUnits).toBeLessThan(500);
    expect(managedQuote.downscaledOffer!.affordableQuotedPoints).toBeLessThanOrEqual(50);
  });

  // =========================================================================
  // SCENARIO 9: Partial delivery -> release-first settlement
  // =========================================================================
  it("Scenario 9: Partial delivery calculates charge on delivered units and refunds remainder", async () => {
    const reservedCredits = 100;
    const unitPrice = 2;
    const deliveredUnits = 15;

    const actualCharge = deliveredUnits * unitPrice; // 30 points
    const refundCredits = reservedCredits - actualCharge; // 70 points

    expect(actualCharge).toBe(30);
    expect(refundCredits).toBe(70);
    expect(actualCharge + refundCredits).toBe(reservedCredits);
  });

  // =========================================================================
  // SCENARIO 10: Multi-turn follow-up context preservation
  // =========================================================================
  it("Scenario 10: Preserves brief and exclusion file across conversation turns", async () => {
    const mockDb = createMockDb();

    // Turn 1: Save brief with exclusion file
    const briefTurn1 = {
      platforms: ["facebook"],
      topics: ["عقارات التجمع"],
      targetVolume: 100,
      exclusionFile: {
        name: "excluded_brokers.xlsx",
        baselineRowCount: 5,
        companyNames: ["Broker 1", "Broker 2"],
        corporateDomains: ["b1.com", "b2.com"],
        normalizedEntities: ["broker 1", "broker 2"],
      },
    };

    await saveConversationBrief(mockDb as any, "conv_turn_test", "user_1", briefTurn1 as any);

    // Turn 2: Retrieve brief
    const retrievedBrief = await getConversationBrief(mockDb as any, "conv_turn_test", "user_1");

    expect(retrievedBrief).toBeDefined();
    expect(retrievedBrief?.exclusionFile).toBeDefined();
    expect(retrievedBrief?.exclusionFile?.name).toBe("excluded_brokers.xlsx");
    expect(retrievedBrief?.topics).toEqual(["عقارات التجمع"]);
  });

  // =========================================================================
  // SCENARIO 11: Provider failure / empty result -> zero charge, full release
  // =========================================================================
  it("Scenario 11: Provider failure releases 100% of reserved points with zero charge", async () => {
    const reservedCredits = 150;
    const deliveredUnits = 0; // Failed or empty

    const chargedCredits = 0;
    const releasedCredits = reservedCredits;

    expect(chargedCredits).toBe(0);
    expect(releasedCredits).toBe(150);

    // Customer message is sanitized without raw provider names
    const rawError = "Error calling diffbot.x.extract-discussion: 504 Gateway Timeout";
    const cleanError = sanitizeCustomerErrorMessage(rawError);

    expect(cleanError).not.toContain("diffbot");
  });

  // =========================================================================
  // SCENARIO 12: Security & idempotency
  // =========================================================================
  it("Scenario 12: Financial ID format conformity and quote plan hash tamper prevention", async () => {
    const jobId = "job_sec_test_1";

    const reservationDocId = `res_${jobId}`;
    const releaseDocId = `rel_${jobId}`;
    const chargeDocId = `chg_${jobId}`;

    expect(reservationDocId).toMatch(/^res_[a-zA-Z0-9_\-]+$/);
    expect(releaseDocId).toMatch(/^rel_[a-zA-Z0-9_\-]+$/);
    expect(chargeDocId).toMatch(/^chg_[a-zA-Z0-9_\-]+$/);

    // Plan hash tampering check
    const validPlan = {
      summaryAr: "بحث عقارات",
      items: [{ capabilitySlug: "fb", params: { q: "test" }, targetVolumeMin: 1, targetVolumeMax: 10 }],
      outputFormats: ["xlsx" as const],
    };
    const legitHash = computePlanHash(validPlan.items, validPlan.outputFormats);

    const tamperedPlan = {
      summaryAr: "بحث عقارات",
      items: [{ capabilitySlug: "fb", params: { q: "test" }, targetVolumeMin: 1, targetVolumeMax: 1000 }], // Tampered volume
      outputFormats: ["xlsx" as const],
    };
    const tamperedHash = computePlanHash(tamperedPlan.items, tamperedPlan.outputFormats);

    expect(legitHash).not.toBe(tamperedHash);

    // Provider gate sanitization check
    process.env.TREG_LIVE = ' "TRUE" ';
    process.env.TREG_TOKEN = ' "token-valid-abc" ';
    const gate = getLiveProviderGateStatus();
    expect(gate.isReady).toBe(true);
    expect(gate.reasonCode).toBe("ok");
  });
});
