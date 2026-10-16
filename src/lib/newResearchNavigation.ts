const ACTIVE_JOB_ID_KEY = "diger_active_job_id";
const CANVAS_OPEN_KEY = "diger_canvas_open";

/** Clear stale resume hints before navigating to a new, unrelated research chat. */
export function startNewResearch(
  navigate: () => void,
  storage?: Pick<Storage, "removeItem">,
): void {
  const keys = [ACTIVE_JOB_ID_KEY, CANVAS_OPEN_KEY];
  for (const key of keys) {
    try {
      const target = storage || (typeof window !== "undefined" ? window.sessionStorage : undefined);
      target?.removeItem(key);
    } catch {
      // Session storage is only a resume hint; navigation must still work if it is unavailable.
    }
  }
  navigate();
}
