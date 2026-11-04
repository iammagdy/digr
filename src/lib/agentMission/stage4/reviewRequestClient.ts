import { REVIEW_REQUEST_ERRORS_AR, type ReviewRequestView } from "./reviewRequestLabels";

/**
 * MONEY PR 7d, 2B-2 task 3: THE BROWSER'S SIDE OF THE REVIEW REQUEST (client-safe: no server module). It sends the VERSION (to make a request) or the REQUEST ID (to cancel it) and nothing else, and hands back exactly what the server answered; it computes no price and
 * sends no price, cell count, plan or owner. `fetch` and the bearer header are injected, so every path is tested without a browser. A failure is a controlled Arabic sentence.
 */
export const reviewRequestUrl = (missionId: string): string => `/api/missions/${encodeURIComponent(missionId)}/review-request`;

const isVersionNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isRequestId = (v: unknown): v is string => typeof v === "string" && /^msn_[a-z0-9]{8,40}$/.test(v);

/** The answer's request, only if it is exactly a waiting review request (a request in any other status is not one). */
function requestOf(raw: any): ReviewRequestView | null {
  if (!raw || typeof raw !== "object" || !isRequestId(raw.id) || !isVersionNumber(raw.version) || !isCount(raw.cells) || !isCount(raw.points) || raw.status !== "plan_ready") return null;
  return { id: raw.id, version: raw.version, cells: raw.cells, points: raw.points, status: "plan_ready" };
}

const post = (input: { missionId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>>; body: unknown }) =>
  input.fetchFn(reviewRequestUrl(input.missionId), { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) });
const withHeaders = async (input: { headers: () => Promise<Record<string, string>> }) => ({ "Content-Type": "application/json", ...(await input.headers()) });

/** The waiting request of this file, or null (none, the feature off, signed out, an outage, a malformed answer: the page then shows the quote flow or nothing). */
export async function fetchReviewRequest(input: { missionId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<ReviewRequestView | null> {
  try {
    const res = await input.fetchFn(reviewRequestUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.success === true ? requestOf(body.request) : null;
  } catch {
    return null;
  }
}

export type PrepareResult = { ok: true; created: boolean; request: ReviewRequestView } | { ok: false; message: string };
const REFUSALS = ["open_addon", "review_exists", "too_large", "nothing_to_review"] as const;

export async function prepareReviewRequest(input: { missionId: string; version: number; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<PrepareResult> {
  if (!isVersionNumber(input.version)) return { ok: false, message: REVIEW_REQUEST_ERRORS_AR.not_found };
  try {
    const res = await input.fetchFn(reviewRequestUrl(input.missionId), { method: "POST", cache: "no-store", headers: await withHeaders(input), body: JSON.stringify({ action: "create", version: input.version }) });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const request = body && body.success === true ? requestOf(body.request) : null;
      return request ? { ok: true, created: body.created === true, request } : { ok: false, message: REVIEW_REQUEST_ERRORS_AR.unavailable };
    }
    if (res.status === 409) {
      const code = REFUSALS.find((c) => c === body?.error);
      return { ok: false, message: code ? REVIEW_REQUEST_ERRORS_AR[code] : REVIEW_REQUEST_ERRORS_AR.unavailable };
    }
    return { ok: false, message: res.status === 404 ? REVIEW_REQUEST_ERRORS_AR.not_found : res.status === 401 ? REVIEW_REQUEST_ERRORS_AR.unauthorized : res.status === 500 ? REVIEW_REQUEST_ERRORS_AR.damaged : REVIEW_REQUEST_ERRORS_AR.unavailable };
  } catch {
    return { ok: false, message: REVIEW_REQUEST_ERRORS_AR.network };
  }
}

export type CancelResult = { ok: true } | { ok: false; message: string };

export async function cancelReviewRequest(input: { missionId: string; requestId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<CancelResult> {
  if (!isRequestId(input.requestId)) return { ok: false, message: REVIEW_REQUEST_ERRORS_AR.not_found };
  try {
    const res = await input.fetchFn(reviewRequestUrl(input.missionId), { method: "POST", cache: "no-store", headers: await withHeaders(input), body: JSON.stringify({ action: "cancel", requestId: input.requestId }) });
    if (res.ok) return { ok: true };
    return { ok: false, message: res.status === 409 ? REVIEW_REQUEST_ERRORS_AR.changed : res.status === 404 ? REVIEW_REQUEST_ERRORS_AR.not_found : res.status === 401 ? REVIEW_REQUEST_ERRORS_AR.unauthorized : REVIEW_REQUEST_ERRORS_AR.unavailable };
  } catch {
    return { ok: false, message: REVIEW_REQUEST_ERRORS_AR.network };
  }
}
