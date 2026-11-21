import Link from "next/link";

export default function NotFound() {
  return (
    <main dir="rtl" lang="ar" className="min-h-dvh flex flex-col justify-center items-center px-4 bg-bg text-ink2 text-center">
      <div className="w-full max-w-md rounded-3xl border border-ln2 bg-sf p-8 shadow-xs space-y-4">
        <span className="text-4xl font-mono font-bold text-fnt">٤٠٤</span>
        <h1 className="text-xl font-bold text-ink">الصفحة المطلوبة غير موجودة</h1>
        <p className="text-xs sm:text-sm text-mut leading-relaxed">
          عذرًا، الرابط الذي تحاول الوصول إليه غير موجود أو تم نقل الصفحة. يمكنك العودة إلى الصفحة الرئيسية.
        </p>

        <div className="pt-2">
          <Link
            href="/"
            className="touch-target inline-flex items-center justify-center rounded-xl bg-ac px-5 py-2.5 text-xs sm:text-sm font-semibold text-onac hover:opacity-90 transition-all"
          >
            → العودة إلى الرئيسية
          </Link>
        </div>
      </div>
    </main>
  );
}
