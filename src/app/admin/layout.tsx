import { redirect } from "next/navigation";
import { createElement, type ReactNode } from "react";
import { AdminGate } from "@/components/admin/AdminGate";
import { createServerSideClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export function resolveAdminLayoutRedirect(
  user: { app_metadata?: { role?: string } } | null | undefined,
  resolved: boolean,
): string | null {
  if (!resolved) return null;
  if (!user) return "/login";
  const isAdmin = user.app_metadata?.role === "admin";
  if (!isAdmin) return "/dashboard/chat";
  return null;
}

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


