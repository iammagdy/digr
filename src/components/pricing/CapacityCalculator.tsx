"use client";

import { useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import { capacityForAmount, capacityLineAr, pointsForAmountEgp } from "@/lib/pricingPage";

/** «كم أحصل بمبلغي؟»: pure code in the browser (the same functions the server uses); nothing is sent anywhere. */
export default function CapacityCalculator() {
  const [text, setText] = useState("");
  const amount = Number(text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d]/g, "")) || 0;
  const bounded = Math.min(amount, 1_000_000);
  const lines = bounded > 0 ? capacityForAmount(bounded) : [];
  return (
    <div data-testid="capacity-calculator" className="flex flex-col gap-4 rounded-[20px] border border-ln bg-sf p-6">
      <label htmlFor="pricing-amount" className="text-sm font-medium text-ink">اكتب أي مبلغ بالجنيه لترى ما يغطيه</label>
      <input id="pricing-amount" inputMode="numeric" value={text} onChange={(event) => setText(event.target.value)} placeholder="مثال: ٣٠٠" className="min-h-12 rounded-[14px] border border-ln2 bg-bg px-3.5 text-sm text-ink outline-none" />
      {lines.length ? (
        <div role="status" className="flex flex-col gap-2">
          <p className="m-0 text-sm text-ink">{toArabicDigits(bounded)} ج.م = {toArabicDigits(pointsForAmountEgp(bounded))} نقطة</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm font-light text-ink2">
            {lines.map((line) => <li key={line.id}>{line.labelAr}: {capacityLineAr(line)}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
