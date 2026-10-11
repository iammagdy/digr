"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";

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
    <main data-auth-screen>
      <div className="auth-column">
        <div className="flex justify-center">
          <Link href="/" aria-label="Digr — الرئيسية"><BrandLogo size="large" /></Link>
        </div>
        <div className="mt-10 text-center">
          <h1 className="font-display text-4xl text-ink-900">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-600">{subtitle}</p>
        </div>
        <div className="mt-8">{children}</div>
        <div className="mt-8 border-t border-sand-200 pt-5 text-center text-sm text-ink-600">{footer}</div>
        <p className="mt-8 text-center text-xs text-sand-500">
          <Link href="/" className="transition-colors hover:text-ink-900">العودة للصفحة الرئيسية</Link>
        </p>
      </div>
    </main>
  );
}
