"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";

export default function RegisterPage() {
  const { register } = useUser();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
      return;
    }

    setLoading(true);
    try {
      await register(email, password, name);
      router.push("/dashboard");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "حدث خطأ غير متوقع";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-bold text-sand-900">
          حساب جديد
        </h1>
        <p className="mt-2 text-center text-sm text-sand-500">
          سجّل حساب جديد لبدء طلب البيانات
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-sand-700"
            >
              الاسم
            </label>
            <input
              id="name"
              type="text"
              required
              autoComplete="name"
              className="mt-1 block w-full rounded-lg border border-sand-300 bg-white px-4 py-2.5 text-sand-900 placeholder:text-sand-400"
              placeholder="اسمك الكامل"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-sand-700"
            >
              البريد الإلكتروني
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              dir="ltr"
              className="mt-1 block w-full rounded-lg border border-sand-300 bg-white px-4 py-2.5 text-sand-900 placeholder:text-sand-400"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-sand-700"
            >
              كلمة المرور
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              dir="ltr"
              className="mt-1 block w-full rounded-lg border border-sand-300 bg-white px-4 py-2.5 text-sand-900 placeholder:text-sand-400"
              placeholder="8 أحرف على الأقل"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? "جاري التسجيل..." : "تسجيل"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-sand-500">
          لديك حساب؟{" "}
          <Link href="/login" className="font-medium text-accent">
            سجّل دخولك
          </Link>
        </p>
      </div>
    </main>
  );
}
