"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { startLivePolling, type LiveData, type LiveEnd, type LivePoller, type LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LivePollResponse } from "@/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 S8 (docs/STAGE-2.md): the live sheet of a mission, by POLLING `/api/missions/<id>/live` (never Supabase Realtime). The loop is `startLivePolling`: it pauses while the tab is
 * hidden, asks again as soon as the tab is visible, and stops when the job is done or when the route has no snapshot three times in a row (the flag off: the page keeps today's panel).
 * `enabled: false` asks nothing at all.
 */
async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export interface LiveSheetState { data: LiveData | null; ended: LiveEnd | null; setWindow: (w: Partial<LiveWindow>) => void }

export function useLiveSheet(missionId: string, options: { enabled: boolean }): LiveSheetState {
  const [data, setData] = useState<LiveData | null>(null);
  const [ended, setEnded] = useState<LiveEnd | null>(null);
  const poller = useRef<LivePoller | null>(null);
  useEffect(() => {
    if (!options.enabled) return undefined;
    setEnded(null);
    const fetchPage = async (q: { cursor: string | null } & LiveWindow): Promise<LivePollResponse | null> => {
      const p = new URLSearchParams();
      if (q.cursor) p.set("cursor", q.cursor);
      if (q.sheet) p.set("sheet", q.sheet);
      p.set("offset", String(q.offset));
      p.set("limit", String(q.limit));
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/live?${p.toString()}`, { cache: "no-store", headers: await authHeaders() });
      // the route is off (404) or the viewer cannot see it: the same as «no snapshot», so the loop ends after three
      if (!res.ok) return { changed: false, cursor: null, retryAfterMs: 30_000, empty: true };
      const json = (await res.json().catch(() => null)) as (LivePollResponse & { success?: boolean }) | null;
      return json && json.success !== false ? json : null;
    };
    poller.current = startLivePolling({ fetchPage, onData: setData, onEnd: setEnded });
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") poller.current?.refresh(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => { poller.current?.stop(); poller.current = null; if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible); };
  }, [missionId, options.enabled]);
  const setWindow = useCallback((w: Partial<LiveWindow>) => poller.current?.setWindow(w), []);
  return { data, ended, setWindow };
}
