import { REPORT_ERRORS_AR, type ReviewReportView } from "./reviewReportLabels";

/**
 * STAGE A: THE BROWSER'S SIDE OF THE REVIEW REPORT (client-safe: no server module). It only READS: GET, no body, no cache. It hands back exactly the fields of the view and nothing else the server might add, and it shows nothing it cannot validate.
 * `fetch` and the bearer header are injected, so every path is tested without a browser. A failure is a controlled Arabic sentence; only a temporary one can be retried.
 */
export const reviewReportUrl = (missionId: string, version?: number): string => `/api/missions/${encodeURIComponent(missionId)}/review-report${version === undefined ? "" : `?version=${version}`}`;

const isVersionNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const CODES = ["empty_cells", "invalid_email", "invalid_phone", "invalid_link", "invalid_date", "exact_duplicate", "stated_gap"];
const REASONS = ["delivery", "edit", "review_fix"];
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The answer's report, only if it is exactly a well-formed view (a score is a whole number from 0 to 100; every issue has a code of the review, a count of at least one and its sentence). Any other field is dropped. */
function reportOf(raw: any): ReviewReportView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isVersionNumber(raw.version) || !REASONS.includes(raw.reason) || !Number.isInteger(raw.score) || raw.score < 0 || raw.score > 100 || !isCount(raw.cells) || !isCount(raw.rowsReviewed) || !isText(raw.reviewedAt) || !Array.isArray(raw.issues)) return null;
  const issues: ReviewReportView["issues"] = [];
  for (const i of raw.issues) {
    if (!i || typeof i !== "object" || !CODES.includes(i.code) || !isText(i.sheet) || !isText(i.column) || !Number.isInteger(i.count) || i.count < 1 || !isText(i.textAr)) return null;
    issues.push({ code: i.code, sheet: i.sheet, column: i.column, count: i.count, textAr: i.textAr });
  }
  return { version: raw.version, reason: raw.reason, score: raw.score, cells: raw.cells, rowsReviewed: raw.rowsReviewed, reviewedAt: raw.reviewedAt, issues };
}

type Headers = () => Promise<Record<string, string>>;

export type ReviewedVersionsResult =
  | { state: "ok"; versions: number[] }
  /** The feature is off, the customer is signed out, or nothing is theirs: the page draws nothing. */
  | { state: "off" }
  | { state: "error"; message: string };

/** The versions that have a published report (sorted, each once). */
export async function fetchReviewedVersions(input: { missionId: string; fetchFn: typeof fetch; headers: Headers }): Promise<ReviewedVersionsResult> {
  try {
    const res = await input.fetchFn(reviewReportUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (res.status === 404 || res.status === 401) return { state: "off" };
    if (!res.ok) return { state: "error", message: REPORT_ERRORS_AR.unavailable };
    const body = await res.json().catch(() => null);
    if (!body || body.success !== true || !Array.isArray(body.versions) || !body.versions.every(isVersionNumber)) return { state: "error", message: REPORT_ERRORS_AR.unavailable };
    return { state: "ok", versions: [...new Set<number>(body.versions)].sort((a, b) => a - b) };
  } catch {
    return { state: "error", message: REPORT_ERRORS_AR.network };
  }
}

export type ReviewReportResult = { ok: true; report: ReviewReportView } | { ok: false; message: string; retryable: boolean };

export async function fetchReviewReport(input: { missionId: string; version: number; fetchFn: typeof fetch; headers: Headers }): Promise<ReviewReportResult> {
  if (!isVersionNumber(input.version)) return { ok: false, message: REPORT_ERRORS_AR.not_found, retryable: false };
  try {
    const res = await input.fetchFn(reviewReportUrl(input.missionId, input.version), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) {
      if (res.status === 404) return { ok: false, message: REPORT_ERRORS_AR.not_found, retryable: false };
      if (res.status === 401) return { ok: false, message: REPORT_ERRORS_AR.unauthorized, retryable: false };
      if (res.status === 500) return { ok: false, message: REPORT_ERRORS_AR.damaged, retryable: false };
      return { ok: false, message: REPORT_ERRORS_AR.unavailable, retryable: true };
    }
    const body = await res.json().catch(() => null);
    const report = body && body.success === true ? reportOf(body.report) : null;
    return report ? { ok: true, report } : { ok: false, message: REPORT_ERRORS_AR.unavailable, retryable: true };
  } catch {
    return { ok: false, message: REPORT_ERRORS_AR.network, retryable: true };
  }
}
