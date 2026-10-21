"use client";

import { useEffect, useState } from "react";
import { setDegradedFromServer } from "@/lib/degradedClient";

export interface BusyStatus { busy: boolean; messageAr: string; degraded: boolean; degradedMessageAr: string }

/** How often the dashboard asks (a minute, with a few seconds of jitter so a room of phones does not ask together), and never while the tab is hidden. */
export const BUSY_POLL_MS = 60_000;

export function useBusyStatus(): BusyStatus {
  const [status, setStatus] = useState<BusyStatus>({ busy: false, messageAr: "", degraded: false, degradedMessageAr: "" });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch("/api/busy-status", { cache: "no-store" });
          if (response.ok) {
            const data = await response.json();
            setDegradedFromServer(Boolean(data?.degraded));
            if (alive) setStatus({ busy: Boolean(data?.busy), messageAr: String(data?.messageAr || ""), degraded: Boolean(data?.degraded), degradedMessageAr: String(data?.degradedMessageAr || "") });
          }
        } catch { /* the banner is a courtesy: no answer means no banner */ }
      }
      if (alive) timer = setTimeout(tick, BUSY_POLL_MS + Math.floor(Math.random() * 8_000));
    };
    timer = setTimeout(tick, 800 + Math.floor(Math.random() * 2_000));
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  return status;
}
