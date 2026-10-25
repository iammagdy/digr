import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-dvh flex flex-col justify-center items-center px-4 bg-sand-50 text-ink-800 text-center">
      <div className="w-full max-w-md rounded-3xl border border-sand-300 bg-white p-8 shadow-xs space-y-4">
        <span className="text-4xl font-mono font-bold text-ink-400">404</span>
        <h1 className="text-xl font-bold text-ink-900">الصفحة المطلوبة غير موجودة</h1>
        <p className="text-xs sm:text-sm text-ink-600 leading-relaxed">
          عذراً، الرابط الذي تحاول الوصول إليه غير موجود أو تم نقله. يمكنك العودة لمنصة المساعد ومتابعة أبحاثك.
        </p>

        <div className="pt-2">
          <Link
            href="/dashboard/chat"
            className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white hover:bg-ink-800 transition-all"
          >
            ← العودة للمساعد الذكي
          </Link>
        </div>
      </div>
    </main>
  );
}
