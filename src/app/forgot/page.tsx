"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { account } from "@/lib/appwrite";
import { AuthLayout, AuthToast, authInput, authPrimaryBtn } from "@/components/AuthLayout";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) { setError("أنت غير متصل بالإنترنت."); return; }
    setError("");
    setBusy(true);
    try {
      await account.createRecovery(email.trim(), `${window.location.origin}/reset`);
    } catch (err) {
      // Same message whether or not the email exists — never reveal which addresses are registered.
      if ((err as { code?: number })?.code === 429) { setError("محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا."); setBusy(false); return; }
    }
    setBusy(false);
    setSent(true);
  }

  return (
    <AuthLayout
      title={sent ? "راجع بريدك" : "نسيت كلمة المرور؟"}
      subtitle={sent ? "أرسلنا رابط إعادة التعيين إن كان البريد مسجلًا." : "اكتب بريدك وسنرسل لك رابطًا لتعيين كلمة مرور جديدة."}
      showPending={false}
    >
      {!sent ? (
        <form onSubmit={submit} className="mt-7 flex flex-col gap-3" style={{ animation: "up .5s both" }}>
          <input type="email" dir="ltr" required autoComplete="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={`${authInput} text-left`} />
          <button type="submit" disabled={busy} className={`${authPrimaryBtn} mt-1.5`}>إرسال رابط إعادة التعيين</button>
          {error && <AuthToast tone="bad">{error}</AuthToast>}
          <Link href="/login" className="py-2.5 text-center text-sm text-mut">→ العودة لتسجيل الدخول</Link>
        </form>
      ) : (
        <div className="mt-7 flex flex-col gap-3.5" style={{ animation: "up .5s both" }}>
          <p className="m-0 rounded-[18px] bg-sf2 px-[18px] py-3.5 text-sm leading-[1.9] text-ink">إذا كان البريد مسجلًا لدينا، ستصلك رسالة خلال دقائق برابط صالح لمدة ساعة.</p>
          <Link href="/reset" className={`${authPrimaryBtn} min-h-[58px] text-[15px]`}>فتحت الرابط — تعيين كلمة مرور جديدة</Link>
          <Link href="/login" className="py-2.5 text-center text-sm text-mut">→ العودة لتسجيل الدخول</Link>
        </div>
      )}
    </AuthLayout>
  );
}
