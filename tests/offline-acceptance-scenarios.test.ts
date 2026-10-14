import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { extractResearchIntent } from "../src/lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../src/lib/server/questionDecisionFramework";
import {
  buildMultiStepResearchPlan,
  executeMultiStepPlanOffline,
} from "../src/lib/server/multiStepOrchestrator";
import {
  generateCompanyExcelReport,
  generateMethodologyText,
  generateExcelReport,
} from "../src/functions/shared/fileGenerators";
import { parseExclusionFile } from "../src/lib/server/exclusionFileParser";

describe("Offline Acceptance Scenarios (End-to-End Validation)", () => {
  // Scenario A: YouTube Public Research
  it("Scenario A: Public YouTube research plan and execution", async () => {
    const userMessage = "أريد 100 مقطع فيديو من يوتيوب عن ملخص وأهداف مباريات كأس العالم مع إحصائيات المشاهدات";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);

    const plan = buildMultiStepResearchPlan(intent);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0].capabilitySlug).toBe("youtube-search");

    const mockExecutor = async (step: any) => {
      if (step.capabilitySlug === "youtube-search") {
        return {
          rows: Array.from({ length: 10 }, (_, i) => ({
            id: `yt_${i}`,
            videoId: `vid_${i}`,
            title: `ملخص أهداف مباراة ${i + 1}`,
            views_count: (i + 1) * 10000,
            likes_count: (i + 1) * 500,
          })),
        };
      }
      return { rows: [] };
    };

    const summary = await executeMultiStepPlanOffline(plan, mockExecutor);
    expect(summary.status).toBe("completed");
    expect(summary.uniqueDeliveredCount).toBe(10);
  });

  // Scenario B: MEP Contractors with Uploaded Exclusion File & 6-Sheet Excel Report
  it("Scenario B: MEP contractors in Egypt with exclusion list & 6-sheet Excel report", async () => {
    // 1. User uploaded exclusion CSV
    const csvContent = `اسم الشركة,الموقع الإلكتروني,السجل التجاري
شركة أوراسكوم للإنشاءات,https://orascom.com,112233
شركة بتروجت,petrojet.com.eg,445566`;
    const exclusionSpec = await parseExclusionFile(Buffer.from(csvContent, "utf-8"), "csv");
    expect(exclusionSpec.baselineRowCount).toBe(2);

    // 2. User prompt in natural Egyptian Arabic
    const userMessage = "عايز 50 شركة مقاولات كهروميكانيكية في مصر غير الشركات الموجودة في الملف المرفق مع تقرير إكسل كامل";
    const intent = extractResearchIntent(userMessage, undefined, [
      {
        fileId: "f_mep",
        fileName: "current_contractors.csv",
        fileType: "csv",
        purpose: "exclusion_list",
      },
    ]);

    // 3. Discovery Decision
    const decision = evaluateDiscoveryDecision(intent);
    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);

    // 4. Multi-Step Execution
    const plan = buildMultiStepResearchPlan(intent, exclusionSpec);
    expect(plan.steps.some((s) => s.stepType === "entity_deduplication")).toBe(true);

    const mockExecutor = async (step: any) => {
      if (step.stepType === "data_collection") {
        return {
          rows: [
            { id: "c_1", company_name: "أوراسكوم للإنشاء والتجارة", domain: "https://www.orascom.com", phone: "+2021234567" },
            { id: "c_2", company_name: "شركة مقاولات النيل الكهروميكانيكية", domain: "nile-mep.com", phone: "+2022345678" },
            { id: "c_3", company_name: "بتروجت للمشروعات", domain: "http://petrojet.com.eg", phone: "+2023456789" },
            { id: "c_4", company_name: "شركة القاهرة للأنظمة الكهربائية والميكانيكية", domain: "cairo-systems.com" },
            { id: "c_5", company_name: "الأهرام للأعمال الكهروميكانيكية", domain: "ahram-mep.com" },
          ],
        };
      }
      return { rows: [] };
    };

    const summary = await executeMultiStepPlanOffline(plan, mockExecutor, {
      baselineExclusionRecords: exclusionSpec.normalizedEntities,
    });

    expect(summary.status).toBe("completed");
    expect(summary.rawCollectedCount).toBe(5);
    expect(summary.duplicatesRemovedCount).toBe(2); // orascom and petrojet excluded
    expect(summary.uniqueDeliveredCount).toBe(3);

    // 5. Generate 6-Sheet Corporate Excel Report
    const payload = {
      title: "دليل شركات المقاولات الكهروميكانيكية (MEP) في مصر",
      platform: "web",
      entityType: "companies",
      collectedAt: new Date().toISOString(),
      rows: summary.finalDataset,
    };

    const excelBuffer = await generateCompanyExcelReport(payload, summary.deduplicationAudit);
    expect(excelBuffer).toBeDefined();
    expect(excelBuffer.length).toBeGreaterThan(1000);

    // Verify all 6 sheets exist in generated Excel workbook
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excelBuffer as any);

    const sheetNames = wb.worksheets.map((ws) => ws.name);
    expect(sheetNames.some((n) => n.includes("الملخص التنفيذي"))).toBe(true);
    expect(sheetNames.some((n) => n.includes("دليل الشركات"))).toBe(true);
    expect(sheetNames.some((n) => n.includes("للتصفية"))).toBe(true);
    expect(sheetNames.some((n) => n.includes("سجل تدقيق الاستبعاد"))).toBe(true);
    expect(sheetNames.some((n) => n.includes("جودة البيانات"))).toBe(true);
    expect(sheetNames.some((n) => n.includes("دليل الحقول"))).toBe(true);

    // Check methodology text transparency: honest coverage statement
    const methodology = generateMethodologyText(payload, {
      rawCollected: summary.rawCollectedCount,
      uniqueDelivered: summary.uniqueDeliveredCount,
      duplicatesRemoved: summary.duplicatesRemovedCount,
      deduplicationCount: summary.duplicatesRemovedCount,
    });
    expect(methodology).toContain("نسبة التغطية غير متاحة (مجتمع البحث غير محصور)");
    expect(methodology).toContain("إجمالي السجلات الخام المستخرجة: 5");
    expect(methodology).toContain("السجلات المستبعدة والمكررة: 2");
    expect(methodology).toContain("السجلات الفريدة المعتمدة: 3");
  });

  // Scenario C: X/Twitter Public Sentiment Research
  it("Scenario C: X public sentiment research with bounded sample", async () => {
    const userMessage = "أريد جمع 200 تغريدة من تويتر حول أسعار الذهب وسعر عيار 21 في مصر";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(intent.sampleSize.value).toBe(200);

    const plan = buildMultiStepResearchPlan(intent);
    expect(plan.steps.some((s) => s.stepType === "data_collection")).toBe(true);
  });

  // Scenario D: Complete Arabic Request -> Zero Discovery Questions
  it("Scenario D: Complete Egyptian Arabic request triggers zero discovery questions", () => {
    const userMessage = "أريد استخراج 1000 تعليق من فيسبوك حول قانون الإيجار القديم في مصر خلال آخر 3 شهور بصيغة إكسل وPDF";
    const intent = extractResearchIntent(userMessage);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("PROCEED_TO_PLAN");
    expect(decision.questions.length).toBe(0);
    expect(decision.isCompleteWithoutQuestions).toBe(true);
  });

  // Scenario E: Incomplete Request with Missing Exclusion File
  it("Scenario E: Incomplete request with missing exclusion file asks ONLY for the file", () => {
    const userMessage = "عايز 50 شركة طاقة متجددة في مصر بدون الشركات الموجودة في شيت الإكسل المرفق";
    const intent = extractResearchIntent(userMessage, undefined, []);
    const decision = evaluateDiscoveryDecision(intent);

    expect(decision.action).toBe("CLARIFY");
    expect(decision.missingCrucialFields).toEqual(["exclusion_file"]);
    expect(decision.questions.length).toBe(1);
    expect(decision.questions[0].questionAr).toContain("ملف الاستبعاد");
  });

  // Scenario F: Multi-Capability Offline Flow
  it("Scenario F: Multi-capability parent-child offline execution flow", async () => {
    const intent = extractResearchIntent("بحث في يوتيوب عن التحول الرقمي");
    const plan = buildMultiStepResearchPlan(intent);

    let parentRan = false;
    let childRan = false;

    const mockExecutor = async (step: any) => {
      if (step.stepId.includes("video_search")) {
        parentRan = true;
        return {
          rows: [
            { videoId: "v_1", title: "مقدمة التحول الرقمي" },
            { videoId: "v_2", title: "تطبيقات الذكاء الاصطناعي" },
          ],
        };
      }
      if (step.stepId.includes("collect_comments")) {
        childRan = true;
        return {
          rows: [
            { commentId: "c_1", text: "فيديو ممتاز ومفيد جداً", parentVideoId: "v_1" },
            { commentId: "c_2", text: "شكراً على الشرح الوافي", parentVideoId: "v_2" },
          ],
        };
      }
      return { rows: [] };
    };

    const summary = await executeMultiStepPlanOffline(plan, mockExecutor);
    expect(summary.status).toBe("completed");
    expect(parentRan).toBe(true);
    expect(childRan).toBe(true);
  });

  // Scenario G: Upstream Provider Mid-Run Failure Simulation
  it("Scenario G: Upstream provider mid-run failure aborts cleanly with 0 charge", async () => {
    const intent = extractResearchIntent("جمع منشورات فيسبوك عن العقارات");
    const plan = buildMultiStepResearchPlan(intent);

    const failingExecutor = async () => {
      return {
        rows: [],
        error: "upstream_rate_limit_429",
      };
    };

    const summary = await executeMultiStepPlanOffline(plan, failingExecutor);
    expect(summary.status).toBe("failed");
    expect(summary.uniqueDeliveredCount).toBe(0);
    expect(summary.stepResults.some((s) => s.status === "failed")).toBe(true);
  });
});
