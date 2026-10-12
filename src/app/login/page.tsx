"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { AuthLayout, AuthToast, PasswordInput, authErrorMessage, authInput, authPrimaryBtn } from "@/components/AuthLayout";

export default function LoginPage() {
  const { user, loading: authLoading, login } = useUser();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reset") === "1") {
      setToast("تم تغيير كلمة المرور. سجّل الدخول بها الآن.");
      const t = setTimeout(() => setToast(""), 4000);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) router.replace(user.emailVerification ? "/dashboard/chat" : "/verify");
  }, [user, authLoading, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) { setError("أنت غير متصل بالإنترنت."); return; }
    setError("");
    setBusy(true);
    try {
      const u = await login(email.trim(), password);
      router.replace(u && !u.emailVerification ? "/verify" : "/dashboard/chat");
    } catch (err) {
      setError(authErrorMessage(err, "حدث خطأ غير متوقع أثناء تسجيل الدخول"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="مرحبًا بعودتك" subtitle="سجّل الدخول لمتابعة أبحاثك وملفاتك ورصيدك.">
      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3">
        <input
          type="email" dir="ltr" required autoComplete="email" placeholder="name@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} className={`${authInput} text-left`}
        />
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        <Link href="/forgot" className="self-start p-1.5 text-[13px] text-mut underline decoration-ln2 underline-offset-[5px]">نسيت كلمة المرور؟</Link>
        <button type="submit" disabled={busy || authLoading} className={`${authPrimaryBtn} mt-2.5`}>{busy ? "جاري التحقق..." : "تسجيل الدخول"}</button>
      </form>
      {error && <AuthToast tone="bad">{error}</AuthToast>}
      {toast && <AuthToast>{toast}</AuthToast>}
      <p className="mb-0 mt-6 text-center text-sm font-light text-mut">
        ليس لديك حساب؟{" "}
        <Link href="/register" className="p-1 text-sm font-medium text-ink underline decoration-gold underline-offset-[5px]">أنشئ حسابًا</Link>
      </p>
    </AuthLayout>
  );
}
