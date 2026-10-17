export const MAX_WORKER_START_RETRIES = 3;
export const MAX_WORKER_START_ATTEMPTS = MAX_WORKER_START_RETRIES + 1;

export const WORKER_START_RETRY_REASON_AR = "تعذر بدء البحث الآن. ستتم إعادة المحاولة تلقائياً.";
export const WORKER_START_FINAL_REASON_AR = "تعذر بدء البحث بعد عدة محاولات. أُعيدت النقاط المحجوزة إلى رصيدك.";

export interface WorkerStartFailureResult {
  attemptCount: number | null;
  failed: boolean;
  released: boolean;
  releaseConfirmed: boolean;
}

/** Persist one failed worker-start attempt using approved atomic RPCs only. */
export async function recordWorkerStartFailure(
  adminClient: any,
  jobId: string,
): Promise<WorkerStartFailureResult> {
  const { data: failure, error: failureError } = await adminClient.rpc("record_chunk_failure", {
    p_job_id: jobId,
    p_error_message: WORKER_START_RETRY_REASON_AR,
  });
  if (failureError || !failure?.success) {
    console.error(`[worker_start:failure_record_failed] jobId=${jobId} code=${failureError?.code || "rpc_failed"}`);
    return { attemptCount: null, failed: false, released: false, releaseConfirmed: false };
  }

  const attemptCount = Number.isFinite(Number(failure.attempt_count)) ? Number(failure.attempt_count) : null;
  if (failure.ignored && failure.status === "failed") {
    return { attemptCount, failed: true, released: true, releaseConfirmed: true };
  }

  if (failure.released === true) {
    return { attemptCount, failed: true, released: true, releaseConfirmed: true };
  }

  if (attemptCount === null || attemptCount < MAX_WORKER_START_ATTEMPTS) {
    return { attemptCount, failed: false, released: false, releaseConfirmed: false };
  }

  const { data: release, error: releaseError } = await adminClient.rpc("release_job_atomic", {
    p_job_id: jobId,
    p_error_message: WORKER_START_FINAL_REASON_AR,
  });
  const releaseConfirmed = !releaseError && (release?.success === true || release?.already_released === true);
  if (!releaseConfirmed) {
    console.error(`[worker_start:release_failed] jobId=${jobId} code=${releaseError?.code || "rpc_failed"}`);
    return { attemptCount, failed: false, released: false, releaseConfirmed: false };
  }

  // The job row is authoritative; this event gives the conversation a single
  // customer-visible terminal explanation after the plan card.
  try {
    const { data: job } = await adminClient.from("jobs").select("user_id").eq("id", jobId).maybeSingle();
    if (job?.user_id) {
      await adminClient.from("job_events").insert({
        job_id: jobId,
        user_id: job.user_id,
        message: WORKER_START_FINAL_REASON_AR,
        units: 0,
        event_type: "error",
      });
    }
  } catch (eventError: any) {
    console.warn(`[worker_start:terminal_event_failed] jobId=${jobId} code=${eventError?.code || "unknown"}`);
  }

  return { attemptCount, failed: true, released: true, releaseConfirmed: true };
}
