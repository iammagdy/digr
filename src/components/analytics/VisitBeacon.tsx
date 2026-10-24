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
    // Everything this effect does (listeners, storage, sendBeacon, fetch) is inside one try/catch, and so is its cleanup: nothing it does can throw into React.
    try {
      if (loading || isAdmin || !pathname) return;
      let tracker: ReturnType<typeof trackView> = null;
      try { tracker = trackView(pathname); } catch { tracker = null; }
      if (!tracker) return;
      const current = tracker;
      const onVisibility = () => { try { if (document.visibilityState === "hidden") current.leave(); else current.resume(); } catch { /* the page never depends on the beacon */ } };
      const onPageHide = () => { try { current.leave(); } catch { /* same */ } };
      let listening = false;
      try {
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);
        listening = true;
      } catch {
        // no listeners: the view was already sent, the leave beacon is sent by the cleanup below
      }
      return () => {
        try {
          if (listening) {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", onPageHide);
          }
        } catch { /* ignore */ }
        try { current.leave(); } catch { /* ignore */ }
      };
    } catch {
      return undefined;
    }
  }, [pathname, loading, isAdmin]);

  return null;
}
