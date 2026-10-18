import { ResearchIntentSpec } from "./researchIntent";
import { ExclusionSpec } from "./exclusionFileParser";
import {
  EntityRecord,
  deduplicateAgainstBaseline,
  DeduplicationAuditItem,
} from "./negativeListEngine";
import { expandSearchStrategy, ExpandedSearchStrategy } from "./queryExpansion";
import { RAW_SEED_CAPABILITIES, Capability } from "../../functions/shared/capabilityRegistry";
import {
  calculateCapabilityUnitPricePoints,
  calculateCapabilityQuote,
  DEFAULT_PRICING_SETTINGS,
} from "../../functions/shared/quotes";
import {
  generateExcelReport,
  generateCsvReport,
  generatePdfReport,
  generateMethodologyText,
} from "../../functions/shared/fileGenerators";

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
  isExecutable?: boolean;
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
  catalogValidated?: boolean;
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
  generatedFiles?: {
    excelBytes?: number;
    csvBytes?: number;
    pdfBytes?: number;
  };
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
  validationErrors?: string[];
}

export type MockProviderExecutor = (
  step: ResearchStepSpec,
  contextData: Record<string, any>
) => Promise<{
  rows: any[];
  nextCursor?: string | null;
  error?: string;
}>;

// Catalog Lookup Cache
function getCatalogMap(): Map<string, any> {
  const list = RAW_SEED_CAPABILITIES || [];
  return new Map(list.map((c) => [c.slug, c]));
}

/**
 * Validates plan capabilities, endpoint IDs, DAG dependencies, and parameter schemas.
 * Ensures no placeholder or unverified capability can be marked as executable.
 */
export function validatePlanCapabilities(
  plan: ResearchExecutionPlan,
  allowedCatalog: Capability[] = RAW_SEED_CAPABILITIES
): {
  isValid: boolean;
  errors: string[];
  validatedSteps: ResearchStepSpec[];
} {
  const errors: string[] = [];
  const validSlugs = new Map(allowedCatalog.map((c) => [c.slug, c]));
  const allPlanStepIds = new Set(plan.steps.map((s) => s.stepId));
  const seenStepIds = new Set<string>();
  const validatedSteps: ResearchStepSpec[] = [];

  // Plan-level limit validation
  if (!plan.maxTargetVolume || plan.maxTargetVolume <= 0 || plan.maxTargetVolume > 5000) {
    errors.push(`الحد الأقصى لحجم العينة للخطة (${plan.maxTargetVolume}) غير صالح. يجب أن يكون بين 1 و 5000.`);
  }

  for (const step of plan.steps) {
    let stepValid = true;

    // Validate execution limits
    if (!step.maxDeliveredUnits || step.maxDeliveredUnits <= 0 || step.maxDeliveredUnits > 5000) {
      errors.push(`الحد الأقصى للوحدات المنجزة للخطوة (${step.stepId}) غير صالح: ${step.maxDeliveredUnits}.`);
      stepValid = false;
    }
    if (!step.maxCalls || step.maxCalls <= 0 || step.maxCalls > 500) {
      errors.push(`الحد الأقصى لعدد الاستدعاءات للخطوة (${step.stepId}) غير صالح: ${step.maxCalls}.`);
      stepValid = false;
    }
    if (typeof step.estimatedPoints !== "number" || step.estimatedPoints < 0 || !Number.isFinite(step.estimatedPoints)) {
      errors.push(`قيمة النقاط المقدرة للخطوة (${step.stepId}) غير صالحة: ${step.estimatedPoints}.`);
      stepValid = false;
    }

    // Validate DAG dependencies: all dependencies must exist in the plan, not be self, and have appeared earlier
    if (step.dependsOn && step.dependsOn.length > 0) {
      for (const dep of step.dependsOn) {
        if (!allPlanStepIds.has(dep)) {
          errors.push(`خطوة (${step.stepId}) تعتمد على خطوة غير موجودة في الخطة: ${dep}`);
          stepValid = false;
        } else if (dep === step.stepId) {
          errors.push(`خطوة (${step.stepId}) لا يمكن أن تعتمد على نفسها (تبعية ذاتية غير صالحة).`);
          stepValid = false;
        } else if (!seenStepIds.has(dep)) {
          errors.push(`خطوة (${step.stepId}) تعتمد على خطوة لم تسبقها في الترتيب التنفيذي: ${dep}`);
          stepValid = false;
        }
      }
    }

    seenStepIds.add(step.stepId);

    // Validate Data Collection & Comment Threads against catalog
    if (step.stepType === "data_collection" || step.stepType === "comment_threads") {
      const catalogEntry = validSlugs.get(step.capabilitySlug);

      // Guard: Placeholder or non-catalog capability
      if (!catalogEntry) {
        stepValid = false;
        errors.push(
          `الإمكانية (${step.capabilitySlug}) غير معتمدة في كتالوج الخدمات الموثوق ولا يمكن تنفيذها في الإنتاج.`
        );
      } else {
        // Verify endpoint ID matches the catalog definition
        if (step.endpointId !== catalogEntry.tregEndpointId) {
          stepValid = false;
          errors.push(
            `معرّف نقطة النهاية (${step.endpointId}) لا يطابق نقطة النهاية المعتمدة (${catalogEntry.tregEndpointId}) للإمكانية ${step.capabilitySlug}.`
          );
        }

        // Verify billing unit
        const validBillingUnits = ["call", "item", "page"];
        if (!catalogEntry.pricingUnit || !validBillingUnits.includes(catalogEntry.pricingUnit)) {
          stepValid = false;
          errors.push(
            `وحدة التسعير (${catalogEntry.pricingUnit}) غير مدعومة للإمكانية ${step.capabilitySlug}.`
          );
        }

        // Verify price
        const unitCost = Number(catalogEntry.unitCostUsd);
        if (!Number.isFinite(unitCost) || unitCost <= 0) {
          stepValid = false;
          errors.push(
            `سعر الوحدة (${catalogEntry.unitCostUsd}) غير صالح أو مفقود للإمكانية ${step.capabilitySlug}.`
          );
        }

        // Schema validation on required parameters
        try {
          const schema =
            typeof catalogEntry.paramsSchema === "string"
              ? JSON.parse(catalogEntry.paramsSchema)
              : catalogEntry.paramsSchema;
          const required = schema?.required || [];
          for (const reqProp of required) {
            if (
              step.params === undefined ||
              step.params[reqProp] === undefined ||
              step.params[reqProp] === null ||
              step.params[reqProp] === ""
            ) {
              errors.push(
                `المعلمة الإلزامية (${reqProp}) غير موجودة في معلمات الخطوة (${step.stepId}).`
              );
              stepValid = false;
            }
          }
        } catch {
          errors.push(`فشل تدقيق مخطط المعلمات للإمكانية ${step.capabilitySlug}.`);
          stepValid = false;
        }
      }
    }

    step.isExecutable = stepValid;
    validatedSteps.push(step);
  }

  return {
    isValid: errors.length === 0,
    errors,
    validatedSteps,
  };
}

/**
 * Builds an intelligent multi-step research execution plan matching user intent,
 * with real catalog capabilities and approved server pricing logic.
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
        isExecutable: true,
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
      isExecutable: true,
    });

    // 3. Public Company Discovery
    const linkedinCap = getCatalogMap().get("linkedin-profile");
    if (!linkedinCap || typeof linkedinCap.unitCostUsd !== "number" || linkedinCap.unitCostUsd <= 0) {
      throw new Error("سعر أو تعريف القدرة linkedin-profile غير متوفر في الكتالوج المعتمد.");
    }
    const discoveryQuote = calculateCapabilityQuote(targetVol * 2, linkedinCap.unitCostUsd, 999999, DEFAULT_PRICING_SETTINGS);
    const discoveryPoints = discoveryQuote.quotedPoints;
    totalEstimatedPoints += discoveryPoints;

    steps.push({
      stepId: "step_3_company_discovery",
      stepNameAr: "جمع بيانات الشركات العامة المستهدفة من المصادر العلنية",
      stepType: "data_collection",
      dependsOn: ["step_2_query_expansion"],
      capabilitySlug: "linkedin-profile",
      endpointId: "internal-linkedin-profile",
      params: { query: intent.topic.value, profileUrl: "https://linkedin.com/company/public-search" },
      maxDeliveredUnits: targetVol * 2,
      maxCalls: Math.ceil(targetVol / 10),
      estimatedPoints: discoveryPoints,
      isExecutable: true,
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
      isExecutable: true,
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
      isExecutable: true,
    });
  } else if (intent.platforms.value.includes("youtube")) {
    // YouTube Multi-Step Workflow with approved catalog endpoints
    const videoVol = Math.max(5, Math.ceil(targetVol / 20));
    const searchCap = getCatalogMap().get("youtube-search");
    if (!searchCap || typeof searchCap.unitCostUsd !== "number" || searchCap.unitCostUsd <= 0) {
      throw new Error("سعر أو تعريف القدرة youtube-search غير متوفر في الكتالوج المعتمد.");
    }
    const videoQuote = calculateCapabilityQuote(videoVol, searchCap.unitCostUsd, 999999, DEFAULT_PRICING_SETTINGS);
    totalEstimatedPoints += videoQuote.quotedPoints;

    steps.push({
      stepId: "step_1_video_search",
      stepNameAr: "البحث عن مقاطع الفيديو العامة ذات الصلة",
      stepType: "data_collection",
      capabilitySlug: "youtube-search",
      endpointId: "internal-youtube-search",
      params: { query: intent.topic.value, count: videoVol },
      maxDeliveredUnits: videoVol,
      maxCalls: 1,
      estimatedPoints: videoQuote.quotedPoints,
      isExecutable: true,
    });

    // Step 2: Collect Comments for discovered videos
    const commentsCap = getCatalogMap().get("youtube-comments");
    if (!commentsCap || typeof commentsCap.unitCostUsd !== "number" || commentsCap.unitCostUsd <= 0) {
      throw new Error("سعر أو تعريف القدرة youtube-comments غير متوفر في الكتالوج المعتمد.");
    }
    const commentsQuote = calculateCapabilityQuote(targetVol, commentsCap.unitCostUsd, 999999, DEFAULT_PRICING_SETTINGS);
    totalEstimatedPoints += commentsQuote.quotedPoints;

    steps.push({
      stepId: "step_2_collect_comments",
      stepNameAr: "استخراج التعليقات والردود العامة للمقاطع المكتشفة",
      stepType: "comment_threads",
      dependsOn: ["step_1_video_search"],
      capabilitySlug: "youtube-comments",
      endpointId: "internal-youtube-comments",
      params: { videoId: "search_result_videos", count: targetVol },
      maxDeliveredUnits: targetVol,
      maxCalls: Math.ceil(targetVol / 20),
      estimatedPoints: commentsQuote.quotedPoints,
      isExecutable: true,
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
      isExecutable: true,
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
      isExecutable: true,
    });
  } else {
    // Standard Social Workflow (X / Twitter Keyword Search)
    const xCap = getCatalogMap().get("x-keyword-search");
    if (!xCap || typeof xCap.unitCostUsd !== "number" || xCap.unitCostUsd <= 0) {
      throw new Error("سعر أو تعريف القدرة x-keyword-search غير متوفر في الكتالوج المعتمد.");
    }
    const xQuote = calculateCapabilityQuote(targetVol, xCap.unitCostUsd, 999999, DEFAULT_PRICING_SETTINGS);
    totalEstimatedPoints += xQuote.quotedPoints;

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
      isExecutable: true,
    });

    steps.push({
      stepId: "step_2_data_collection",
      stepNameAr: "جمع واستخراج المنشورات والتغريدات العامة",
      stepType: "data_collection",
      dependsOn: ["step_1_query_expansion"],
      capabilitySlug: "x-keyword-search",
      endpointId: "internal-x-search",
      params: { query: intent.topic.value, max_results: targetVol },
      maxDeliveredUnits: targetVol,
      maxCalls: Math.ceil(targetVol / 20),
      estimatedPoints: xQuote.quotedPoints,
      isExecutable: true,
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
      isExecutable: true,
    });

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
      isExecutable: true,
    });
  }

  return {
    planId,
    titleAr: `خطة بحث: ${intent.topic.value}`,
    targetPlatform: intent.platforms.value.join("، ") || "web",
    entityType: intent.entityType.value,
    steps,
    totalReservedPoints: Math.max(totalEstimatedPoints, 50),
    maxTargetVolume: targetVol,
    createdAt: new Date().toISOString(),
    catalogValidated: true,
  };
}

/**
 * Offline Multi-Step Orchestrator Engine:
 * Executes dependent steps sequentially, applying real query expansion,
 * deduplication, honest reporting, and actual file generation buffers.
 */
export async function executeMultiStepPlanOffline(
  plan: ResearchExecutionPlan,
  mockExecutor: MockProviderExecutor,
  options?: {
    baselineExclusionRecords?: EntityRecord[];
    intent?: ResearchIntentSpec;
  }
): Promise<OrchestrationExecutionSummary> {
  const stepResults: StepResult[] = [];
  const contextData: Record<string, any> = {};
  let rawCollected = 0;
  let uniqueDelivered = 0;
  let duplicatesRemoved = 0;
  let baselineExclusionsRemoved = 0;
  let deduplicationAudit: DeduplicationAuditItem[] = [];
  const methodologyNotes: string[] = [
    `تم تنفيذ خطة البحث (${plan.titleAr}) عبر ${plan.steps.length} مراحل متتابعة.`,
  ];

  let currentRows: any[] = [];

  // 1. Initial Validation of Plan Capabilities & Dependencies
  const validation = validatePlanCapabilities(plan);
  if (!validation.isValid) {
    return {
      planId: plan.planId,
      status: "failed",
      rawCollectedCount: 0,
      uniqueDeliveredCount: 0,
      duplicatesRemovedCount: 0,
      stepResults: [],
      finalDataset: [],
      deduplicationAudit: [],
      methodologyNotesAr: [`فشل التحقق من صحة خطة البحث: ${validation.errors.join("؛ ")}`],
      validationErrors: validation.errors,
    };
  }

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
      // Real Query Expansion via domain lexicons and intent
      const topic = step.params.topic || plan.titleAr.replace(/^خطة بحث:\s*/, "");
      const strategy: ExpandedSearchStrategy = options?.intent
        ? expandSearchStrategy(options.intent)
        : expandSearchStrategy({
            topic: { value: topic, provenance: "EXPLICIT" },
            platforms: { value: [plan.targetPlatform], provenance: "INFERRED" },
            entityType: { value: plan.entityType, provenance: "INFERRED" },
            sampleSize: { value: plan.maxTargetVolume, provenance: "DEFAULT" },
            timeframe: { value: "آخر شهر", provenance: "DEFAULT" },
            geographicScope: { value: "غير محدد", provenance: "DEFAULT" },
            outputTypes: { value: ["xlsx", "csv", "pdf"], provenance: "DEFAULT" },
            exclusionListReference: { detected: false, fileAttached: false, provenance: "DEFAULT" },
          } as any);

      contextData.expandedStrategy = strategy;
      stepResults.push({
        stepId: step.stepId,
        stepType: step.stepType,
        status: "completed",
        collectedCount: strategy.allQueries.length,
        deliveredCount: strategy.allQueries.length,
        duplicatesRemoved: 0,
        rows: strategy.allQueries,
      });
      methodologyNotes.push(
        `تم توسيع استراتيجية البحث آلياً لتوليد ${strategy.allQueries.length} محاور استعلام دلالية.`
      );
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
            status: currentRows.length > 0 ? "partial_success" : "failed",
            rawCollectedCount: rawCollected,
            uniqueDeliveredCount: currentRows.length,
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
          status: currentRows.length > 0 ? "partial_success" : "failed",
          rawCollectedCount: rawCollected,
          uniqueDeliveredCount: currentRows.length,
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
      baselineExclusionsRemoved += dedupResult.confirmedDuplicates.length;
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
      // Real report generation execution: generates actual buffers, validates non-empty results
      try {
        const searchTerms = [...new Set(plan.steps
          .filter((candidate) => candidate.stepType === "data_collection" || candidate.stepType === "comment_threads")
          .flatMap((candidate) => [candidate.params?.search, candidate.params?.topic, candidate.params?.keyword])
          .filter((term): term is string => typeof term === "string")
          .map((term) => term.trim())
          .filter(Boolean))].slice(0, 10);
        const country = plan.steps
          .map((candidate) => candidate.params?.country || candidate.params?.location)
          .find((value) => typeof value === "string" && value.trim());
        const reportContext = {
          scope: {
            country: typeof country === "string" ? country : undefined,
            searchTerms,
          },
          collection: {
            methodLabel: plan.steps
              .filter((candidate) => candidate.stepType === "data_collection" || candidate.stepType === "comment_threads")
              .map((candidate) => candidate.stepNameAr)
              .filter(Boolean)
              .join("، ") || "تنفيذ خطة البحث المعتمدة",
          },
          counts: {
            rawRows: rawCollected,
            acceptedRows: currentRows.length,
            baselineExclusions: baselineExclusionsRemoved,
          },
        };
        const payload = {
          metadata: {
            platform: plan.targetPlatform,
            title: plan.titleAr,
            entityType: plan.entityType,
            rowsCount: currentRows.length,
            collectedAt: new Date().toISOString(),
            targetRequested: plan.maxTargetVolume,
            reportContext,
            methodology: "تعرض هذه المخرجات السجلات التي أعادتها خطوات خطة البحث المنفذة، بعد قواعد التنظيف والاستبعاد المسجلة. اكتمال الحقول لا يثبت صحة المعلومات أو شمول مجتمع البحث.",
          },
          rows: currentRows,
        };

        const excelBuf = await generateExcelReport(payload, { deduplicationAudit });
        const csvBuf = generateCsvReport(payload);
        const pdfBuf = await generatePdfReport(payload);
        const methText = generateMethodologyText(payload, {
          rawCollected,
          uniqueDelivered: currentRows.length,
          duplicatesRemoved,
        });

        if (!Buffer.isBuffer(excelBuf) || excelBuf.length === 0) {
          throw new Error("فشل توليد مصنف Excel: الحجم فارغ.");
        }

        stepResults.push({
          stepId: step.stepId,
          stepType: step.stepType,
          status: "completed",
          collectedCount: currentRows.length,
          deliveredCount: currentRows.length,
          duplicatesRemoved: 0,
          rows: currentRows,
          generatedFiles: {
            excelBytes: excelBuf.length,
            csvBytes: csvBuf.length,
            pdfBytes: pdfBuf.length,
          },
        });
        methodologyNotes.push(
          `تم توليد المخرجات البحثية المعتمدة: مصنف Excel (${excelBuf.length} بايت)، CSV (${csvBuf.length} بايت)، PDF (${pdfBuf.length} بايت).`
        );
      } catch (genErr: any) {
        stepResults.push({
          stepId: step.stepId,
          stepType: step.stepType,
          status: "failed",
          collectedCount: currentRows.length,
          deliveredCount: 0,
          duplicatesRemoved: 0,
          rows: [],
          error: genErr?.message || "فشل توليد ملفات التقرير",
        });
        return {
          planId: plan.planId,
          status: "partial_success",
          rawCollectedCount: rawCollected,
          uniqueDeliveredCount: currentRows.length,
          duplicatesRemovedCount: duplicatesRemoved,
          stepResults,
          finalDataset: currentRows,
          deduplicationAudit,
          methodologyNotesAr: methodologyNotes,
        };
      }
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
