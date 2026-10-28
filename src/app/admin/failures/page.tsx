"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface Attempt { endpoint: string; outcome: string; httpStatus?: number | null }
interface Row { id: string; kind: string; at: string; cairoAt: string; userId: string | null; userEmail: string | null; isTest: boolean; requestText: string; service: string; attempts: Attempt[]; reasonAr: string; providerUsd: number; modelUsd: number | null; jobId: string | null; jobHref: string | null; requestId: string | null; retryable: boolean }
interface Summary { service: string; reasonAr: string; last24h: number; last7d: number }
interface Board { kinds: Record<string, string>; rows: Row[]; summary: Summary[]; partial: string[] }
interface Retry { outcome: string; customerText: string; endpoints: string[]; attempts: Array<{ endpoint: string; outcome: string; httpStatus: number; costUsd: number }>; unitPricePoints: number | null; turns: number; modelUsd: number; providerUsd: number; capUsd: number; overCap: boolean; endReason: string }

/** USD with Arabic-Indic digits: this screen is admin-only, one of the few places a cost in dollars is shown. */
const usd = (n: number | null) => (n === null ? "—" : `${toArabicDigits(n.toFixed(4))} دولار`);
const OUTCOME_AR: Record<string, string> = { plan: "خطة جاهزة", question: "سؤال للعميل", refusal: "رفض", restricted: "خدمة مقيّدة", purpose: "يطلب الغرض" };

export default function FailuresPage() {
  const { toast } = useAdmin();
  const [board, setBoard] = useState<Board | null>(null);
  const [hideTest, setHideTest] = useState(true);
  const [kind, setKind] = useState("all");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Retry>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try { setBoard(await adminFetch<Board>(`/api/admin/failures?hideTest=${hideTest ? "1" : "0"}`)); }
    catch (e) { toast(e instanceof Error ? e.message : "تعذّر التحميل"); }
    finally { setLoading(false); }
  }, [hideTest, toast]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (board?.rows ?? []).filter((r) => kind === "all" || r.kind === kind), [board, kind]);

  async function retry(row: Row) {
    if (retrying) return;
    setRetrying(row.id);
    try {
      const res = await adminFetch<{ result: Retry }>("/api/admin/failures/retry", { method: "POST", body: JSON.stringify({ requestText: row.requestText, runId: `f${Date.now().toString(36)}` }) });
      setResults((prev) => ({ ...prev, [row.id]: res.result }));
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّرت إعادة التجربة"); }
    finally { setRetrying(null); }
  }

  return (
    <div className="flex flex-col gap-4" dir="rtl" style={{ maxWidth: 1100 }}>
      <section className={SECTION} aria-label="لوحة الأعطال">
        <h2 className="m-0 text-base font-semibold text-ink">لوحة الأعطال</h2>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">كل عملية فشلت أو رجعت فارغة خلال آخر ٧ أيام، من البيانات الموجودة: مهام فشلت أو لم تُسلِّم شيئًا أو سلّمت جزءًا، ودورات تخطيط انتهت دون خطة، وعيّنات فشلت قبل الموافقة. «أعد التجربة» تعيد الطلب وحده عبر المخطط وتتوقف قبل أي موافقة، بحدّ ٠٫٠٥ دولار.</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={hideTest} onChange={(e) => setHideTest(e.target.checked)} data-testid="failures-hide-test" />إخفاء حسابات الاختبار</label>
          <select aria-label="نوع العطل" value={kind} onChange={(e) => setKind(e.target.value)} className="min-h-11 rounded-xl border border-ln2 bg-sf px-3 text-sm text-ink">
            <option value="all">كل الأنواع</option>
            {Object.entries(board?.kinds ?? {}).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="button" className={BTN} onClick={() => void load()} disabled={loading}>{loading ? "جارٍ التحميل…" : "تحديث"}</button>
        </div>
        {board?.partial.length ? <p className="m-0 text-[13px] text-bad" role="status">تعذّرت قراءة جزء من البيانات: {board.partial.join("، ")}.</p> : null}
      </section>

      <section className={SECTION} aria-label="الملخص">
        <h3 className="m-0 text-[13px] font-semibold text-ink">الملخص حسب الخدمة والسبب</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]" data-testid="failures-summary">
            <thead><tr className="text-right text-ink2"><th className="border-b border-ln px-2 py-1">الخدمة</th><th className="border-b border-ln px-2 py-1">السبب</th><th className="border-b border-ln px-2 py-1">٢٤ ساعة</th><th className="border-b border-ln px-2 py-1">٧ أيام</th></tr></thead>
            <tbody>
              {(board?.summary ?? []).map((s, i) => <tr key={i}><td className="border-b border-ln px-2 py-1">{s.service}</td><td className="border-b border-ln px-2 py-1">{s.reasonAr}</td><td className="border-b border-ln px-2 py-1">{toArabicDigits(s.last24h)}</td><td className="border-b border-ln px-2 py-1">{toArabicDigits(s.last7d)}</td></tr>)}
              {board && board.summary.length === 0 ? <tr><td colSpan={4} className="px-2 py-3 text-ink2">لا أعطال في هذه الفترة.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className={SECTION} aria-label="الأعطال">
        <h3 className="m-0 text-[13px] font-semibold text-ink">الأعطال ({toArabicDigits(rows.length)})</h3>
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="failures-list">
          {rows.map((r) => (
            <li key={r.id} className="rounded-[14px] border border-ln bg-sf p-3 text-[12px] leading-[1.8]" data-testid="failure-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">{board?.kinds[r.kind] ?? r.kind} · {r.service}</span>
                <span className="text-ink2" dir="ltr">{r.cairoAt} (القاهرة)</span>
              </div>
              <p className="m-0 mt-1 text-ink"><span className="text-ink2">الحساب: </span><span dir="ltr">{r.userEmail ?? r.userId ?? "—"}</span>{r.isTest ? <span className="ms-2 rounded-md border border-ln2 px-1.5 py-0.5 text-[11px] text-ink2" data-testid="failure-test-badge">اختبار</span> : null}</p>
              <p className="m-0 mt-1 text-ink"><span className="text-ink2">الطلب: </span>{r.requestText || "غير مسجّل"}</p>
              <p className="m-0 mt-1 text-ink"><span className="text-ink2">السبب: </span>{r.reasonAr}</p>
              {r.attempts.length > 0 ? <p className="m-0 mt-1 text-ink2" dir="ltr">{r.attempts.map((a) => `${a.endpoint} = ${a.outcome}${a.httpStatus ? `/${a.httpStatus}` : ""}`).join(" ; ")}</p> : null}
              <p className="m-0 mt-1 text-ink2">تكلفة المصدر {usd(r.providerUsd)} · تكلفة النموذج {usd(r.modelUsd)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {r.jobHref ? <a href={r.jobHref} className="text-ink underline">افتح المهمة</a> : null}
                <button type="button" className={BTN} disabled={!r.retryable || retrying !== null} onClick={() => void retry(r)} data-testid="failure-retry" title={r.retryable ? "" : "لا نص محفوظ لهذا الطلب"}>{retrying === r.id ? "جارٍ التجربة…" : "أعد التجربة"}</button>
              </div>
              {results[r.id] ? (
                <div className="mt-2 rounded-[12px] border border-ln bg-bg p-2.5" data-testid="failure-retry-result">
                  <p className="m-0 font-semibold text-ink">{OUTCOME_AR[results[r.id].outcome] ?? results[r.id].outcome}: {results[r.id].customerText}</p>
                  {results[r.id].endpoints.length > 0 ? <p className="m-0 text-ink2" dir="ltr">{results[r.id].endpoints.join(" > ")}</p> : null}
                  <p className="m-0 text-ink2">النموذج {usd(results[r.id].modelUsd)} · المصدر {usd(results[r.id].providerUsd)} من حدّ {usd(results[r.id].capUsd)}{results[r.id].overCap ? " · تجاوز الحد" : ""}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
