"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sand-500">جاري التحميل...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen">
      {/* Top nav */}
      <header className="border-b border-sand-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-xl font-bold text-sand-900">
            Digr
          </Link>

          <nav className="flex items-center gap-6 text-sm">
            <Link
              href="/dashboard"
              className="text-sand-600 transition-colors hover:text-sand-900"
            >
              الرئيسية
            </Link>
            <Link
              href="/dashboard/order"
              className="text-sand-600 transition-colors hover:text-sand-900"
            >
              طلب جديد
            </Link>
            <Link
              href="/dashboard/jobs"
              className="text-sand-600 transition-colors hover:text-sand-900"
            >
              طلباتي
            </Link>
            <Link
              href="/dashboard/topup"
              className="text-sand-600 transition-colors hover:text-sand-900"
            >
              شحن الرصيد
            </Link>
          </nav>

          <div className="flex items-center gap-4">
            <span className="text-sm text-sand-500">{user.name}</span>
            <button
              onClick={() => {
                logout();
                router.push("/");
              }}
              className="text-sm text-sand-400 transition-colors hover:text-danger"
            >
              خروج
            </button>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
