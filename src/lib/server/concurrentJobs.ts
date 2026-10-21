import { toArabicDigits } from "../arabicDigits";

/**
 * How many requests one customer may have running or waiting at once. A person who starts ten at the same moment spends the provider's
 * daily allowance on himself and slows everyone in the room: the next request waits for one of his own to finish. Read only; the count
 * is a database read (shared by every server instance); a failed read lets the request through (the money and capacity checks still apply).
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = 3;

export function maxConcurrentJobsPerUser(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.MAX_CONCURRENT_JOBS_PER_USER);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(20, Math.floor(configured)) : DEFAULT_MAX_CONCURRENT_JOBS;
}

export interface ConcurrentJobsDecision { allowed: boolean; active: number; max: number; messageAr: string }

export function evaluateConcurrentJobs(active: number, max: number = maxConcurrentJobsPerUser()): ConcurrentJobsDecision {
  const count = Math.max(0, Math.floor(Number(active) || 0));
  const allowed = count < max;
  return {
    allowed,
    active: count,
    max,
    messageAr: allowed ? "" : `لديك ${toArabicDigits(count)} طلبات قيد التنفيذ الآن، وهذا أقصى ما نشغّله معًا لحساب واحد. انتظر اكتمال أحدها ثم ابدأ الطلب الجديد؛ خطتك محفوظة ولا يُخصم شيء.`,
  };
}

export async function countActiveJobs(admin: any, userId: string): Promise<number> {
  try {
    const result = await admin.from("jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", ["queued", "running"]);
    return result?.error ? 0 : typeof result?.count === "number" ? result.count : 0;
  } catch {
    return 0;
  }
}
