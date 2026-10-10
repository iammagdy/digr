"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { databases } from "@/lib/appwrite";
import { Query } from "appwrite";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const [balance, setBalance] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Load balance for header badge
  const loadBalance = useCallback(async () => {
    if (!user) return;
    try {
      let total = 0;
      let offset = 0;
      const limit = 100;
      while (true) {
        const res = await databases.listDocuments("digr", "credit_ledger", [
          Query.equal("userId", user.$id),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        for (const doc of res.documents) {
          total += (doc.delta as number) || 0;
        }
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setBalance(total);
    } catch {
      setBalance(0);
    }
  }, [user]);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    } else if (user) {
      loadBalance();
    }
  }, [user, loading, router, loadBalance]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sand-50">
        <div className="flex items-center gap-3 text-sm text-ink-500 font-medium">
          <span className="h-4 w-4 rounded-full border-2 border-ink-900 border-t-transparent animate-spin" />
          <span>جاري التحميل...</span>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const navLinks = [
    { href: "/dashboard/chat", label: "المساعد الذكي" },
    { href: "/dashboard/jobs", label: "طلباتي" },
    { href: "/dashboard/topup", label: "شحن الرصيد" },
  ];

  if (pathname === "/dashboard/chat") {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 text-ink-800">
      {/* Top Application Header */}
      <header className="sticky top-0 z-40 border-b border-sand-200/90 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 h-16">
          <div className="flex items-center gap-6">
            <Link href="/dashboard/chat" className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink-900">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-900 text-xs font-semibold text-white">
                دِ
              </span>
              <span>Digr</span>
            </Link>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1 text-sm font-medium">
              {navLinks.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-lg px-3.5 py-2 transition-colors ${
                      isActive
                        ? "bg-sand-100 text-ink-900 font-semibold"
                        : "text-ink-600 hover:text-ink-900 hover:bg-sand-50"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Balance Badge */}
            <Link
              href="/dashboard/topup"
              className="touch-target flex items-center gap-2 rounded-xl border border-sand-200 bg-sand-50/80 px-3 py-1.5 hover:border-sand-300 transition-colors"
              title="رصيد محفظتك المتاح"
            >
              <span className="text-xs text-ink-500 hidden sm:inline">الرصيد:</span>
              <span className="text-xs sm:text-sm font-bold text-ink-900 font-mono">
                {balance === null ? "..." : `${balance.toLocaleString("ar-EG")} نقطة`}
              </span>
              <span className="rounded-md bg-amber-100 border border-amber-200 text-amber-800 px-1.5 py-0.5 text-[10px] font-bold">
                + شحن
              </span>
            </Link>

            {/* User Profile / Logout */}
            <div className="hidden sm:flex items-center gap-3 border-r border-sand-200 pr-3 mr-1 text-xs">
              <span className="text-ink-600 font-medium">{user.name}</span>
              <button
                onClick={async () => {
                  await logout();
                  router.push("/");
                }}
                className="text-ink-400 hover:text-danger transition-colors font-medium"
              >
                خروج
              </button>
            </div>

            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="touch-target md:hidden rounded-lg p-2 text-ink-600 hover:bg-sand-100 transition-colors"
              aria-label="القائمة"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {mobileMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-sand-200 bg-white px-4 pt-3 pb-5 space-y-2 animate-in fade-in duration-200">
            <div className="text-xs text-ink-500 pb-2 border-b border-sand-100">
              المستخدم: <strong className="text-ink-800">{user.name}</strong> ({user.email})
            </div>
            {navLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`touch-target block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  pathname === item.href
                    ? "bg-sand-100 text-ink-900 font-semibold"
                    : "text-ink-600 hover:bg-sand-50"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <div className="pt-2 border-t border-sand-100">
              <button
                onClick={async () => {
                  await logout();
                  router.push("/");
                }}
                className="touch-target w-full text-right rounded-lg px-3 py-2 text-sm text-danger hover:bg-red-50 font-medium"
              >
                تسجيل الخروج
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Workspace Viewport */}
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
