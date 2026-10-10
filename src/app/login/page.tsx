"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";

export default function LoginPage() {
  const { user, loading: authLoading, login } = useUser();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && user) {
      router.push("/dashboard/chat");
    }
  }, [user, authLoading, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.push("/dashboard/chat");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "حدث خطأ غير متوقع أثناء تسجيل الدخول";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col justify-center items-center px-4 sm:px-6 bg-sand-50 text-ink-800">
      {/* Brand Header */}
      <div className="w-full max-w-sm text-center mb-8">
        <Link href="/" className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-ink-900">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-900 text-sm font-semibold text-white">
            دِ
          </span>
          <span>Digr</span>
        </Link>
        <h1 className="mt-4 text-xl font-bold text-ink-900">تسجيل الدخول</h1>
        <p className="mt-1 text-xs text-ink-500">
          أدخل بيانات حسابك للمتابعة إلى منصة استخراج البيانات
        </p>
      </div>

      {/* Form Card */}
      <div className="w-full max-w-sm rounded-3xl border border-sand-300 bg-white p-6 sm:p-8 shadow-xs text-right">
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-danger">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs font-semibold text-ink-700">
              البريد الإلكتروني
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              dir="ltr"
              className="mt-1 block w-full rounded-xl border border-sand-300 bg-sand-50/50 px-4 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:border-ink-900 transition-all font-mono"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-ink-700">
              كلمة المرور
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              dir="ltr"
              className="mt-1 block w-full rounded-xl border border-sand-300 bg-sand-50/50 px-4 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:border-ink-900 transition-all font-mono"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="touch-target w-full rounded-xl bg-ink-900 px-4 py-3 text-sm font-semibold text-white hover:bg-ink-800 disabled:opacity-50 transition-all shadow-xs mt-2"
          >
            {loading ? "جاري التحقق..." : "تسجيل الدخول"}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-sand-100 text-center text-xs text-ink-500">
          ليس لديك حساب بعد؟{" "}
          <Link href="/register" className="font-semibold text-ink-900 underline hover:no-underline">
            أنشئ حساباً جديداً
          </Link>
        </div>
      </div>

      <div className="mt-8 text-center text-xs text-ink-400">
        <Link href="/" className="hover:text-ink-700 transition-colors">
          ← العودة للصفحة الرئيسية
        </Link>
      </div>
    </main>
  );
}
