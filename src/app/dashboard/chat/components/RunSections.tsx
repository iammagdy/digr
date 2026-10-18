"use client";

import { formatAr } from "@/lib/arabicDigits";
import { sanitizeActivityError } from "@/functions/shared/liveActivityFeed";
import { producedFormats, type ResultFileIds, type ResultFormat } from "@/lib/producedFormats";

// Excel holds the data only; the methodology is its own Arabic PDF.
const FILES: Record<ResultFormat, { name: string; desc: string; requestLabel: string }> = {
  xlsx: { name: "إكسل", desc: "جدول البيانات فقط", requestLabel: "جهّز ملف إكسل" },
  pdf: { name: "بي دي إف", desc: "الدليل المنهجي", requestLabel: "جهّز ملف بي دي إف" },
  csv: { name: "سي إس في", desc: "بيانات جدولية", requestLabel: "جهّز ملف سي إس في" },
};

/** Design «الملفات»: delivery summary + ONLY the files this request produced (the formats of the approved quote). Numbers come from the finished job, never from the quote. */
export function FilesSection({
  rows, requested, charged, reserved, fileIds, downloadingKey, onDownload, onOpenCanvas, canvasOpen,
}: {
  rows: number;
  requested?: number;
  charged?: number;
  reserved?: number;
  /** Stored file ids of the finished job; a missing id means that format was not produced. */
  fileIds?: ResultFileIds | null;
  downloadingKey: string | null;
  onDownload: (ext: ResultFormat) => void;
  onOpenCanvas: () => void;
  canvasOpen: boolean;
}) {
  const ready = producedFormats(fileIds);
  return (
    <div style={{ animation: "up .6s both" }}>
      <p className="mb-0 mt-3 text-sm font-light leading-[1.9] text-ink">
        سُلّم {formatAr(rows)} سجلًا{requested ? ` من ${formatAr(requested)}` : ""}
        {typeof charged === "number" && <> — تم خصم {formatAr(charged)} نقطة.</>}
      </p>
      <div className="mt-4 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,180px),1fr))" }}>
        {ready.map((ext) => (
          <button
            key={ext} type="button" onClick={() => onDownload(ext)} disabled={downloadingKey !== null}
            className="flex min-h-14 cursor-pointer items-center justify-between gap-2.5 rounded-xl border border-ln bg-sf px-3.5 text-right disabled:cursor-wait disabled:opacity-60"
          >
            <span>
              <span className="block text-[13px] font-semibold text-ink">{FILES[ext].name}</span>
              <span className="block text-[11px] font-light text-fnt">{FILES[ext].desc}</span>
            </span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sf2 text-xs text-ink">↓</span>
          </button>
        ))}
      </div>
      <button
        type="button" onClick={onOpenCanvas} aria-expanded={canvasOpen} aria-controls="results-canvas"
        className="mt-3 min-h-11 min-w-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink"
      >
        لوحة النتائج
      </button>
    </div>
  );
}

/** Design «تعذّر إكمال البحث»: a failed run is fully refunded; retry asks for a fresh quote. */
export function FailureBox({
  providerMessage, refunded, onRetry, onGoRequests,
}: { providerMessage?: string; refunded?: number; onRetry: () => void; onGoRequests: () => void }) {
  return (
    <div
      role="alert"
      className="mt-4 flex flex-col gap-3 rounded-[20px] p-4"
      style={{ border: "1px solid color-mix(in oklab, var(--bad) 35%, transparent)", background: "color-mix(in oklab, var(--bad) 6%, var(--sf))", animation: "up .4s both" }}
    >
      <p className="m-0 text-[13px] font-semibold text-ink">تعذّر إكمال البحث</p>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">
        {providerMessage ? `${sanitizeActivityError(providerMessage)} ` : "تعذر إكمال البحث حالياً. "}
        لم يُخصم أي رصيد.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-[18px] text-[13px] text-onac">إعادة المحاولة</button>
        <button type="button" onClick={onGoRequests} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink">عرض في طلباتي</button>
      </div>
    </div>
  );
}
