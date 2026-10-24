"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import type { JobDiagnostic } from "@/lib/server/zeroDeliveryDiagnostic";

/**
 * The admin-only reason a request delivered nothing: how many posts and rows were turned away for which reason, and a sample of at most five
 * rejected posts and five rejected rows (cut short). Loaded on demand from an admin route; no customer route carries these texts.
 */
const REASON_AR: Record<string, string> = {
  topic_not_in_text: "لا تذكر موضوع البحث", out_of_region: "خارج الدولة المطلوبة", no_text: "بلا نص", industry_mismatch: "مجال مختلف", other_mismatch: "أسباب أخرى",
};

export function JobDiagnosticPanel({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<{ diagnostic: JobDiagnostic | null } | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || data) return;
    setBusy(true);
    try {
      setData(await adminFetch<{ diagnostic: JobDiagnostic | null }>(`/api/admin/job-diagnostic?jobId=${encodeURIComponent(jobId)}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل تشخيص الطلب.");
    } finally { setBusy(false); }
  };

  const d = data?.diagnostic ?? null;
  return (
    <div className="col-span-full">
      <button type="button" onClick={toggle} aria-expanded={open} data-testid={`diagnostic-toggle-${jobId}`} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-xs text-ink">لماذا لم يُسلَّم شيء</button>
      {open && (
        <div className="mt-2 flex flex-col gap-3 rounded-[14px] border border-ln bg-bg p-3.5 text-xs text-ink2" data-testid={`diagnostic-panel-${jobId}`}>
          {busy && <p className="m-0 text-mut">جارٍ التحميل…</p>}
          {error && <p role="alert" className="m-0 text-bad">{error}</p>}
          {data && !d && <p className="m-0 text-mut">لا يوجد تشخيص محفوظ لهذا الطلب.</p>}
          {d && (
            <>
              <p className="m-0">المنشورات: روجع {formatAr(d.posts.judged)} · اعتُمد {formatAr(d.posts.adopted)} · استُبعد {formatAr(d.posts.excluded)} · قيد المراجعة {formatAr(d.posts.held)} · لم يُتحقق {formatAr(d.posts.unreviewed)}</p>
              <p className="m-0">السجلات: استُلم {formatAr(d.rows.received)} · خارج الفترة {formatAr(d.rows.outsideWindow)} · قُبل {formatAr(d.rows.accepted)} · استُبعد {formatAr(d.rows.excluded)} · قيد المراجعة {formatAr(d.rows.held)} · غير مراجَع {formatAr(d.rows.unreviewed)}</p>
              {Object.keys(d.rows.byReason).length > 0 && <p className="m-0">أسباب الاستبعاد: {Object.entries(d.rows.byReason).map(([code, n]) => `${REASON_AR[code] ?? code} ${formatAr(n ?? 0)}`).join("، ")}</p>}
              {([["منشورات مرفوضة (عينة)", d.samples.posts], ["سجلات مرفوضة (عينة)", d.samples.rows]] as const).map(([title, list]) => list.length > 0 && (
                <div key={title} className="flex flex-col gap-1">
                  <p className="m-0 font-semibold text-ink">{title}</p>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {list.map((sample, i) => <li key={i} className="rounded-xl bg-sf p-2.5"><span className="block break-words text-ink">{sample.text}</span><span className="block text-mut">{sample.reasonAr}</span></li>)}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
