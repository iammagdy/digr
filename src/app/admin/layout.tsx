import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminGate } from "@/components/admin/AdminGate";
import { createServerSideClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Server-side guard. When the browser sends a valid session and the account does NOT carry
 * `app_metadata.role: admin`, the request is redirected before any admin markup is rendered.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const isAdmin = user.app_metadata?.role === "admin";
      if (!isAdmin) redirect("/dashboard/chat");
    }
  } catch {
    // If auth resolution throws or cookies are missing, fall through to AdminGate client enforcement
  }

  return <AdminGate>{children}</AdminGate>;
}
