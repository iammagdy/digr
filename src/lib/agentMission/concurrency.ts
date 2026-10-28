import { AGENT_CONCURRENCY_MAX, AGENT_DYNO_MEMORY_MB, AGENT_MEMORY_WARN_SHARE, AGENT_WORKER_CONCURRENCY } from "./constants";

/** AGENT_CONCURRENCY: a whole number from 1 to AGENT_CONCURRENCY_MAX; anything else (unset, text, 0, negative, fractional) means the default of 1. */
export function parseConcurrency(raw: string | undefined | null): number {
  const text = String(raw ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return AGENT_WORKER_CONCURRENCY;
  const n = Number(text);
  return n >= 1 ? Math.min(n, AGENT_CONCURRENCY_MAX) : AGENT_WORKER_CONCURRENCY;
}

/** True when the memory of the worker and the processes it started is above the warning share of the dyno's memory. Null (not measured) never warns. */
export function memoryWarning(treeRssMb: number | null | undefined, limitMb: number = AGENT_DYNO_MEMORY_MB): boolean {
  return typeof treeRssMb === "number" && Number.isFinite(treeRssMb) && treeRssMb >= limitMb * AGENT_MEMORY_WARN_SHARE;
}
