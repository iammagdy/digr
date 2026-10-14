import { describe, it, expect, vi } from "vitest";
import {
  buildMultiStepResearchPlan,
  executeMultiStepPlanOffline,
  validatePlanCapabilities,
} from "../src/lib/server/multiStepOrchestrator";
import { extractResearchIntent } from "../src/lib/server/researchIntent";
import { ExclusionSpec } from "../src/lib/server/exclusionFileParser";

describe("Multi-Step Orchestrator Engine", () => {
  it("builds a multi-step plan for company research with exclusion baseline", () => {
    const intent = extractResearchIntent("عايز 50 شركة مقاولات كهروميكانيكية في مصر");
    const mockExclusionSpec: ExclusionSpec = {
      baselineRowCount: 2,
      companyNames: ["شركة أوراسكوم للإنشاءات", "شركة بتروجت"],
      corporateDomains: ["orascom.com", "petrojet.com.eg"],
      normalizedEntities: [
        { id: "base_1", name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" },
        { id: "base_2", name: "شركة بتروجت", domain: "petrojet.com.eg" },
      ],
      brandFingerprints: ["dom:orascom.com", "dom:petrojet.com.eg"],
    };

    const plan = buildMultiStepResearchPlan(intent, mockExclusionSpec);

    expect(plan.steps.length).toBe(5);
    expect(plan.steps[0].stepType).toBe("exclusion_parsing");
    expect(plan.steps[1].stepType).toBe("query_expansion");
    expect(plan.steps[2].stepType).toBe("data_collection");
    expect(plan.steps[3].stepType).toBe("entity_deduplication");
    expect(plan.steps[4].stepType).toBe("report_generation");

    // Dependent step links
    expect(plan.steps[2].dependsOn).toContain("step_2_query_expansion");
    expect(plan.steps[3].dependsOn).toContain("step_3_company_discovery");
  });

  it("executes multi-step plan offline, removing duplicates against baseline", async () => {
    const intent = extractResearchIntent("عايز 50 شركة مقاولات كهروميكانيكية في مصر");
    const baselineRecords = [
      { id: "ex_1", name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" },
      { id: "ex_2", name: "شركة بتروجت", domain: "petrojet.com.eg" },
    ];

    const plan = buildMultiStepResearchPlan(intent);

    const mockExecutor = async (step: any) => {
      if (step.stepType === "data_collection") {
        return {
          rows: [
            { id: "cand_1", company_name: "أوراسكوم للإنشاءات", website: "https://orascom.com" },
            { id: "cand_2", company_name: "شركة النيل للمقاولات الكهروميكانيكية", website: "nile-mep.com" },
            { id: "cand_3", company_name: "شركة بتروجت للمشروعات", website: "http://petrojet.com.eg" },
            { id: "cand_4", company_name: "الدلتا للأعمال الهندسية", website: "delta-eng.com" },
          ],
        };
      }
      return { rows: [] };
    };

    const summary = await executeMultiStepPlanOffline(plan, mockExecutor, {
      baselineExclusionRecords: baselineRecords,
    });

    expect(summary.status).toBe("completed");
    expect(summary.rawCollectedCount).toBe(4);
    expect(summary.duplicatesRemovedCount).toBe(2);
    expect(summary.uniqueDeliveredCount).toBe(2);

    const deliveredNames = summary.finalDataset.map((r) => r.name || r.company_name);
    expect(deliveredNames).toContain("شركة النيل للمقاولات الكهروميكانيكية");
    expect(deliveredNames).toContain("الدلتا للأعمال الهندسية");
    expect(deliveredNames).not.toContain("أوراسكوم للإنشاءات");
    expect(deliveredNames).not.toContain("شركة بتروجت للمشروعات");

    // Verify deduplication audit trail
    expect(summary.deduplicationAudit.length).toBe(4);
    const orascomAudit = summary.deduplicationAudit.find((a) => a.candidateName.includes("أوراسكوم"));
    expect(orascomAudit?.status).toBe("CONFIRMED_DUPLICATE");
  });

  it("handles upstream provider failure gracefully mid-plan", async () => {
    const intent = extractResearchIntent("عايز 50 مقطع فيديو من يوتيوب عن الذكاء الاصطناعي");
    const plan = buildMultiStepResearchPlan(intent);

    const failingMockExecutor = async () => {
      return {
        rows: [],
        error: "simulated_upstream_provider_500_error",
      };
    };

    const summary = await executeMultiStepPlanOffline(plan, failingMockExecutor);

    expect(summary.status).toBe("failed");
    expect(summary.uniqueDeliveredCount).toBe(0);
    const failedStep = summary.stepResults.find((s) => s.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.error).toBe("simulated_upstream_provider_500_error");
    expect(summary.methodologyNotesAr.some((n) => n.includes("خطأ المزود"))).toBe(true);
  });

  it("validates plan capabilities and marks unverified placeholder endpoints as unexecutable", () => {
    const intent = extractResearchIntent("جمع 100 تغريدة من تويتر");
    const plan = buildMultiStepResearchPlan(intent);

    // Inject an unapproved placeholder capability into the plan
    plan.steps.push({
      stepId: "step_malicious_unverified",
      stepNameAr: "نقطة غير معتمدة",
      stepType: "data_collection",
      capabilitySlug: "unapproved-random-scraper",
      endpointId: "google.serp.organic",
      params: { query: "test" },
      maxDeliveredUnits: 10,
      maxCalls: 1,
      estimatedPoints: 50,
    });

    const validation = validatePlanCapabilities(plan);

    expect(validation.isValid).toBe(false);
    expect(validation.errors.some((e: string) => e.includes("غير معتمدة في كتالوج"))).toBe(true);
    const unverifiedStep = validation.validatedSteps.find(
      (s: any) => s.stepId === "step_malicious_unverified"
    );
    expect(unverifiedStep?.isExecutable).toBe(false);
  });

  it("produces genuine query expansion and real non-empty deliverables in report_generation", async () => {
    const intent = extractResearchIntent("عايز 50 شركة مقاولات كهروميكانيكية في مصر");
    const plan = buildMultiStepResearchPlan(intent);

    const mockExecutor = async (step: any) => {
      if (step.stepType === "data_collection") {
        return {
          rows: [
            { id: "c1", company_name: "شركة المقاولون العرب", website: "arabcont.com" },
            { id: "c2", company_name: "شركة حسن علام للمقاولات", website: "hassanallam.com" },
          ],
        };
      }
      return { rows: [] };
    };

    const summary = await executeMultiStepPlanOffline(plan, mockExecutor, { intent });

    expect(summary.status).toBe("completed");

    // 1. Verify query expansion generated genuine sector terms
    const expansionStep = summary.stepResults.find((s) => s.stepType === "query_expansion");
    expect(expansionStep?.status).toBe("completed");
    expect(expansionStep?.rows.length).toBeGreaterThan(1);
    expect(expansionStep?.rows.some((q) => q.includes("كهروميكانيك") || q.includes("MEP"))).toBe(true);

    // 2. Verify report generation actually created valid buffers
    const reportStep = summary.stepResults.find((s) => s.stepType === "report_generation");
    expect(reportStep?.status).toBe("completed");
    expect(reportStep?.generatedFiles?.excelBytes).toBeGreaterThan(1000);
    expect(reportStep?.generatedFiles?.csvBytes).toBeGreaterThan(10);
    expect(reportStep?.generatedFiles?.pdfBytes).toBeGreaterThan(1000);
  });

  it("handles partial success when late step fails after collecting data", async () => {
    const intent = extractResearchIntent("عايز 50 مقطع فيديو من يوتيوب عن الذكاء الاصطناعي");
    const plan = buildMultiStepResearchPlan(intent);

    let callCount = 0;
    const stepFlakyExecutor = async (step: any) => {
      callCount++;
      if (step.stepId === "step_1_video_search") {
        return {
          rows: [{ id: "v1", title: "مقطع فيديو 1" }, { id: "v2", title: "مقطع فيديو 2" }],
        };
      }
      // Step 2 fails
      return {
        rows: [],
        error: "comments_endpoint_timeout_504",
      };
    };

    const summary = await executeMultiStepPlanOffline(plan, stepFlakyExecutor);

    expect(summary.status).toBe("partial_success");
    expect(summary.rawCollectedCount).toBe(2);
    expect(summary.uniqueDeliveredCount).toBe(2);
    const failedStep = summary.stepResults.find((s) => s.status === "failed");
    expect(failedStep?.error).toBe("comments_endpoint_timeout_504");
  });

  describe("validatePlanCapabilities & Negative Validation Tests", () => {
    it("rejects plan with invalid plan-level limits (maxTargetVolume <= 0 or > 5000)", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      plan.maxTargetVolume = 6000;
      const res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("الحد الأقصى لحجم العينة"))).toBe(true);

      plan.maxTargetVolume = 0;
      const resZero = validatePlanCapabilities(plan);
      expect(resZero.isValid).toBe(false);
    });

    it("rejects steps with invalid execution limits (maxDeliveredUnits, maxCalls, estimatedPoints)", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      plan.steps[0].maxDeliveredUnits = 0;
      plan.steps[0].maxCalls = 600;
      plan.steps[0].estimatedPoints = -5;

      const res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("الحد الأقصى للوحدات المنجزة"))).toBe(true);
      expect(res.errors.some((e) => e.includes("الحد الأقصى لعدد الاستدعاءات"))).toBe(true);
      expect(res.errors.some((e) => e.includes("قيمة النقاط المقدرة"))).toBe(true);
    });

    it("rejects invalid DAG dependencies (missing dependency, self-dependency, forward dependency)", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);

      // 1. Missing dependency
      plan.steps[0].dependsOn = ["non_existent_step_id"];
      let res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("غير موجودة في الخطة"))).toBe(true);

      // 2. Self dependency
      plan.steps[0].dependsOn = [plan.steps[0].stepId];
      res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("تبعية ذاتية غير صالحة"))).toBe(true);

      // 3. Forward dependency (step 0 depends on step 1 which hasn't run yet)
      if (plan.steps.length > 1) {
        plan.steps[0].dependsOn = [plan.steps[1].stepId];
        res = validatePlanCapabilities(plan);
        expect(res.isValid).toBe(false);
        expect(res.errors.some((e) => e.includes("لم تسبقها في الترتيب التنفيذي"))).toBe(true);
      }
    });

    it("rejects unknown / unverified capabilities", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      plan.steps.push({
        stepId: "step_unknown",
        stepNameAr: "إمكانية غير معروفة",
        stepType: "data_collection",
        capabilitySlug: "totally-fake-capability",
        endpointId: "fake.endpoint",
        params: {},
        maxDeliveredUnits: 10,
        maxCalls: 1,
        estimatedPoints: 10,
      });

      const res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("غير معتمدة في كتالوج الخدمات"))).toBe(true);
    });

    it("rejects endpoint mismatch for known capabilities", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      plan.steps.push({
        stepId: "step_mismatch",
        stepNameAr: "نقطة غير مطابقة",
        stepType: "data_collection",
        capabilitySlug: "tiktok-profile",
        endpointId: "wrong.endpoint.id",
        params: { username: "validuser" },
        maxDeliveredUnits: 1,
        maxCalls: 1,
        estimatedPoints: 50,
      });

      const res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("لا يطابق نقطة النهاية المعتمدة"))).toBe(true);
    });

    it("rejects missing or empty required parameters according to paramsSchema", () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      plan.steps.push({
        stepId: "step_missing_param",
        stepNameAr: "معلمة مفقودة",
        stepType: "data_collection",
        capabilitySlug: "tiktok-profile",
        endpointId: "tikhub.tiktok.user.profile",
        params: { username: "" }, // required param is empty string
        maxDeliveredUnits: 1,
        maxCalls: 1,
        estimatedPoints: 50,
      });

      const res = validatePlanCapabilities(plan);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("المعلمة الإلزامية (username) غير موجودة"))).toBe(true);
    });

    it("rejects capabilities with unsupported billing units or non-positive unit cost in catalog", () => {
      const mockCatalog: any[] = [
        {
          slug: "bad-billing-unit",
          nameAr: "وحدة تسعير سيئة",
          nameEn: "Bad Unit",
          descriptionAr: "وصف",
          category: "web",
          pricingUnit: "invalid_unit",
          unitCostUsd: 0.05,
          tregEndpointId: "test.endpoint.1",
          paramsSchema: "{}",
          enabled: true,
        },
        {
          slug: "zero-cost-unit",
          nameAr: "سعر صفري",
          nameEn: "Zero Cost",
          descriptionAr: "وصف",
          category: "web",
          pricingUnit: "call",
          unitCostUsd: 0,
          tregEndpointId: "test.endpoint.2",
          paramsSchema: "{}",
          enabled: true,
        },
      ];

      const plan: any = {
        planId: "plan_test_catalog",
        titleAr: "خطة اختبار",
        targetPlatform: "web",
        entityType: "companies",
        maxTargetVolume: 10,
        totalReservedPoints: 50,
        createdAt: new Date().toISOString(),
        steps: [
          {
            stepId: "step_bad_unit",
            stepNameAr: "خطوة 1",
            stepType: "data_collection",
            capabilitySlug: "bad-billing-unit",
            endpointId: "test.endpoint.1",
            params: {},
            maxDeliveredUnits: 10,
            maxCalls: 1,
            estimatedPoints: 50,
          },
          {
            stepId: "step_zero_cost",
            stepNameAr: "خطوة 2",
            stepType: "data_collection",
            capabilitySlug: "zero-cost-unit",
            endpointId: "test.endpoint.2",
            params: {},
            maxDeliveredUnits: 10,
            maxCalls: 1,
            estimatedPoints: 50,
          },
        ],
      };

      const res = validatePlanCapabilities(plan, mockCatalog);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("وحدة التسعير (invalid_unit) غير مدعومة"))).toBe(true);
      expect(res.errors.some((e) => e.includes("سعر الوحدة (0) غير صالح أو مفقود"))).toBe(true);
    });

    it("executeMultiStepPlanOffline NEVER calls mockExecutor if validation fails", async () => {
      const intent = extractResearchIntent("جمع 10 تغريدات");
      const plan = buildMultiStepResearchPlan(intent);
      // Invalidate the plan
      plan.maxTargetVolume = 99999;

      const mockExecutorSpy = vi.fn(async () => ({ rows: [] }));

      const summary = await executeMultiStepPlanOffline(plan, mockExecutorSpy);

      expect(summary.status).toBe("failed");
      expect(mockExecutorSpy).not.toHaveBeenCalled();
      expect(summary.validationErrors?.length).toBeGreaterThan(0);
    });
  });
});
