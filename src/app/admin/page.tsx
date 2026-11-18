"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { startVisiblePolling } from "@/lib/visiblePolling";
import { useAdmin } from "@/components/admin/AdminShell";
import { HEAVY_SLOTS, LIVE_SLOTS, LOADING_SLOTS, OverviewView, loadSlot, type OverviewSlots, type SlotKey } from "@/components/admin/OverviewCards";

const fetcher = (path: string) => adminFetch(path);

/**
 * «نظرة عامة» (DT-20261118-06 §3.2). The cards are drawn by OverviewView; this page only reads: the heavy cards on a range change and on «أعد المحاولة»,
 * the live tiles every 60 s while the tab is visible (VERCEL ACTIVE CPU: visiblePolling.ts) and on «تحديث». A failed 60 s refresh keeps the last numbers and says so.
 */
export default function AdminOverview() {
  const { range, isMobile, alerts, providers } = useAdmin();
  const [slots, setSlots] = useState<OverviewSlots>(LOADING_SLOTS);
  const [liveAt, setLiveAt] = useState<string | null>(null);
  const [liveStale, setLiveStale] = useState(false);

  const load = useCallback((key: SlotKey) => {
    setSlots((s) => ({ ...s, [key]: { status: "loading" } }));
    void loadSlot(key, range, fetcher).then((slot) => setSlots((s) => ({ ...s, [key]: slot })));
  }, [range]);

  useEffect(() => { for (const key of HEAVY_SLOTS) load(key); }, [load]);

  const refreshLive = useCallback(() => {
    for (const key of LIVE_SLOTS) {
      // the live paths do not depend on the range
      void loadSlot(key, 30, fetcher).then((slot) => {
        setSlots((s) => ({ ...s, [key]: slot.status === "error" && s[key].status === "ready" ? s[key] : slot }));
        setLiveStale(slot.status === "error");
        if (slot.status === "ready") setLiveAt(new Date().toISOString());
      });
    }
  }, []);

  useEffect(() => { refreshLive(); return startVisiblePolling(refreshLive, 60_000); }, [refreshLive]);

  return (
    <OverviewView
      range={range}
      isMobile={isMobile}
      alerts={alerts}
      providers={providers}
      slots={slots}
      liveAt={liveAt}
      liveStale={liveStale}
      now={Date.now()}
      onRetry={(key) => ((LIVE_SLOTS as string[]).includes(key) ? refreshLive() : load(key))}
      onRefreshLive={refreshLive}
    />
  );
}
