import { Client, TablesDB, Storage } from "../../shared/dbCompat";
import { z } from "zod";
import { releaseReservation } from "../../shared/ledger";
import { notifyJobOutcome } from "../../shared/notify";
import {
  runJobWatchdog,
  reportStuckJobsReadOnly,
  executeMultiStepJob,
} from "../../shared/multiStepWorker";

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

    log(`[job-worker] Starting generic worker for job ${jobId}`);

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

    // Execute through ONE generic multi-step worker
    const parsedParams = typeof job.params === "string" ? JSON.parse(job.params || "{}") : (job.params || {});
    const targetVolumeMax = Number(job.targetVolumeMax || parsedParams.targetVolumeMax || 1);
    const unitPricePoints = Number(job.unitPricePoints || (job.reservedCredits ? job.reservedCredits / targetVolumeMax : 1));

    const execResult = await executeMultiStepJob(tables, storage, {
      jobId,
      userId: job.userId,
      templateSlug: job.templateSlug,
      targetVolumeMax,
      unitPricePoints,
      reservedCredits: job.reservedCredits,
      params: parsedParams,
    });

    log(`[job-worker] Job ${jobId} finished with status: ${execResult.status} (deliveredUnits=${execResult.deliveredUnits}, charged=${execResult.chargedCredits})`);

    await notifyJobOutcome(client, job.userId, execResult as any, log);

    return res.json(execResult, 200);
  } catch (err: any) {
    error(`[job-worker] Worker exception: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
