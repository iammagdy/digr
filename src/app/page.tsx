import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      {/* Hero */}
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-5xl font-bold tracking-tight text-sand-900">
          Digr
        </h1>
        <p className="mt-4 text-xl leading-relaxed text-sand-600">
          بيانات جاهزة للتحليل — للباحثين والإحصائيين والطلاب
        </p>
        <p className="mt-2 text-base text-sand-500">
          اطلب مجموعات بيانات من مصادر عامة، وادفع برصيد مسبق، واستلم ملفات
          Excel جاهزة مع دليل المتغيرات ومنهجية الجمع.
        </p>

        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/login"
            className="rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            تسجيل الدخول
          </Link>
          <Link
            href="/register"
            className="rounded-lg border border-sand-300 bg-white px-6 py-3 text-sm font-medium text-sand-700 transition-colors hover:bg-sand-100"
          >
            حساب جديد
          </Link>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-auto pb-8 pt-16 text-center text-xs text-sand-400">
        © {new Date().getFullYear()} Digr
      </footer>
    </main>
  );
}
