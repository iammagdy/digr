"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, Badge, Stamp } from "@/components/ui";

export interface PlanItem {
  capabilitySlug: string;
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
}

export interface PlanQuoteData {
  quoteId: string;
  planHash?: string;
  summaryAr: string;
  items?: PlanItem[];
  targetVolumeMax: number;
  unitPricePoints: number;
  quotedPoints: number;
  isAffordable: boolean;
  userBalance: number;
  downscaledOffer?: {
    maxAffordableUnits: number;
    affordableQuotedPoints: number;
    rawCostPoints: number;
  };
  isDependent?: boolean;
  stepCostRanges?: Array<{
    stepId: string;
    capabilitySlug: string;
    labelAr?: string;
    minUnits: number;
    maxUnits: number;
    minPoints: number;
    maxPoints: number;
  }>;
  outputFormats: string[];
  expiresAt: string;
  methodologyNotes?: string;
}

interface PlanQuoteCardProps {
  quote: PlanQuoteData;
  onStart: (quote: PlanQuoteData) => void;
  onSaveEdit: (quote: PlanQuoteData, newLimit: number, newParam: string, newFormats: string[]) => Promise<void>;
  onAcceptDownscaled?: (units: number) => void;
  isStarting: boolean;
}

export function formatExpiry(expiresAt: string): string {
  try {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(ms)) return "";
    if (ms <= 0) return "انتهت صلاحية عرض السعر";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `ينتهي عرض السعر خلال ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    return `ينتهي عرض السعر خلال ${hours} ساعة`;
  } catch {
    return "";
  }
}

export default function PlanQuoteCard({
  quote,
  onStart,
  onSaveEdit,
  onAcceptDownscaled,
  isStarting,
}: PlanQuoteCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editLimit, setEditLimit] = useState(quote.targetVolumeMax || 1);
  const primaryItem = quote.items?.[0];
  const initialParam = primaryItem?.params ? (primaryItem.params.username || primaryItem.params.query || "") : "";
  const [editParamVal, setEditParamVal] = useState(initialParam);
  const [editFormats, setEditFormats] = useState<string[]>(quote.outputFormats || ["xlsx", "pdf", "csv"]);
  const [savingEdit, setSavingEdit] = useState(false);

  const expiryText = formatExpiry(quote.expiresAt);
  const expired = expiryText === "انتهت صلاحية عرض السعر";

  function toggleFormat(fmt: string) {
    if (editFormats.includes(fmt)) {
      if (editFormats.length > 1) setEditFormats(editFormats.filter((f) => f !== fmt));
    } else {
      setEditFormats([...editFormats, fmt]);
    }
  }

  async function handleSave() {
    setSavingEdit(true);
    try {
      await onSaveEdit(quote, editLimit, editParamVal, editFormats);
      setIsEditing(false);
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="paper-dossier mt-3 overflow-hidden rounded-2xl border border-sand-300 shadow-[var(--shadow-card)]" aria-label="خطة البحث وعرض السعر">
      {/* Dossier header */}
      <div className="flex items-start justify-between gap-4 border-b border-sand-200 bg-white/60 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs font-bold text-accent">خطة البحث المقترحة</p>
          <h3 className="mt-1 text-base font-bold leading-relaxed text-ink-900">{quote.summaryAr}</h3>
        </div>
        <div className="shrink-0 text-center">
          <div className="tnum inline-flex items-baseline gap-1 rounded-2xl border border-amber-points/30 bg-amber-points-bg px-3.5 py-2">
            <span className="text-2xl font-bold text-amber-points">{quote.quotedPoints}</span>
            <span className="text-xs font-bold text-amber-points">نقطة</span>
          </div>
          <p className="tnum mt-1 text-xs text-sand-500">≈ {(quote.quotedPoints * 0.1).toFixed(1)} ج.م</p>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* Plan ledger */}
        {!isEditing ? (
          <dl className="divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white text-sm">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-sand-600">الهدف المستهدف</dt>
              <dd className="font-bold text-ink-900" dir="auto">{initialParam ? `@${initialParam}` : "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-sand-600">حجم الجمع المطلوب</dt>
              <dd className="tnum font-bold text-ink-900">حتى {quote.targetVolumeMax.toLocaleString("ar-EG")} سجل</dd>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-sand-600">ملفات التسليم</dt>
              <dd className="flex gap-1.5">
                {(quote.outputFormats || ["xlsx", "pdf", "csv"]).map((fmt) => (
                  <span key={fmt} className="tnum rounded-md bg-sand-100 px-2 py-0.5 text-xs font-bold text-sand-700 uppercase">{fmt}</span>
                ))}
              </dd>
            </div>
            {quote.methodologyNotes && (
              <div className="px-4 py-3">
                <dt className="mb-1 text-sand-600">منهجية الجمع</dt>
                <dd className="text-xs leading-relaxed text-ink-700">{quote.methodologyNotes}</dd>
              </div>
            )}
          </dl>
        ) : (
          /* Inline editor */
          <div className="space-y-4 rounded-2xl border border-accent/25 bg-accent-light/40 p-4" aria-label="تعديل الخطة">
            <p className="text-xs font-bold text-accent-ink">تعديل معايير الخطة — سيُعاد حساب عرض السعر من الخادم</p>
            <div>
              <label htmlFor={`pq-param-${quote.quoteId}`} className="mb-1.5 block text-xs font-semibold text-ink-800">الهدف (اسم المستخدم أو الاستعلام)</label>
              <input
                id={`pq-param-${quote.quoteId}`}
                type="text"
                value={editParamVal}
                onChange={(e) => setEditParamVal(e.target.value)}
                dir="auto"
                className="min-h-11 w-full rounded-xl border border-sand-300 bg-white px-3.5 text-sm text-ink-900 outline-none focus:border-accent"
              />
            </div>
            <div>
              <label htmlFor={`pq-limit-${quote.quoteId}`} className="mb-1.5 block text-xs font-semibold text-ink-800">الحد الأقصى للسجلات</label>
              <input
                id={`pq-limit-${quote.quoteId}`}
                type="number"
                min={1}
                max={1000}
                value={editLimit}
                onChange={(e) => setEditLimit(Number(e.target.value))}
                className="tnum min-h-11 w-full rounded-xl border border-sand-300 bg-white px-3.5 text-sm text-ink-900 outline-none focus:border-accent"
              />
            </div>
            <fieldset>
              <legend className="mb-1.5 text-xs font-semibold text-ink-800">تنسيقات الملفات</legend>
              <div className="flex gap-2">
                {["xlsx", "pdf", "csv"].map((fmt) => (
                  <label key={fmt} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-sand-300 bg-white px-3.5 text-xs font-bold text-ink-900 uppercase has-checked:border-accent has-checked:bg-accent-light/60">
                    <input type="checkbox" checked={editFormats.includes(fmt)} onChange={() => toggleFormat(fmt)} className="h-4 w-4 accent-[#0b6b5c]" />
                    {fmt}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setIsEditing(false)} className="min-h-11 cursor-pointer rounded-xl px-4 text-xs font-semibold text-sand-600 hover:text-ink-900">
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={savingEdit}
                className="min-h-11 cursor-pointer rounded-xl bg-accent px-5 text-xs font-bold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingEdit ? "جاري تحديث العرض..." : "تطبيق وتحديث العرض"}
              </button>
            </div>
          </div>
        )}

        {quote.isDependent && (
          <Alert tone="warning" title="خطة متعددة المراحل">
            الحجز محسوب على سقف كل مرحلة، والتنفيذ الفعلي غير مفعّل حاليًا.
            {(quote.stepCostRanges || []).length > 0 && (
              <ul className="tnum mt-2 space-y-1">
                {(quote.stepCostRanges || []).map((range) => (
                  <li key={range.stepId}>{range.labelAr || range.capabilitySlug}: من {range.minPoints} إلى {range.maxPoints} نقطة — حتى {range.maxUnits} وحدة.</li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        {/* Expiry */}
        {expiryText && (
          <p role="status" className={`flex items-center gap-1.5 text-xs font-semibold ${expired ? "text-danger" : "text-sand-600"}`}>
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {expiryText}
          </p>
        )}

        {/* Affordability */}
        {!quote.isAffordable && (
          <Alert tone="warning" title={`رصيدك (${quote.userBalance} نقطة) أقل من المطلوب (${quote.quotedPoints} نقطة)`}>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Link href="/dashboard/topup" className="font-bold underline">شحن الرصيد</Link>
              {quote.downscaledOffer && onAcceptDownscaled && (
                <button
                  type="button"
                  onClick={() => onAcceptDownscaled(quote.downscaledOffer!.maxAffordableUnits)}
                  className="tnum min-h-11 cursor-pointer rounded-xl bg-amber-points px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-amber-points-hover"
                >
                  قبول العرض المخفض: حتى {quote.downscaledOffer.maxAffordableUnits} سجل مقابل {quote.downscaledOffer.affordableQuotedPoints} نقطة
                </button>
              )}
            </div>
          </Alert>
        )}

        {/* Balance line */}
        <div className="tnum flex items-center justify-between rounded-xl bg-sand-50 px-4 py-2.5 text-xs">
          <span className="text-sand-600">رصيدك المتاح</span>
          <span className={`font-bold ${quote.isAffordable ? "text-ink-900" : "text-danger"}`}>{quote.userBalance} نقطة</span>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sand-200 pt-4">
          <button
            type="button"
            onClick={() => setIsEditing(!isEditing)}
            disabled={quote.isDependent}
            title={quote.isDependent ? "تعديل كل مرحلة غير متاح في هذه النسخة" : undefined}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-sand-600 underline decoration-sand-300 underline-offset-4 transition-colors hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            {isEditing ? "إغلاق التعديل" : "تعديل الخطة"}
          </button>
          <button
            type="button"
            onClick={() => onStart(quote)}
            disabled={isStarting || !quote.isAffordable || quote.isDependent || expired}
            className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl bg-primary px-7 py-3 text-sm font-bold text-white shadow-xs transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isStarting ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
                جاري الحجز والبدء...
              </>
            ) : (
              <>{expired ? "انتهت صلاحية العرض" : quote.isDependent ? "التنفيذ متعدد المراحل غير متاح" : "أوافق على الخطة وابدأ البحث"}</>
            )}
          </button>
        </div>
        {!expired && !quote.isDependent && (
          <p className="text-center text-xs text-sand-500">بالضغط على الموافقة سيُحجز المبلغ تقديريًا — ولا يُخصم النهائي إلا بعد تسليم السجلات.</p>
        )}
      </div>
    </div>
  );
}
