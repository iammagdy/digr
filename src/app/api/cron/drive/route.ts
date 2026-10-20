import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret, resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { DRIVER_DISPATCH_TIMEOUT_MS, MAX_IDLE_MS, MAX_JOBS_PER_TICK, MIN_IDLE_MS } from "../../../../lib/server/driverLimits";
import { dispatchWorkerChunk } from "../../../../lib/server/workerDispatch";
import { notifyStalledJobs } from "../../../../lib/server/jobStallNotifier";
import { longJobDriverMode } from "../../../../lib/driverMode";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The always-on driver: it resumes APPROVED jobs whose chain of chunks broke, so a job finishes with the page closed. The
 * database scheduler (pg_cron + pg_net, see docs/proposals/08_long_job_driver_setup.md) calls it every minute with the cron secret.
 *
 * It reserves, charges and releases nothing. It only asks the existing worker route to run the next chunk of a job the customer
 * already approved: the worker claims the chunk through claim_job_chunk (a lease plus the expected step, so two drivers, a driver
 * and a self-chain or a driver and an open page never run the same chunk twice), and reserve, settle and release stay in their
 * existing atomic functions. The work of one call is bounded: at most MAX_JOBS_PER_TICK chunks, each one provider page.
 *
 * It also tells the customers of stalled jobs once (notifyStalledJobs), because only a scheduler that is always on notices them.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ success: false, error: "غير مصرح." }, { status: 401 });
  }
  const admin = createAdminClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const idleSince = new Date(now - MAX_IDLE_MS).toISOString();
  const settledBefore = new Date(now - MIN_IDLE_MS).toISOString();

  const { data, error } = await admin
    .from("jobs")
    .select("id, step, status, lease_until, next_attempt_at, updated_at")
    .in("status", ["queued", "running"])
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .gt("updated_at", idleSince)
    .lt("updated_at", settledBefore)
    .order("updated_at", { ascending: true })
    .limit(MAX_JOBS_PER_TICK * 3);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  const candidates: any[] = Array.isArray(data) ? data : [];
  const due = candidates
    .filter((job) => !job.next_attempt_at || new Date(job.next_attempt_at).getTime() <= now)
    .slice(0, MAX_JOBS_PER_TICK);

  let baseUrl: string;
  try {
    baseUrl = resolveInternalBaseUrl(req);
  } catch {
    return NextResponse.json({ success: false, error: "تعذر تحديد عنوان التنفيذ الداخلي." }, { status: 500 });
  }

  // In parallel: each chunk can run for most of a minute, and the worker claims a job with a lease, so two ticks never double-run one.
  const [results, stalledNotices] = await Promise.all([
    Promise.all(due.map(async (job) => {
      try {
        const outcome = await dispatchWorkerChunk(baseUrl, job.id, job.step ?? 0, createInternalWorkerAuthHeaders(job.id), DRIVER_DISPATCH_TIMEOUT_MS);
        return { jobId: job.id as string, started: Boolean(outcome.started) };
      } catch {
        return { jobId: job.id as string, started: false };
      }
    })),
    notifyStalledJobs(admin, now),
  ]);
  return NextResponse.json({
    success: true,
    mode: longJobDriverMode(),
    considered: candidates.length,
    dispatched: results.length,
    started: results.filter((result) => result.started).length,
    stalledNotices,
    results,
  });
}
