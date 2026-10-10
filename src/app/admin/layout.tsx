"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";

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
    <div className="min-h-screen bg-sand-50">
      <header className="border-b border-sand-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/admin/topups" className="text-lg font-bold text-sand-900">
              Digr <span className="mr-1 text-xs font-normal text-amber-600 bg-amber-50 px-2 py-0.5 rounded">إدارة</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/admin/topups" className="text-sand-700 hover:text-sand-900 font-medium">
                طلبات الشحن
              </Link>
              <Link href="/dashboard" className="text-sand-400 hover:text-sand-600">
                لوحة المستخدم
              </Link>
            </nav>
          </div>
          <span className="text-xs text-sand-500">{user?.name} (مسؤول)</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
