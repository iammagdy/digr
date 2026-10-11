"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/hooks/useUser";
import { databases } from "@/lib/appwrite";
import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Query } from "appwrite";
import { balanceLoading, balanceReady, balanceFailed, balanceText, type BalanceView } from "@/lib/honestDisplay";
import { Avatar, Drawer, Spinner } from "@/components/ui";

const NAV = [
  {
    href: "/dashboard",
    label: "لوحة المتابعة",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" />
      </svg>
    ),
  },
  {
    href: "/dashboard/chat",
    label: "المساعد البحثي",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 01-8 8H5l-2 2V12a8 8 0 018-8h2a8 8 0 018 8z" />
      </svg>
    ),
  },
  {
    href: "/dashboard/jobs",
    label: "طلباتي",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/dashboard/topup",
    label: "الرصيد والشحن",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

function NavLinks({ pathname, onNavigate, dark = false }: { pathname: string; onNavigate?: () => void; dark?: boolean }) {
  return (
    <nav aria-label="التنقل في التطبيق" className="space-y-1">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`touch-target relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
              active
                ? dark
                  ? "bg-white/10 text-white"
                  : "bg-accent-light text-accent-ink"
                : dark
                  ? "text-sand-300 hover:bg-white/5 hover:text-white"
                  : "text-ink-600 hover:bg-sand-100 hover:text-ink-900"
            }`}
          >
            {active && (
              <span aria-hidden="true" className={`absolute inset-y-2 start-0 w-1 rounded-full ${dark ? "bg-pine-200" : "bg-accent"}`} />
            )}
            <span aria-hidden="true" className={active ? "" : "opacity-70"}>{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const [balance, setBalance] = useState<BalanceView>(balanceLoading());
  const [mobileOpen, setMobileOpen] = useState(false);

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
        for (const doc of res.documents) total += (doc.delta as number) || 0;
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setBalance(balanceReady(total));
    } catch {
      // A failed request proves nothing about the balance — never show a fake zero.
      setBalance(balanceFailed());
    }
  }, [user]);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    else if (user) loadBalance();
  }, [user, loading, router, loadBalance]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-sand-50">
        <Spinner label="جاري تحميل مساحة العمل" />
      </div>
    );
  }
  if (!user) return null;

  // Chat renders its own full-screen workspace
  if (pathname === "/dashboard/chat") return <>{children}</>;

  const handleLogout = async () => {
    await logout();
    router.push("/");
  };

  return (
    <div className="min-h-dvh bg-bg text-foreground lg:ps-68">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-68 flex-col border-e border-border bg-surface text-foreground lg:flex" aria-label="الشريط الجانبي">
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -top-24 -start-24 h-64 w-64 rounded-full bg-gold/8 blur-3xl" />
        </div>
        <div className="relative p-5 pb-2">
          <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="Digr — لوحة المستخدم">
            <BrandLogo size="large" />
          </Link>
          <p className="mt-2 ps-0.5 text-xs text-foreground-muted">مساحة البحث بالبيانات العامة</p>
        </div>
        <div className="relative flex-1 overflow-y-auto p-4">
          <NavLinks pathname={pathname} />
        </div>
        <div className="relative space-y-3 border-t border-border p-4">
          <Link href="/dashboard/topup" className="block rounded-2xl border border-border bg-surface-subtle p-3.5 transition-colors hover:border-border-strong">
            <p className="text-xs text-foreground-muted">رصيد النقاط المتاح</p>
            <p className="tnum mt-1 text-2xl font-bold text-foreground">
              {balanceText(balance)}{" "}
              <span className="text-xs font-semibold text-amber-points">نقطة</span>
            </p>
          </Link>
          <div className="flex items-center gap-3">
            <Avatar name={user.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
              <p className="truncate text-xs text-foreground-muted" dir="ltr">{user.email}</p>
            </div>
            <ThemeToggle className="h-10 w-10" />
            <button
              type="button"
              onClick={handleLogout}
              className="touch-target rounded-lg px-2.5 py-2 text-xs font-semibold text-foreground-muted transition-colors hover:bg-surface-subtle hover:text-foreground cursor-pointer"
            >
              خروج
            </button>
          </div>
          <div className="pt-1 text-center">
              <span className="font-mono text-[10px] text-faint" dir="ltr" data-testid="dashboard-build-id">
              build {process.env.NEXT_PUBLIC_GIT_COMMIT || "83444cf"}
            </span>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 border-b border-sand-200 bg-white/95 backdrop-blur-md lg:hidden">
        <div className="flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="فتح قائمة التنقل"
              className="touch-target inline-flex items-center justify-center rounded-xl text-ink-700 hover:bg-sand-100"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <Link href="/dashboard" className="flex items-center gap-2" aria-label="Digr — لوحة المستخدم">
              <BrandLogo size="small" />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle className="h-10 w-10" />
            <Link
              href="/dashboard/topup"
              className="tnum inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-amber-points/30 bg-amber-points-bg px-3 text-sm font-bold text-amber-points"
              aria-label={`رصيدك ${balance.status === "failed" ? "غير متاح حاليًا" : balance.status === "loading" ? "جارٍ التحميل" : balanceText(balance)} — شحن الرصيد`}
            >
              {balanceText(balance)} نقطة
              <span aria-hidden="true" className="text-base leading-none">+</span>
            </Link>
          </div>
        </div>
      </header>

      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} title="التنقل" side="start">
        <div className="space-y-5">
          <NavLinks pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          <div className="flex items-center gap-3 border-t border-sand-200 pt-5">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink-900">{user.name}</p>
              <p className="truncate text-xs text-sand-500" dir="ltr">{user.email}</p>
            </div>
            <ThemeToggle className="h-10 w-10" />
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="touch-target w-full rounded-xl border border-danger/25 bg-danger-bg px-4 py-2.5 text-sm font-bold text-danger cursor-pointer"
          >
            تسجيل الخروج
          </button>
          <div className="pt-2 text-center">
            <span className="font-mono text-[10px] text-sand-500" dir="ltr">
              build {process.env.NEXT_PUBLIC_GIT_COMMIT || "83444cf"}
            </span>
          </div>
        </div>
      </Drawer>

      <main className="flex min-h-dvh flex-col justify-between">
        <div>{children}</div>
        <footer className="py-4 text-center">
          <span className="font-mono text-[11px] text-sand-400" dir="ltr" data-testid="dashboard-footer-build-id">
            build {process.env.NEXT_PUBLIC_GIT_COMMIT || "83444cf"}
          </span>
        </footer>
      </main>
    </div>
  );
}
