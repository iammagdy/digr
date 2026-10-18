"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { Spinner } from "@/components/ui";
import { AuthLayout, AuthToast, PasswordInput, authErrorMessage, authInput, authPrimaryBtn } from "@/components/AuthLayout";

export default function RegisterPage() {
  const { user, loading: authLoading, register } = useUser();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authLoading && user) router.replace(user.emailVerification ? "/dashboard/chat" : "/verify");
  }, [user, authLoading, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) { setError("أنت غير متصل بالإنترنت."); return; }
    setError("");
    if (password.length < 8) { setError("كلمة المرور يجب ألا تقل عن 8 خانات"); return; }
    setBusy(true);
    try {
      await register(email.trim(), password, name.trim());
      router.replace("/verify");
    } catch (err) {
      setError(authErrorMessage(err, "حدث خطأ غير متوقع أثناء إنشاء الحساب"));
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner label="جاري التحقق من الجلسة" />
      </div>
    );
  }

  return (
    <AuthLayout title="أنشئ حسابك" subtitle="ابدأ في تصميم خطط بحثك والحصول على عروض أسعار شفافة بالنقاط.">
      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3">
        <input
          type="text" required autoComplete="name" placeholder="الاسم" value={name}
          onChange={(e) => setName(e.target.value)} className={authInput}
        />
        <input
          type="email" dir="ltr" required autoComplete="email" placeholder="name@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} className={`${authInput} text-left`}
        />
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        <button type="submit" disabled={busy || authLoading} className={`${authPrimaryBtn} mt-2.5`}>{busy ? "جاري إنشاء الحساب..." : "إنشاء الحساب"}</button>
      </form>
      {error && <AuthToast tone="bad">{error}</AuthToast>}
      <p className="mb-0 mt-[34px] text-center text-sm font-light text-mut">
        لديك حساب بالفعل؟{" "}
        <Link href="/login" className="p-1 text-sm font-medium text-ink underline decoration-gold underline-offset-[5px]">سجّل الدخول</Link>
      </p>
      <p className="mb-0 mt-3.5 text-center text-xs font-light leading-[1.8] text-fnt">
        بإنشائك الحساب أنت توافق على جمع البيانات من المصادر المتاحة وفق ضوابط الخصوصية والاستخدام المقبول.{" "}
        <Link href="/legal/terms" className="text-xs text-mut underline">الشروط</Link> · <Link href="/legal/privacy" className="text-xs text-mut underline">الخصوصية</Link>
      </p>
    </AuthLayout>
  );
}

