"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { capabilityById, PROVIDER_FACTS } from "@/lib/multiProvider/catalog";
import type { RoutingTrace, TraceSummary } from "@/lib/multiProvider/trace";

/**
 * The admin-only routing trace of one job, inside the existing admin jobs list: who chose the route and why, the stages with provider
 * and capability, calls, cost, found / new / duplicate, fallbacks. It is loaded on demand from an admin route and is never part of a
 * customer response (the customer's routes and job events carry none of these fields).
 */

const SOURCE_AR: Record<string, string> = { model: "اختار النموذج من المسارات المسموحة", cheapest_allowed: "اختار الكود أرخص مسار مسموح", only_option: "مسار وحيد مسموح" };
const FALLBACK_REASON_AR: Record<string, string> = { no_chooser: "لا يوجد مُختار نموذجي", model_failed: "فشل استدعاء النموذج", invalid_choice: "اختيار النموذج غير صالح" };
const STAGE_AR: Record<string, string> = { discover: "اكتشاف الشركات", enrich: "قراءة الصفحات العامة", verify: "التحقق في الكود" };
const STOP_AR: Record<string, string> = { budget: "ميزانية المزودين", no_more_work: "لا مزيد من العمل", target_reached: "اكتمل المطلوب" };
const EXCLUDE_AR: Record<string, string> = {
  flag_off: "الميزة مغلقة", provider_disabled: "المزود غير مفعّل", key_missing: "لا يوجد مفتاح", unhealthy: "المزود غير سليم", cap_exceeded: "الحد اليومي لا يتسع",
  unverified_price: "سعر غير مؤكد", blocked_capability: "قدرة محظورة", not_covering: "لا يغطي الحقول المطلوبة", over_job_cap: "فوق حد الطلب", no_volume: "لا حجم",
};

const usd = (n: number) => `${toArabicDigits(n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0")} دولار`;
const providerLabel = (p: string | null) => (p && (PROVIDER_FACTS as Record<string, { labelAr: string }>)[p]?.labelAr) || "—";
const capLabel = (id: string | null) => (id ? capabilityById(id)?.labelAr ?? "—" : "—");

export function RoutingTracePanel({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<{ trace: RoutingTrace | null; summary: TraceSummary | null } | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || data) return;
    setBusy(true);
    try {
      setData(await adminFetch<{ trace: RoutingTrace | null; summary: TraceSummary | null }>(`/api/admin/job-trace?jobId=${encodeURIComponent(jobId)}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل مسار الطلب.");
    } finally { setBusy(false); }
  };

  const decision = data?.trace?.decision ?? null;
  const summary = data?.summary ?? null;

  return (
    <div className="col-span-full">
      <button type="button" onClick={toggle} aria-expanded={open} data-testid={`trace-toggle-${jobId}`} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-xs text-ink">تتبع المسار</button>
      {open && (
        <div className="mt-2 flex flex-col gap-3 rounded-[14px] border border-ln bg-bg p-3.5 text-xs text-ink2" data-testid={`trace-panel-${jobId}`}>
          {busy && <p className="m-0 text-mut">جارٍ التحميل…</p>}
          {error && <p role="alert" className="m-0 text-bad">{error}</p>}
          {data && !data.trace && <p className="m-0 text-mut">لا يوجد تتبع مسار لهذا الطلب (لم يمر بمسار المزودين المتعددين).</p>}
          {decision && (
            <div className="flex flex-col gap-1.5">
              <p className="m-0 font-semibold text-ink">قرار المسار</p>
              <p className="m-0">{SOURCE_AR[decision.source] ?? decision.source}{decision.fallbackReason ? ` (${FALLBACK_REASON_AR[decision.fallbackReason] ?? decision.fallbackReason})` : ""}</p>
              {decision.reason && <p className="m-0">سبب النموذج: {decision.reason}</p>}
              <p className="m-0">الحجم {formatAr(decision.count)} · سعر الوحدة {formatAr(decision.unitPricePoints)} نقطة · الحجز {formatAr(decision.reservePoints)} نقطة · ميزانية المزودين {usd(decision.budgetUsd)}</p>
              <p className="m-0 text-mut">مسارات مسموحة: {formatAr(decision.allowed.length)} · مستبعدة: {decision.excluded.length === 0 ? "لا شيء" : decision.excluded.map((e) => `${EXCLUDE_AR[e.reason] ?? e.reason}${e.provider ? ` (${providerLabel(e.provider)})` : ""}`).join("، ")}</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {decision.stages.map((s, i) => (
                  <li key={`${s.stage}-${i}`} className="rounded-xl bg-sf p-2.5">
                    <span className="font-semibold text-ink">{STAGE_AR[s.stage] ?? s.stage}</span>
                    {s.capabilityId ? ` · ${providerLabel(s.provider)} · ${capLabel(s.capabilityId)} · حتى ${formatAr(s.maxCalls)} استدعاء` : ""}
                    {s.expectedYield != null ? ` · العائد المتوقع ${formatAr(Math.round(s.expectedYield * 100))}٪ (افتراض)` : ""}
                    {" · "}التكلفة التقديرية {usd(s.estimatedJobUsd)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary && summary.stages.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="m-0 font-semibold text-ink">ما نُفّذ فعلًا</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {summary.stages.map((s, i) => (
                  <li key={`${s.stage}-${s.capabilityId}-${i}`} className="rounded-xl bg-sf p-2.5">
                    <span className="font-semibold text-ink">{STAGE_AR[s.stage] ?? s.stage}</span>
                    {s.capabilityId ? ` · ${providerLabel(s.provider)} · ${capLabel(s.capabilityId)}` : ""}
                    {s.calls > 0 ? ` · الاستدعاءات ${formatAr(s.calls)} (نجح ${formatAr(s.success)}، فشل ${formatAr(s.failed)}، بلا نتيجة ${formatAr(s.empty)}) · التكلفة ${usd(s.costUsd)}` : ""}
                    {s.stage === "discover" ? ` · وُجد ${formatAr(s.found)}، جديد ${formatAr(s.fresh)}، مكرر ${formatAr(s.duplicate)}` : ""}
                    {s.stage === "enrich" ? ` · صفحات رئيسية مقروءة ${formatAr(s.read)}` : ""}
                    {s.stage === "verify" ? ` · موثّق ${formatAr(s.verified)}، غير موثّق ${formatAr(s.unverified)}، متخطّى ${formatAr(s.skipped)}` : ""}
                  </li>
                ))}
              </ul>
              {summary.fallbacks.length > 0 && (
                <p className="m-0">البدائل: {summary.fallbacks.map((f) => `${STAGE_AR[f.stage] ?? f.stage}: ${capLabel(f.fromCapabilityId)} ← ${f.toCapabilityId ? capLabel(f.toCapabilityId) : "لا بديل"} (${f.reason})`).join("، ")}</p>
              )}
              <p className="m-0 text-mut">إجمالي الاستدعاءات {formatAr(summary.totalCalls)} · إجمالي التكلفة {usd(summary.totalCostUsd)} · المُسلَّم {formatAr(summary.delivered)}{summary.stoppedBy ? ` · توقّف بسبب: ${STOP_AR[summary.stoppedBy] ?? summary.stoppedBy}` : ""}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
