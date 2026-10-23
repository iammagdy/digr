"use client";

import { toArabicDigits } from "@/lib/arabicDigits";
import { tint } from "./format";

/** What the admin sees where an old row has no metadata of its own and nothing can be read from its job (read only, no write). */
export const NOT_RECORDED = "غير مسجّل (قبل التحديث)";

export interface JobCellInfo {
  jobId: string | null;
  jobLabelAr?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  isTestAccount?: boolean;
  jobHref?: string | null;
}

/**
 * The job behind a provider call, for the owner: a short Arabic label of the job (type — topic), the user's email with the test-account badge
 * and a link to the job's admin view. Admin only. When the job cannot be read the cell still shows the short job id.
 */
export function JobCell({ info }: { info: JobCellInfo }) {
  if (!info.jobId) return <span>—</span>;
  const shortId = toArabicDigits(String(info.jobId).slice(-8));
  const label = info.jobLabelAr || `مهمة ${shortId}`;
  const who = info.userEmail || info.userName || "";
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-testid="job-cell">
      {info.jobHref ? <a href={info.jobHref} className="break-words font-semibold text-ink underline decoration-ln2 underline-offset-2" data-testid="job-link">{label}</a> : <span className="break-words font-semibold text-ink">{label}</span>}
      {who && <span className="break-all text-mut" dir="ltr">{who}</span>}
      {info.isTestAccount && <span className="w-fit rounded-full px-2 py-[1px] text-[10px] font-semibold text-goldT" style={{ background: tint("var(--gold)", 16) }}>حساب تجريبي</span>}
      {info.jobLabelAr && <span className="text-fnt" dir="ltr">{shortId}</span>}
    </span>
  );
}
