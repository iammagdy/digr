"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { BalanceProvider } from "@/hooks/useBalance";
import { AppShell } from "@/components/app/AppShell";
import { Spinner } from "@/components/ui";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    // Top-ups and research are blocked until the email is verified.
    else if (!user.emailVerification) router.replace("/verify");
  }, [user, loading, router]);

  if (loading || !user || !user.emailVerification) {
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
