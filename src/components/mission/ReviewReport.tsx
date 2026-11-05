"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { REPORT_FREE_AR, REPORT_FULL_SCORE_AR, REPORT_HEADING_AR, REPORT_ISSUES_HEADING_AR, REPORT_LOADING_AR, REPORT_NO_ISSUES_AR, REPORT_PICK_AR, REPORT_RETRY_AR, REPORT_SCOPE_AR, reportVersionOptionAr, reviewReportLinesAr, type ReviewReportView } from "@/lib/agentMission/stage4/reviewReportLabels";
import { fetchReviewedVersions, fetchReviewReport } from "@/lib/agentMission/stage4/reviewReportClient";

/**
 * STAGE A: «نتيجة مراجعة الملف» on the request's own page, under the review section. It READS the report the server already checked against the reviewed version (docs: reviewReport.ts) and shows: which version was reviewed, the score out of 100, the cells checked, the items
 * reviewed and every issue the checks found, each with its plain Arabic sentence. It says what the score is (automated checks) and what it is not (proof that the data is true); a score of 100 is never described as proof. Showing a stored report is free and makes no request:
 * there is NO price, approval or payment control here. While the feature is off (the route answers 404), or no version has a report, it draws NOTHING, so the page is what it was.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 sm:w-auto";
const SELECT = "min-h-11 w-full rounded-[12px] border border-ln2 bg-transparent px-3 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-60 sm:w-auto";

export interface ReviewReportBodyProps {
  /** The versions that have a published report. */
  reported: ReadonlyArray<number>;
  selected: number | null;
  onSelect: (version: number) => void;
  status: "idle" | "loading" | "ready" | "error";
  report?: ReviewReportView | null;
  error?: string | null;
  onRetry?: () => void;
}

export function ReviewReportBody({ reported, selected, onSelect, status, report = null, error = null, onRetry }: ReviewReportBodyProps) {
  if (status === "idle" || (reported.length === 0 && status !== "error")) return null;
  const head = <h2 id="review-report-heading" className="m-0 text-[15px] font-medium text-ink">{REPORT_HEADING_AR}</h2>;
  const picker = reported.length > 1 ? (
    <label className="flex flex-col gap-1 text-[13px] text-ink">
      <span>{REPORT_PICK_AR}</span>
      <select data-testid="review-report-version" className={SELECT} value={selected ?? ""} disabled={status === "loading"} onChange={(e) => onSelect(Number(e.target.value))}>
        {reported.map((v) => <option key={v} value={v}>{reportVersionOptionAr(v)}</option>)}
      </select>
    </label>
  ) : null;
  return (
    <section data-testid="review-report" aria-labelledby="review-report-heading" dir="rtl" className="flex flex-col gap-3 break-words rounded-[18px] border border-ln bg-sf p-4">
      {head}
      {picker}
      {status === "loading" ? <p role="status" aria-busy="true" data-testid="review-report-loading" className="m-0 text-[13px] leading-[1.9] text-ink2">{REPORT_LOADING_AR}</p> : null}
      {status === "error" ? (
        <div className="flex flex-col gap-2">
          <p role="alert" data-testid="review-report-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p>
          {onRetry ? <button type="button" data-testid="review-report-retry" className={BTN} onClick={onRetry}>{REPORT_RETRY_AR}</button> : null}
        </div>
      ) : null}
      {status === "ready" && report ? (
        <div className="flex flex-col gap-3" data-testid="review-report-body">
          <div className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
            {reviewReportLinesAr(report).map((line, i) => <p key={i} className={i === 1 ? "m-0 text-[18px] font-medium" : "m-0 text-ink2"}>{line}</p>)}
            <p className="m-0 text-[12px] text-mut"><time dateTime={report.reviewedAt}>{reviewedOnAr(report.reviewedAt)}</time></p>
          </div>
          <p data-testid="review-report-scope" className="m-0 text-[13px] leading-[1.9] text-ink2">{REPORT_SCOPE_AR}</p>
          {report.score === 100 ? <p data-testid="review-report-full-score" className="m-0 text-[13px] leading-[1.9] text-ink">{REPORT_FULL_SCORE_AR}</p> : null}
          {report.issues.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] font-medium text-ink">{REPORT_ISSUES_HEADING_AR}</h3>
              <ul data-testid="review-report-issues" className="m-0 flex list-disc flex-col gap-1 ps-5 text-[13px] leading-[1.9] text-ink2">
                {report.issues.map((issue, i) => <li key={i}>{issue.textAr}</li>)}
              </ul>
            </div>
          ) : <p data-testid="review-report-clean" className="m-0 text-[13px] leading-[1.9] text-ink">{REPORT_NO_ISSUES_AR}</p>}
          <p className="m-0 text-[12px] leading-[1.9] text-mut">{REPORT_FREE_AR}</p>
        </div>
      ) : null}
    </section>
  );
}

/** «١٤ نوفمبر ٢٠٢٦»: the day the review was made, in UTC so the server and the browser write the same day. */
function reviewedOnAr(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `تاريخ المراجعة: ${d.toLocaleDateString("ar-EG", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function ReviewReport({ missionId }: { missionId: string }) {
  const [reported, setReported] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<ReviewReportBodyProps["status"]>("idle");
  const [report, setReport] = useState<ReviewReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);

  const load = useCallback(async (version: number, alive: () => boolean) => {
    setStatus("loading"); setReport(null); setError(null);
    const r = await fetchReviewReport({ missionId, version, fetchFn: fetch, headers: authHeaders });
    if (!alive()) return;
    if (r.ok) { setReport(r.report); setStatus("ready"); }
    else { setError(r.message); setRetryable(r.retryable); setStatus("error"); }
  }, [missionId]);

  const start = useCallback(async (alive: () => boolean) => {
    const list = await fetchReviewedVersions({ missionId, fetchFn: fetch, headers: authHeaders });
    if (!alive()) return;
    if (list.state === "off") { setStatus("idle"); return; }
    if (list.state === "error") { setReported([]); setError(list.message); setRetryable(true); setStatus("error"); return; }
    setReported(list.versions);
    if (list.versions.length === 0) { setStatus("idle"); return; }
    const latest = list.versions[list.versions.length - 1];
    setSelected(latest);
    await load(latest, alive);
  }, [missionId, load]);

  useEffect(() => {
    let alive = true;
    void start(() => alive);
    return () => { alive = false; };
  }, [start]);

  const onSelect = useCallback((version: number) => { setSelected(version); void load(version, () => true); }, [load]);
  const onRetry = useCallback(() => { if (selected === null) void start(() => true); else void load(selected, () => true); }, [selected, start, load]);
  return <ReviewReportBody reported={reported} selected={selected} onSelect={onSelect} status={status} report={report} error={error} onRetry={retryable ? onRetry : undefined} />;
}
