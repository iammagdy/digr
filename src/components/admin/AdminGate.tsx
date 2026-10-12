"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { Spinner } from "@/components/ui";
import { AdminShell } from "./AdminShell";

/** Client-side UX gate. The real enforcement is server-side: layout.tsx and every /api/admin/* route check `labels: admin`. */
export function AdminGate({ children }: { children: ReactNode }) {
  const { user, loading } = useUser();
  const router = useRouter();
  const isAdmin = Array.isArray(user?.labels) && user!.labels.includes("admin");

  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);

  if (loading || !user) {
    return <div className="flex min-h-dvh items-center justify-center bg-bg"><Spinner label="جاري التحقق من الصلاحيات" /></div>;
  }
  if (!isAdmin) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
        <h1 className="m-0 font-display text-4xl font-medium text-ink">غير مصرح</h1>
        <p className="m-0 text-sm font-light text-mut">هذه الصفحة مخصصة لمديري النظام فقط.</p>
        <Link href="/dashboard/chat" className="mt-4 flex min-h-12 items-center rounded-full bg-ac px-6 text-sm text-onac">العودة إلى لوحتي</Link>
      </div>
    );
  }
  return <AdminShell>{children}</AdminShell>;
}
