"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { BalanceProvider } from "@/hooks/useBalance";
import { AppShell } from "@/components/app/AppShell";
import { Spinner } from "@/components/ui";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  const isChat = pathname === "/dashboard/chat";

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (!isChat) router.replace("/login");
    } else if (!user.emailVerification) {
      router.replace("/verify");
    }
  }, [user, loading, router, isChat]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner label="جاري تحميل مساحة العمل" />
      </div>
    );
  }

  if (!user) {
    if (isChat) {
      return (
        <BalanceProvider>
          <AppShell>{children}</AppShell>
        </BalanceProvider>
      );
    }
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner label="جاري تحميل مساحة العمل" />
      </div>
    );
  }

  if (!user.emailVerification) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner label="جاري تحميل مساحة العمل" />
      </div>
    );
  }

  return (
    <BalanceProvider>
      <AppShell>{children}</AppShell>
    </BalanceProvider>
  );
}
