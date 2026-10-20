import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret, resolveInternalBaseUrl, createInternalWorkerAuthHeaders } from "../../../../lib/server/cronAuth";
import { dispatchWorkerChunk } from "../../../../lib/server/workerDispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The most jobs one tick resumes; the next tick picks up the rest. */
export const MAX_JOBS_PER_TICK = 5;
/** A job idle for longer than this is left to the daily watchdog (it refunds it). */
export const MAX_IDLE_MS = 25 * 60 * 1000;

/**
 * PROPOSAL (parked branch, not wired into vercel.json): resumes APPROVED jobs whose chain broke, so a job finishes with the
 * page closed. It is called every minute by the database scheduler (pg_cron + pg_net, see docs/proposals/07_pg_cron_driver.sql)
 * with the cron secret. It reserves nothing and charges nothing: it only asks the existing worker route to run the next chunk of
 * a job the customer already approved; reserve, settle and release stay in their existing functions.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ success: false, error: "غير مصرح." }, { status: 401 });
  }
  const admin = createAdminClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const idleSince = new Date(now - MAX_IDLE_MS).toISOString();

  const { data, error } = await admin
    .from("jobs")
    .select("id, step, status, lease_until, next_attempt_at, updated_at")
    .in("status", ["queued", "running"])
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .gt("updated_at", idleSince)
    .order("updated_at", { ascending: true })
    .limit(MAX_JOBS_PER_TICK * 3);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  const due = (data || []).filter((job: any) => !job.next_attempt_at || new Date(job.next_attempt_at).getTime() <= now).slice(0, MAX_JOBS_PER_TICK);
  const baseUrl = resolveInternalBaseUrl(req);
  // In parallel: each chunk can run for most of a minute, and the worker claims a job with a lease, so two ticks never double-run one.
  const results = await Promise.all(due.map(async (job: any) => {
    try {
      const outcome = await dispatchWorkerChunk(baseUrl, job.id, job.step ?? 0, createInternalWorkerAuthHeaders(job.id));
      return { jobId: job.id as string, started: Boolean(outcome.started) };
    } catch {
      return { jobId: job.id as string, started: false };
    }
  }));
  return NextResponse.json({ success: true, considered: data?.length ?? 0, dispatched: results.length, results });
}
