"use client";

import { useState } from "react";
import { formatAr } from "@/lib/arabicDigits";
import { formatNumber } from "@/lib/honestDisplay";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";

export interface RevisionQuoteData {
  jobId: string;
  revisionDescription: string;
  operation: ArtifactEditOperation;
  points: number;
  targetVersion?: number;
}

interface RevisionQuoteCardProps {
  quote: RevisionQuoteData;
  onApply: (quote: RevisionQuoteData) => Promise<void>;
  isApplying: boolean;
  userBalance?: number | null;
  disabled?: boolean;
}

export default function RevisionQuoteCard({
  quote,
  onApply,
  isApplying,
  userBalance,
  disabled = false,
}: RevisionQuoteCardProps) {
  const [error, setError] = useState<string | null>(null);
  const affordable = userBalance === null || userBalance === undefined || userBalance >= quote.points;

  async function handleConfirm() {
    setError(null);
    try {
      await onApply(quote);
    } catch (err: any) {
      setError(err?.message || "تعذر تطبيق التعديل على الملفات");
    }
  }

  return (
    <div
      className="mt-[18px] rounded-2xl border border-ln bg-sf p-4 text-ink"
      style={{ animation: "up .5s both" }}
      aria-label="عرض سعر تعديل المخرجات"
      dir="rtl"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="inline-block rounded-full bg-ac/10 px-3 py-1 text-xs font-semibold text-ac">
            طلب تعديل مخرجات
          </span>
          <h3 className="mb-0 mt-2 text-base font-bold text-ink">
            {quote.revisionDescription || "تعديل تنسيق وإخراج ملفات البحث"}
          </h3>
        </div>
        <div className="text-left">
          <p className="m-0 text-[26px] font-semibold leading-none text-ink">
            {formatAr(quote.points)}
            <span className="text-xs text-mut" style={{ marginInlineStart: 6 }}>
              نقطة
            </span>
          </p>
          <p className="mb-0 mt-1 text-xs font-light text-mut">
            ≈ {formatAr(Number((quote.points * 0.1).toFixed(2)))} ج.م
          </p>
        </div>
      </div>

      <div className="mt-3.5 rounded-[14px] bg-sf2 p-3 text-xs leading-[1.8] text-ink2">
        <p className="m-0">
          • <strong className="text-ink">نطاق التعديل:</strong> تحرير وتنسيق البيانات الموجودة محلياً (بدون استهلاك رصيد لجمع بيانات جديدة).
        </p>
        <p className="m-0 mt-1">
          • <strong className="text-ink">إدارة النسخ:</strong> سيتم حفظ التعديل كنسخة جديدة برقم {quote.targetVersion ? formatAr(quote.targetVersion) : "جديد"} مع الحفاظ التام على النسخة الأصلية للرجوع إليها في أي وقت.
        </p>
        <p className="m-0 mt-1 text-amber-800 dark:text-amber-300">
          • <strong className="text-ink">الخصم المالي:</strong> تكلفة التعديل ١٠ نقاط تُخصم عند اعتماد النسخة. تتطلب العملية تفعيل الخصم الذري المعتمد لضمان حماية الرصيد وعدم الخصم إلا عند نجاح الحفظ.
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-bad">
          {error}
        </p>
      )}

      {!affordable && (
        <p role="alert" className="mb-0 mt-3 text-xs text-bad">
          رصيدك الحالي ({formatNumber(userBalance ?? 0)} نقطة) غير كافٍ لإتمام التعديل.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={disabled || isApplying || !affordable}
          className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-ac px-5 text-[13px] font-medium text-onac transition-opacity focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isApplying ? "جاري تجهيز النسخة الجديدة..." : `اعتماد وتطبيق التعديل (${formatAr(quote.points)} نقطة)`}
        </button>
      </div>
    </div>
  );
}
