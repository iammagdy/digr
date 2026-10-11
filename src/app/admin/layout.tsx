"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.push("/login");
      } else {
        const hasAdminLabel = Array.isArray(user.labels) && user.labels.includes("admin");
        setIsAdmin(hasAdminLabel);
      }
    }
  }, [user, loading, router]);

  if (loading || isAdmin === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sand-500">جاري التحقق من الصلاحيات...</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-bold text-sand-900">غير مصرح</h1>
        <p className="mt-2 text-sm text-sand-500">
          هذه الصفحة مخصصة لمديري النظام فقط.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
        >
          العودة للوحة التحكم
        </Link>
      </div>
    );
  }

  return (
    <div className="admin-shell min-h-screen bg-bg text-foreground" data-design-surface="admin">
      <aside className="admin-sidebar" aria-label="قائمة الإدارة">
        <Link href="/admin/topups" className="admin-brand" aria-label="Digr — الإدارة">
          <BrandLogo size="medium" />
          <span>إدارة</span>
        </Link>
        <nav className="admin-nav" aria-label="التنقل الإداري">
          <Link href="/admin/topups" aria-current="page" className="admin-nav__active">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7h18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 9h4m-4 4h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
            طلبات الشحن
          </Link>
          <Link href="/dashboard" className="admin-nav__link">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            لوحة المستخدم
          </Link>
        </nav>
        <div className="admin-sidebar__account">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-foreground">{user?.name}</p>
            <p className="text-xs text-foreground-muted">مسؤول النظام</p>
          </div>
          <ThemeToggle className="h-10 w-10" />
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <h1>طلبات الشحن</h1>
          <Link href="/dashboard" className="admin-topbar__user">{user?.name} <span>مسؤول</span></Link>
        </header>
        <main className="admin-content">{children}</main>
      </div>
    </div>
  );
}
