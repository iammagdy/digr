"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function LoginPage() {
  const { user, loading: authLoading, login } = useUser();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && user) router.push("/dashboard/chat");
  }, [user, authLoading, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.push("/dashboard/chat");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع أثناء تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="مرحبًا بعودتك"
      subtitle="سجّل الدخول لمتابعة أبحاثك وملفاتك ورصيدك."
      footer={
        <>
          ليس لديك حساب بعد؟{" "}
          <Link href="/register" className="font-bold text-accent hover:text-accent-hover">
            أنشئ حسابًا جديدًا
          </Link>
        </>
      }
    >
      {error && (
        <div className="mb-5">
          <Alert tone="danger" title="تعذّر تسجيل الدخول">
            {error}
          </Alert>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-5" noValidate={false}>
        <Field label="البريد الإلكتروني" htmlFor="email">
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            dir="ltr"
            className="auth-input text-left font-mono"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="كلمة المرور" htmlFor="password">
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              dir="ltr"
              className="auth-input pe-12 text-left font-mono"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              aria-pressed={showPassword}
              className="absolute end-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-sand-500 transition-colors hover:bg-sand-100 hover:text-ink-900"
            >
              {showPassword ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              )}
            </button>
          </div>
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={loading || authLoading}>
          {loading ? "جاري التحقق..." : "تسجيل الدخول"}
        </Button>
      </form>
    </AuthLayout>
  );
}
