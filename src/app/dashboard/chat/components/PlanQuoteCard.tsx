"use client";

import { useState } from "react";
import Link from "next/link";
import { formatNumber, formatCurrency } from "@/lib/honestDisplay";

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

function getPlatformLabel(slug: string): string {
  const s = slug.toLowerCase();
  if (s.includes("facebook") || s.includes("fb")) return "فيسبوك";
  if (s.includes("tiktok")) return "تيك توك";
  if (s.includes("instagram") || s.includes("ig")) return "إنستغرام";
  if (s.includes("youtube") || s.includes("yt")) return "يوتيوب";
  if (s.includes("x-") || s.includes("twitter")) return "منصة X";
  if (s.includes("reddit")) return "ريديت";
  return "الإنترنت العام";
}

function getActionLabel(slug: string): string {
  const s = slug.toLowerCase();
  if (s.includes("comment")) return "سحب التعليقات";
  if (s.includes("profile") || s.includes("user")) return "بيانات الحساب";
  if (s.includes("search") || s.includes("post") || s.includes("keyword")) return "جمع المنشورات";
  return "جمع البيانات";
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

  // Derive plain language steps: (what, from where, how many)
  const steps: Array<{ what: string; fromWhere: string; howMany: number }> = [];
  if (quote.items && quote.items.length > 0) {
    for (const item of quote.items) {
      const slug = item.capabilitySlug || "";
      steps.push({
        what: getActionLabel(slug),
        fromWhere: getPlatformLabel(slug),
        howMany: item.targetVolumeMax || quote.targetVolumeMax || 1,
      });
    }
  } else if (quote.stepCostRanges && quote.stepCostRanges.length > 0) {
    for (const r of quote.stepCostRanges) {
      const slug = r.capabilitySlug || "";
      steps.push({
        what: r.labelAr || getActionLabel(slug),
        fromWhere: getPlatformLabel(slug),
        howMany: r.maxUnits || quote.targetVolumeMax || 1,
      });
    }
  } else {
    steps.push({
      what: "جمع البيانات",
      fromWhere: "المنصة المطلوبة",
      howMany: quote.targetVolumeMax || 1,
    });
  }

  return (
    <div
      className="mt-3 overflow-hidden rounded-2xl border border-sand-300 bg-white p-4 sm:p-5 shadow-[var(--shadow-card)]"
      aria-label="خطة البحث وعرض السعر"
      dir="rtl"
    >
      {/* Short Arabic Title & Approximate Points Total */}
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-sand-100">
        <h3 className="text-base font-bold leading-relaxed text-ink-900 max-w-md">
          {quote.summaryAr}
        </h3>
        <div className="text-left shrink-0" dir="ltr">
          <div className="tnum text-lg font-bold text-amber-points">
            {formatNumber(quote.quotedPoints)} نقطة
          </div>
          <div className="tnum text-xs text-sand-500">
            ≈ {formatCurrency(quote.quotedPoints * 0.1)}
          </div>
        </div>
      </div>

      {/* Steps in plain language (what, from where, how many) */}
      {!isEditing ? (
        <div className="py-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-sand-500">خطوات التنفيذ:</div>
          <ul className="space-y-2 text-xs sm:text-sm text-ink-800">
            {steps.map((st, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sand-100 text-[11px] font-bold text-sand-600">
                  {formatNumber(idx + 1)}
                </span>
                <span>
                  {st.what} من <strong>{st.fromWhere}</strong> — حتى{" "}
                  <strong className="tnum">{formatNumber(st.howMany)}</strong> سجل
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        /* Inline editor */
        <div className="my-3 space-y-3 rounded-xl border border-sand-200 bg-sand-50 p-3.5 text-xs">
          <div>
            <label htmlFor={`pq-param-${quote.quoteId}`} className="mb-1 block font-semibold text-ink-800">
              الهدف المستهدف
            </label>
            <input
              id={`pq-param-${quote.quoteId}`}
              type="text"
              value={editParamVal}
              onChange={(e) => setEditParamVal(e.target.value)}
              dir="auto"
              className="min-h-10 w-full rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 outline-none focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor={`pq-limit-${quote.quoteId}`} className="mb-1 block font-semibold text-ink-800">
              الحد الأقصى للسجلات
            </label>
            <input
              id={`pq-limit-${quote.quoteId}`}
              type="number"
              min={1}
              max={10000}
              value={editLimit}
              onChange={(e) => setEditLimit(Number(e.target.value))}
              className="tnum min-h-10 w-full rounded-lg border border-sand-300 bg-white px-3 text-xs text-ink-900 outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="cursor-pointer px-3 py-1.5 text-xs text-sand-600 hover:text-ink-900"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={savingEdit}
              className="cursor-pointer rounded-lg bg-accent px-4 py-1.5 text-xs font-bold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {savingEdit ? "جاري التحديث..." : "حفظ التعديل"}
            </button>
          </div>
        </div>
      )}

      {/* Affordability & Balance note (plain, no colored warning boxes) */}
      {!quote.isAffordable && (
        <div className="mt-2 text-xs text-danger flex flex-wrap items-center gap-1.5">
          <span>رصيدك الحالي ({formatNumber(quote.userBalance)} نقطة) غير كافٍ.</span>
          <Link href="/dashboard/topup" className="font-bold underline text-accent">
            شحن الرصيد
          </Link>
          {quote.downscaledOffer && onAcceptDownscaled && (
            <button
              type="button"
              onClick={() => onAcceptDownscaled(quote.downscaledOffer!.maxAffordableUnits)}
              className="tnum ms-2 cursor-pointer rounded-lg bg-sand-100 px-2 py-1 text-xs font-semibold text-ink-800 hover:bg-sand-200"
            >
              قبول {formatNumber(quote.downscaledOffer.maxAffordableUnits)} سجل مقابل{" "}
              {formatNumber(quote.downscaledOffer.affordableQuotedPoints)} نقطة
            </button>
          )}
        </div>
      )}

      {/* Expiry note */}
      {expiryText && (
        <div className={`mt-1.5 text-xs ${expired ? "text-danger" : "text-sand-500"}`}>
          {expiryText}
        </div>
      )}

      {/* Action buttons: one primary "ابدأ" button and secondary "تعديل" link */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-sand-100 pt-3">
        <button
          type="button"
          onClick={() => setIsEditing(!isEditing)}
          disabled={quote.isDependent}
          className="cursor-pointer text-xs font-semibold text-sand-600 underline underline-offset-4 hover:text-ink-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {isEditing ? "إلغاء التعديل" : "تعديل"}
        </button>

        <button
          type="button"
          onClick={() => onStart(quote)}
          disabled={isStarting || !quote.isAffordable || quote.isDependent || expired}
          className="cursor-pointer min-h-10 rounded-xl bg-primary px-6 py-2 text-sm font-bold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white inline-flex items-center gap-2"
        >
          {isStarting ? (
            <>
              <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
              جاري البدء...
            </>
          ) : expired ? (
            "انتهت صلاحية العرض"
          ) : (
            "ابدأ"
          )}
        </button>
      </div>
    </div>
  );
}
