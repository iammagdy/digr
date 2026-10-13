export const PENDING_QUESTION_KEY = "diger:pendingQuestion";

/* sessionStorage is the source of truth; localStorage mirrors it so the question
   survives the email-verification link opening in a new tab. */
export function savePendingQuestion(q: string) {
  try { window.sessionStorage.setItem(PENDING_QUESTION_KEY, q); } catch { /* private mode */ }
  try { window.localStorage.setItem(PENDING_QUESTION_KEY, q); } catch { /* private mode */ }
}
export function readPendingQuestion(): string {
  try {
    const s = window.sessionStorage.getItem(PENDING_QUESTION_KEY);
    if (s) return s;
  } catch { /* ignore */ }
  try { return window.localStorage.getItem(PENDING_QUESTION_KEY) || ""; } catch { return ""; }
}
export function clearPendingQuestion() {
  try { window.sessionStorage.removeItem(PENDING_QUESTION_KEY); } catch { /* ignore */ }
  try { window.localStorage.removeItem(PENDING_QUESTION_KEY); } catch { /* ignore */ }
}
