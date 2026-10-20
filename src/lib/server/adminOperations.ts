/**
 * The admin operations snapshot: what is running, what is stuck, what failed, how much of the provider's daily allowance is used
 * and what needs attention. Pure functions over rows the route reads (SELECT only); nothing here writes or calls a provider.
 */
export const STALLED_AFTER_MS = 3 * 60 * 1000;
/** The daily watchdog refunds a job idle for this long. */
export const REFUND_AFTER_MS = 30 * 60 * 1000;
export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QUEUE_BACKLOG_ALERT = 10;

export interface JobRowLite {
  id: string;
  status: string;
  lease_until: string | null;
  updated_at: string | null;
  created_at: string | null;
  reserved_credits?: number | null;
  delivered_units?: number | null;
  error_message?: string | null;
}

export type JobClass = "queued" | "running" | "stalled" | "failed_recent" | "other";

const ms = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.NaN);

/** A job with a live lease is running; one that should be moving but has no live lease for a few minutes is stalled. */
export function classifyJob(job: JobRowLite, now: number): JobClass {
  if (job.status === "failed") {
    const at = ms(job.updated_at);
    return Number.isFinite(at) && now - at <= FAILED_WINDOW_MS ? "failed_recent" : "other";
  }
  if (job.status !== "queued" && job.status !== "running") return "other";
  const lease = ms(job.lease_until);
  if (Number.isFinite(lease) && lease > now) return "running";
  const touched = ms(job.updated_at);
  if (Number.isFinite(touched) && now - touched >= STALLED_AFTER_MS) return "stalled";
  return job.status === "queued" ? "queued" : "running";
}

export interface AlertLine { level: "info" | "warn" | "bad"; textAr: string }

export interface OperationsInput {
  jobs: JobRowLite[];
  now: number;
  provider: { todaySpendUsd: number; todayCapUsd: number; availableBalanceUsd: number; creditUsd: number; warnPercent: number };
}

export interface OperationsSnapshot {
  counts: { queued: number; running: number; stalled: number; failedRecent: number };
  oldestQueuedMinutes: number | null;
  provider: { todaySpendUsd: number; todayCapUsd: number; percentOfCap: number; level: "ok" | "warn" | "reached"; availableBalanceUsd: number; balanceIsLow: boolean };
  stalled: Array<{ id: string; idleMinutes: number; refundInMinutes: number }>;
  failed: Array<{ id: string; at: string | null; reservedCredits: number; reasonAr: string }>;
  alerts: AlertLine[];
}

const n = (value: number) => new Intl.NumberFormat("ar-EG").format(Math.round(value));

export function buildOperationsSnapshot(input: OperationsInput): OperationsSnapshot {
  const { jobs, now, provider } = input;
  const queued: JobRowLite[] = [];
  const stalled: OperationsSnapshot["stalled"] = [];
  const failed: OperationsSnapshot["failed"] = [];
  let running = 0;

  for (const job of jobs) {
    const kind = classifyJob(job, now);
    if (kind === "queued") queued.push(job);
    else if (kind === "running") running += 1;
    else if (kind === "stalled") {
      const idle = now - ms(job.updated_at);
      stalled.push({ id: job.id, idleMinutes: Math.floor(idle / 60000), refundInMinutes: Math.max(0, Math.ceil((REFUND_AFTER_MS - idle) / 60000)) });
    } else if (kind === "failed_recent") {
      failed.push({ id: job.id, at: job.updated_at, reservedCredits: Number(job.reserved_credits) || 0, reasonAr: String(job.error_message || "").trim() || "لم يُسجَّل سبب." });
    }
  }

  const oldestQueued = queued.length ? Math.max(...queued.map((job) => now - (ms(job.created_at) || now))) : null;
  const percentOfCap = provider.todayCapUsd > 0 ? Math.min(100, (provider.todaySpendUsd / provider.todayCapUsd) * 100) : provider.todaySpendUsd > 0 ? 100 : 0;
  const level: OperationsSnapshot["provider"]["level"] = provider.todaySpendUsd >= provider.todayCapUsd ? "reached" : percentOfCap >= provider.warnPercent ? "warn" : "ok";
  const balanceIsLow = provider.availableBalanceUsd <= Math.max(0.02, provider.creditUsd * 0.2);

  const alerts: AlertLine[] = [];
  if (stalled.length) alerts.push({ level: "bad", textAr: `${n(stalled.length)} طلب متوقف دون تقدم؛ سيُرجع النظام نقاطه تلقائيًا إن بقي متوقفًا.` });
  if (failed.length) alerts.push({ level: "warn", textAr: `${n(failed.length)} طلب فشل خلال آخر ٢٤ ساعة (أُرجعت نقاطه).` });
  if (level === "reached") alerts.push({ level: "bad", textAr: "وصل الإنفاق اليومي للمزود إلى الحد؛ لن تبدأ طلبات جديدة اليوم." });
  else if (level === "warn") alerts.push({ level: "warn", textAr: `استُهلك ${n(percentOfCap)}٪ من الحد اليومي للمزود.` });
  if (balanceIsLow) alerts.push({ level: "warn", textAr: "رصيد المزود منخفض؛ اشحنه قبل أي طلب كبير." });
  if (queued.length >= QUEUE_BACKLOG_ALERT) alerts.push({ level: "warn", textAr: `${n(queued.length)} طلب في الانتظار.` });

  return {
    counts: { queued: queued.length, running, stalled: stalled.length, failedRecent: failed.length },
    oldestQueuedMinutes: oldestQueued === null ? null : Math.floor(oldestQueued / 60000),
    provider: { todaySpendUsd: provider.todaySpendUsd, todayCapUsd: provider.todayCapUsd, percentOfCap, level, availableBalanceUsd: provider.availableBalanceUsd, balanceIsLow },
    stalled,
    failed,
    alerts,
  };
}
