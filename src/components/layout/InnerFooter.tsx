import Link from "next/link";

export function InnerFooter() {
  return (
    <footer className="mt-auto border-t border-ln bg-sf px-5 py-8 text-ink2">
      <div className="mx-auto flex max-w-[1000px] flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-start">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-mut sm:justify-start">
          <Link href="/" className="hover:text-ink text-ink2 transition-colors">الرئيسية</Link>
          <Link href="/pricing" className="hover:text-ink text-ink2 transition-colors">الأسعار</Link>
          <Link href="/calculator" className="hover:text-ink text-ink2 transition-colors">احسب طلبك</Link>
          <Link href="/help" className="hover:text-ink text-ink2 transition-colors">مركز المساعدة</Link>
          <Link href="/contact" className="hover:text-ink text-ink2 transition-colors">اتصل بنا</Link>
          <Link href="/legal/terms" className="hover:text-ink text-ink2 transition-colors">الشروط والأحكام</Link>
          <Link href="/legal/privacy" className="hover:text-ink text-ink2 transition-colors">سياسة الخصوصية</Link>
          <Link href="/legal/refunds" className="hover:text-ink text-ink2 transition-colors">سياسة الرصيد</Link>
          <Link href="/legal/acceptable-use" className="hover:text-ink text-ink2 transition-colors">الاستخدام المقبول</Link>
          <Link href="/legal/cookies" className="hover:text-ink text-ink2 transition-colors">ملفات تعريف الارتباط</Link>
        </div>
        <p className="m-0 text-[12px] text-mut dir-rtl">
          ديجر © ٢٠٢٦ · مصادر متاحة فقط
        </p>
      </div>
    </footer>
  );
}

export default InnerFooter;
