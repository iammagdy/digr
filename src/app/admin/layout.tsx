import { redirect } from "next/navigation";
import { createElement, type ReactNode } from "react";
import { AdminGate } from "@/components/admin/AdminGate";
import { createServerSideClient } from "@/lib/supabase/server";
import { resolveAdminLayoutRedirect } from "@/lib/adminLayoutRedirect";

export const dynamic = "force-dynamic";

/**
 * Server-side guard. When the browser sends a valid session and the account does NOT carry
 * `app_metadata.role: admin`, the request is redirected before any admin markup is rendered.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  let user: any = null;
  let resolved = false;
  try {
    const supabase = await createServerSideClient();
    const { data } = await supabase.auth.getUser();
    user = data?.user ?? null;
    resolved = true;
  } catch {
    // If auth resolution throws or cookies are missing, fall through to AdminGate client enforcement
  }

  const targetRedirect = resolveAdminLayoutRedirect(user, resolved);
  if (targetRedirect) {
    redirect(targetRedirect);
  }

  return createElement(AdminGate, null, children);
}


