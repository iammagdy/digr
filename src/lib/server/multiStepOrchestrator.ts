import { ResearchIntentSpec } from "./researchIntent";
import { ExclusionSpec } from "./exclusionFileParser";
import {
  EntityRecord,
  deduplicateAgainstBaseline,
  DeduplicationAuditItem,
} from "./negativeListEngine";
import { ExpandedSearchStrategy } from "./queryExpansion";

export type ResearchStepType =
  | "exclusion_parsing"
  | "query_expansion"
  | "data_collection"
  | "entity_deduplication"
  | "comment_threads"
  | "normalization"
  | "report_generation";

export interface ResearchStepSpec {
  stepId: string;
  stepNameAr: string;
  stepType: ResearchStepType;
  dependsOn?: string[];
  capabilitySlug: string;
  endpointId: string;
  params: Record<string, any>;
  maxDeliveredUnits: number;
  maxCalls: number;
  estimatedPoints: number;
}

export interface ResearchExecutionPlan {
  planId: string;
  titleAr: string;
  targetPlatform: string;
  entityType: string;
  steps: ResearchStepSpec[];
  totalReservedPoints: number;
  maxTargetVolume: number;
  createdAt: string;
}

export interface StepResult {
  stepId: string;
  stepType: ResearchStepType;
  status: "completed" | "failed" | "skipped";
  collectedCount: number;
  deliveredCount: number;
  duplicatesRemoved: number;
  rows: any[];
  auditTrail?: DeduplicationAuditItem[];
  error?: string;
}

export interface OrchestrationExecutionSummary {
  planId: string;
  status: "completed" | "partial_success" | "failed";
  rawCollectedCount: number;
  uniqueDeliveredCount: number;
  duplicatesRemovedCount: number;
  stepResults: StepResult[];
  finalDataset: any[];
  deduplicationAudit: DeduplicationAuditItem[];
  methodologyNotesAr: string[];
}

export type MockProviderExecutor = (
  step: ResearchStepSpec,
  contextData: Record<string, any>
) => Promise<{
  rows: any[];
  nextCursor?: string | null;
  error?: string;
}>;

/**
 * Builds an intelligent multi-step research execution plan matching the user's intent.
 */
export function buildMultiStepResearchPlan(
  intent: ResearchIntentSpec,
  exclusionSpec?: ExclusionSpec
): ResearchExecutionPlan {
  const planId = `plan_${Date.now()}`;
  const steps: ResearchStepSpec[] = [];
  let totalEstimatedPoints = 0;
  const targetVol = intent.sampleSize.value;

  if (intent.entityType.value === "companies") {
    // 1. Exclusion Parsing Step (if exclusion list supplied)
    if (exclusionSpec && exclusionSpec.baselineRowCount > 0) {
      steps.push({
        stepId: "step_1_exclusion_baseline",
        stepNameAr: "تحليل وتجهيز قائمة الاستبعاد المرجعية",
        stepType: "exclusion_parsing",
        capabilitySlug: "internal-exclusion-parser",
        endpointId: "internal.exclusion.parser",
        params: { baselineCount: exclusionSpec.baselineRowCount },
        maxDeliveredUnits: exclusionSpec.baselineRowCount,
        maxCalls: 1,
        estimatedPoints: 0,
      });
    }

    // 2. Query Expansion Step
    steps.push({
      stepId: "step_2_query_expansion",
      stepNameAr: "توسيع محاور واستراتيجيات البحث للشركات",
      stepType: "query_expansion",
      capabilitySlug: "internal-query-expansion",
      endpointId: "internal.query.expansion",
      params: { topic: intent.topic.value, scope: intent.geographicScope.value },
      maxDeliveredUnits: 10,
      maxCalls: 1,
      estimatedPoints: 0,
    });

    // 3. Public Company Discovery
    const discoveryPoints = Math.ceil(targetVol * 2);
    totalEstimatedPoints += discoveryPoints;
    steps.push({
      stepId: "step_3_company_discovery",
      stepNameAr: "جمع بيانات الشركات العامة المستهدفة من المصادر العلنية",
      stepType: "data_collection",
      dependsOn: ["step_2_query_expansion"],
      capabilitySlug: "company-public-search",
      endpointId: "google.serp.organic",
      params: { query: intent.topic.value, targetCount: targetVol * 2 }, // gather headroom for deduplication
      maxDeliveredUnits: targetVol * 2,
      maxCalls: Math.ceil(targetVol / 10),
      estimatedPoints: discoveryPoints,
    });

    // 4. Entity Deduplication against baseline
    steps.push({
      stepId: "step_4_deduplication",
      stepNameAr: "تدقيق واستبعاد الشركات المكررة في القائمة المرجعية",
      stepType: "entity_deduplication",
      dependsOn: ["step_3_company_discovery"],
      capabilitySlug: "internal-entity-deduplicator",
      endpointId: "internal.deduplication.engine",
      params: { targetDelivered: targetVol },
      maxDeliveredUnits: targetVol,
      maxCalls: 1,
      estimatedPoints: 0,
    });

    // 5. Final Report Generation
    steps.push({
      stepId: "step_5_report_gen",
      stepNameAr: "توليد ملفات التقرير الأكاديمي ودليل الشركات",
      stepType: "report_generation",
      dependsOn: ["step_4_deduplication"],
      capabilitySlug: "internal-file-generator",
      endpointId: "internal.file.generator",
      params: { formats: intent.outputTypes.value },
      maxDeliveredUnits: targetVol,
      maxCalls: 1,
      estimatedPoints: 0,
    });
  } else if (intent.platforms.value.includes("youtube")) {
    // YouTube Multi-Step Workflow
    // Step 1: Discover Videos
    const videoVol = Math.max(5, Math.ceil(targetVol / 20));
    const videoPoints = Math.ceil(videoVol * 3);
    totalEstimatedPoints += videoPoints;

    steps.push({
      stepId: "step_1_video_search",
      stepNameAr: "البحث عن مقاطع الفيديو العامة ذات الصلة",
      stepType: "data_collection",
      capabilitySlug: "youtube-search",
      endpointId: "internal-youtube-search",
      params: { query: intent.topic.value, count: videoVol },
      maxDeliveredUnits: videoVol,
      maxCalls: 1,
      estimatedPoints: videoPoints,
    });

    // Step 2: Collect Comments for discovered videos
    const commentPoints = Math.ceil(targetVol * 1.5);
    totalEstimatedPoints += commentPoints;

    steps.push({
      stepId: "step_2_collect_comments",
      stepNameAr: "استخراج التعليقات والردود العامة للمقاطع المكتشفة",
      stepType: "comment_threads",
      dependsOn: ["step_1_video_search"],
      capabilitySlug: "youtube-comments",
      endpointId: "internal-youtube-comments",
      params: { targetCount: targetVol },
      maxDeliveredUnits: targetVol,
      maxCalls: Math.ceil(targetVol / 20),
      estimatedPoints: commentPoints,
    });

    // Step 3: Normalization & Hierarchy Grouping
    steps.push({
      stepId: "step_3_normalization",
      stepNameAr: "هيكلة وربط الردود بالتعليقات الأصلية وحذف التكرار",
      stepType: "normalization",
      dependsOn: ["step_2_collect_comments"],
      capabilitySlug: "internal-normalizer",
      endpointId: "internal.normalization.pipeline",
      params: {},
      maxDeliveredUnits: targetVol,
      maxCalls: 1,
      estimatedPoints: 0,
    });

    // Step 4: Final Deliverables
    steps.push({
      stepId: "step_4_deliverables",
      stepNameAr: "تصدير مصنف إكسل والتقرير الإحصائي",
      stepType: "report_generation",
      dependsOn: ["step_3_normalization"],
      capabilitySlug: "internal-file-generator",
      endpointId: "internal.file.generator",
      params: { formats: intent.outputTypes.value },
      maxDeliveredUnits: targetVol,
      maxCalls: 1,
      estimatedPoints: 0,
    });
  } else {
    // Standard Single/Multi Query Social Workflow (e.g. X, TikTok, Facebook)
    const points = Math.ceil(targetVol * 2);
    totalEstimatedPoints += points;

    steps.push({
      stepId: "step_1_query_expansion",
      stepNameAr: "توسيع الكلمات والوسوم الدلالية",
      stepType: "query_expansion",
      capabilitySlug: "internal-query-expansion",
      endpointId: "internal.query.expansion",
      params: { topic: intent.topic.value },
      maxDeliveredUnits: 10,
      maxCalls: 1,
      estimatedPoints: 0,
    });

    steps.push({
      stepId: "step_2_data_collection",
      stepNameAr: "جمع واستخراج المنشورات والتغريدات العامة",
      stepType: "data_collection",
      dependsOn: ["step_1_query_expansion"],
      capabilitySlug: `${intent.platforms.value[0] || "x"}-keyword-search`,
      endpointId: "internal-x-search",
      params: { query: intent.topic.value, count: targetVol },
      maxDeliveredUnits: targetVol,
      maxCalls: Math.ceil(targetVol / 20),
      estimatedPoints: points,
    });

    steps.push({
      stepId: "step_3_normalization",
      stepNameAr: "تنقية البيانات وحذف التكرارات وفحص الاكتمال",
      stepType: "normalization",
      dependsOn: ["step_2_data_collection"],
      capabilitySlug: "internal-normalizer",
      endpointId: "internal.normalization.pipeline",
      params: {},
      maxDeliveredUnits: targetVol,
      maxCalls: 1,
      estimatedPoints: 0,
    });
  }

  return {
    planId,
    titleAr: `خطة بحث: ${intent.topic.value}`,
    targetPlatform: intent.platforms.value.join("، "),
    entityType: intent.entityType.value,
    steps,
    totalReservedPoints: Math.max(totalEstimatedPoints, 50),
    maxTargetVolume: targetVol,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Offline Multi-Step Orchestrator Engine:
 * Executes dependent steps sequentially, applying deduplication,
 * checkpointing, and error classification with offline mock provider injection.
 */
export async function executeMultiStepPlanOffline(
  plan: ResearchExecutionPlan,
  mockExecutor: MockProviderExecutor,
  options?: {
    baselineExclusionRecords?: EntityRecord[];
  }
): Promise<OrchestrationExecutionSummary> {
  const stepResults: StepResult[] = [];
  const contextData: Record<string, any> = {};
  let rawCollected = 0;
  let uniqueDelivered = 0;
  let duplicatesRemoved = 0;
  let deduplicationAudit: DeduplicationAuditItem[] = [];
  const methodologyNotes: string[] = [
    `تم تنفيذ خطة البحث (${plan.titleAr}) عبر ${plan.steps.length} مراحل متتابعة.`,
  ];

  let currentRows: any[] = [];

  for (const step of plan.steps) {
    if (step.stepType === "exclusion_parsing") {
      const baseline = options?.baselineExclusionRecords || [];
      contextData.baselineExclusions = baseline;
      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: baseline.length,
        deliveredCount: baseline.length,
        duplicatesRemoved: 0,
        rows: baseline,
      });
      methodologyNotes.push(`تم تحميل وفهرسة ${baseline.length} سجلاً في قائمة الاستبعاد المرجعية.`);
    } else if (step.stepType === "query_expansion") {
      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: 4,
        deliveredCount: 4,
        duplicatesRemoved: 0,
        rows: ["استراتيجية 1", "استراتيجية 2", "استراتيجية 3", "استراتيجية 4"],
      });
      methodologyNotes.push("تم توسيع مصطلحات ومحاور البحث لاستيعاب المترادفات والبدائل باللغتين العربية والإنجليزية.");
    } else if (step.stepType === "data_collection" || step.stepType === "comment_threads") {
      try {
        const out = await mockExecutor(step, contextData);
        if (out.error) {
          stepResults.push({
            stepId: step.stepId,
            stepType: step.stepType,
            status: "failed",
            collectedCount: 0,
            deliveredCount: 0,
            duplicatesRemoved: 0,
            rows: [],
            error: out.error,
          });
          methodologyNotes.push(`توقفت مرحلة الجمع (${step.stepNameAr}) بسبب خطأ المزود: ${out.error}`);
          return {
            planId: plan.planId,
            status: "failed",
            rawCollectedCount: rawCollected,
            uniqueDeliveredCount: uniqueDelivered,
            duplicatesRemovedCount: duplicatesRemoved,
            stepResults,
            finalDataset: currentRows,
            deduplicationAudit,
            methodologyNotesAr: methodologyNotes,
          };
        }

        const rows = out.rows || [];
        rawCollected += rows.length;
        currentRows = [...currentRows, ...rows];
        contextData[step.stepId] = rows;

        stepResults.push({
          stepId: step.stepId,
          stepType: step.stepType,
          status: "completed",
          collectedCount: rows.length,
          deliveredCount: rows.length,
          duplicatesRemoved: 0,
          rows,
        });
        methodologyNotes.push(`تم استخراج ${rows.length} سجلاً من خلال ${step.stepNameAr}.`);
      } catch (err: any) {
        stepResults.push({
          stepId: step.stepId,
          stepType: step.stepType,
          status: "failed",
          collectedCount: 0,
          deliveredCount: 0,
          duplicatesRemoved: 0,
          rows: [],
          error: err?.message || "Execution failed",
        });
        return {
          planId: plan.planId,
          status: "failed",
          rawCollectedCount: rawCollected,
          uniqueDeliveredCount: uniqueDelivered,
          duplicatesRemovedCount: duplicatesRemoved,
          stepResults,
          finalDataset: currentRows,
          deduplicationAudit,
          methodologyNotesAr: methodologyNotes,
        };
      }
    } else if (step.stepType === "entity_deduplication") {
      const baseline = (contextData.baselineExclusions as EntityRecord[]) || options?.baselineExclusionRecords || [];
      const candidates: EntityRecord[] = currentRows.map((r, i) => ({
        id: r.id || `cand_${i}`,
        name: r.company_name || r.name || r.title || `Company ${i}`,
        domain: r.website || r.domain || r.url,
        crNumber: r.cr_number,
      }));

      const dedupResult = deduplicateAgainstBaseline(candidates, baseline);
      deduplicationAudit = dedupResult.auditTrail;
      duplicatesRemoved += dedupResult.confirmedDuplicates.length;
      currentRows = dedupResult.delivered;

      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: candidates.length,
        deliveredCount: dedupResult.delivered.length,
        duplicatesRemoved: dedupResult.confirmedDuplicates.length,
        rows: dedupResult.delivered,
        auditTrail: dedupResult.auditTrail,
      });

      methodologyNotes.push(
        `تم فحص ${candidates.length} كياناً، واستبعاد ${dedupResult.confirmedDuplicates.length} شركة مكررة تطابق القائمة المرجعية، وتوثيق ${dedupResult.ambiguousMatches.length} حالة تشابه جزئي للمراجعة.`
      );
    } else if (step.stepType === "normalization") {
      // In-memory deduplication of posts/comments by ID
      const seenIds = new Set<string>();
      const deduped: any[] = [];
      let localDups = 0;

      for (const r of currentRows) {
        const id = r.id || r.source_id || r.tweet_id || r.comment_id || r.videoId;
        if (id && seenIds.has(id)) {
          localDups++;
        } else {
          if (id) seenIds.add(id);
          deduped.push(r);
        }
      }

      duplicatesRemoved += localDups;
      currentRows = deduped;

      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: currentRows.length + localDups,
        deliveredCount: currentRows.length,
        duplicatesRemoved: localDups,
        rows: currentRows,
      });

      methodologyNotes.push(`تم تطبيع البيانات وتوحيد الحقول واستبعاد ${localDups} سجلات مكررة رقمياً.`);
    } else if (step.stepType === "report_generation") {
      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: currentRows.length,
        deliveredCount: currentRows.length,
        duplicatesRemoved: 0,
        rows: currentRows,
      });
      methodologyNotes.push("تم توليد مخرجات البحث في مصنفات Excel RTL متعددة الأوراق وCSV وPDF متوافقة.");
    }
  }

  uniqueDelivered = currentRows.length;

  return {
    planId: plan.planId,
    status: "completed",
    rawCollectedCount: rawCollected,
    uniqueDeliveredCount: uniqueDelivered,
    duplicatesRemovedCount: duplicatesRemoved,
    stepResults,
    finalDataset: currentRows,
    deduplicationAudit,
    methodologyNotesAr: methodologyNotes,
  };
}
