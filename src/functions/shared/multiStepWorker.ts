import { logProviderCost } from "./providerCosts";
import { ID, Query, Role, Permission, TablesDB, Storage } from "./dbCompat";
import { completeJobWithRelFirst, releaseCredits, releaseReservation } from "./ledger";
import { calculateFinalSettlement } from "./quotes";
import {
  generateExcelReport,
  generatePdfReport,
  generateCsvReport,
  generateMethodologyText as buildMethodologyDoc,
} from "./fileGenerators";
import { executeTregCall, TregCallOptions, TregCallResult } from "./tregClient";
import { parseStoredPlan } from "./planManager";
import { searchCatalog } from "./catalogClient";
import {
  checkProviderDailySpendCap,
  recordProviderCallSpend,
  getConfiguredJobPointsCap,
} from "./providerSpend";

export interface GenericJobStep {
  stepId: string;
  capabilitySlug?: string;
  endpointId?: string;
  method?: "GET" | "POST";
  params?: Record<string, any>;
  targetVolumeMin?: number;
  targetVolumeMax?: number;
  paginationStrategy?: "cursor" | "offset" | "page" | "none";
  unitPricePoints?: number;
}

export interface WorkerStepInput {
  jobId: string;
  targetVolumeMax: number;
  unitPricePoints: number;
  reservedCredits: number;
  userId: string;
  templateSlug: string;
  params: Record<string, any>;
  pricingUnit?: "call" | "item" | "page";
  steps?: GenericJobStep[];
  fetchPageFn?: (cursor: string | null, page: number) => Promise<PageFetchResult>;
  isTestMode?: boolean;
}

export interface PageFetchResult {
  ok: boolean;
  httpStatus: number;
  items: any[];
  nextCursor?: string | null;
  costMicro?: number;
  errorType?: "route_max_cost" | "insufficient_balance" | "rate_limit" | "client_error" | "network_error";
  errorMessage?: string;
}

export interface WorkerExecutionResult {
  success: boolean;
  jobId: string;
  status: "done" | "failed" | "cancelled";
  deliveredUnits: number;
  reservedCredits: number;
  chargedCredits: number;
  refundCredits: number;
  released?: boolean;
  alreadyReleased?: boolean;
  resultFiles?: {
    xlsxFileId: string;
    pdfFileId: string;
    csvFileId: string;
    methodologyFileId?: string;
    jsonFileId?: string;
  };
  errorAr?: string;
}

/**
 * Robust parser for TikTok user profile responses returned by upstream TikHub/TREG
 */
export function parseTikTokProfileResponse(rawBody: any, requestedUsername: string) {
  if (!rawBody) return null;
  const data = rawBody.data || rawBody;
  const user = data.userInfo?.user || data.user || data.data?.userInfo?.user || data.data?.user;
  const stats = data.userInfo?.stats || data.stats || data.data?.userInfo?.stats || data.data?.stats;

  if (!user && !stats) {
    if (typeof data === "object" && (data.uniqueId || data.id || data.nickname)) {
      return {
        id: String(data.id || data.uid || ""),
        uniqueId: String(data.uniqueId || requestedUsername).replace(/^@/, ""),
        nickname: String(data.nickname || requestedUsername),
        signature: String(data.signature || data.bio || ""),
        verified: Boolean(data.verified || data.customVerify),
        followerCount: Number(data.followerCount || 0),
        followingCount: Number(data.followingCount || 0),
        heartCount: Number(data.heartCount || data.heart || 0),
        videoCount: Number(data.videoCount || 0),
        avatarUrl: String(data.avatarLarger || data.avatarMedium || ""),
        bioLink: String(data.bioLink?.link || data.bioLink || ""),
        profileUrl: `https://www.tiktok.com/@${String(data.uniqueId || requestedUsername).replace(/^@/, "")}`,
        collectedDate: new Date().toISOString().slice(0, 10),
      };
    }
    return null;
  }

  const cleanUsername = String(user?.uniqueId || requestedUsername).replace(/^@/, "");
  const extractUrl = (val: any): string => {
    if (!val) return "";
    if (typeof val === "string") return val;
    if (Array.isArray(val)) return val[0] || "";
    if (val.urlList && Array.isArray(val.urlList)) return val.urlList[0] || "";
    if (val.url_list && Array.isArray(val.url_list)) return val.url_list[0] || "";
    return "";
  };

  const extractLink = (val: any): string => {
    if (!val) return "";
    if (typeof val === "string") return val;
    if (val.link && typeof val.link === "string") return val.link;
    if (val.url && typeof val.url === "string") return val.url;
    return "";
  };

  return {
    id: String(user?.id || user?.uid || ""),
    uniqueId: cleanUsername,
    nickname: String(user?.nickname || cleanUsername),
    signature: String(user?.signature || user?.bio || ""),
    verified: Boolean(user?.verified || user?.customVerify),
    followerCount: Number(stats?.followerCount ?? 0),
    followingCount: Number(stats?.followingCount ?? 0),
    heartCount: Number(stats?.heartCount ?? stats?.heart ?? 0),
    videoCount: Number(stats?.videoCount ?? 0),
    avatarUrl: extractUrl(user?.avatarLarger || user?.avatarMedium || user?.avatarThumb),
    bioLink: extractLink(user?.bioLink),
    profileUrl: `https://www.tiktok.com/@${cleanUsername}`,
    collectedDate: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Generic row flattener: flattens top-level and 1 nested level (e.g. user.name -> user_name, stats.likes -> likes).
 * Joins arrays of primitives with comma.
 */
export function flattenRow(row: any): Record<string, any> {
  if (!row || typeof row !== "object") {
    return { value: row !== undefined && row !== null ? row : "" };
  }

  let baseRow = { ...row };
  if (baseRow.userInfo && typeof baseRow.userInfo === "object") {
    baseRow = {
      ...(baseRow.userInfo.user || {}),
      ...(baseRow.userInfo.stats || {}),
      ...baseRow,
    };
    delete baseRow.userInfo;
  }

  const flattened: Record<string, any> = {};

  for (const [key, val] of Object.entries(baseRow)) {
    if (val === null || val === undefined) {
      flattened[key] = "";
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        flattened[key] = "";
      } else if (typeof val[0] === "object" && val[0] !== null) {
        flattened[key] = val.map((v) => JSON.stringify(v)).join(", ");
      } else {
        flattened[key] = val.map((v) => String(v)).join(", ");
      }
    } else if (typeof val === "object") {
      for (const [subKey, subVal] of Object.entries(val)) {
        const compositeKey = `${key}_${subKey}`;
        if (subVal === null || subVal === undefined) {
          flattened[compositeKey] = "";
        } else if (Array.isArray(subVal)) {
          flattened[compositeKey] = subVal.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
        } else if (typeof subVal === "object") {
          flattened[compositeKey] = JSON.stringify(subVal);
        } else {
          flattened[compositeKey] = subVal;
        }
      }
    } else {
      flattened[key] = val;
    }
  }

  return flattened;
}

/**
 * Generic row extractor: whatever JSON structure comes back, extracts array and flattens into row objects.
 */
export function extractAndFlattenRows(rawResponse: any): Array<Record<string, any>> {
  if (!rawResponse) return [];

  let candidates: any[] = [];

  if (Array.isArray(rawResponse)) {
    candidates = rawResponse;
  } else if (typeof rawResponse === "object") {
    const arrayCandidates = [
      rawResponse.data,
      rawResponse.items,
      rawResponse.results,
      rawResponse.records,
      rawResponse.leads,
      rawResponse.companies,
      rawResponse.posts,
      rawResponse.tweets,
      rawResponse.videos,
      rawResponse.users,
      rawResponse.data?.leads,
      rawResponse.data?.companies,
      rawResponse.data?.items,
      rawResponse.data?.results,
      rawResponse.data?.data,
      rawResponse.data?.posts,
      rawResponse.data?.tweets,
      rawResponse.data?.videos,
      rawResponse.data?.users,
    ];

    for (const arr of arrayCandidates) {
      if (Array.isArray(arr)) {
        candidates = arr;
        break;
      }
    }

    if (candidates.length === 0) {
      for (const val of Object.values(rawResponse)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
          candidates = val;
          break;
        }
      }
    }

    if (candidates.length === 0) {
      const obj = rawResponse.data || rawResponse.user || rawResponse.profile || rawResponse;
      if (obj && typeof obj === "object" && Object.keys(obj).length > 0) {
        candidates = [obj];
      }
    }
  }

  return candidates.map(flattenRow);
}

/**
 * Builds white-label methodology facts document (.txt).
 */
export function generateMethodologyText(payload: any): string {
  return buildMethodologyDoc(payload);
}

async function executeTregCallWithRetry(
  options: TregCallOptions,
  maxRetries: number = 3
): Promise<TregCallResult> {
  let attempt = 0;
  let lastResult: TregCallResult;

  while (attempt <= maxRetries) {
    lastResult = await executeTregCall(options);

    if (lastResult.ok) return lastResult;

    const isRetryable =
      lastResult.httpStatus === 429 ||
      (lastResult.httpStatus >= 500 && lastResult.httpStatus <= 599) ||
      lastResult.error === "network_failure" ||
      lastResult.error === "rate_limit";

    if (!isRetryable || attempt === maxRetries) {
      return lastResult;
    }

    attempt++;
    const backoffMs = Math.min(1000, 50 * Math.pow(2, attempt - 1));
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  return lastResult!;
}

/**
 * Generic multi-step worker with live TREG execution, pagination loops, spend caps,
 * retries on 429/5xx, release-first settlement, and comprehensive artifact generation (Excel, PDF, CSV, TXT, JSON).
 */
export async function executeMultiStepJob(
  tables: TablesDB,
  storage: Storage | null,
  input: WorkerStepInput
): Promise<WorkerExecutionResult> {
  const {
    jobId,
    targetVolumeMax,
    unitPricePoints,
    reservedCredits,
    userId,
    templateSlug,
    params,
    fetchPageFn,
    isTestMode,
  } = input;

  const isProduction = process.env.NODE_ENV === "production";
  const isLive = !isTestMode && !fetchPageFn;

  // STRICT GUARD 1: Refuse fake/mock execution in production
  if (isProduction && !isLive) {
    const errorAr = "لا يُسمح باستخدام بيانات تجريبية في بيئة الإنتاج. تم استرجاع كامل الرصيد المحجوز.";
    await releaseCredits(tables, userId, jobId, reservedCredits, "إلغاء واسترجاع كامل الرصيد: منع البيانات التجريبية في الإنتاج");
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: {
        status: "failed",
        errorAr,
        finishedAt: new Date().toISOString(),
      },
    });
    return {
      success: false,
      jobId,
      status: "failed",
      deliveredUnits: 0,
      reservedCredits,
      chargedCredits: 0,
      refundCredits: reservedCredits,
      errorAr,
    };
  }

  // TREG_LIVE Verification Guard: Fail safely with clear Arabic refusal if TREG_LIVE is not 'true'
  if (!fetchPageFn && process.env.TREG_LIVE !== "true") {
    const errorAr = "مزود البيانات الحقيقي معطل حالياً في البيئة (TREG_LIVE!=true). تم استرجاع كامل الرصيد المحجوز إلى محفظتك.";
    const relRes = await releaseReservation(
      tables,
      userId,
      jobId,
      reservedCredits,
      "استرجاع الرصيد المحجوز لعدم تفعيل مزود البيانات الحقيقي"
    );
    try {
      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          status: "failed",
          errorAr,
          finishedAt: new Date().toISOString(),
        },
      });
    } catch {}
    try {
      await tables.createRow({
        databaseId: "digr",
        tableId: "job_events",
        rowId: ID.unique(),
        data: {
          jobId,
          textAr: errorAr,
          count: 0,
          kind: "error",
          createdAt: new Date().toISOString(),
        },
        permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
      });
    } catch {}
    return {
      success: false,
      jobId,
      status: "failed",
      released: relRes.released,
      alreadyReleased: relRes.alreadyReleased,
      deliveredUnits: 0,
      reservedCredits,
      chargedCredits: 0,
      refundCredits: reservedCredits,
      errorAr,
    };
  }

  // 1. Mark Job as running
  try {
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { status: "running" },
    });
  } catch {}

  // Helper to emit progress events
  const emitProgress = async (textAr: string, count: number, kind: string = "progress") => {
    try {
      await tables.createRow({
        databaseId: "digr",
        tableId: "job_events",
        rowId: ID.unique(),
        data: {
          jobId,
          textAr,
          count,
          kind,
          createdAt: new Date().toISOString(),
        },
        permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
      });
    } catch (err: any) {
      console.warn("Failed to write event:", err.message);
    }
  };

  await emitProgress("جاري الاتصال بمصدر البيانات والبدء في استخراج السجلات...", 0, "progress");

  let collectedRows: any[] = [];
  let totalCostMicro = 0;
  let isCancelled = false;

  // Branch A: Custom mock fetcher (used in specialized pagination unit tests)
  if (fetchPageFn) {
    let cursor: string | null = null;
    let page = 1;

    while (collectedRows.length < targetVolumeMax) {
      try {
        const currentJobDoc: any = await tables.getRow({
          databaseId: "digr",
          tableId: "jobs",
          rowId: jobId,
        });
        if (currentJobDoc.status === "cancelled") {
          isCancelled = true;
          break;
        }
      } catch {}

      let pageResult = await fetchPageFn(cursor, page);

      if (!pageResult.ok && (pageResult.httpStatus === 429 || pageResult.errorType === "rate_limit")) {
        await emitProgress("تم رصد ضغط مؤقت في المصدر. جاري إعادة المحاولة...", collectedRows.length, "info");
        await new Promise((r) => setTimeout(r, 100));
        pageResult = await fetchPageFn(cursor, page);
      }

      if (!pageResult.ok) {
        if (collectedRows.length === 0) {
          let errorAr = pageResult.errorMessage || "تعذر استخراج البيانات من المصدر";
          if (pageResult.errorType === "route_max_cost" || pageResult.httpStatus === 402) {
            if (pageResult.errorMessage?.includes("platform_balance")) {
              errorAr = "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
            } else {
              errorAr = "تجاوز الطلب سقف التكلفة المسموح به للمصدر.";
            }
          }

          await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لفشل الاستخراج");
          await tables.updateRow({
            databaseId: "digr",
            tableId: "jobs",
            rowId: jobId,
            data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
          });
          return {
            success: false,
            jobId,
            status: "failed",
            deliveredUnits: 0,
            reservedCredits,
            chargedCredits: 0,
            refundCredits: reservedCredits,
            errorAr,
          };
        }
        break;
      }

      collectedRows.push(...pageResult.items);
      totalCostMicro += pageResult.costMicro || 0;
      if (pageResult.costMicro) await logProviderCost(tables, { jobId, provider: "treg", units: 1, costUsd: pageResult.costMicro / 1_000_000 });
      await emitProgress(`تم جمع ${collectedRows.length} سجل من أصل ${targetVolumeMax}...`, collectedRows.length, "progress");

      if (!pageResult.nextCursor) break;
      cursor = pageResult.nextCursor;
      page++;
    }
  } else {
    // Branch B: Generic Multi-Step Executor (TREG API calls via POST https://treg.to/call/{endpointId})
    let steps: GenericJobStep[] = [];

      if (input.steps && input.steps.length > 0) {
      steps = input.steps;
    } else {
      // Look up quote from plans_quotes if available
      try {
        const quotesRes = await tables.listRows({
          databaseId: "digr",
          tableId: "plans_quotes",
          queries: [Query.equal("jobId", jobId), Query.limit(1)],
        });
        if (quotesRes.rows.length > 0) {
          const quote = quotesRes.rows[0] as any;
          const items = parseStoredPlan(quote.itemsJson);
          if (Array.isArray(items) && items.length > 0) {
            steps = items.map((it: any, idx: number) => ({
              stepId: it.stepId || `step_${idx + 1}`,
              capabilitySlug: it.capabilitySlug,
              endpointId: it.endpointId || it.capabilitySlug,
              method: it.method || it.tregMethod,
              params: it.params || {},
              targetVolumeMin: it.targetVolumeMin,
              targetVolumeMax: it.targetVolumeMax || targetVolumeMax,
              paginationStrategy: it.paginationStrategy || "none",
              unitPricePoints: it.unitPricePoints || unitPricePoints,
            }));
          }
        }
      } catch {}

      if (steps.length === 0 && params._planItems && Array.isArray(params._planItems)) {
        steps = params._planItems.map((it: any, idx: number) => ({
          stepId: it.stepId || `step_${idx + 1}`,
          capabilitySlug: it.capabilitySlug,
          endpointId: it.endpointId || it.capabilitySlug,
          method: it.method || it.tregMethod,
          params: it.params || {},
          targetVolumeMax: it.targetVolumeMax || targetVolumeMax,
          paginationStrategy: it.paginationStrategy || "none",
          unitPricePoints: it.unitPricePoints || unitPricePoints,
        }));
      }

      if (steps.length === 0) {
        steps = [
          {
            stepId: "step_1",
            capabilitySlug: templateSlug,
            endpointId: params.endpointId || (templateSlug === "tiktok-profile" ? "tikhub.tiktok.user.profile" : templateSlug),
            method: params.method || (templateSlug === "tiktok-profile" ? "GET" : undefined),
            params,
            targetVolumeMax,
            paginationStrategy: (params.paginationStrategy || (templateSlug === "tiktok-profile" ? "none" : "page")) as any,
            unitPricePoints,
          },
        ];
      }
    }

    const jobPointsCap = getConfiguredJobPointsCap();

    for (const step of steps) {
      if (collectedRows.length >= targetVolumeMax) break;

      let endpointId = step.endpointId;
      let stepMethod = step.method;
      if (!endpointId || endpointId === step.capabilitySlug) {
        if (step.capabilitySlug === "tiktok-profile") {
          endpointId = "tikhub.tiktok.user.profile";
          stepMethod = stepMethod || "GET";
        } else {
          try {
            const catMatches = await searchCatalog(step.capabilitySlug || "");
            if (catMatches.length > 0) {
              endpointId = catMatches[0].id || catMatches[0].slug;
              stepMethod = stepMethod || catMatches[0].method;
            }
          } catch {}
          endpointId = endpointId || step.capabilitySlug || "unknown";
        }
      }

      if (!stepMethod) {
        if (
          endpointId === "tikhub.tiktok.user.profile" ||
          endpointId.startsWith("scrapecreators.") ||
          endpointId.startsWith("tikhub.")
        ) {
          stepMethod = "GET";
        } else {
          stepMethod = "POST";
        }
      }

      const paginationStrategy = step.paginationStrategy || "none";
      const stepTargetVolume = step.targetVolumeMax || targetVolumeMax;
      const pageSize = Number(step.params?.limit || step.params?.count || step.params?.per_page || 20);

      let cursor: string | null = null;
      let offset = 0;
      let page = 1;
      const maxPagesPerStep = 50;

      while (collectedRows.length < targetVolumeMax && page <= maxPagesPerStep) {
        // Spend Cap Check before EVERY page call
        const currentChargeEstimate = Math.ceil(collectedRows.length * unitPricePoints);
        const remainingForStep = Math.max(1, stepTargetVolume - collectedRows.length);
        const estItemsThisPage = Math.min(pageSize, remainingForStep);
        const estPagePoints = pricingStrategyPointsEstimate(input.pricingUnit, estItemsThisPage, unitPricePoints);

        if (currentChargeEstimate + estPagePoints > reservedCredits || currentChargeEstimate + estPagePoints > jobPointsCap) {
          if (collectedRows.length === 0) {
            const errorAr = "الرصيد المحجوز غير كافٍ لمعالجة الدفعة الأولى من السجلات.";
            await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لعدم كفاية الرصيد للدفعة الأولى");
            await tables.updateRow({
              databaseId: "digr",
              tableId: "jobs",
              rowId: jobId,
              data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
            });
            await emitProgress(errorAr, 0, "error");
            return {
              success: false,
              jobId,
              status: "failed",
              deliveredUnits: 0,
              reservedCredits,
              chargedCredits: 0,
              refundCredits: reservedCredits,
              errorAr,
            };
          }
          await emitProgress("تم الوصول إلى سقف النقاط المحجوزة للطلب، تم إنهاء الجمع وحفظ السجلات المتاحة.", collectedRows.length, "info");
          break;
        }

        const spendCapCheck = await checkProviderDailySpendCap(0.01, tables);
        if (!spendCapCheck.allowed) {
          if (collectedRows.length === 0) {
            const errorAr = "تم بلوغ الحد اليومي لمزود البيانات ($0.80 USD). تم إيقاف الطلب واسترجاع الرصيد المحجوز.";
            await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع الرصيد لبلوغ الحد اليومي للمزود");
            await tables.updateRow({
              databaseId: "digr",
              tableId: "jobs",
              rowId: jobId,
              data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
            });
            await emitProgress(errorAr, 0, "error");
            return {
              success: false,
              jobId,
              status: "failed",
              deliveredUnits: 0,
              reservedCredits,
              chargedCredits: 0,
              refundCredits: reservedCredits,
              errorAr,
            };
          }
          await emitProgress("تم بلوغ الحد اليومي لمزود البيانات ($0.80 USD). تم حفظ السجلات المستخرجة.", collectedRows.length, "warning");
          break;
        }

        // Merge step.params with pagination params
        const pageParams: Record<string, any> = { ...(step.params || {}) };
        if (paginationStrategy === "cursor") {
          if (cursor) {
            pageParams.cursor = cursor;
            pageParams.next_cursor = cursor;
          }
        } else if (paginationStrategy === "offset") {
          pageParams.offset = offset;
          pageParams.limit = pageSize;
        } else if (paginationStrategy === "page") {
          pageParams.page = page;
          pageParams.limit = pageSize;
        }

        const callResult = await executeTregCallWithRetry({
          endpointId,
          method: stepMethod,
          params: pageParams,
          userId,
          jobId,
          stepId: step.stepId,
          page,
          routeMaxCostUsd: "0.05",
        });

        // Record call in job_calls collection
        try {
          await tables.createRow({
            databaseId: "digr",
            tableId: "job_calls",
            rowId: ID.unique(),
            data: {
              jobId,
              tregCallId: callResult.tregCallId || `treg_${Date.now()}`,
              endpointId,
              idemKey: `job_${jobId}_step_${step.stepId}_p${page}`,
              httpStatus: callResult.httpStatus,
              costMicro: callResult.costMicro || 0,
              cacheHit: false,
              fetchedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          });
        } catch {}

        if (callResult.costMicro) {
          totalCostMicro += callResult.costMicro;
          await recordProviderCallSpend(callResult.costMicro, tables);
          await logProviderCost(tables, { jobId, provider: "treg", units: 1, costUsd: callResult.costMicro / 1_000_000 });
        }

        if (!callResult.ok) {
          if (collectedRows.length === 0) {
            let errorAr = "تعذر استخراج البيانات من المصدر بعد عدة محاولات.";
            if (callResult.isRouteMaxCost) {
              errorAr = "تجاوز الطلب سقف التكلفة المسموح به للمصدر ($0.05).";
            } else if (callResult.isPlatformBalanceLow) {
              errorAr = "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
            } else if (callResult.httpStatus === 404) {
              errorAr = "الهدف المطلوب غير موجود أو محمي.";
            } else if (callResult.httpStatus === 422) {
              errorAr = callResult.detail
                ? `تعذر معالجة مدخلات الطلب لدى المزود (422): ${callResult.detail}`
                : "تعذر معالجة مدخلات الطلب لدى المزود (422).";
            } else if (callResult.httpStatus === 429) {
              errorAr = "المصدر مشغول حالياً (429 Rate Limit) بعد استنفاد محاولات الإعادة.";
            }

            await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لفشل الاستخراج من المصدر");
            await tables.updateRow({
              databaseId: "digr",
              tableId: "jobs",
              rowId: jobId,
              data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
            });
            await emitProgress(errorAr, 0, "error");
            return {
              success: false,
              jobId,
              status: "failed",
              deliveredUnits: 0,
              reservedCredits,
              chargedCredits: 0,
              refundCredits: reservedCredits,
              errorAr,
            };
          }
          // Failed page after collecting some rows: keep rows collected from earlier pages
          await emitProgress(`توقف المصدر مؤقتاً عند الصفحة ${page}. تم الاحتفاظ بـ ${collectedRows.length} سجل مجمع.`, collectedRows.length, "warning");
          break;
        }

        const newRows = extractAndFlattenRows(callResult.data);
        if (newRows.length === 0) {
          break;
        }

        collectedRows.push(...newRows);
        await emitProgress(`تم جمع ${collectedRows.length} سجل حتى الآن...`, collectedRows.length, "progress");

        if (paginationStrategy === "cursor") {
          const nextCur =
            callResult.data?.next_cursor ||
            callResult.data?.cursor ||
            callResult.data?.nextCursor ||
            callResult.data?.pagination?.next_cursor ||
            callResult.data?.meta?.next_cursor ||
            callResult.data?.next_max_id;

          if (!nextCur || nextCur === cursor) break;
          cursor = String(nextCur);
          page++;
        } else if (paginationStrategy === "offset") {
          offset += newRows.length;
          if (newRows.length < pageSize) break;
          page++;
        } else if (paginationStrategy === "page") {
          page++;
          if (newRows.length < pageSize) break;
        } else {
          break; // strategy === "none"
        }

        if (collectedRows.length >= stepTargetVolume) break;
      }
    }
  }

  if (collectedRows.length === 0) {
    const errorAr = "لم يُعثر على أي بيانات مطابقة من المصدر.";
    await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لعدم وجود بيانات");
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
    });
    await emitProgress(errorAr, 0, "error");
    return {
      success: false,
      jobId,
      status: "failed",
      deliveredUnits: 0,
      reservedCredits,
      chargedCredits: 0,
      refundCredits: reservedCredits,
      errorAr,
    };
  }

  // Refuse placeholder data
  const hasPlaceholder = collectedRows.some((r) => {
    const s = JSON.stringify(r);
    return s.includes("Record 1 for") || s.includes("placeholder");
  });

  if (hasPlaceholder) {
    const errorAr = "تم رصد سجلات غير حقيقية أو تجريبية. تم إلغاء الطلب واسترجاع كامل الرصيد تلقائياً.";
    await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لرصد سجلات تجريبية");
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
    });
    await emitProgress(errorAr, 0, "error");
    return {
      success: false,
      jobId,
      status: "failed",
      deliveredUnits: 0,
      reservedCredits,
      chargedCredits: 0,
      refundCredits: reservedCredits,
      errorAr,
    };
  }

  const deliveredUnits = Math.min(collectedRows.length, targetVolumeMax);

  // Settlement: charge = ceil(deliveredUnits * unitPricePoints)
  const settlement = calculateFinalSettlement(deliveredUnits, unitPricePoints, reservedCredits);
  const chargedCredits = settlement.chargePoints;
  const refundCredits = settlement.refundPoints;

  // Release-first completion order (rel_ first then chg_)
  await completeJobWithRelFirst(
    tables,
    userId,
    jobId,
    reservedCredits,
    chargedCredits,
    isCancelled ? "تسوية طلب ملغى جزئياً" : "تسوية واكتمال استخراج البيانات"
  );

  // Artifact generation
  const dateStr = new Date().toISOString().slice(0, 10);
  const finalPayload: any = {
    metadata: {
      platform: "Diger Data Platform",
      company: "Diger",
      title: `نتائج استخراج ${templateSlug}`,
      template: templateSlug,
      jobId,
      collectedAt: new Date().toISOString(),
      rowsCount: deliveredUnits,
      methodology: `تم استخراج ${deliveredUnits} سجل بنجاح بتاريخ ${dateStr}. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`,
    },
    rows: collectedRows.slice(0, deliveredUnits),
  };

  const xlsxFileId = `xlsx_${jobId}`;
  const pdfFileId = `pdf_${jobId}`;
  const csvFileId = `csv_${jobId}`;
  const methodologyFileId = `methodology_${jobId}`;
  const jsonFileId = `json_${jobId}`;

  if (storage) {
    try {
      const [xlsxBuf, pdfBuf, csvBuf] = await Promise.all([
        generateExcelReport(finalPayload),
        generatePdfReport(finalPayload),
        Promise.resolve(generateCsvReport(finalPayload)),
      ]);
      const methodologyText = generateMethodologyText(finalPayload);

      const permissions = [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))];

      for (const fid of [xlsxFileId, pdfFileId, csvFileId, methodologyFileId]) {
        try {
          await storage.deleteFile("results", fid);
        } catch {}
      }
      try {
        await storage.deleteFile("job_data", jsonFileId);
      } catch {}

      await Promise.all([
        storage.createFile(
          "results",
          xlsxFileId,
          new File([new Uint8Array(xlsxBuf)], `diger_${templateSlug}_${jobId}.xlsx`, {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          permissions
        ),
        storage.createFile(
          "results",
          pdfFileId,
          new File([new Uint8Array(pdfBuf)], `diger_${templateSlug}_${jobId}.pdf`, {
            type: "application/pdf",
          }),
          permissions
        ),
        storage.createFile(
          "results",
          csvFileId,
          new File([new Uint8Array(csvBuf)], `diger_${templateSlug}_${jobId}.csv`, {
            type: "text/csv; charset=utf-8",
          }),
          permissions
        ),
        storage.createFile(
          "results",
          methodologyFileId,
          new File([new Uint8Array(Buffer.from(methodologyText, "utf-8"))], `methodology_${jobId}.txt`, {
            type: "text/plain; charset=utf-8",
          }),
          permissions
        ),
        storage.createFile(
          "job_data",
          jsonFileId,
          new File([new Uint8Array(Buffer.from(JSON.stringify(finalPayload, null, 2)))], `diger_${templateSlug}_${jobId}.json`, {
            type: "application/json",
          }),
          []
        ),
      ]);
    } catch (storageErr: any) {
      console.warn("Storage upload warning:", storageErr.message);
    }
  }

  // Record jobs_internal
  try {
    const marginEgp = chargedCredits * 0.1 - (totalCostMicro / 1_000_000) * 50;
    const internalDoc = {
      jobId,
      actualCostMicro: totalCostMicro,
      revenueCredits: chargedCredits,
      marginEgp,
      dataSource: isLive ? "live" : "fake",
    };

    const existingInternal = await tables.listRows({
      databaseId: "digr",
      tableId: "jobs_internal",
      queries: [Query.equal("jobId", jobId), Query.limit(1)],
    });

    if (existingInternal.rows.length > 0) {
      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs_internal",
        rowId: existingInternal.rows[0].$id,
        data: internalDoc,
      });
    } else {
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs_internal",
        rowId: ID.unique(),
        data: internalDoc,
      });
    }
  } catch (intErr: any) {
    console.warn("Failed to record jobs_internal:", intErr.message);
  }

  // Update Job Document to status: 'done'
  const finalStatus = isCancelled ? "cancelled" : "done";
  try {
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: {
        status: finalStatus,
        chargedCredits,
        rowsCollected: deliveredUnits,
        resultFileId: xlsxFileId,
        finishedAt: new Date().toISOString(),
      },
    });
  } catch {}

  await emitProgress(
    `تم اكتمال جمع البيانات بنجاح (${deliveredUnits} سجل). التكلفة الفعلية: ${chargedCredits} نقطة، وتم استرداد ${refundCredits} نقطة لمحافظتك.`,
    deliveredUnits,
    "info"
  );

  return {
    success: true,
    jobId,
    status: finalStatus,
    deliveredUnits,
    reservedCredits,
    chargedCredits,
    refundCredits,
    resultFiles: {
      xlsxFileId,
      pdfFileId,
      csvFileId,
      methodologyFileId,
      jsonFileId,
    },
  };
}

function pricingStrategyPointsEstimate(
  pricingUnit: "call" | "item" | "page" | undefined,
  pageSize: number,
  unitPricePoints: number
): number {
  if (pricingUnit === "page" || pricingUnit === "call") {
    return unitPricePoints;
  }
  return Math.ceil(pageSize * unitPricePoints);
}

/**
 * Watchdog Function: identifies stale or crashed jobs older than threshold (30 mins),
 * fails them cleanly and releases their full reserved points back to the user idempotently.
 */
export async function runJobWatchdog(
  tables: TablesDB,
  timeoutMinutes: number = 30
): Promise<{ recoveredCount: number; jobIds: string[]; skippedIds: string[] }> {
  const timeoutThresholdMs = Date.now() - timeoutMinutes * 60 * 1000;
  const timeoutThreshold = new Date(timeoutThresholdMs).toISOString();

  const staleJobsRes = await tables.listRows({
    databaseId: "digr",
    tableId: "jobs",
    queries: [
      Query.equal("status", ["running", "queued"]),
      Query.lessThan("createdAt", timeoutThreshold),
    ],
  });

  const recoveredIds: string[] = [];
  const skippedIds: string[] = [];

  for (const job of staleJobsRes.rows as any[]) {
    if (job.status !== "running" && job.status !== "queued") {
      skippedIds.push(job.$id);
      continue;
    }
    const jobCreatedMs = job.createdAt ? new Date(job.createdAt).getTime() : 0;
    if (jobCreatedMs > timeoutThresholdMs) {
      continue;
    }

    try {
      const releaseRes = await releaseReservation(
        tables,
        job.userId,
        job.$id,
        job.reservedCredits,
        "إلغاء حجز الرصيد لتأخر تنفيذ الطلب واسترجاع كامل النقاط"
      );

      if (releaseRes.alreadyReleased) {
        skippedIds.push(job.$id);
        continue;
      }

      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: job.$id,
        data: {
          status: "failed",
          errorAr: "تم إنهاء الطلب تلقائياً لتجاوز المهلة الزمنية المحددة للمعالجة.",
          finishedAt: new Date().toISOString(),
        },
      });

      await tables.createRow({
        databaseId: "digr",
        tableId: "job_events",
        rowId: ID.unique(),
        data: {
          jobId: job.$id,
          textAr: "انتهت مهلة استخراج البيانات وتوقف الطلب، وتمت استعادة كامل الرصيد المحجوز.",
          count: 0,
          kind: "error",
          createdAt: new Date().toISOString(),
        },
        permissions: [Permission.read(Role.user(job.userId)), Permission.read(Role.label("admin"))],
      });

      recoveredIds.push(job.$id);
    } catch (err: any) {
      console.error(`Watchdog recovery error on job ${job.$id}:`, err.message);
    }
  }

  return {
    recoveredCount: recoveredIds.length,
    jobIds: recoveredIds,
    skippedIds,
  };
}

export interface StuckJobReportItem {
  jobId: string;
  status: string;
  ageMinutes: number;
  reservedCredits: number;
  alreadyReleased: boolean;
}

/**
 * Read-only report mode: lists stuck jobs (IDs and ages only, no PII) and how to release them safely.
 * Performs ZERO writes.
 */
export async function reportStuckJobsReadOnly(
  tables: TablesDB,
  timeoutMinutes: number = 30
): Promise<{
  stuckCount: number;
  stuckJobs: StuckJobReportItem[];
  safeReleaseStepsAr: string[];
}> {
  const nowMs = Date.now();
  const timeoutThreshold = new Date(nowMs - timeoutMinutes * 60 * 1000).toISOString();

  const staleJobsRes = await tables.listRows({
    databaseId: "digr",
    tableId: "jobs",
    queries: [
      Query.equal("status", ["running", "queued"]),
      Query.lessThan("createdAt", timeoutThreshold),
    ],
  });

  const stuckJobs: StuckJobReportItem[] = [];

  for (const job of staleJobsRes.rows as any[]) {
    if (job.status !== "running" && job.status !== "queued") continue;
    const createdMs = job.createdAt ? new Date(job.createdAt).getTime() : nowMs;
    const ageMinutes = Math.floor((nowMs - createdMs) / 60000);
    if (ageMinutes < timeoutMinutes) continue;

    let alreadyReleased = false;
    try {
      await tables.getRow({
        databaseId: "digr",
        tableId: "credit_ledger",
        rowId: `rel_${job.$id}`,
      });
      alreadyReleased = true;
    } catch {
      alreadyReleased = false;
    }

    stuckJobs.push({
      jobId: String(job.$id),
      status: String(job.status),
      ageMinutes,
      reservedCredits: Number(job.reservedCredits || 0),
      alreadyReleased,
    });
  }

  return {
    stuckCount: stuckJobs.length,
    stuckJobs,
    safeReleaseStepsAr: [
      "1. افتح لوحة تحكم Supabase -> Table Editor -> jobs وحدد معرّف الطلب العالق (jobId).",
      "2. في جدول credit_ledger تأكد من عدم وجود صف بمعرّف rel_<jobId>، ثم أنشئ صفًا بمعرّف مستند مخصص (Custom Document ID) يساوي rel_<jobId> بالقيم: type='release'، delta=+5 (موجب قيمة reservedCredits)، userId=<نفس userId للطلب>، jobId=<jobId>.",
      "3. في جدول jobs حدّث حالة الطلب إلى status='failed' وerrorAr='تم إلغاء الطلب واسترجاع النقاط المحجوزة' (أو شغّل دالة job-worker بـ {\"mode\":\"watchdog\"} لتنفيذ الخطوتين تلقائيًا بأمان).",
    ],
  };
}
