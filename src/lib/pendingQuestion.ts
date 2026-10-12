export const PENDING_QUESTION_KEY = "digr:pendingQuestion";

export function savePendingQuestion(q: string) {
  try { window.sessionStorage.setItem(PENDING_QUESTION_KEY, q); } catch { /* private mode */ }
}
export function readPendingQuestion(): string {
  try { return window.sessionStorage.getItem(PENDING_QUESTION_KEY) || ""; } catch { return ""; }
}
export function clearPendingQuestion() {
  try { window.sessionStorage.removeItem(PENDING_QUESTION_KEY); } catch { /* ignore */ }
}
