"use client";

import { useRef } from "react";
import { useDialogA11y } from "@/hooks/useDialogA11y";

/**
 * The confirmation before the methodology is bought. Moved here unchanged from the chat page so its behaviour can be tested on its own:
 * while the purchase is in progress neither Escape nor a click on the backdrop closes it, and both buttons are disabled.
 * Focus starts on «إلغاء» (the harmless choice) and returns to the button that opened it.
 */
export default function MethodologyConfirmDialog({
  open,
  methodologyPurchasing,
  pointsText,
  confirmGenerateMethodology,
  onCancel,
}: {
  open: boolean;
  methodologyPurchasing: boolean;
  /** «٥٠ نقطة»: what the methodology costs, already formatted. */
  pointsText: string;
  confirmGenerateMethodology: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeUnlessPurchasing = () => { if (!methodologyPurchasing) onCancel(); };
  useDialogA11y({ open, onClose: closeUnlessPurchasing, containerRef: sectionRef, initialFocusRef: cancelRef });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUnlessPurchasing(); }}>
      <section ref={sectionRef} role="alertdialog" aria-modal="true" aria-labelledby="methodology-purchase-title" className="w-full max-w-md rounded-2xl border border-ln bg-sf p-5 shadow-2xl" dir="rtl">
        <h2 id="methodology-purchase-title" className="m-0 text-lg font-semibold text-ink">صياغة المنهجية الرسمية</h2>
        <p className="mb-0 mt-2 text-sm leading-7 text-ink2">تُضاف المنهجية إلى نتيجة هذا الطلب مقابل {pointsText}. لن يتم الخصم إلا بعد تجهيزها.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" disabled={methodologyPurchasing} onClick={() => void confirmGenerateMethodology()} className="min-h-11 rounded-full border-0 bg-ac px-5 text-sm text-onac disabled:opacity-60">{methodologyPurchasing ? "جارٍ التجهيز…" : "تأكيد وطلب المنهجية"}</button>
          <button ref={cancelRef} type="button" disabled={methodologyPurchasing} onClick={onCancel} className="min-h-11 rounded-full border border-ln2 bg-transparent px-4 text-sm text-ink">إلغاء</button>
        </div>
      </section>
    </div>
  );
}
