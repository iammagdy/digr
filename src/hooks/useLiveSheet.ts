"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { startLivePolling, type LiveData, type LiveEnd, type LiveFetchResult, type LivePoller, type LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LivePollResponse } from "@/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 S8 (docs/STAGE-2.md): the live sheet of a mission, by POLLING `/api/missions/<id>/live` (never Supabase Realtime). The loop is `startLivePolling`: it pauses while the tab is
 * hidden, asks again as soon as the tab is visible, and stops when the job is done or when the route is off. `enabled: false` asks nothing at all.
 *
 * LAUNCH ROUND: the same mission is shown in the chat AND on its request page. The last data each mission's sheet held is kept for this browser tab (`lastLiveData`), so a customer who
 * goes from one to the other, or whose card is drawn again, sees what was already true at once instead of an empty sheet, and the loop starts from that data's cursor and window (the
 * first answer is «nothing changed» when nothing did). Nothing is kept across a reload, and nothing is invented: it is the route's own last answer.
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

const lastLiveData = new Map<string, LiveData>();
/** Clears what the tab remembers (the tests). A viewer who may not see a mission never keeps its rows: the route's first «off» answer removes them (see `onReach`). */
export const clearLiveSheetMemory = (): void => lastLiveData.clear();
export const rememberedLiveData = (missionId: string): LiveData | null => lastLiveData.get(missionId) ?? null;

/** One answer of the route as the loop reads it: 404 is «off» (the flag, or not this viewer's mission); any other failure is a passing one (asked again later, the last data stays). */
export async function readLiveAnswer(res: Pick<Response, "ok" | "status" | "json">): Promise<LiveFetchResult> {
  if (res.status === 404) return "off";
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as (LivePollResponse & { success?: boolean }) | null;
  if (!json || json.success === false) return null;
  const { success: _s, ...answer } = json as LivePollResponse & { success?: boolean };
  void _s;
  return answer as LivePollResponse;
}

export type LiveReach = "ok" | "failing";
export interface LiveSheetState {
  data: LiveData | null;
  ended: LiveEnd | null;
  /** The route answered and there is no snapshot yet (the flag is on; the worker has not saved anything yet). */
  waiting: boolean;
  /** The last ask failed (network or server): the data shown is the last one received. */
  reach: LiveReach;
  setWindow: (w: Partial<LiveWindow>) => void;
}

export function useLiveSheet(missionId: string, options: { enabled: boolean; /** Whether the mission still works (see `isMissionLive` of the loop). */ missionLive?: boolean }): LiveSheetState {
  const [data, setData] = useState<LiveData | null>(() => (options.enabled ? lastLiveData.get(missionId) ?? null : null));
  const [ended, setEnded] = useState<LiveEnd | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [reach, setReach] = useState<LiveReach>("ok");
  const poller = useRef<LivePoller | null>(null);
  const missionLiveRef = useRef<boolean | undefined>(options.missionLive);
  missionLiveRef.current = options.missionLive;
  useEffect(() => {
    if (!options.enabled) return undefined;
    setEnded(null);
    const remembered = lastLiveData.get(missionId) ?? null;
    // another mission in the same card: nothing of the previous one stays on screen
    setData(remembered);
    setWaiting(false);
    setReach("ok");
    const fetchPage = async (q: { cursor: string | null } & LiveWindow): Promise<LiveFetchResult> => {
      const p = new URLSearchParams();
      if (q.cursor) p.set("cursor", q.cursor);
      if (q.sheet) p.set("sheet", q.sheet);
      p.set("offset", String(q.offset));
      p.set("limit", String(q.limit));
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/live?${p.toString()}`, { cache: "no-store", headers: await authHeaders() });
      return readLiveAnswer(res);
    };
    const onData = (d: LiveData) => { lastLiveData.set(missionId, d); setData(d); setWaiting(false); };
    const onReach = (reached: boolean, answer: string) => { setReach(reached ? "ok" : "failing"); if (answer === "waiting") setWaiting(true); else if (answer === "off") { setWaiting(false); lastLiveData.delete(missionId); setData(null); } };
    // a remembered DONE sheet is complete: it is shown as it is, and the loop asks once (the done snapshot is the last one; a page or sheet turn asks again). The route still decides: «off»
    // (not this viewer's mission, or the flag) removes what was remembered and draws nothing
    poller.current = startLivePolling(
      { fetchPage, onData, onEnd: setEnded, onReach, ...(missionLiveRef.current === undefined ? {} : { isMissionLive: () => missionLiveRef.current !== false }) },
      remembered ? { cursor: remembered.status === "done" ? null : remembered.cursor, window: { sheet: remembered.window.stageKey || null, offset: remembered.window.offset } } : {},
    );
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") poller.current?.refresh(); };
    const onOnline = () => poller.current?.refresh();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    return () => {
      poller.current?.stop();
      poller.current = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    };
    // missionLive is read through its ref: a change of it never restarts the loop
  }, [missionId, options.enabled]);
  const setWindow = useCallback((w: Partial<LiveWindow>) => poller.current?.setWindow(w), []);
  return { data: options.enabled ? data : null, ended, waiting: options.enabled && waiting && data === null, reach, setWindow };
}
