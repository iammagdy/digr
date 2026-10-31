"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthLayout, AuthToast, authInput, authPrimaryBtn } from "@/components/AuthLayout";

/** Strength meter from the design: length ≥ 8, a letter, a digit, a symbol. */
function strength(pw: string) {
  return Number(pw.length >= 8) + Number(/[A-Za-z]/.test(pw)) + Number(/\d/.test(pw)) + Number(/[^\w]/.test(pw));
}

export default function ResetPage() {
  const router = useRouter();
  const [creds, setCreds] = useState<{ ready: boolean } | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get("code");
    const tokenHash = q.get("token_hash");
    const userId = q.get("userId");
    const secret = q.get("secret");

    const supabase = createClient();

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (!error) setCreds({ ready: true });
        else setCreds(null);
      });
    } else if (tokenHash) {
      supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }).then(({ error }) => {
        if (!error) setCreds({ ready: true });
        else setCreds(null);
      });
    } else if (userId && secret) {
      setCreds({ ready: true });
    } else {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) setCreds({ ready: true });
      });
    }
  }, []);

  const sc = strength(pw);
  const mismatch = !!pw2 && pw !== pw2;
  const ok = pw.length >= 8 && pw === pw2;
  const hint = !pw ? "٨ خانات على الأقل، ويفضّل أرقام ورموز." : pw.length < 8 ? "قصيرة — ٨ خانات على الأقل" : mismatch ? "كلمتا المرور غير متطابقتين" : sc >= 3 ? "قوية ✓" : "متوسطة — أضف رقمًا أو رمزًا";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || !creds) return;
    setBusy(true);
    setError("");
    try {
      const supabase = createClient();
      const { error: updateErr } = await supabase.auth.updateUser({ password: pw });
      if (updateErr) throw updateErr;
      router.replace("/login?reset=1");
    } catch {
      setError("الرابط غير صالح أو منتهي الصلاحية. اطلب رابطًا جديدًا.");
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="كلمة مرور جديدة" subtitle="اختر كلمة مرور قوية لم تستخدمها من قبل." showPending={false}>
      <form onSubmit={submit} className="mt-7 flex flex-col gap-3" style={{ animation: "up .5s both" }}>
        <input type="password" dir="ltr" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="كلمة المرور الجديدة · ٨ خانات على الأقل" className={`${authInput} text-left`} />
        <input type="password" dir="ltr" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="تأكيد كلمة المرور" className={`${authInput} text-left`} />
        <div className="flex gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-1 flex-1 rounded transition-colors duration-[250ms]" style={{ background: i < sc ? (sc >= 3 ? "var(--ok)" : "var(--gold)") : "var(--ln)" }} />
          ))}
        </div>
        <p className="m-0 text-xs" style={{ color: mismatch ? "var(--bad)" : "var(--mut)" }}>{hint}</p>
        <button type="submit" disabled={!ok || busy || !creds} className={`${authPrimaryBtn} mt-1.5`} style={{ opacity: ok ? 1 : 0.45 }}>حفظ كلمة المرور</button>
        {!creds && (
          <AuthToast tone="bad">افتح الرابط من رسالة البريد لتعيين كلمة مرور جديدة. <Link href="/forgot" className="underline">اطلب رابطًا جديدًا</Link></AuthToast>
        )}
        {error && <AuthToast tone="bad">{error}</AuthToast>}
      </form>
    </AuthLayout>
  );
}
