/**
 * The admin stats' job events. The jobs table's finished status is «completed» (the one status the dashboards use since PR #227); a job that finished
 * reports the units it DELIVERED (`deliveredUnits`, the table's column), never a column that does not exist. Pure: no database, no network.
 */
export const FINISHED_JOB_STATUS = "completed";

const toArabicIndic = (n: number): string => String(Math.max(0, Math.round(n))).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

export function isFinishedJob(status: unknown): boolean {
  return status === FINISHED_JOB_STATUS;
}

/** The event line of a finished job: how many records it delivered. */
export function finishedJobLabelAr(job: { deliveredUnits?: number | null }): string {
  return `اكتمل بحثه · ${toArabicIndic(Number(job.deliveredUnits) || 0)} سجلًا`;
}
