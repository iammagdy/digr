"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared premium auth layout.
 * Desktop: brand panel + focused form. Mobile: single column, form first.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh bg-sand-50 lg:grid-cols-2">
      {/* Brand panel — desktop only */}
      <aside className="relative hidden overflow-hidden bg-pine-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-10" aria-hidden="true">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -start-32 h-96 w-96 rounded-full bg-accent/15 blur-3xl" />
          <div className="absolute bottom-0 end-0 h-72 w-72 rounded-full bg-white/5 blur-3xl" />
        </div>
        <Link href="/" className="relative flex items-center gap-2.5" tabIndex={-1}>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-lg font-bold text-white ring-1 ring-white/20">دِ</span>
          <span className="text-2xl font-bold tracking-tight">Digr</span>
        </Link>
        <div className="relative max-w-md">
          <p className="font-display text-3xl leading-snug text-white">
            «من السؤال البحثي إلى ملفات جاهزة للتحليل — بشفافية كاملة.»
          </p>
          <div className="mt-8 space-y-3 text-sm text-sand-200">
            {["أسئلة توضيحية ذكية بالعربية", "خطط بحث قابلة للتعديل", "عرض سعر بالنقاط قبل أي التزام"].map((t) => (
              <p key={t} className="flex items-center gap-2.5">
                <svg className="h-4 w-4 shrink-0 text-pine-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {t}
              </p>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-sand-400">بيانات عامة فقط · موافقة صريحة قبل أي جمع · 1 نقطة = 0.10 ج.م</p>
      </aside>

      {/* Form column */}
      <div className="flex flex-col px-4 py-8 sm:px-8 sm:py-10">
        <div className="mx-auto w-full max-w-md flex-1">
          <Link href="/" className="mb-8 inline-flex items-center gap-2.5 lg:hidden" aria-label="Digr — الرئيسية">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-pine-800 text-base font-bold text-white">دِ</span>
            <span className="text-xl font-bold tracking-tight text-ink-900">Digr</span>
          </Link>
          <div className="mt-2 lg:mt-14">
            <h1 className="font-display text-3xl text-ink-900">{title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">{subtitle}</p>
          </div>
          <div className="mt-8">{children}</div>
          <div className="mt-8 border-t border-sand-200 pt-5 text-center text-sm text-ink-600">{footer}</div>
        </div>
        <p className="mt-8 text-center text-xs text-sand-500">
          <Link href="/" className="transition-colors hover:text-ink-900">العودة للصفحة الرئيسية</Link>
        </p>
      </div>
    </main>
  );
}
