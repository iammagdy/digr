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
    <form onSubmit={submit} data-promo-box="1" className="rounded-[18px] bg-wallet-promo px-4 py-3.5 text-wallet-promo-ink" aria-label="كود ترويجي">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-wallet-amber text-lg font-bold text-wallet-promo-ink">%</span>
          <div className="flex flex-col">
            <label htmlFor="promo-code-input" className="text-[15px] font-bold text-wallet-promo-ink">عندك كود ترويجي؟</label>
            <span className="text-xs text-wallet-promo-sub">تُضاف نقاطه إلى رصيدك فورًا.</span>
          </div>
        </div>
        <div className="flex min-w-[240px] flex-[1_1_280px] justify-end gap-2">
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
            className="min-h-11 min-w-0 max-w-[360px] flex-1 rounded-full border border-wallet-promo-line bg-white px-4 text-right text-base text-wallet-promo-ink outline-none focus-visible:outline-2"
          />
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 bg-wallet-card px-5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "جاري التطبيق..." : "تطبيق الكود"}
          </button>
        </div>
      </div>
      <p role="status" aria-live="polite" className={`m-0 text-[13px] leading-[1.8] ${result ? "mt-2" : ""}`} style={{ color: result?.ok ? "var(--wallet-promo-ok)" : "var(--wallet-promo-bad)" }}>
        {result ? result.text : ""}
      </p>
    </form>
  );
}
