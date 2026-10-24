"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { tint } from "@/components/admin/format";
import { dayLabel } from "@/lib/dayLabel";
import { RoutingTracePanel } from "@/components/admin/RoutingTracePanel";
import { JobDiagnosticPanel } from "@/components/admin/JobDiagnosticPanel";
import { ADMIN_JOB_STATE_LABEL_AR, type AdminJobState } from "@/lib/server/adminJobState";
import { HIDE_TEST_ACCOUNTS_LABEL_AR } from "@/lib/server/adminTestAccounts";

interface JobRow { id: string; title: string; platform: string; createdAt: string; user: string; requested: number | null; delivered: number; held: number; charged: number; costUsd: number | null; chain?: boolean; status: AdminJobState }
interface OpenJob { id: string; status: AdminJobState; label: string; ageMinutes: number; idleMinutes: number }
interface Resp {
  hideTest: boolean;
  jobs: JobRow[];
  open: OpenJob[];
  stats: {
    last30: number;
    runningNow: number;
    stalled: number;
    queuedStuck: number;
    success: { numerator: number; denominator: number; percent: number | null; failedWithDelivery: number };
    released: { points: number; rows: number };
  };
}

const STATE_COLOR: Record<AdminJobState, string> = {
  done: "var(--ok)",
  refunded: "var(--goldT)",
  failed: "var(--bad)",
  refused: "var(--bad)",
  running: "var(--info)",
  queued: "var(--info)",
  queued_stuck: "var(--goldT)",
  stalled: "var(--bad)",
  unknown: "var(--mut)",
};
const TABS: Array<[string, string]> = [["all", "الكل"], ["running", "قيد التنفيذ"], ["done", "مكتمل"], ["failed", "فشل"], ["refunded", "حجز مُحرَّر"]];
const COLS = "minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.7fr) minmax(0,.8fr)";
const usd = (value: number) => `${formatAr(value, 4)} دولار`;
const ENDED_NEEDS_DIAGNOSTIC: AdminJobState[] = ["refunded", "failed", "refused"];

export default function AdminJobsPage() {
  const { isMobile } = useAdmin();
  const [filter, setFilter] = useState("all");
  // «إخفاء حسابات الاختبار» is on by default. It only changes what is shown; no row is read differently or changed.
  const [hideTest, setHideTest] = useState(true);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  // Opened from a call log: `?job=<id>` shows that one job.
  const [oneJob, setOneJob] = useState("");
  useEffect(() => {
    try { setOneJob(new URLSearchParams(window.location.search).get("job") || ""); } catch { setOneJob(""); }
  }, []);

  useEffect(() => {
    const q = oneJob ? `&job=${encodeURIComponent(oneJob)}` : "";
    adminFetch<Resp>(`/api/admin/jobs?status=${oneJob ? "all" : filter}&hideTest=${hideTest ? 1 : 0}${q}`).then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  }, [filter, oneJob, hideTest]);

  const s = data?.stats;
  const successSub = s
    ? `${formatAr(s.success.numerator)} من ${formatAr(s.success.denominator)} طلبًا منتهيًا${s.success.failedWithDelivery ? ` · منها ${formatAr(s.success.failedWithDelivery)} فشلت أو رُفضت بعد تسليم جزئي` : ""}`
    : "";
  const cards = [
    { k: "مهام آخر ٣٠ يومًا", v: s ? formatAr(s.last30) : "…", sub: "", c: "var(--ink)" },
    { k: "قيد التنفيذ الآن", v: s ? formatAr(s.runningNow) : "…", sub: s ? `متوقفة ${formatAr(s.stalled)} · عالقة في الانتظار ${formatAr(s.queuedStuck)}` : "", c: "var(--info)" },
    { k: "نسبة النجاح", v: s ? (s.success.percent == null ? "—" : `${formatAr(s.success.percent, 1)}٪`) : "…", sub: successSub, c: "var(--ok)" },
    { k: "نقاط حجز مُحرَّرة", v: s ? formatAr(s.released.points) : "…", sub: s ? `من ${formatAr(s.released.rows)} حجزًا مُحرَّرًا في آخر ٣٠ يومًا` : "", c: "var(--goldT)" },
  ];

  return (
    <div data-screen-label="Jobs" className="flex flex-col gap-3.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {cards.map((card) => <div key={card.k} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{card.k}</p><p className="mb-0 mt-1.5 font-display text-[30px] leading-none" style={{ color: card.c }}>{card.v}</p>{card.sub && <p className="m-0 mt-2 text-[11px] leading-[1.7] text-fnt">{card.sub}</p>}</div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-ink2">
          <input type="checkbox" checked={hideTest} onChange={(e) => setHideTest(e.target.checked)} className="h-4 w-4" />
          <span>{HIDE_TEST_ACCOUNTS_LABEL_AR}</span>
        </label>
      </div>
      {oneJob && (
        <p role="status" className="m-0 flex flex-wrap items-center gap-2 rounded-[14px] bg-sf2 px-3.5 py-3 text-[13px] text-ink" data-testid="one-job-banner">
          <span>تعرض هذه الصفحة مهمة واحدة فقط (من سجل الاستدعاءات).</span>
          <a href="/admin/jobs" className="font-semibold text-ink underline">عرض كل المهام</a>
        </p>
      )}
      {data && data.open.length > 0 && (
        <details className="rounded-[18px] border border-ln bg-sf p-3.5" data-testid="open-jobs">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink">الطلبات المفتوحة الآن ({formatAr(data.open.length)})</summary>
          <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0 text-[12px] text-ink2">
            {data.open.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span dir="ltr" className="font-mono text-[11px] text-fnt">{o.id}</span>
                <span style={{ color: STATE_COLOR[o.status] }}>{o.label}</span>
                <span className="text-fnt">منذ {formatAr(o.ageMinutes)} د · بلا تقدم منذ {formatAr(o.idleMinutes)} د</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="no-scrollbar flex max-w-full gap-1 self-start overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold" style={{ background: filter === id ? "var(--sf)" : "transparent", color: filter === id ? "var(--ink)" : "var(--mut)", boxShadow: filter === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <div className="overflow-hidden rounded-[20px] border border-ln bg-sf">
        {!isMobile && (
          <div className="grid gap-3 bg-sf2 px-[18px] py-3 text-[11px] font-semibold text-mut" style={{ gridTemplateColumns: COLS }}>
            <span>البحث</span><span>المستخدم</span><span>السجلات</span><span>النقاط (حجز / خصم)</span><span>تكلفة المزود</span><span>الحالة</span>
          </div>
        )}
        {!data && [0, 1, 2].map((i) => <div key={i} className="h-[68px] border-t border-ln bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}
        {data?.jobs.map((j) => {
          const label = ADMIN_JOB_STATE_LABEL_AR[j.status];
          const color = STATE_COLOR[j.status];
          const pct = j.requested ? Math.min(100, (j.delivered / j.requested) * 100) : j.status === "done" ? 100 : 0;
          return (
            <div key={j.id} className="grid items-center gap-x-3 gap-y-2 border-t border-ln px-[18px] py-3.5 text-[13px] text-ink2 first:border-t-0" style={{ gridTemplateColumns: isMobile ? "minmax(0,1fr) auto" : COLS }}>
              <span className="min-w-0" style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
                <span className="block truncate font-semibold text-ink">{j.title}</span>
                <span className="block text-[11px] text-fnt">{j.platform} · {dayLabel(j.createdAt)}</span>
              </span>
              <span className="min-w-0 truncate">{j.user}</span>
              <span><span className="block">{formatAr(j.delivered)}{j.requested ? ` / ${formatAr(j.requested)}` : ""}</span><span className="mt-1 block h-1 overflow-hidden rounded bg-sf2"><span className="block h-full" style={{ width: `${pct}%`, background: j.status === "failed" ? "var(--bad)" : "var(--bar)" }} /></span></span>
              <span dir="ltr" className="text-right">{formatAr(j.held)} / {formatAr(j.charged)}</span>
              <span>{j.costUsd == null ? "—" : usd(j.costUsd)}</span>
              <span><span className="whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-semibold" style={{ background: tint(color === "var(--goldT)" ? "var(--gold)" : color, 14), color }}>{label}</span></span>
              {j.chain && <RoutingTracePanel jobId={j.id} />}
              {ENDED_NEEDS_DIAGNOSTIC.includes(j.status) && <JobDiagnosticPanel jobId={j.id} />}
            </div>
          );
        })}
        {data && data.jobs.length === 0 && <p className="m-0 p-10 text-center text-[13px] text-fnt">لا توجد عمليات بحث في هذا القسم.</p>}
      </div>
    </div>
  );
}
