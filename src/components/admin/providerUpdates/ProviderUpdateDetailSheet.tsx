"use client";

import { useState } from "react";
import { Sheet, SheetHandle, KV } from "../Sheet";
import { StatusBadge, type BadgeTone } from "../ui";
import { tint } from "../format";
import type { ProviderUpdateFeedRow, UpdateKind, UpdateStatus } from "./types";

const KIND_LABELS: Record<UpdateKind, { label: string; tone: BadgeTone }> = {
  new: { label: "ميزة جديدة", tone: "ok" },
  changed: { label: "تعديل متاح", tone: "warn" },
  removed: { label: "إيقاف أو حذف", tone: "bad" },
};

const STATUS_LABELS: Record<UpdateStatus, { label: string; tone: BadgeTone }> = {
  new: { label: "جديدة", tone: "gold" },
  studied: { label: "اتدرست", tone: "mute" },
  planned: { label: "في الخطة", tone: "warn" },
  merged: { label: "اندمجت", tone: "ok" },
  rejected: { label: "اترفضت", tone: "bad" },
};

export function providerDisplayName(provider: string): string {
  if (!provider) return "—";
  const norm = provider.toLowerCase();
  if (norm.includes("context")) return "Context.dev";
  if (norm.length <= 4) return norm.toUpperCase();
  return norm.charAt(0).toUpperCase() + norm.slice(1);
}

export function ProviderUpdateDetailSheet({
  item,
  reports,
  onClose,
}: {
  item: ProviderUpdateFeedRow | null;
  reports: Record<string, string>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);

  if (!item) return null;

  const kindInfo = KIND_LABELS[item.kind] ?? { label: item.kind, tone: "mute" as BadgeTone };
  const statusInfo = STATUS_LABELS[item.status] ?? { label: item.status, tone: "mute" as BadgeTone };
  const rawReport = reports[item.id];
  const hasReport = typeof rawReport === "string" && rawReport.trim().length > 0;

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(item.item).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const briefText = item.brief_ar && item.brief_ar.trim().length > 0
    ? item.brief_ar
    : "«الملخص لسه بيتكتب»";

  return (
    <Sheet label={`تفاصيل ${item.title_ar}`} onClose={onClose}>
      <div className="flex h-full flex-col overflow-hidden p-5">
        <SheetHandle />

        {step === 1 ? (
          <div className="flex flex-1 flex-col overflow-y-auto">
            {/* Header badges and title */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={kindInfo.tone}>{kindInfo.label}</StatusBadge>
              <StatusBadge tone={statusInfo.tone}>{statusInfo.label}</StatusBadge>
              <span className="text-xs font-semibold text-mut">
                {providerDisplayName(item.provider)}
              </span>
            </div>

            <h2 className="mt-3 text-lg font-bold text-ink">{item.title_ar}</h2>
            <p className="mt-1 text-xs text-mut">{item.summary_ar}</p>

            {/* Hero Brief Block (باختصار) */}
            <div
              data-testid="brief-container"
              className="mt-4 rounded-2xl p-4 text-sm leading-relaxed text-ink"
              style={{
                background: tint("var(--ac)", 8),
                border: "1px solid var(--ln2)",
              }}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ac">
                <span>💡</span>
                <span>باختصار</span>
              </div>
              <p data-testid="brief-text" className="m-0 leading-[1.8]">
                {briefText}
              </p>
            </div>

            {/* KV Details Grid */}
            <div className="mt-4 flex flex-col divide-y divide-ln">
              <KV
                k="نقطة المزود"
                v={item.item}
                mono
                copy={{ label: copied ? "تم النسخ" : "نسخ", onCopy: handleCopy }}
              />
              <KV k="المزود" v={providerDisplayName(item.provider)} />
              <KV k="التكلفة" v={item.price_ar || "—"} />
              <KV k="الحالة لدينا" v={statusInfo.label} />
              {item.status === "rejected" && item.status_reason_ar && (
                <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-ln py-2">
                  <span className="shrink-0 text-[13px] text-bad font-semibold">سبب الاستبعاد</span>
                  <span className="text-left text-[13px] text-bad">{item.status_reason_ar}</span>
                </div>
              )}
            </div>

            {/* External source doc link */}
            {item.source_url && (
              <div className="mt-4">
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hit flex min-h-11 items-center justify-center gap-2 rounded-xl border border-ln2 bg-sf px-4 text-xs font-semibold text-ink hover:border-ln"
                >
                  <span>🔗 فتح التوثيق الأصلي لدى المزود</span>
                </a>
              </div>
            )}

            {/* Step transition button */}
            <div className="mt-auto pt-6">
              <button
                type="button"
                data-testid="open-full-report-button"
                onClick={() => setStep(2)}
                className="hit flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-ink px-4 text-xs font-semibold text-bg shadow-sm"
              >
                <span>📄 عرض التقرير الكامل لدراسة الكشّاف</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Step 2 Header with back button */}
            <div className="flex items-center justify-between border-b border-ln pb-3">
              <button
                type="button"
                data-testid="back-to-brief-button"
                onClick={() => setStep(1)}
                className="hit flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-ln2 bg-sf px-3.5 text-xs font-semibold text-ink hover:border-ln"
              >
                <span>← العودة إلى الملخص</span>
              </button>
              <span className="text-xs font-semibold text-mut truncate max-w-[200px]">
                {item.title_ar}
              </span>
            </div>

            {/* Markdown Report Content */}
            <div
              data-testid="report-content-container"
              className="flex-1 overflow-y-auto py-4 text-sm leading-relaxed text-ink"
            >
              {hasReport ? (
                <article
                  data-testid="markdown-report"
                  className="prose prose-sm max-w-none space-y-3 whitespace-pre-wrap font-sans"
                >
                  {rawReport}
                </article>
              ) : (
                <div
                  data-testid="empty-report-notice"
                  className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-ln2 p-6 text-center text-xs text-mut"
                >
                  <span className="mb-2 text-2xl">📋</span>
                  <span>«تقرير الدراسة الكامل غير متاح لهذا التحديث حالياً»</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
