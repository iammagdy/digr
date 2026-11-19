"use client";

import { useMemo, useState } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { buildInspection } from "@/lib/server/adminMissionInspector";
import { dateTimeAr } from "./format";
import { Card, EmptyState, SegmentChips, StatusBadge, type BadgeTone } from "./ui";

/**
 * THE ADMIN MISSION INSPECTOR, READ ONLY (DT-20261118-06 PR 2, Megz D-0104): what ONE mission did, for the team. Everything here comes from the inspect API (named fields, every string already redacted); this component only draws it.
 * There is no form, no input and no button that changes anything: the only controls are the filter chips of the calls table. RTL: logical classes only (`ms-`, `me-`, `ps-`, `pe-`, `text-start`), no emoji, Arabic-Indic digits.
 */
export type Inspection = ReturnType<typeof buildInspection>;

/** The no-card reasons the worker writes (`admin: planning_failed class=… reason=…`) in plain Arabic for the team; an unknown reason is shown as its code. */
export const NO_CARD_REASON_AR: Record<string, string> = {
  planning_over_budget: "تجاوز ميزانية التخطيط",
  planning_daily_cap: "استنفاد الحد اليومي لمصدر البيانات",
  planning_recording_unavailable: "تعذّر تسجيل تكلفة النداءات",
  planning_missing_params: "نقص في مدخلات الاستدعاء المطلوبة للمصدر",
  sources_failed: "فشل جميع مصادر العينة أو توقفها",
  people_sources_failed: "فشل مصدر بيانات مسؤولي الشركات في العينة",
  people_sources_not_tried: "لم تُجرَّب مصادر مسؤولي الشركات قبل إنهاء التخطيط",
  no_plan: "انتهى التخطيط من غير خطة",
  sample_empty: "عينة المصدر رجعت فارغة",
  not_served: "الطلب غير مخدوم بمصادر الكتالوج",
  claimed_empty_but_rows_returned: "النموذج اعتبر المصدر فارغًا مع أن النداءات رجّعت بيانات",
};
export function noCardReasonAr(r: { cls: string; reason: string; rejectionCount?: number }): string {
  if (r.reason === "plan_invalid" && r.rejectionCount !== undefined) {
    const count = r.rejectionCount;
    if (count === 1) return "الخطة المقترحة بقيت غير صالحة بعد محاولة رفض واحدة";
    if (count === 2) return "الخطة المقترحة بقيت غير صالحة بعد محاولتي رفض";
    const attempts = count <= 10 ? "محاولات رفض" : "محاولة رفض";
    return `الخطة المقترحة بقيت غير صالحة بعد ${toArabicDigits(count)} ${attempts}`;
  }
  if (r.reason === "plan_invalid" || r.reason.startsWith("plan_invalid_after_")) return "الخطة المقترحة بقيت غير صالحة بعد عدة محاولات.";
  return NO_CARD_REASON_AR[r.reason] ?? `سبب غير معروف (${r.reason}).`;
}
const STAGE_STATE_AR: Record<string, [string, BadgeTone]> = { not_reached: ["لم تصل", "mute"], running: ["جارية", "warn"], done: ["اكتملت", "ok"], empty: ["رجعت فاضية", "warn"], failed: ["فشلت", "bad"] };
const CALL_STATUS_AR: Record<string, [string, BadgeTone]> = { ok: ["نجح", "ok"], empty: ["فاضي", "warn"], failed: ["فشل", "bad"], refused: ["رُفض", "bad"], unknown: ["غير معروف", "mute"] };
const STATUS_AR: Record<string, string> = { queued: "في الانتظار", planning: "تخطيط", needs_input: "ينتظر إجابة", plan_ready: "كارت جاهز", approved: "معتمد", executing: "يُنفَّذ", completed: "اكتمل", failed: "فشل", unserved: "غير مخدوم", cancelled: "أُلغي" };
const FILTERS: Array<["all" | "bad" | "ok" | "empty", string]> = [["all", "الكل"], ["bad", "الفاشلة والمرفوضة"], ["empty", "الفاضية"], ["ok", "الناجحة"]];
const n = (v: number | null | undefined): string => (typeof v === "number" ? formatAr(v) : "—");
const money = (v: number): string => toArabicDigits(v.toFixed(4));

const TH = "px-2 py-2 text-start text-[11px] font-semibold text-mut";
const TD = "px-2 py-2 align-top text-xs text-ink";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;

export function MissionInspector({ data }: { data: Inspection }) {
  const [filter, setFilter] = useState<"all" | "bad" | "ok" | "empty">("all");
  const shown = useMemo(() => {
    const keep = data.calls.filter((c) => (filter === "all" ? true : filter === "bad" ? c.status === "failed" || c.status === "refused" : c.status === filter));
    // the failed and the refused first (that is what the team looks for), then by time
    const weight = (s: string) => (s === "failed" || s === "refused" ? 0 : 1);
    return [...keep].sort((a, b) => weight(a.status) - weight(b.status) || String(a.at).localeCompare(String(b.at)));
  }, [data.calls, filter]);
  const m = data.mission;
  const reason = data.planner.noCardReason;
  const reasonCode = reason?.reason === "plan_invalid" && reason.rejectionCount !== undefined
    ? `plan_invalid_after_${reason.rejectionCount}_rejections`
    : reason && NO_CARD_REASON_AR[reason.reason] ? reason.reason : null;
  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="mission-inspector" dir="rtl">
      <Card title="المهمة" sub="للقراءة فقط: لا شيء هنا يغيّر مهمة أو رصيدًا." action={<StatusBadge tone={m.status === "failed" || m.status === "unserved" ? "bad" : m.status === "completed" ? "ok" : "warn"}>{STATUS_AR[m.status] ?? m.status}</StatusBadge>}>
        <p className="m-0 break-words text-sm text-ink" data-testid="request-text">{m.requestText || "—"}</p>
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-xs min-[900px]:grid-cols-4">
          <div><dt className="text-mut">المعرّف</dt><dd className="m-0" dir="ltr" style={MONO}>{m.id}</dd></div>
          <div><dt className="text-mut">أُنشئت</dt><dd className="m-0">{dateTimeAr(m.createdAt)}</dd></div>
          <div><dt className="text-mut">آخر تحديث</dt><dd className="m-0">{dateTimeAr(m.updatedAt)}</dd></div>
          <div><dt className="text-mut">المسلَّم من المطلوب</dt><dd className="m-0">{n(m.deliveredRows)} من {n(m.requestedRows)}</dd></div>
          <div><dt className="text-mut">المحجوز</dt><dd className="m-0">{n(m.reservedPoints)} نقطة</dd></div>
          <div><dt className="text-mut">المخصوم</dt><dd className="m-0">{n(m.chargedPoints)} نقطة</dd></div>
        </dl>
        {m.error && <p className="m-0 break-words rounded-xl bg-sf2 p-3 text-xs text-bad" dir="auto" data-testid="mission-error">{m.error}</p>}
        {m.summaryAr && <p className="m-0 text-xs text-ink2">{m.summaryAr}</p>}
      </Card>

      <Card title="قرار المخطط" sub={`${n(data.planner.llmCalls)} نداء للنموذج، تكلفة تقديرية ${money(data.planner.costUsd)} دولار`}>
        <p className="m-0 text-sm text-ink" data-testid="understanding">{data.planner.understandingAr ?? "لا يوجد فهم مسجّل لهذه المهمة."}</p>
        {data.planner.steps.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink2">
            {data.planner.steps.map((s: { key: string; platform: string; capability: string; topic: string | null; hasSource: boolean }) => <li key={s.key}><span dir="ltr" style={MONO}>{s.key}</span> — <span dir="ltr" style={MONO}>{s.capability || s.platform}</span>{s.topic ? ` — ${s.topic}` : ""}{s.hasSource ? " — بمصدر محدد" : ""}</li>)}
          </ul>
        )}
        {reason && (
          <p className="m-0 rounded-xl bg-sf2 p-3 text-xs text-ink" data-testid="no-card-reason">
            لماذا لا يوجد كارت: {noCardReasonAr(reason)}
            {reasonCode && <> <span dir="ltr" style={MONO} className="ms-1 text-[11px] text-mut">({reasonCode})</span></>}
          </p>
        )}
      </Card>

      <Card title="المراحل" sub="حالة كل مرحلة تُستنتج من النداءات التي استخدمت مصدرها.">
        {data.stages.length === 0 ? <EmptyState title="لا توجد مراحل: الخطة لم تُبنَ بعد." /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] border-collapse"><thead><tr><th className={TH}>المرحلة</th><th className={TH}>المصدر</th><th className={TH}>الحالة</th><th className={TH}>المخطط</th><th className={TH}>نداءات</th><th className={TH}>صفوف</th></tr></thead>
            <tbody>{data.stages.map((s) => { const st = STAGE_STATE_AR[s.state] ?? [s.state, "mute" as BadgeTone]; return (
              <tr key={s.key} className="border-t border-ln">
                <td className={TD}>{s.titleAr || s.key}{s.estimated && <> <StatusBadge tone="warn" dot={false}>سعر تقديري</StatusBadge></>}{!s.deliver && <span className="ms-1 text-mut">(مساعدة)</span>}</td>
                <td className={TD}><span dir="ltr" style={MONO}>{s.endpointId}</span>{s.sharedEndpoint && <span className="ms-1 text-mut">(مصدر مشترك)</span>}{!s.hasEngine && <span className="ms-1 text-mut">(بالنموذج)</span>}</td>
                <td className={TD}><StatusBadge tone={st[1]}>{st[0]}</StatusBadge></td>
                <td className={TD}>{n(s.plannedRows)}{s.perParentRows ? ` (${n(s.perParentRows)} لكل أصل)` : ""}</td>
                <td className={TD}>{n(s.callsOk)} ناجح · {n(s.callsEmpty)} فاضٍ · {n(s.callsFailed)} فاشل · {n(s.callsRefused)} مرفوض</td>
                <td className={TD}>{n(s.rowsReturned)}</td>
              </tr>); })}</tbody></table></div>
        )}
      </Card>

      <Card title="الاستدعاءات" sub={data.truncated ? `يُعرض ${n(data.callTotals.shown)} من ${n(data.callTotals.total)} استدعاءً.` : `${n(data.callTotals.total)} استدعاءً.`}>
        <SegmentChips label="تصفية الاستدعاءات" items={FILTERS} value={filter} onChange={setFilter} counts={{ all: data.callTotals.total, bad: data.callTotals.byStatus.failed + data.callTotals.byStatus.refused, empty: data.callTotals.byStatus.empty, ok: data.callTotals.byStatus.ok }} />
        {shown.length === 0 ? <EmptyState title="لا توجد استدعاءات بهذا الشرط." /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse" data-testid="calls-table"><thead><tr><th className={TH}>الوقت</th><th className={TH}>المصدر</th><th className={TH}>الحالة</th><th className={TH}>HTTP</th><th className={TH}>صفوف</th><th className={TH}>التكلفة (دولار)</th><th className={TH}>المدة (م.ث)</th><th className={TH}>السبب</th></tr></thead>
            <tbody>{shown.map((c) => { const st = CALL_STATUS_AR[c.status] ?? CALL_STATUS_AR.unknown; return (
              <tr key={c.id} className="border-t border-ln">
                <td className={TD}>{dateTimeAr(c.at)}</td>
                <td className={TD}><span dir="ltr" style={MONO}>{c.endpointId}</span><span className="ms-1 text-mut">{c.phase === "execution" ? "تنفيذ" : "تخطيط"}</span>{c.paramKeys.length > 0 && <div className="text-mut" dir="ltr" style={MONO}>{c.paramKeys.join(", ")}</div>}</td>
                <td className={TD}><StatusBadge tone={st[1]}>{st[0]}</StatusBadge></td>
                <td className={TD}>{c.httpStatus === null ? "—" : toArabicDigits(c.httpStatus)}</td>
                <td className={TD}>{n(c.rowsReturned)}</td>
                <td className={TD}>{money(c.costUsd)}</td>
                <td className={TD}>{n(c.durationMs)}</td>
                <td className={TD}><span dir="auto" className="break-words">{c.failure || c.refusedReason || "—"}</span></td>
              </tr>); })}</tbody></table></div>
        )}
        {data.callTotals.byEndpoint.length > 0 && (
          <div className="overflow-x-auto"><table className="w-full min-w-[520px] border-collapse"><caption className="pb-1 text-start text-[11px] font-semibold text-mut">الإجمالي لكل مصدر</caption><thead><tr><th className={TH}>المصدر</th><th className={TH}>ناجح</th><th className={TH}>فاضٍ</th><th className={TH}>فاشل</th><th className={TH}>مرفوض</th><th className={TH}>صفوف</th><th className={TH}>دولار</th></tr></thead>
            <tbody>{data.callTotals.byEndpoint.map((e) => <tr key={e.endpointId} className="border-t border-ln"><td className={TD}><span dir="ltr" style={MONO}>{e.endpointId}</span></td><td className={TD}>{n(e.ok)}</td><td className={TD}>{n(e.empty)}</td><td className={TD}>{n(e.failed)}</td><td className={TD}>{n(e.refused)}</td><td className={TD}>{n(e.rows)}</td><td className={TD}>{money(e.costUsd)}</td></tr>)}</tbody></table></div>
        )}
      </Card>

      <Card title="الأحداث" sub="الأحداث الداخلية (قياسات وعلامات المشرف) باهتة.">
        {data.events.length === 0 ? <EmptyState title="لا توجد أحداث." /> : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {data.events.map((e) => {
              const diagCounts = e.internal ? Object.entries(e.counts ?? {}).filter(([k, v]) => /^(?:adm_flag|issue_|finish_)/.test(k) && typeof v === "number" && Number.isFinite(v)) : [];
              return (
                <li key={e.id ?? `${e.at}-${e.kind}`} className="flex flex-col gap-0.5 border-t border-ln pt-2 first:border-t-0 first:pt-0" style={{ opacity: e.internal ? 0.6 : 1 }}>
                  <span className="text-[11px] text-mut">{dateTimeAr(e.at)} · {e.kind}{e.internal ? " · داخلي" : ""}</span>
                  <span className="break-words text-xs text-ink" dir="auto">{e.messageAr}</span>
                  {diagCounts.length > 0 && (
                    <span className="font-mono text-[11px] text-mut" dir="ltr">{diagCounts.map(([k, v]) => `${k}=${v}`).join(" · ")}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {data.files.length > 0 && <Card title="الملفات" sub="أسماء فقط، بلا روابط."><ul className="m-0 list-none p-0 text-xs text-ink">{data.files.map((f) => <li key={f.name}>{f.name} <span className="text-mut">({f.kind})</span></li>)}</ul></Card>}
    </div>
  );
}
