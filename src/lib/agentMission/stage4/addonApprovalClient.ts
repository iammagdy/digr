import { pointsAr } from "../../pointsFormat";

/**
 * LAUNCH ROUND, WORKSTREAM 2: THE BROWSER'S SIDE OF THE APPROVAL (client-safe: no server module, no price logic). It sends the REQUEST ID and the POINTS THE PAGE SHOWED and nothing else; the server recomputes the price and only compares. `fetch` and the bearer header are injected,
 * so every path is tested without a browser. It never throws: a failure is a controlled Arabic sentence, and an answer that may have moved money is ALWAYS «uncertain» (never «nothing was held»).
 */
export const addonApprovalUrl = (missionId: string): string => `/api/missions/${encodeURIComponent(missionId)}/addon-approval`;
/** The event the approval fires on the window so the page's own status panel re-reads the truth from the server. */
export const FILE_WORKFLOW_REFRESH_EVENT = "diger:file-workflow-refresh";

export const APPROVE_HEADING_AR = "اعتماد الطلب";
export const APPROVE_CONSENT_AR = "عند الاعتماد نحجز نقاط الطلب مؤقتًا من رصيدك، ولا يُخصم منها إلا ما يُنجز فعلًا، ويُحرَّر الحجز المؤقت لما لا يُخصم.";
export const APPROVING_AR = "جارٍ الاعتماد…";
export const APPROVED_AR = "اعتُمد الطلب وحُجزت النقاط؛ يبدأ التنفيذ الآن. تابع حالته في «حالة طلباتك على هذا الملف».";
export const ALREADY_APPROVED_AR = "هذا الطلب اعتُمد بالفعل أو قيد الاعتماد الآن؛ تابع حالته في «حالة طلباتك على هذا الملف».";
/** The connection failed or the answer is unknown: the points MAY be held, so this never says nothing was held. */
export const APPROVE_UNKNOWN_AR = "لم نتمكن من تأكيد اعتماد الطلب بعد. قد تكون نقاطك حُجزت مؤقتًا، ولن يُخصم منها إلا ما يُنجز. تحقق من «حالة طلباتك على هذا الملف» قبل أن تعيد المحاولة.";
export const APPROVE_SIGNED_OUT_AR = "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى؛ لم يُحجز أو يُخصم شيء.";
/** The route refused before any money function (the approval is no longer offered, or the request is not this customer's any more). */
export const APPROVE_NOT_AVAILABLE_AR = "لم يعد اعتماد هذا الطلب متاحًا من هنا. حدّث الصفحة؛ لم يُحجز أو يُخصم شيء.";
export const approveButtonAr = (points: number): string => `اعتمد الطلب واحجز ${pointsAr(points)}`;

const isRequestId = (v: unknown): v is string => typeof v === "string" && /^msn_[a-z0-9]{8,40}$/.test(v);
const isHold = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5000;
const sentence = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= 400 ? v : null);

/** Is the approval offered at all? False while the feature is off (404), signed out, in an outage or on any malformed answer: the page then draws no button. */
export async function fetchApprovalAvailable(input: { missionId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<boolean> {
  try {
    const res = await input.fetchFn(addonApprovalUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.success === true && body?.available === true;
  } catch {
    return false;
  }
}

export type ApproveResult =
  | { state: "approved"; message: string }
  | { state: "already_approved"; message: string }
  | { state: "refused"; message: string }
  | { state: "uncertain"; message: string };

/** Sends the approval: exactly `{ requestId, expectedPoints }`. `expectedPoints` is the hold the page SHOWED; the server compares it with its own price. */
export async function sendApproval(input: { missionId: string; requestId: string; expectedPoints: number; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<ApproveResult> {
  if (!isRequestId(input.requestId) || !isHold(input.expectedPoints)) return { state: "refused", message: "تعذّر قراءة الطلب. حدّث الصفحة وحاول مرة أخرى؛ لم يُحجز أو يُخصم شيء." };
  try {
    const res = await input.fetchFn(addonApprovalUrl(input.missionId), { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", ...(await input.headers()) }, body: JSON.stringify({ requestId: input.requestId, expectedPoints: input.expectedPoints }) });
    let body: any = null;
    try { body = await res.json(); } catch { /* an unreadable answer: below */ }
    if (res.ok && body?.success === true && body?.state === "approved") return { state: "approved", message: APPROVED_AR };
    if (body?.state === "already_approved") return { state: "already_approved", message: ALREADY_APPROVED_AR };
    if (body?.state === "uncertain") return { state: "uncertain", message: sentence(body.error) ?? APPROVE_UNKNOWN_AR };
    if (body?.state === "refused" && sentence(body.error)) return { state: "refused", message: sentence(body.error) as string };
    // an answer of the route itself with no `state` (the session ended, the feature was switched off, a bad id): these are decided BEFORE any money function, so nothing was held
    if (res.status === 401) return { state: "refused", message: APPROVE_SIGNED_OUT_AR };
    if ((res.status === 400 || res.status === 403 || res.status === 404) && !body?.state) return { state: "refused", message: APPROVE_NOT_AVAILABLE_AR };
    // an answer that is not one of ours (a gateway error, an HTML page): the server may have processed the request
    return { state: "uncertain", message: APPROVE_UNKNOWN_AR };
  } catch {
    // the connection failed after the request left: the points MAY be held
    return { state: "uncertain", message: APPROVE_UNKNOWN_AR };
  }
}
