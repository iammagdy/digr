"use client";

import { useState } from "react";

export interface JobEvent {
  $id: string;
  textAr: string;
  count?: number;
  kind: "info" | "progress" | "warning" | "error";
  createdAt: string;
}

interface ActivityTimelineProps {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  events: JobEvent[];
  rowsCollected: number;
}

export default function ActivityTimeline({ status, events, rowsCollected }: ActivityTimelineProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Default Arabic steps if live events are sparse
  const defaultSteps = [
    { text: "تم تحديد الخدمة المطلوبة", done: true },
    { text: "تم قبول عرض السعر وحجز الرصيد", done: true },
    { text: "جاري الاتصال بمصدر البيانات وجمع السجلات", done: status !== "queued" },
    { text: "حساب السجلات ومراجعة مؤشرات التغطية البرمجية", done: status === "done" || status === "cancelled" || rowsCollected > 0 },
    { text: "تم تجهيز ملفات Excel و PDF و CSV", done: status === "done" || status === "cancelled" },
  ];

  const isRunning = status === "queued" || status === "running";

  return (
    <div className="mt-3 bg-white border border-sand-300 rounded-2xl shadow-2xs overflow-hidden transition-all">
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        className="p-3.5 bg-sand-50/80 flex items-center justify-between cursor-pointer border-b border-sand-200 select-none"
      >
        <div className="flex items-center gap-2.5">
          {isRunning ? (
            <span className="w-2.5 h-2.5 rounded-full bg-accent animate-ping" />
          ) : status === "done" ? (
            <span className="w-2.5 h-2.5 rounded-full bg-success" />
          ) : (
            <span className="w-2.5 h-2.5 rounded-full bg-danger" />
          )}

          <span className="text-xs font-bold text-ink-900">
            متابعة التنفيذ وسجل النشاط
          </span>

          <span className="text-2xs px-2 py-0.5 rounded-full font-semibold bg-sand-200 text-sand-700">
            {status === "done"
              ? "تم بنجاح"
              : status === "failed"
              ? "فشل الاستخراج"
              : status === "cancelled"
              ? "تم الإلغاء"
              : isRunning
              ? "جاري المعالجة..."
              : "في الانتظار"}
          </span>
        </div>

        <button
          type="button"
          className="text-xs text-sand-500 hover:text-ink-900 font-medium"
        >
          {collapsed ? "عرض الخطوات ▼" : "طي السجل ▲"}
        </button>
      </div>

      {/* Step List */}
      {!collapsed && (
        <div className="p-4 space-y-3 text-xs">
          {events && events.length > 0 ? (
            <div className="space-y-2">
              {events.map((evt, idx) => (
                <div key={evt.$id || idx} className="flex items-start gap-2.5">
                  <span className="text-success mt-0.5 font-bold">✓</span>
                  <div className="flex-1">
                    <span className="text-ink-900 font-medium">{evt.textAr}</span>
                    {evt.count !== undefined && (
                      <span className="mr-1.5 text-2xs text-sand-500 font-bold tabular-nums">
                        ({evt.count} سجل)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2.5">
              {defaultSteps.map((step, idx) => (
                <div key={idx} className="flex items-center gap-2.5">
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-3xs font-bold ${
                      step.done
                        ? "bg-success text-white"
                        : "bg-sand-200 text-sand-500"
                    }`}
                  >
                    {step.done ? "✓" : idx + 1}
                  </span>
                  <span
                    className={`${
                      step.done ? "text-ink-900 font-medium" : "text-sand-500"
                    }`}
                  >
                    {step.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {status === "done" && (
            <div className="pt-2 border-t border-sand-200 text-3xs text-sand-500 text-left">
              تم جمع {rowsCollected.toLocaleString("ar-EG")} سجل وحفظ الملفات. راجع ملاحظات التغطية في لوحة النتائج.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
