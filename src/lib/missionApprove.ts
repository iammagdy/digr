/**
 * THE APPROVE CLICK THAT RECOVERS (round 14, live: on both missions the first «اعتمد» showed a browser error and the second succeeded). The evidence (read-only SELECTs, runtime logs): each mission has exactly ONE quote, ONE job and ONE reserve, so the first click never reached the reserve; the
 * server logged no error for it; the route answers JSON on every path. What the browser can do before the request leaves is read the session (`getSession` swallows its own failure and then sends NO token, so a session that is being refreshed gives a 401 on the first click) or lose the connection.
 * The approval is idempotent on the server (the claim `plan_ready -> approved` changes exactly one row and the money functions use deterministic ids), so one automatic retry after a fresh session is safe, and a failure is never reported as «nothing was held» until the mission itself is read again.
 * Pure: the four things it needs are handed in, so the rule is tested without a browser.
 */
export interface ApproveDeps {
  /** One POST of the approval with the session as it is now: the HTTP status and the parsed body, or null when the request never completed. */
  post: () => Promise<{ status: number; body: { success?: boolean; error?: string } | null } | null>;
  /** Make the browser session fresh (a refresh of the token); never throws. */
  refreshSession: () => Promise<void>;
  /** Read the mission again: true when it is no longer waiting for approval (it was approved, it runs, it ended). Null when the read failed. */
  isApproved: () => Promise<boolean | null>;
  sleep: (ms: number) => Promise<void>;
}

export type ApproveOutcome = { ok: true; viaRead: boolean } | { ok: false; error: string; retriable: boolean };

/** Statuses worth one more try with a fresh session: no token (401), the gate or the platform answering for a moment (502, 503, 504), a request that never completed (0). A business answer (402, 403, 409, 429) is final. */
export const RETRIABLE_APPROVE_STATUSES: ReadonlySet<number> = new Set([0, 401, 502, 503, 504]);

export const APPROVE_UNKNOWN_AR = "لم نستطع تأكيد الاعتماد الآن. حدّث الصفحة وتحقق من «طلباتي»: إن كانت المهمة تعمل فقد اعتُمدت، وإن بقيت الخطة تنتظر اعتمادك فاضغط «اعتمد» مرة أخرى.";

export async function approveWithRecovery(deps: ApproveDeps): Promise<ApproveOutcome> {
  let last: { status: number; error: string } = { status: 0, error: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await deps.post().catch(() => null);
    if (res && res.status >= 200 && res.status < 300 && res.body?.success === true) return { ok: true, viaRead: false };
    last = { status: res?.status ?? 0, error: String(res?.body?.error ?? "") };
    // «already approved» (the first request got through and only its answer was lost): the mission says so
    if (res?.status === 409) { if ((await deps.isApproved().catch(() => null)) === true) return { ok: true, viaRead: true }; break; }
    if (!RETRIABLE_APPROVE_STATUSES.has(last.status)) break;
    if (attempt === 0) { await deps.refreshSession().catch(() => undefined); await deps.sleep(800); }
  }
  // the answer is lost or final: the mission itself says what happened, and «nothing was held» is said only when it still waits
  const approved = await deps.isApproved().catch(() => null);
  if (approved === true) return { ok: true, viaRead: true };
  if (approved === null && RETRIABLE_APPROVE_STATUSES.has(last.status)) return { ok: false, error: APPROVE_UNKNOWN_AR, retriable: true };
  return { ok: false, error: last.error && /[؀-ۿ]/.test(last.error) ? last.error : "تعذّر اعتماد الخطة الآن؛ حاول بعد قليل. لم يُخصم شيء.", retriable: RETRIABLE_APPROVE_STATUSES.has(last.status) };
}
