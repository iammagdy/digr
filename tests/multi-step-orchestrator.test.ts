import { describe, it, expect } from "vitest";
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
});
