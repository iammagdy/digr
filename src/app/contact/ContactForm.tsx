"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Brand";
import { toArabicDigits } from "@/lib/arabicDigits";
import { SUPPORT_PLACEHOLDER_AR, validateSupportMessage, whatsappHref, type SupportSettings } from "@/lib/supportContact";

/** «تواصل معنا»: a form that stores the message, the support email and WhatsApp number from the admin settings. */
export default function ContactForm({ initialSettings = { supportEmail: "", whatsappNumber: "" } }: { initialSettings?: SupportSettings }) {
  const [settings, setSettings] = useState<SupportSettings>(initialSettings);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    // Refresh in case the owner changed the settings after the page was rendered; a failed refresh keeps what the server rendered.
    fetch("/api/support/settings").then((r) => r.json()).then((s) => setSettings((prev) => ({ supportEmail: s?.supportEmail || prev.supportEmail, whatsappNumber: s?.whatsappNumber || prev.whatsappNumber }))).catch(() => {});
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const check = validateSupportMessage({ name, email, message });
    if (!check.ok) { setResult({ ok: false, text: check.errorAr }); return; }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/support/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...check.value, website }) });
      const data = await res.json().catch(() => ({}));
      setResult({ ok: Boolean(res.ok && data?.success), text: data?.messageAr || "تعذر إرسال الرسالة الآن. حاول مرة أخرى بعد قليل." });
      if (res.ok && data?.success) setMessage("");
    } catch {
      setResult({ ok: false, text: "تعذر الاتصال الآن. تأكد من الإنترنت وحاول مرة أخرى." });
    } finally {
      setBusy(false);
    }
  }

  const wa = whatsappHref(settings.whatsappNumber);
  // The «coming soon» note appears only when NEITHER channel is set; with one set, the other card is simply not shown.
  const hasEmail = Boolean(settings.supportEmail);
  const hasAnyChannel = hasEmail || Boolean(wa);
  const field = "min-h-12 w-full rounded-xl border border-ln2 bg-bg px-3.5 text-base text-ink outline-none focus-visible:outline-2";
  return (
    <main data-screen-label="Contact" className="min-h-dvh bg-bg px-5 pb-[72px] pt-5 text-ink2">
      <div className="mx-auto flex max-w-[640px] flex-col gap-[18px]">
        <div className="flex items-center justify-between gap-2.5">
          <Link href="/" className="flex min-h-11 items-center rounded-full bg-sf2 px-4 text-[13px] text-ink">→ الرئيسية</Link>
          <Link href="/" aria-label="ديجر" className="flex min-h-11 items-center"><Logo height={26} /></Link>
        </div>
        <div>
          <h1 className="m-0 font-display text-[40px] font-medium leading-[1.15] text-ink">تواصل معنا</h1>
          <p className="mb-0 mt-2 text-[15px] font-light leading-[2] text-ink2">اكتب لنا مشكلتك أو سؤالك، وسنرد عليك على بريدك الإلكتروني. إن كان عندك طلب بعينه فاضغط «بلّغ عن مشكلة» من صفحة طلباتك ليصلنا رقمه تلقائيًا.</p>
        </div>

        <div className="grid grid-cols-1 gap-2.5 min-[560px]:grid-cols-2">
          {(hasEmail || !hasAnyChannel) && <div className="rounded-[18px] border border-ln bg-sf p-4">
            <p className="m-0 text-xs text-mut">البريد الإلكتروني للدعم</p>
            <p className="mb-0 mt-1.5 text-[15px] text-ink" dir="ltr" style={{ textAlign: "right" }}>
              {settings.supportEmail ? <a href={`mailto:${settings.supportEmail}`} className="text-ink">{settings.supportEmail}</a> : <span dir="rtl">{SUPPORT_PLACEHOLDER_AR}</span>}
            </p>
          </div>}
          {(wa || !hasAnyChannel) && <div className="rounded-[18px] border border-ln bg-sf p-4">
            <p className="m-0 text-xs text-mut">واتساب</p>
            <p className="mb-0 mt-1.5 text-[15px] text-ink" dir="ltr" style={{ textAlign: "right" }}>
              {wa ? <a href={wa} dir="ltr" className="text-ink" rel="noopener noreferrer" target="_blank">{`+${toArabicDigits(settings.whatsappNumber)}`}</a> : <span dir="rtl">{SUPPORT_PLACEHOLDER_AR}</span>}
            </p>
          </div>}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3 rounded-[22px] border border-ln bg-sf p-[18px]" aria-label="نموذج التواصل" noValidate>
          <label className="flex flex-col gap-1.5"><span className="text-[13px] font-semibold text-ink">الاسم</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" className={field} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-[13px] font-semibold text-ink">البريد الإلكتروني</span><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" dir="ltr" autoComplete="email" className={`${field} text-left`} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-[13px] font-semibold text-ink">الرسالة</span><textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} rows={6} className={`${field} min-h-36 py-3 leading-[1.9]`} /></label>
          {/* Hidden from people; bots that fill it are ignored. */}
          <div aria-hidden="true" style={{ position: "absolute", insetInlineStart: "-9999px", height: 0, overflow: "hidden" }}>
            <label>موقع<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          </div>
          <button type="submit" disabled={busy} className="min-h-12 cursor-pointer rounded-full border-0 bg-ac px-6 text-[14px] font-semibold text-onac disabled:cursor-wait disabled:opacity-60">{busy ? "جاري الإرسال..." : "إرسال الرسالة"}</button>
          <p role="status" aria-live="polite" className="m-0 min-h-[1.25rem] text-[13px] leading-[1.8]" style={{ color: result ? (result.ok ? "var(--ok)" : "var(--bad)") : "var(--mut)" }}>{result?.text || ""}</p>
        </form>
      </div>
    </main>
  );
}
