"use client";

import { useState } from "react";
import Link from "next/link";

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

  function toggleFormat(fmt: string) {
    if (editFormats.includes(fmt)) {
      if (editFormats.length > 1) {
        setEditFormats(editFormats.filter((f) => f !== fmt));
      }
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
    <div className="mt-3 p-5 bg-white border border-sand-300 rounded-2xl shadow-xs transition-all">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-3 pb-3 border-b border-sand-200">
        <div>
          <span className="text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sand-100 text-sand-700">
            خطة الاستخراج وعرض السعر
          </span>
          <h3 className="text-base font-bold text-ink-900 mt-1">
            {quote.summaryAr}
          </h3>
        </div>

        {/* Points Badge */}
        <div className="text-left shrink-0">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-points-bg border border-amber-points/30 rounded-xl">
            <span className="text-lg font-bold text-amber-points tabular-nums">
              {quote.quotedPoints}
            </span>
            <span className="text-xs font-semibold text-amber-points">نقطة</span>
          </div>
          <div className="text-3xs text-sand-500 mt-0.5 text-center">
            شامل احتياطي التغطية
          </div>
        </div>
      </div>

      {/* Plan Details & Inline Editor */}
      {!isEditing ? (
        <div className="space-y-2 mb-4 text-xs sm:text-sm">
          <div className="flex items-center justify-between text-sand-700">
            <span>الحساب / الاستعلام المستهدف:</span>
            <span className="font-semibold text-ink-900" dir="ltr">
              @{initialParam || "tiktok"}
            </span>
          </div>

          <div className="flex items-center justify-between text-sand-700">
            <span>الحد الأقصى للسجلات:</span>
            <span className="font-semibold text-ink-900">
              حتى {quote.targetVolumeMax} سجل
            </span>
          </div>

          {quote.isDependent && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" role="status" dir="rtl">
              <p className="font-semibold">خطة متعددة المراحل — الحجز محسوب على سقف كل مرحلة، والتنفيذ الفعلي غير مفعّل حالياً.</p>
              <ul className="mt-2 space-y-1">
                {(quote.stepCostRanges || []).map((range) => (
                  <li key={range.stepId}>
                    {range.labelAr || range.capabilitySlug}: من {range.minPoints} إلى {range.maxPoints} نقطة، حتى {range.maxUnits} وحدة.
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between text-sand-700">
            <span>تنسيقات الملفات الجاهزة:</span>
            <div className="flex gap-1">
              {(quote.outputFormats || ["xlsx", "pdf", "csv"]).map((fmt) => (
                <span
                  key={fmt}
                  className="px-2 py-0.5 text-2xs uppercase font-bold bg-sand-100 text-sand-700 rounded-md"
                >
                  {fmt}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-sand-50 rounded-xl border border-sand-300 mb-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-sand-700 mb-1">
              معرف الحساب (@username):
            </label>
            <input
              type="text"
              value={editParamVal}
              onChange={(e) => setEditParamVal(e.target.value)}
              className="w-full p-2 text-xs bg-white border border-sand-300 rounded-lg focus:outline-hidden focus:border-primary"
              dir="ltr"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-sand-700 mb-1">
              الحد الأقصى للسجلات:
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={editLimit}
              onChange={(e) => setEditLimit(Number(e.target.value))}
              className="w-full p-2 text-xs bg-white border border-sand-300 rounded-lg focus:outline-hidden focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-sand-700 mb-1">
              تنسيقات الملفات:
            </label>
            <div className="flex gap-2">
              {["xlsx", "pdf", "csv"].map((fmt) => (
                <label
                  key={fmt}
                  className="flex items-center gap-1.5 text-xs text-ink-900 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={editFormats.includes(fmt)}
                    onChange={() => toggleFormat(fmt)}
                    className="rounded-xs text-primary focus:ring-primary"
                  />
                  <span className="uppercase font-bold">{fmt}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="px-3 py-1.5 text-xs text-sand-600 hover:text-ink-900 cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={savingEdit}
              className="px-4 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary-hover disabled:opacity-50 cursor-pointer"
            >
              {savingEdit ? "جاري التحديث..." : "تطبيق وتحديث العرض"}
            </button>
          </div>
        </div>
      )}

      {/* Over-Budget Notice & Downscaled Option */}
      {!quote.isAffordable && (
        <div className="mb-4 p-3 bg-amber-points-bg/70 border border-amber-points/30 rounded-xl text-xs space-y-2">
          <div className="flex items-center justify-between text-amber-points font-semibold">
            <span className="inline-flex items-center gap-1.5">
              <svg className="w-4 h-4 text-amber-points shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>رصيدك المتاح ({quote.userBalance} نقطة) أقل من المطلوب ({quote.quotedPoints} نقطة)</span>
            </span>
            <Link href="/dashboard/topup" className="underline hover:text-amber-points-hover">
              شحن الرصيد
            </Link>
          </div>

          {quote.downscaledOffer && (
            <div className="pt-2 border-t border-amber-points/20 flex items-center justify-between">
              <span className="text-sand-700 inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-sand-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>عرض مخفض: جمع حتى {quote.downscaledOffer.maxAffordableUnits} سجل مقابل {quote.downscaledOffer.affordableQuotedPoints} نقطة</span>
              </span>
              {onAcceptDownscaled && (
                <button
                  type="button"
                  onClick={() => onAcceptDownscaled(quote.downscaledOffer!.maxAffordableUnits)}
                  className="px-2.5 py-1 bg-amber-points text-white rounded-lg font-semibold hover:bg-amber-points-hover transition-colors cursor-pointer"
                >
                  قبول العرض المخفض
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Primary Actions */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => setIsEditing(!isEditing)}
          disabled={quote.isDependent}
          title={quote.isDependent ? "تعديل كل مرحلة غير متاح في هذه النسخة" : undefined}
          className="min-h-11 text-xs text-sand-600 hover:text-ink-900 font-medium underline underline-offset-2 transition-colors cursor-pointer inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5 text-sand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span>{isEditing ? "إغلاق التعديل" : "تعديل الخطة يدوياً"}</span>
        </button>

        <button
          type="button"
          onClick={() => onStart(quote)}
          disabled={isStarting || !quote.isAffordable || quote.isDependent}
          className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-bold rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isStarting ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>جاري الحجز والبدء...</span>
            </>
          ) : (
            <span>{quote.isDependent ? "التنفيذ متعدد المراحل غير متاح" : "ابدأ الاستخراج الآن"}</span>
          )}
        </button>
      </div>
    </div>
  );
}
