"use client";

import { useCallback, useEffect, useState } from "react";
import { adminDownload, adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { CallsLogResult, CallStatus, TestFilter } from "@/lib/server/adminCallsLog";
import { dateTimeAr, tint } from "./format";
import { JobCell, NOT_RECORDED } from "./JobCell";

/**
 * The admin CALLS LOG: every provider API call with the user behind it (admin only, read only). Provider names are shown here because only an
 * admin sees this page. Server-side filters and pages; the summary is the sum of the filtered rows; the export is the same filtered result.
 */
const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const BTN = "min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs text-ink";

const PROVIDERS = [["treg", "TREG"], ["firecrawl", "Firecrawl"], ["contextdev", "Context.dev"]] as const;
const PROVIDER_NAME: Record<string, string> = { treg: "TREG", firecrawl: "Firecrawl", contextdev: "Context.dev" };
const STATUS_AR: Record<CallStatus, string> = { success: "نجح", failed: "فشل", empty: "بلا نتيجة" };
const STATUS_COLOR: Record<CallStatus, string> = { success: "var(--ok)", failed: "var(--bad)", empty: "var(--mut)" };
const UNAVAILABLE = "غير متاح";

/** Dollars with up to 6 decimals in Arabic-Indic digits (admin only). */
const usd = (n: number) => `${toArabicDigits(n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0")} دولار`;

interface Filters { provider: string; from: string; to: string; status: string; user: string; test: TestFilter; jobId: string; key: string }
const EMPTY: Filters = { provider: "", from: "", to: "", status: "", user: "", test: "all", jobId: "", key: "" };

function queryString(f: Filters, page?: number, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (f.provider) q.set("provider", f.provider);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.status) q.set("status", f.status);
  if (f.user.trim()) q.set("user", f.user.trim());
  if (f.test !== "all") q.set("test", f.test);
  if (f.jobId.trim()) q.set("jobId", f.jobId.trim());
  if (f.key) q.set("key", f.key);
  if (page) q.set("page", String(page));
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

export function AllCallsLog() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [log, setLog] = useState<CallsLogResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async (use: Filters, nextPage: number) => {
    setBusy(true);
    try {
      const r = await adminFetch<{ log: CallsLogResult }>(`/api/admin/calls-log?${queryString(use, nextPage)}`);
      setLog(r.log); setPage(r.log.page); setApplied(use); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل سجل الاستدعاءات.");
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(EMPTY, 1); }, [load]);

  const download = async (format: "csv" | "xlsx") => {
    setNote("");
    try {
      const r = await adminDownload(`/api/admin/calls-log/export?${queryString(applied, undefined, { format })}`, `calls-log.${format}`);
      setNote(r.capped ? `تم تنزيل أحدث ${formatAr(r.rows ?? 0)} استدعاء فقط (الحد الأقصى للتصدير ${formatAr(log?.exportCap ?? 0)}). ضيّق الفلاتر لتصدير الباقي.` : `تم تنزيل ${formatAr(r.rows ?? 0)} استدعاء.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "تعذر تنزيل الملف.");
    }
  };

  const pages = log ? Math.max(1, Math.ceil(log.total / log.pageSize)) : 1;
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-3.5" data-testid="all-calls-log">
      <section className={SECTION} aria-label="الفلاتر">
        <h3 className="m-0 text-[15px] font-semibold text-ink">سجل الاستدعاءات</h3>
        <p className="m-0 text-[11px] leading-[1.7] text-fnt">كل استدعاء لأي مزود (TREG وFirecrawl وContext.dev) مع المستخدم صاحب الطلب. قراءة فقط، والأحدث أولًا.</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">من تاريخ</span><input type="date" dir="ltr" value={filters.from} onChange={(e) => set({ from: e.target.value })} className={FIELD} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">إلى تاريخ</span><input type="date" dir="ltr" value={filters.to} onChange={(e) => set({ to: e.target.value })} className={FIELD} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">المزود</span>
            <select value={filters.provider} onChange={(e) => set({ provider: e.target.value })} className={FIELD} style={{ textAlign: "right" }}>
              <option value="">الكل</option>
              {PROVIDERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحالة</span>
            <select value={filters.status} onChange={(e) => set({ status: e.target.value })} className={FIELD} style={{ textAlign: "right" }}>
              <option value="">الكل</option>
              {(Object.keys(STATUS_AR) as CallStatus[]).map((k) => <option key={k} value={k}>{STATUS_AR[k]}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2"><span className="text-xs font-semibold text-mut">المستخدم (بريد أو اسم أو معرّف)</span><input type="text" value={filters.user} onChange={(e) => set({ user: e.target.value })} className={FIELD} placeholder="ابحث عن مستخدم" /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">نوع الحساب</span>
            <select value={filters.test} onChange={(e) => set({ test: e.target.value as TestFilter })} className={FIELD} style={{ textAlign: "right" }}>
              <option value="all">الكل</option><option value="test">تجريبي</option><option value="real">حقيقي</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">رقم المهمة</span><input type="text" dir="ltr" value={filters.jobId} onChange={(e) => set({ jobId: e.target.value })} className={FIELD} /></label>
          {log?.keyOptions && (
            <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">مفتاح TREG</span>
              <select value={filters.key} onChange={(e) => set({ key: e.target.value })} className={FIELD} style={{ textAlign: "right" }} data-testid="key-filter">
                <option value="">كل المفاتيح</option>
                <option value="none">بدون مجمّع (قبل التفعيل)</option>
                {log.keyOptions.map((k) => <option key={k.number} value={String(k.number)}>{`#${toArabicDigits(k.number)} · ${k.label} (${formatAr(k.calls)})`}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void load(filters, 1)} className={BTN}>{busy ? "جارٍ التحميل…" : "تطبيق"}</button>
          <button type="button" disabled={busy} onClick={() => { setFilters(EMPTY); void load(EMPTY, 1); }} className={BTN}>مسح الفلاتر</button>
          <button type="button" onClick={() => void download("csv")} className={BTN} data-testid="export-csv">تنزيل ملف نصي (يُفتح في إكسل)</button>
          <button type="button" onClick={() => void download("xlsx")} className={BTN} data-testid="export-xlsx">تنزيل ملف إكسل</button>
        </div>
        <p className="m-0 text-[11px] leading-[1.7] text-fnt">التصدير يشمل نتيجة الفلاتر المطبّقة فقط، بحد أقصى {formatAr(log?.exportCap ?? 20000)} استدعاء (الأحدث أولًا).</p>
        {note && <p role="status" className="m-0 text-[12px] text-ink">{note}</p>}
      </section>

      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}

      {log && (
        <section className={SECTION} aria-label="ملخص النتيجة" data-testid="calls-summary">
          <div className="grid gap-2 text-xs sm:grid-cols-4">
            <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">عدد الاستدعاءات</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{formatAr(log.summary.calls)}</p></div>
            <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">إجمالي التكلفة</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink" dir="ltr">{usd(log.summary.costUsd)}</p></div>
            <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">نجح / فشل / بلا نتيجة</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{formatAr(log.summary.byStatus.success)} / {formatAr(log.summary.byStatus.failed)} / {formatAr(log.summary.byStatus.empty)}</p>{log.summary.byStatus.unknown > 0 && <p className="m-0 mt-1 text-[11px] text-mut">{UNAVAILABLE}: {formatAr(log.summary.byStatus.unknown)}</p>}</div>
            <div className="rounded-xl bg-sf p-3"><p className="m-0 text-mut">الصفحة</p><p className="mb-0 mt-1 text-[15px] font-semibold text-ink">{formatAr(page)} من {formatAr(pages)}</p></div>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            {PROVIDERS.map(([id, label]) => {
              const p = log.summary.byProvider[id];
              const s = log.spendToday.find((x) => x.provider === id);
              return (
                <div key={id} className="rounded-xl bg-sf p-3" data-testid={`provider-card-${id}`}>
                  <p className="m-0 font-semibold text-ink">{label}</p>
                  <p className="m-0 mt-1 text-mut">{formatAr(p.calls)} استدعاء · <span dir="ltr">{usd(p.costUsd)}</span></p>
                  <p className="m-0 mt-1 text-mut">آخر استدعاء: {p.lastCallAt ? dateTimeAr(p.lastCallAt) : "—"}</p>
                  <p className="m-0 mt-1 text-mut">اليوم: <span dir="ltr">{s?.todayUsd === null || s?.todayUsd === undefined ? UNAVAILABLE : usd(s.todayUsd)}</span> من <span dir="ltr">{usd(s?.limitUsd ?? 0)}</span> (الحد اليومي)</p>
                </div>
              );
            })}
          </div>
          {log.summary.byKey && (
            <div className="grid gap-2 text-xs sm:grid-cols-4" data-testid="spend-per-key">
              {log.summary.byKey.map((k) => (
                <div key={k.keyNumber} className="rounded-xl bg-sf p-3"><p className="m-0 font-semibold text-ink">{`مفتاح #${toArabicDigits(k.keyNumber)} · ${k.keyLabel}`}</p><p className="m-0 mt-1 text-mut">{formatAr(k.calls)} استدعاء · <span dir="ltr">{usd(k.costUsd)}</span></p></div>
              ))}
            </div>
          )}
          {log.truncated && <p role="status" className="m-0 text-[12px] text-bad">تمت القراءة حتى الحد الأقصى الآمن؛ الأرقام تغطي ما قُرئ فقط.</p>}
        </section>
      )}

      {log && !log.metadataAvailable && (
        <p role="status" className="m-0 rounded-[14px] px-3.5 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: tint("var(--gold)", 14) }}>
          نوع الاستدعاء والحالة والمدة {UNAVAILABLE} حتى يُطبَّق تحديث قاعدة البيانات المقترح.{log.statusFilterUnavailable ? " لذلك لم يُطبَّق فلتر الحالة." : ""}
        </p>
      )}

      <section className={SECTION} aria-label="الاستدعاءات">
        {log && log.rows.length === 0 && !error && <p className="m-0 text-[13px] text-mut">لا توجد استدعاءات بهذه المعايير.</p>}
        {log && log.rows.length > 0 && (
          <div className="rtable-wrap overflow-x-auto">
            <table className="rtable w-full border-collapse text-[11px] @min-[860px]:min-w-[980px]" data-testid="calls-table">
              <thead><tr className="text-mut">{["الوقت", "المزود", ...(log.keyOptions ? ["المفتاح"] : []), "نوع الاستدعاء", "المهمة والمستخدم", "الوحدات", "التكلفة", "الحالة", "المدة"].map((c) => <th key={c} scope="col" className="border-b border-ln py-2 text-start font-medium">{c}</th>)}</tr></thead>
              <tbody>
                {log.rows.map((r, i) => {
                  const missing = log.metadataAvailable ? NOT_RECORDED : UNAVAILABLE;
                  const status = r.status ?? r.statusDerived ?? null;
                  return (
                    <tr key={r.id ?? i} className="text-ink">
                      <td data-label="الوقت" className="border-b border-ln py-2">{dateTimeAr(r.at)}</td>
                      <td data-label="المزود" className="border-b border-ln py-2" dir="ltr">{PROVIDER_NAME[r.provider] ?? r.provider}</td>
                      {log.keyOptions && <td data-label="المفتاح" className="border-b border-ln py-2" data-testid="key-cell">{typeof r.keyNumber === "number" ? `#${toArabicDigits(r.keyNumber)} · ${r.keyLabel ?? ""}` : "—"}</td>}
                      <td data-label="نوع الاستدعاء" className="border-b border-ln py-2">{r.capabilityLabelAr ?? (r.capabilityDerivedAr ? `${r.capabilityDerivedAr} (من المهمة)` : missing)}</td>
                      <td data-label="المهمة والمستخدم" className="border-b border-ln py-2"><JobCell info={r} /></td>
                      <td data-label="الوحدات" className="border-b border-ln py-2">{formatAr(r.units)}</td>
                      <td data-label="التكلفة" className="border-b border-ln py-2" dir="ltr">{usd(r.costUsd)}{r.isEstimate ? " · تقدير" : ""}</td>
                      <td data-label="الحالة" className="border-b border-ln py-2" style={{ color: status ? STATUS_COLOR[status] : undefined }}>{status ? `${STATUS_AR[status]}${r.status ? "" : " (مُستنتج)"}` : missing}</td>
                      <td data-label="المدة" className="border-b border-ln py-2">{r.durationMs === null ? missing : `${formatAr(r.durationMs)} مللي ثانية`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {log && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-mut">صفحة {formatAr(page)} من {formatAr(pages)} · {formatAr(log.total)} استدعاء</span>
            <div className="flex gap-2">
              <button type="button" disabled={busy || page <= 1} onClick={() => void load(applied, page - 1)} className={BTN} style={{ opacity: page <= 1 ? 0.5 : 1 }}>السابق</button>
              <button type="button" disabled={busy || page >= pages} onClick={() => void load(applied, page + 1)} className={BTN} style={{ opacity: page >= pages ? 0.5 : 1 }}>التالي</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
