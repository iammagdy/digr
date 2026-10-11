import { Client, TablesDB, Storage, Permission, Role, ID } from "node-appwrite";
import { z } from "zod";
import {
  completeJobWithRelFirst,
  releaseReservation,
} from "../../shared/ledger";
import {
  runJobWatchdog,
  reportStuckJobsReadOnly,
} from "../../shared/multiStepWorker";
import { executeTregCall } from "../../shared/tregClient";
import {
  generateExcelReport,
  generatePdfReport,
  generateCsvReport,
} from "../../shared/fileGenerators";

const workerPayloadSchema = z.object({
  jobId: z.string().min(1),
});

export default async ({ req, res, log, error }: any) => {
  const apiKey =
    req.headers?.["x-appwrite-key"] ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(apiKey);

  const tables = new TablesDB(client);
  const storage = new Storage(client);

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const triggerType = req.headers?.["x-appwrite-trigger"];

    // Read-only report mode: lists stuck jobs (IDs and ages only) and safe release steps without writing to DB
    if (rawBody?.mode === "report_stuck") {
      const timeoutMinutes = Number(rawBody?.timeoutMinutes) || 30;
      const report = await reportStuckJobsReadOnly(tables, timeoutMinutes);
      return res.json({ success: true, mode: "report_stuck", ...report }, 200);
    }

    // Scheduled watchdog mode: runs every 10 minutes via Appwrite schedule trigger or explicit {"mode":"watchdog"}
    if (triggerType === "schedule" || rawBody?.mode === "watchdog") {
      const timeoutMinutes = Number(rawBody?.timeoutMinutes) || 30;
      log(`[job-worker] Running scheduled watchdog (timeout=${timeoutMinutes}m)`);
      const watchdogResult = await runJobWatchdog(tables, timeoutMinutes);
      return res.json({ success: true, mode: "watchdog", ...watchdogResult }, 200);
    }

    const validated = workerPayloadSchema.parse(rawBody);
    const { jobId } = validated;

    log(`[job-worker] Starting worker for job ${jobId}`);

    // 1. Fetch Job from database first so we can always release its reservation if execution is refused
    let job: any;
    try {
      job = await tables.getRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
      });
    } catch {
      return res.json({ success: false, error: `Job ${jobId} not found` }, 404);
    }

    // Guard: Prevent double-running finished jobs; if already failed, ensure hold is released idempotently
    if (job.status === "done" || job.status === "cancelled") {
      log(`[job-worker] Job ${jobId} is already ${job.status}. Skipping.`);
      return res.json({ success: true, message: `Job already ${job.status}` }, 200);
    }
    if (job.status === "failed") {
      const relCheck = await releaseReservation(
        tables,
        job.userId,
        jobId,
        job.reservedCredits,
        "تأكيد استرجاع الرصيد المحجوز لطلب متعثر"
      );
      log(`[job-worker] Job ${jobId} is already failed (alreadyReleased=${relCheck.alreadyReleased}).`);
      return res.json({
        success: true,
        message: "Job already failed",
        released: relCheck.released,
        alreadyReleased: relCheck.alreadyReleased,
      }, 200);
    }

    // Helper: Refuse execution cleanly by releasing reservation idempotently and marking job failed in Arabic
    const failAndReleaseRefusal = async (reasonAr: string, ledgerNoteAr: string) => {
      const releaseResult = await releaseReservation(
        tables,
        job.userId,
        jobId,
        job.reservedCredits,
        ledgerNoteAr
      );
      const nowFailed = new Date().toISOString();
      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          status: "failed",
          errorAr: reasonAr,
          finishedAt: nowFailed,
        },
      });
      await tables.createRow({
        databaseId: "digr",
        tableId: "job_events",
        rowId: ID.unique(),
        data: {
          jobId,
          textAr: reasonAr,
          count: 0,
          kind: "error",
          createdAt: nowFailed,
        },
        permissions: [
          Permission.read(Role.user(job.userId)),
          Permission.read(Role.label("admin")),
        ],
      });
      return res.json(
        {
          success: false,
          jobId,
          status: "failed",
          released: releaseResult.released,
          alreadyReleased: releaseResult.alreadyReleased,
          error: reasonAr,
        },
        200
      );
    };

    // Verify TREG_LIVE is enabled; if not, release reservation idempotently and fail job instead of leaving hold stuck
    if (process.env.TREG_LIVE !== "true") {
      log(`[job-worker] TREG_LIVE is not enabled on this worker. Releasing reservation for job ${jobId}.`);
      return await failAndReleaseRefusal(
        "الخدمة غير مفعلة حاليًا على الخادم. تم استرجاع كامل الرصيد المحجوز إلى محفظتك.",
        "استرجاع الرصيد المحجوز لعدم تفعيل الاتصال المباشر بمصدر البيانات"
      );
    }

    // 2. Fetch private template settings & internal margins before marking running
    let tmplPriv: any;
    try {
      tmplPriv = await tables.getRow({
        databaseId: "digr",
        tableId: "templates_private",
        rowId: job.templateSlug,
      });
    } catch {
      tmplPriv = null;
    }

    if (!tmplPriv || !tmplPriv.tregEndpointId) {
      log(`[job-worker] Missing or unverified template config for ${job.templateSlug}. Releasing reservation.`);
      return await failAndReleaseRefusal(
        "هذه المنصة قيد التجهيز وغير متاحة للتشغيل الآن. تم استرجاع كامل الرصيد المحجوز إلى محفظتك.",
        "استرجاع الرصيد المحجوز لعدم اكتمال إعدادات المنصة المطلوبة"
      );
    }

    // 3. Mark job as running
    const nowStart = new Date().toISOString();
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: { status: "running" },
    });

    await tables.createRow({
      databaseId: "digr",
      tableId: "job_events",
      rowId: ID.unique(),
      data: {
        jobId,
        textAr: "جاري الاتصال بمصدر البيانات واستخراج السجلات...",
        count: 0,
        kind: "progress",
        createdAt: nowStart,
      },
      permissions: [
        Permission.read(Role.user(job.userId)),
        Permission.read(Role.label("admin")),
      ],
    });

    const settings: any = await tables.getRow({
      databaseId: "digr",
      tableId: "settings",
      rowId: "pricing",
    });

    const settingsPub: any = await tables.getRow({
      databaseId: "digr",
      tableId: "settings_public",
      rowId: "pricing",
    });

    // 4. Execute upstream TREG call
    const params = typeof job.params === "string" ? JSON.parse(job.params || "{}") : job.params;
    log(`[job-worker] Calling TREG endpoint ${tmplPriv.tregEndpointId} with cap 0.05 USD`);

    const tregResult = await executeTregCall({
      endpointId: tmplPriv.tregEndpointId,
      method: tmplPriv.tregMethod,
      params,
      userId: job.userId,
      jobId,
      routeMaxCostUsd: "0.05",
    });

    // 5. Record call in job_calls (server-only)
    const callRowId = ID.unique();
    await tables.createRow({
      databaseId: "digr",
      tableId: "job_calls",
      rowId: callRowId,
      data: {
        jobId,
        tregCallId: tregResult.tregCallId,
        endpointId: tmplPriv.tregEndpointId,
        idemKey: `idem_${jobId}`,
        httpStatus: tregResult.httpStatus,
        costMicro: tregResult.costMicro,
        cacheHit: false,
        createdAt: new Date().toISOString(),
      },
    });
    log(`[job-worker] Saved job_calls/${callRowId} (status: ${tregResult.httpStatus}, cost: ${tregResult.costMicro} microUSD)`);

    // 6. Handle Call Failure
    if (!tregResult.ok) {
      let failureNoticeAr = "تعذر استخراج البيانات من المصدر";
      if (tregResult.isRouteMaxCost) {
        failureNoticeAr = "تجاوز الطلب الحد الأقصى للتكلفة المسموح بها من المصدر";
      } else if (tregResult.isPlatformBalanceLow) {
        failureNoticeAr = "الخدمة غير متاحة مؤقتًا، يرجى المحاولة لاحقًا";
      } else if (tregResult.errorDetails) {
        failureNoticeAr = `فشل الطلب: ${tregResult.errorDetails}`;
      }

      log(`[job-worker] Job ${jobId} failed: ${failureNoticeAr}`);

      // Release reserved credits idempotently
      await releaseReservation(tables, job.userId, jobId, job.reservedCredits, "استرجاع الرصيد لفشل استخراج البيانات");

      // Update job to failed
      await tables.updateRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          status: "failed",
          errorAr: failureNoticeAr,
          finishedAt: new Date().toISOString(),
        },
      });

      // Add failure event
      await tables.createRow({
        databaseId: "digr",
        tableId: "job_events",
        rowId: ID.unique(),
        data: {
          jobId,
          textAr: failureNoticeAr,
          count: 0,
          kind: "error",
          createdAt: new Date().toISOString(),
        },
        permissions: [
          Permission.read(Role.user(job.userId)),
          Permission.read(Role.label("admin")),
        ],
      });

      return res.json({ success: false, error: failureNoticeAr }, 200);
    }

    // 7. Handle Call Success
    log(`[job-worker] TREG call succeeded for job ${jobId}. Generating white-label result file...`);

    // Prepare white-label result file
    const dateStr = new Date().toISOString().slice(0, 10);

    let profileData: any = undefined;
    if (job.templateSlug === "tiktok-profile") {
      const userInfo = tregResult.data?.data?.userInfo;
      const u = userInfo?.user || tregResult.data?.data?.user || {};
      const s = userInfo?.stats || tregResult.data?.data?.stats || {};
      const s2 = userInfo?.statsV2 || {};
      profileData = {
        uniqueId: u.uniqueId || "",
        nickname: u.nickname || "",
        signature: u.signature || "",
        verified: Boolean(u.verified),
        secUid: u.secUid || "",
        followerCount: Number(s2.followerCount || s.followerCount || 0),
        followingCount: Number(s2.followingCount || s.followingCount || 0),
        heartCount: Number(s2.heartCount || s.heartCount || 0),
        videoCount: Number(s2.videoCount || s.videoCount || 0),
        avatarUrl: u.avatarLarger || u.avatarMedium || u.avatarThumb || "",
        bioLink: u.bioLink?.link || "",
      };
    }

    const cleanData = tregResult.data?.data || tregResult.data;
    const resultPayload = {
      metadata: {
        platform: "Digr Data Platform",
        company: "Digr",
        title: "مجموعة بيانات Digr",
        template: job.templateSlug,
        jobId,
        collectedAt: new Date().toISOString(),
        rowsCount: 1,
        methodology: `تم استخراج البيانات من مصدر عام متاح للجمهور بتاريخ ${dateStr}. إجمالي السجلات: 1. ملاحظة منهجية: هذه البيانات عامة ومتاحة علنًا، ولا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.`,
      },
      ...(profileData ? { profile: profileData } : {}),
      data: cleanData,
    };

    // Generate Excel, PDF, and CSV reports
    const [xlsxBuffer, pdfBuffer, csvBuffer] = await Promise.all([
      generateExcelReport(resultPayload),
      generatePdfReport(resultPayload),
      Promise.resolve(generateCsvReport(resultPayload)),
    ]);

    const xlsxFileId = `xlsx_${jobId}`;
    const pdfFileId = `pdf_${jobId}`;
    const csvFileId = `csv_${jobId}`;

    const permissions = [
      Permission.read(Role.user(job.userId)),
      Permission.read(Role.label("admin")),
    ];

    // Upload all 3 files to bucket 'results' with File Security ON
    const xlsxFile = new File([new Uint8Array(xlsxBuffer)], `digr_${job.templateSlug}_${jobId}.xlsx`, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const pdfFile = new File([new Uint8Array(pdfBuffer)], `digr_${job.templateSlug}_${jobId}.pdf`, {
      type: "application/pdf",
    });
    const csvFile = new File([new Uint8Array(csvBuffer)], `digr_${job.templateSlug}_${jobId}.csv`, {
      type: "text/csv; charset=utf-8",
    });

    await Promise.all([
      storage.createFile("results", xlsxFileId, xlsxFile, permissions),
      storage.createFile("results", pdfFileId, pdfFile, permissions),
      storage.createFile("results", csvFileId, csvFile, permissions),
    ]);

    log(`[job-worker] Uploaded xlsx (${xlsxFileId}), pdf (${pdfFileId}), and csv (${csvFileId}) to bucket results`);
    const resultFileId = xlsxFileId;

    // Calculate Margin & Internal Reporting
    const actualCostMicro = tregResult.costMicro;
    const deliveredUnits = 1;
    const templateRow: any = await tables.getRow({ databaseId: "digr", tableId: "templates", rowId: job.templateSlug });
    const pricePerUnit = templateRow.priceCreditsPerUnit || 1;
    const chargedCredits = Math.min(job.reservedCredits, pricePerUnit * deliveredUnits);

    const usdToEgp = settings.usdToEgp || 50.0;
    const creditValEgp = settingsPub.creditValueEgp || 0.1;
    const costEgp = (actualCostMicro / 1_000_000) * usdToEgp;
    const revenueEgp = chargedCredits * creditValEgp;
    const marginEgp = revenueEgp - costEgp;

    await tables.createRow({
      databaseId: "digr",
      tableId: "jobs_internal",
      rowId: ID.unique(),
      data: {
        jobId,
        actualCostMicro,
        revenueCredits: chargedCredits,
        marginEgp: Number(marginEgp.toFixed(4)),
      },
    });

    // 8. Release-First Completion Order (rel-first sequence)
    log(`[job-worker] Executing rel-first completion sequence: rel_${jobId} (+${job.reservedCredits}) -> chg_${jobId} (-${chargedCredits})`);

    const completion = await completeJobWithRelFirst(
      tables,
      job.userId,
      jobId,
      job.reservedCredits,
      chargedCredits,
      "تسوية واكتمال الطلب بنجاح"
    );

    if (!completion.released) {
      log(`[job-worker] Warning: rel_${jobId} already existed (job was already released/cancelled). Aborting.`);
      return res.json({ success: false, error: "Job was already released or timed out" }, 200);
    }

    // 9. Update Job row to status: done
    const nowDone = new Date().toISOString();
    await tables.updateRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: {
        status: "done",
        chargedCredits,
        rowsCollected: 1,
        resultFileId,
        finishedAt: nowDone,
      },
    });

    // 10. Append final event in job_events
    await tables.createRow({
      databaseId: "digr",
      tableId: "job_events",
      rowId: ID.unique(),
      data: {
        jobId,
        textAr: "تم اكتمال جمع البيانات بنجاح وإنشاء ملف النتائج",
        count: 1,
        kind: "info",
        createdAt: nowDone,
      },
      permissions: [
        Permission.read(Role.user(job.userId)),
        Permission.read(Role.label("admin")),
      ],
    });

    log(`[job-worker] Job ${jobId} completed successfully! Charged: ${chargedCredits} credits.`);

    return res.json(
      {
        success: true,
        jobId,
        status: "done",
        chargedCredits,
        rowsCollected: 1,
        resultFileId,
      },
      200
    );
  } catch (err: any) {
    error(`[job-worker] Worker exception: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
