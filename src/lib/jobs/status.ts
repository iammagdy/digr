const TERMINAL_JOB_STATUSES = new Set(["completed", "done", "failed", "cancelled", "refused"]);

export function isTerminalJobStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_JOB_STATUSES.has(status);
}

export function toChatJobStatus(status: unknown): "queued" | "running" | "done" | "failed" | "cancelled" {
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "refused") return "failed";
  if (status === "cancelled") return "cancelled";
  return status === "queued" ? "queued" : "running";
}
