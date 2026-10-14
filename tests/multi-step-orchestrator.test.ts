import { describe, it, expect } from "vitest";
import {
  buildMultiStepResearchPlan,
  executeMultiStepPlanOffline,
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
});
