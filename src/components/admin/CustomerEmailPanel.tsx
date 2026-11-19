"use client";

import { useState } from "react";
import { MessageComposer } from "./MessageComposer";

/**
 * «راسل العميل»: a message from the admin to this customer in the platform's e-mail design, sent from noreply@diger.tech to the customer's
 * registered address only. The composer itself (fields, presets, AI draft, preview, test to the admin, attachments, the confirmed send) is
 * `MessageComposer` in «عميل واحد» mode (DT-20261118-06 phase 2A); this panel only opens it inside the customer's sheet.
 */
export function CustomerEmailPanel({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">راسل العميل</h3>
      <div className="flex flex-col gap-2.5 rounded-[14px] border border-ln p-3">
        {open ? (
          <MessageComposer mode="single" userId={userId} />
        ) : (
          <>
            <p className="m-0 text-xs leading-[1.8] text-mut">رسالة بتصميم ديجر من noreply@diger.tech إلى بريد العميل المسجّل، مع مرفق من جهازك أو ملف نتائج مهمة.</p>
            <button type="button" onClick={() => setOpen(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink">كتابة رسالة</button>
          </>
        )}
      </div>
    </section>
  );
}
