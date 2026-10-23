"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { CallLogResult, CallLogStatus } from "@/lib/server/multiProvider/callLog";
import { dateTimeAr, tint } from "./format";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const BTN = "min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs text-ink";

const STATUS_AR: Record<CallLogStatus, string> = { success: "نجح", failed: "فشل", empty: "بلا نتيجة" };
const STATUS_COLOR: Record<CallLogStatus, string> = { success: "var(--ok)", failed: "var(--bad)", empty: "var(--mut)" };
const UNAVAILABLE = "غير متاح";

/** Dollars with up to 6 decimals in Arabic-Indic digits (admin only). */
const usd = (n: number) => `${toArabicDigits(n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0")} دولار`;

/**
 * The API call log of one provider (admin only, read only): newest first, 25 per page, filters by date and status, today's and the total
 * cost read from the platform's own cost table. A field the database does not know yet shows «غير متاح»; nothing is invented.
 */
export function ProviderCallLog({ provider }: { provider: "treg" | "firecrawl" | "contextdev" }) {
  const [log, setLog] = useState<CallLogResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<"" | CallLogStatus>("");

  const load = useCallback(async (nextPage: number) => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ provider, page: String(nextPage) });
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (status) q.set("status", status);
      const r = await adminFetch<{ log: CallLogResult }>(`/api/admin/provider-calls?${q.toString()}`);
      setLog(r.log); setPage(r.log.page); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل سجل الاستدعاءات.");
    } finally { setBusy(false); }
  }, [provider, from, to, status]);

  useEffect(() => { void load(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [provider]);

  const pages = log ? Math.max(1, Math.ceil(log.total / log.pageSize)) : 1;

  return (
    <section className={SECTION} aria-label="سجل الاستدعاءات" data-testid={`provider-call-log-${provider}`}>
      <h3 className="m-0 text-[15px] font-semibold text-ink">سجل الاستدعاءات</h3>
      <p className="m-0 text-[11px] leading-[1.7] text-fnt">كل استدعاء لهذا المزود مسجّل في جدول التكاليف الداخلي (قراءة فقط). الأحدث أولًا، ٢٥ في الصفحة.</p>

      {log && (
        <div className="grid gap-2 text-xs sm:grid-cols-3" aria-label="ملخص التكلفة">
          <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">تكلفة اليوم</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{usd(log.summary.todayUsd)}</p></div>
          <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">إجمالي التكلفة المسجّلة</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{usd(log.summary.totalUsd)}</p></div>
          <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">عدد الاستدعاءات المسجّلة</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{formatAr(log.summary.totalCalls)}</p></div>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">من تاريخ</span><input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">إلى تاريخ</span><input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحالة</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as "" | CallLogStatus)} className={FIELD} style={{ textAlign: "right" }}>
            <option value="">الكل</option>
            {(Object.keys(STATUS_AR) as CallLogStatus[]).map((k) => <option key={k} value={k}>{STATUS_AR[k]}</option>)}
          </select>
        </label>
        <div className="flex items-end"><button type="button" disabled={busy} onClick={() => void load(1)} className={BTN}>{busy ? "جارٍ التحميل…" : "تطبيق"}</button></div>
      </div>

      {log && !log.metadataAvailable && (
        <p role="status" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: tint("var(--gold)", 14) }}>
          نوع الاستدعاء والحالة والمدة {UNAVAILABLE} حتى يُطبَّق تحديث قاعدة البيانات المقترح؛ يظهر الوقت والمهمة والوحدات والتكلفة كما هي مسجّلة.{log.statusFilterUnavailable ? " لذلك لم يُطبَّق فلتر الحالة." : ""}
        </p>
      )}
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}

      {log && log.rows.length === 0 && !error && <p className="m-0 text-[13px] text-mut">لا توجد استدعاءات مسجّلة بهذه المعايير.</p>}
      {log && log.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[11px]">
            <thead><tr className="text-mut">{["الوقت", "نوع الاستدعاء", "المهمة", "الوحدات", "التكلفة", "الحالة", "المدة"].map((c) => <th key={c} className="border-b border-ln py-2 text-right font-medium">{c}</th>)}</tr></thead>
            <tbody>
              {log.rows.map((r, i) => (
                <tr key={r.id ?? i} className="text-ink">
                  <td className="border-b border-ln py-2">{dateTimeAr(r.at)}</td>
                  <td className="border-b border-ln py-2">{r.capabilityLabelAr ?? UNAVAILABLE}</td>
                  <td className="border-b border-ln py-2" dir="ltr">{r.jobId ? toArabicDigits(String(r.jobId).slice(-8)) : "—"}</td>
                  <td className="border-b border-ln py-2">{formatAr(r.units)}</td>
                  <td className="border-b border-ln py-2" dir="ltr">{usd(r.costUsd)}{r.isEstimate ? " · تقدير" : ""}</td>
                  <td className="border-b border-ln py-2" style={{ color: r.status ? STATUS_COLOR[r.status] : undefined }}>{r.status ? STATUS_AR[r.status] : UNAVAILABLE}</td>
                  <td className="border-b border-ln py-2">{r.durationMs === null ? UNAVAILABLE : `${formatAr(r.durationMs)} مللي ثانية`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-mut">صفحة {formatAr(page)} من {formatAr(pages)} · {formatAr(log.total)} استدعاء</span>
          <div className="flex gap-2">
            <button type="button" disabled={busy || page <= 1} onClick={() => void load(page - 1)} className={BTN} style={{ opacity: page <= 1 ? 0.5 : 1 }}>السابق</button>
            <button type="button" disabled={busy || page >= pages} onClick={() => void load(page + 1)} className={BTN} style={{ opacity: page >= pages ? 0.5 : 1 }}>التالي</button>
          </div>
        </div>
      )}

      {log && log.summary.daily.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-ln pt-2">
          <p className="m-0 text-xs font-semibold text-mut">التكلفة اليومية (آخر ٣٠ يومًا)</p>
          {log.summary.daily.slice(0, 10).map((d) => (
            <p key={d.day} className="m-0 text-[11px] leading-[1.7] text-ink">{toArabicDigits(d.day)} — {usd(d.costUsd)} · {formatAr(d.calls)} استدعاء</p>
          ))}
        </div>
      )}
    </section>
  );
}
