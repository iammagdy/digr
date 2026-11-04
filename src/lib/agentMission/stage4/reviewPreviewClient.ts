import { REVIEW_ERRORS_AR, type ReviewQuoteView, type ReviewVersionChoice } from "./reviewPreviewLabels";

/**
 * MONEY PR 7c, 2B-2 task 2: THE BROWSER'S SIDE OF THE REVIEW PREVIEW (client-safe: no server module). It ASKS the review route of the customer's own mission and hands back exactly what the server answered; it computes no price. `fetch` and the
 * bearer header are injected, so every path is tested without a browser. A failure is a controlled Arabic sentence; a list that cannot be read is «nothing to show» (the section stays hidden, as it does while the feature is off).
 */
export const reviewQuoteUrl = (missionId: string, version?: number): string => `/api/missions/${encodeURIComponent(missionId)}/review-quote${version === undefined ? "" : `?version=${version}`}`;

const REASONS = ["delivery", "edit", "review_fix"];
const isVersionNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The published versions the page may offer (oldest first); `[]` for any answer that is not a clean list (the feature off, signed out, an outage, a malformed answer). */
export async function fetchReviewVersions(input: { missionId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<ReviewVersionChoice[]> {
  try {
    const res = await input.fetchFn(reviewQuoteUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return [];
    const body = await res.json();
    if (!body || body.success !== true || !Array.isArray(body.versions)) return [];
    return (body.versions as unknown[])
      .filter((v): v is ReviewVersionChoice => Boolean(v) && typeof v === "object" && isVersionNumber((v as any).version) && REASONS.includes((v as any).reason))
      .map((v) => ({ version: v.version, reason: v.reason }))
      .sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

/** The answer's quote, only if it is exactly one of the shapes the words know (an offer without a whole-number price is not an offer). */
function quoteOf(raw: any): ReviewQuoteView | null {
  if (!raw || typeof raw !== "object" || !isVersionNumber(raw.version) || !REASONS.includes(raw.reason)) return null;
  const base = { version: raw.version as number, reason: raw.reason as ReviewQuoteView["reason"] };
  switch (raw.state) {
    case "offer": return isCount(raw.cells) && isCount(raw.points) ? { state: "offer", ...base, cells: raw.cells, points: raw.points } : null;
    case "reuse": case "blocked": return { state: raw.state, ...base };
    case "too_large": case "nothing_to_review": return isCount(raw.cells) ? { state: raw.state, ...base, cells: raw.cells } : null;
    default: return null;
  }
}

export type ReviewQuoteResult = { ok: true; quote: ReviewQuoteView } | { ok: false; message: string };
const messageOfStatus = (status: number): string =>
  status === 404 ? REVIEW_ERRORS_AR.not_found : status === 401 ? REVIEW_ERRORS_AR.unauthorized : status === 500 ? REVIEW_ERRORS_AR.damaged : REVIEW_ERRORS_AR.unavailable;

export async function fetchReviewQuote(input: { missionId: string; version: number; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<ReviewQuoteResult> {
  if (!isVersionNumber(input.version)) return { ok: false, message: REVIEW_ERRORS_AR.not_found };
  try {
    const res = await input.fetchFn(reviewQuoteUrl(input.missionId, input.version), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return { ok: false, message: messageOfStatus(res.status) };
    const body = await res.json().catch(() => null);
    const quote = body && body.success === true ? quoteOf(body.quote) : null;
    return quote ? { ok: true, quote } : { ok: false, message: REVIEW_ERRORS_AR.unavailable };
  } catch {
    return { ok: false, message: REVIEW_ERRORS_AR.network };
  }
}
