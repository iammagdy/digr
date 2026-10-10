import { Client, TablesDB, Storage, Permission, Role, ID } from "node-appwrite";
import { z } from "zod";
import {
  completeJobWithRelFirst,
  releaseCredits,
} from "../../shared/ledger";
import { executeTregCall } from "../../shared/tregClient";

const workerPayloadSchema = z.object({
  jobId: z.string().min(1),
  testScenario: z.string().optional(),
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
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const validated = workerPayloadSchema.parse(rawBody);
    const { jobId, testScenario } = validated;

    log(`[job-worker] Starting worker for job ${jobId}`);

    // 1. Fetch Job from database
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

    // Guard: Prevent double-running finished jobs
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      log(`[job-worker] Job ${jobId} is already ${job.status}. Skipping.`);
      return res.json({ success: true, message: `Job already ${job.status}` }, 200);
    }

    // 2. Mark job as running
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

    // 3. Fetch private template settings & internal margins
    const tmplPriv: any = await tables.getRow({
      databaseId: "digr",
      tableId: "templates_private",
      rowId: job.templateSlug,
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
    const maxCostMicro = Math.round((tmplPriv.maxCostUsd || 0.01) * 1_000_000);

    log(`[job-worker] Calling TREG endpoint ${tmplPriv.tregEndpointId} with cap ${maxCostMicro} microUSD`);

    const tregResult = await executeTregCall({
      endpointId: tmplPriv.tregEndpointId,
      method: tmplPriv.tregMethod,
      params,
      userId: job.userId,
      jobId,
      maxCostMicro,
      testScenario,
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

      // Release reserved credits
      await releaseCredits(tables, job.userId, jobId, job.reservedCredits, "استرجاع الرصيد لفشل استخراج البيانات");

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
    const resultPayload = {
      metadata: {
        platform: "Digr Data Platform",
        company: "Digr",
        title: "مجموعة بيانات Digr",
        template: job.templateSlug,
        jobId,
        collectedAt: new Date().toISOString(),
        methodology: `تم جمع البيانات من مصدر عام متاح للجمهور بتاريخ ${dateStr}. إجمالي السجلات: 1. ملاحظة منهجية: هذه البيانات عامة ومتاحة علنًا، ولا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.`,
      },
      data: tregResult.data,
    };

    const fileContentBuffer = Buffer.from(JSON.stringify(resultPayload, null, 2), "utf-8");
    const filename = `digr_${job.templateSlug}_${jobId}.json`;
    const resultFileId = ID.unique();

    // Upload result file to bucket 'results' with File Security ON
    const uploadFile = new File([fileContentBuffer], filename, { type: "application/json" });
    await storage.createFile(
      "results",
      resultFileId,
      uploadFile,
      [
        Permission.read(Role.user(job.userId)),
        Permission.read(Role.label("admin")),
      ]
    );
    log(`[job-worker] Uploaded result file ${resultFileId} (${filename}) to bucket results`);

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
