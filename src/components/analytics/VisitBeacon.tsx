"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { trackView } from "@/lib/analytics/client";

/**
 * Sends the visit beacon for every public page. It waits until the account is known (an admin is never tracked), never runs on the admin area and
 * renders nothing. A failure anywhere in it is swallowed: the page never depends on it.
 */
export function VisitBeacon() {
  const pathname = usePathname();
  const { user, loading } = useUser();
  const isAdmin = user?.app_metadata?.role === "admin";

  useEffect(() => {
    if (loading || isAdmin || !pathname) return;
    let tracker: ReturnType<typeof trackView> = null;
    try { tracker = trackView(pathname); } catch { tracker = null; }
    if (!tracker) return;
    const current = tracker;
    const onVisibility = () => { if (document.visibilityState === "hidden") current.leave(); else current.resume(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", current.leave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", current.leave);
      current.leave();
    };
  }, [pathname, loading, isAdmin]);

  return null;
}
