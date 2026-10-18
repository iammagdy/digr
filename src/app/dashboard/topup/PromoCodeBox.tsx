"use client";

import { useState } from "react";

/** «كود ترويجي»: one field, clear Arabic result, immediate balance refresh through onRedeemed. */
export default function PromoCodeBox({ onRedeemed }: { onRedeemed: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/wallet/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        setResult({ ok: true, text: data.messageAr || "تم تطبيق الكود." });
        setCode("");
        onRedeemed();
      } else {
        setResult({ ok: false, text: data?.messageAr || data?.error || "تعذر تطبيق الكود الآن. حاول مرة أخرى بعد قليل." });
      }
    } catch {
      setResult({ ok: false, text: "تعذر الاتصال الآن. تأكد من الإنترنت وحاول مرة أخرى." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} data-promo-box="1" className="mt-2.5 flex flex-col gap-2.5 rounded-[20px] border border-ln bg-sf p-4" aria-label="كود ترويجي">
      <label htmlFor="promo-code-input" className="text-[13px] font-semibold text-ink">كود ترويجي</label>
      <div className="flex gap-2">
        <input
          id="promo-code-input"
          type="text"
          dir="ltr"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="اكتب الكود هنا"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-ln2 bg-bg px-3 text-right text-base text-ink outline-none focus-visible:outline-2"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "جاري التطبيق..." : "تطبيق الكود"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="m-0 min-h-[1.25rem] text-[13px] leading-[1.8]" style={{ color: result ? (result.ok ? "var(--ok)" : "var(--bad)") : "var(--mut)" }}>
        {result ? result.text : "إن وصلك كود هدية، اكتبه هنا لتُضاف نقاطه إلى رصيدك فورًا."}
      </p>
    </form>
  );
}
