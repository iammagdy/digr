import { TablesDB, Storage, Permission, Role, ID, Query } from "node-appwrite";
import { completeJobWithRelFirst, releaseCredits } from "./ledger";
import { calculateFinalSettlement } from "./quotes";
import {
  generateExcelReport,
  generatePdfReport,
  generateCsvReport,
} from "./fileGenerators";
import { executeTregCall } from "./tregClient";
import { parseStoredPlan } from "./planManager";
import {
  buildFallbackReview,
  buildNormalizedRequestSpec,
  computeRunFacts,
  parseNormalizedRequestSpec,
  type NormalizedRequestSpec,
} from "./resultReview";
import { LlmClient } from "./llmClient";
import { recordInitialArtifactVersion } from "./artifactVersions";
import { applyGoodwillOutcome } from "./goodwillRefund";

export interface WorkerStepInput {
  jobId: string;
  targetVolumeMax: number;
  unitPricePoints: number;
  reservedCredits: number;
  userId: string;
  conversationId?: string;
  templateSlug: string;
  params: Record<string, any>;
  pricingUnit?: "call" | "item" | "page";
  fetchPageFn?: (cursor: string | null, page: number) => Promise<PageFetchResult>;
  isTestMode?: boolean;
  requestSpec?: NormalizedRequestSpec;
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
  goodwillRefund?: { points: number; reasonAr?: string } | null;
  resultFiles?: {
    xlsxFileId: string;
    pdfFileId: string;
    csvFileId: string;
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
 * Generalized multi-step worker with strict no-fake guards, live TREG execution,
 * release-first settlement, and comprehensive artifact generation (Excel, PDF, CSV, JSON).
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

  // 1. Mark Job as running
  await tables.updateRow({
    databaseId: "digr",
    tableId: "jobs",
    rowId: jobId,
    data: { status: "running" },
  });

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

  await emitProgress("جاري الاتصال بمصدر البيانات والتحقق من الحساب...", 0, "progress");

  let collectedRows: any[] = [];
  let profileData: any = null;
  let totalCostMicro = 0;
  let isCancelled = false;

  // 2. Handle TikTok Profile Live Call
  if (templateSlug === "tiktok-profile" && !fetchPageFn) {
    const cleanUsername = String(params.username || "").replace(/^@/, "").trim();
    if (!cleanUsername) {
      const errorAr = "اسم المستخدم للحساب المطلوب غير محدد.";
      await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لعدم تحديد الحساب");
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

    await emitProgress(`جاري جلب بيانات الحساب @${cleanUsername} من المصدر...`, 0, "progress");

    // Execute real TREG API call with strict $0.01 route cost cap
    const callResult = await executeTregCall({
      endpointId: "tikhub.tiktok.user.profile",
      method: "GET",
      params: { username: cleanUsername },
      userId,
      jobId,
      routeMaxCostUsd: "0.01",
    });

    totalCostMicro = callResult.costMicro || 0;

    // Record upstream call in server-only job_calls collection
    try {
      await tables.createRow({
        databaseId: "digr",
        tableId: "job_calls",
        rowId: ID.unique(),
        data: {
          jobId,
          tregCallId: callResult.tregCallId || `treg_${Date.now()}`,
          endpointId: "tikhub.tiktok.user.profile",
          idemKey: `idem_${jobId}`,
          httpStatus: callResult.httpStatus,
          costMicro: totalCostMicro,
          cacheHit: false,
          fetchedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      });
    } catch (callErr: any) {
      console.warn("Failed to record job_call:", callErr.message);
    }

    if (!callResult.ok) {
      let errorAr = "تعذر استخراج بيانات الحساب من المصدر.";
      if (callResult.isRouteMaxCost) {
        errorAr = "تجاوز الطلب سقف التكلفة المسموح به للمصدر ($0.01).";
      } else if (callResult.isPlatformBalanceLow) {
        errorAr = "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
      } else if (callResult.httpStatus === 404) {
        errorAr = `الحساب @${cleanUsername} غير موجود أو أنه حساب خاص.`;
      } else if (callResult.errorDetails) {
        errorAr = `خطأ في استجابة المصدر: ${callResult.errorDetails}`;
      }

      await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لفشل الاستدعاء");
      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: { status: "failed", errorAr, finishedAt: new Date().toISOString() },
      });
      await emitProgress(errorAr, 0, "error");

      // Record in jobs_internal
      try {
        await tables.createRow({
          databaseId: "digr",
          tableId: "jobs_internal",
          rowId: ID.unique(),
          data: {
            jobId,
            actualCostMicro: totalCostMicro,
            revenueCredits: 0,
            marginEgp: -(totalCostMicro / 1_000_000 * 50),
            dataSource: "live",
          },
        });
      } catch {}

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

    // Parse profile
    profileData = parseTikTokProfileResponse(callResult.data, cleanUsername);
    if (!profileData || (!profileData.uniqueId && !profileData.nickname)) {
      const errorAr = `لم يتم العثور على بيانات عامة للحساب @${cleanUsername}. قد يكون الحساب مغلقاً أو محذوفاً.`;
      await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لعدم وجود بيانات للحساب");
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

    // Create single structured row
    collectedRows = [
      {
        id: profileData.id,
        username: `@${profileData.uniqueId}`,
        displayName: profileData.nickname,
        bio: profileData.signature,
        verified: profileData.verified ? "نعم" : "لا",
        followers: profileData.followerCount,
        following: profileData.followingCount,
        likes: profileData.heartCount,
        videosCount: profileData.videoCount,
        bioLink: profileData.bioLink,
        profileUrl: profileData.profileUrl,
        collectedDate: profileData.collectedDate,
      },
    ];
  } else if (fetchPageFn) {
    // Pagination loop for custom/tested fetchPageFn
    let cursor: string | null = null;
    let page = 1;

    while (collectedRows.length < targetVolumeMax) {
      // Check if job was cancelled externally mid-run
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
      } catch {
        // Continue if job document read fails
      }

      let pageResult = await fetchPageFn(cursor, page);

      // Rate limit retry logic: if 429, retry once with backoff
      if (!pageResult.ok && (pageResult.httpStatus === 429 || pageResult.errorType === "rate_limit")) {
        await emitProgress("تم رصد ضغط مؤقت في المصدر. جاري إعادة المحاولة...", collectedRows.length, "info");
        await new Promise((r) => setTimeout(r, 100)); // Short backoff
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
      await emitProgress(`تم جمع ${collectedRows.length} سجل من أصل ${targetVolumeMax}...`, collectedRows.length, "progress");

      if (!pageResult.nextCursor) break;
      cursor = pageResult.nextCursor;
      page++;
    }
  } else {
    // No fetchPageFn and capability is not implemented
    const errorAr = `خدمة ${templateSlug} قيد التفعيل ولا يتوفر لها مزود بيانات نشط حالياً.`;
    await releaseCredits(tables, userId, jobId, reservedCredits, "استرجاع كامل الرصيد لعدم توفر الخدمة");
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

  // STRICT GUARD 2: Refuse any row containing placeholder text
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
  const deliveredRows = collectedRows.slice(0, deliveredUnits);

  let requestSpec = parseNormalizedRequestSpec(input.requestSpec) || undefined;
  if (!requestSpec) {
    try {
      const quoteRows = await tables.listRows({
        databaseId: "digr",
        tableId: "plans_quotes",
        queries: [Query.equal("jobId", jobId), Query.limit(1)],
      });
      if (quoteRows.rows.length) {
        const storedPlan = parseStoredPlan(quoteRows.rows[0].itemsJson);
        requestSpec = parseNormalizedRequestSpec(storedPlan.requestSpec) || buildNormalizedRequestSpec(storedPlan);
      }
    } catch {
      console.warn("[result-review:REQUEST_SPEC_UNAVAILABLE]");
    }
  }
  requestSpec ||= buildNormalizedRequestSpec({
    items: [{ capabilitySlug: templateSlug, params, targetVolumeMin: 1, targetVolumeMax }],
    outputFormats: ["xlsx", "pdf", "csv"],
  });
  const runFacts = computeRunFacts(requestSpec, deliveredRows);
  let review = buildFallbackReview(runFacts, requestSpec);
  if (process.env.RESULT_REVIEW_MODEL_ENABLED === "true") {
    try { review = (await new LlmClient().reviewResult(runFacts)) || review; }
    catch { console.warn("[result-review:MODEL_FALLBACK]"); }
  }

  // 3. Exact Settlement Formula: charge = ceil(deliveredUnits * unitPricePoints)
  const settlement = calculateFinalSettlement(deliveredUnits, unitPricePoints, reservedCredits);
  const chargedCredits = settlement.chargePoints;
  const refundCredits = settlement.refundPoints;

  // 4. Release-First Completion Sequence in Ledger
  const settlementResult = await completeJobWithRelFirst(
    tables,
    userId,
    jobId,
    reservedCredits,
    chargedCredits,
    isCancelled ? "تسوية طلب ملغى جزئياً" : "تسوية واكتمال استخراج البيانات"
  );
  const goodwillOutcome = settlementResult.charged
    ? await applyGoodwillOutcome(tables, { userId, jobId, conversationId: input.conversationId, chargedPoints: chargedCredits, facts: runFacts }).catch(() => {
        console.warn("[goodwill:OPTIONAL_SIDE_EFFECT_FAILED]");
        return { status: "unavailable" as const, points: 0, reasonAr: undefined };
      })
    : { status: "no_refund" as const, points: 0 };

  // 5. Generate and Store Output Files (Excel, PDF, CSV, JSON)
  const dateStr = new Date().toISOString().slice(0, 10);
  const finalPayload: any = {
    metadata: {
      platform: "Digr Data Platform",
      company: "Digr",
      title: profileData
        ? `نتائج استخراج ملف تيك توك الشخصي (${profileData.nickname})`
        : `نتائج استخراج ${templateSlug}`,
      template: templateSlug,
      jobId,
      collectedAt: new Date().toISOString(),
      rowsCount: deliveredUnits,
      methodology: profileData
        ? `تم استخراج بيانات الحساب العام @${profileData.uniqueId} بنجاح بتاريخ ${dateStr} من المصدر الرسمي. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`
        : `تم استخراج ${deliveredUnits} سجل بنجاح بتاريخ ${dateStr}. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`,
    },
    rows: deliveredRows,
    ...(process.env.RESULT_REVIEW_STORAGE_ENABLED === "false" ? {} : {
      requestSpec,
      runFacts,
      review,
    }),
  };

  if (profileData) {
    finalPayload.profile = profileData;
  }

  const xlsxFileId = `xlsx_${jobId}`;
  const pdfFileId = `pdf_${jobId}`;
  const csvFileId = `csv_${jobId}`;
  const jsonFileId = `json_${jobId}`;

  if (storage) {
    try {
      const [xlsxBuf, pdfBuf, csvBuf] = await Promise.all([
        generateExcelReport(finalPayload),
        generatePdfReport(finalPayload),
        Promise.resolve(generateCsvReport(finalPayload)),
      ]);

      const permissions = [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))];

      // Safe idempotent deletion of existing file IDs before upload
      for (const fid of [xlsxFileId, pdfFileId, csvFileId]) {
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
          new File([new Uint8Array(xlsxBuf)], `digr_${templateSlug}_${jobId}.xlsx`, {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          permissions
        ),
        storage.createFile(
          "results",
          pdfFileId,
          new File([new Uint8Array(pdfBuf)], `digr_${templateSlug}_${jobId}.pdf`, {
            type: "application/pdf",
          }),
          permissions
        ),
        storage.createFile(
          "results",
          csvFileId,
          new File([new Uint8Array(csvBuf)], `digr_${templateSlug}_${jobId}.csv`, {
            type: "text/csv; charset=utf-8",
          }),
          permissions
        ),
        storage.createFile(
          "job_data",
          jsonFileId,
          new File([new Uint8Array(Buffer.from(JSON.stringify(finalPayload, null, 2)))], `digr_${templateSlug}_${jobId}.json`, {
            type: "application/json",
          }),
          [] // server-only: no client permissions
        ),
      ]);
      if (input.conversationId) {
        await recordInitialArtifactVersion(tables, {
          userId,
          conversationId: input.conversationId,
          jobId,
          rowCount: deliveredUnits,
          fileIds: { xlsx: xlsxFileId, pdf: pdfFileId, csv: csvFileId },
          snapshotFileId: jsonFileId,
        });
      }
    } catch (storageErr: any) {
      console.warn("[result-review:STORAGE_UNAVAILABLE]");
    }
  }

  // 6. Record server-only jobs_internal data
  try {
    const marginEgp = (chargedCredits * 0.1) - (totalCostMicro / 1_000_000 * 50);
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

  // 7. Update Job Document to status: 'done'
  const finalStatus = isCancelled ? "cancelled" : "done";
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

  await emitProgress(
    `تم اكتمال جمع البيانات بنجاح (${deliveredUnits} سجل). التكلفة الفعلية: ${chargedCredits} نقطة، واستُرد ${refundCredits} نقطة من الحجز${goodwillOutcome.points ? `، وأُضيف رد حسن نية قدره ${goodwillOutcome.points} نقطة` : ""}.`,
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
    goodwillRefund: goodwillOutcome.points ? { points: goodwillOutcome.points, reasonAr: goodwillOutcome.reasonAr } : null,
    resultFiles: {
      xlsxFileId,
      pdfFileId,
      csvFileId,
      jsonFileId,
    },
  };
}

/**
 * Watchdog Function: identifies stale or crashed jobs older than threshold (30 mins),
 * fails them cleanly and releases their full reserved points back to the user.
 */
export async function runJobWatchdog(
  tables: TablesDB,
  timeoutMinutes: number = 30
): Promise<{ recoveredCount: number; jobIds: string[] }> {
  const timeoutThreshold = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const staleJobsRes = await tables.listRows({
    databaseId: "digr",
    tableId: "jobs",
    queries: [
      Query.equal("status", ["running", "queued"]),
      Query.lessThan("createdAt", timeoutThreshold),
    ],
  });

  const recoveredIds: string[] = [];

  for (const job of staleJobsRes.rows as any[]) {
    try {
      await releaseCredits(
        tables,
        job.userId,
        job.$id,
        job.reservedCredits,
        "إلغاء حجز الرصيد لتجاوز مهلة معالجة الطلب (Watchdog Recovery)"
      );

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
  };
}
