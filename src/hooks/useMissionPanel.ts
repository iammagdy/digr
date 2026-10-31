"use client";

import { useEffect, useRef, useState } from "react";
import type { MissionPanelContent } from "@/components/mission/MissionPlanPanel";
import { contentFromMission, contentFromPlanQuote, contentFromPlanning, panelPollDelayMs, type MissionStatusResponse, type PlanningResponse } from "@/lib/missionPanelContent";
import { closePageLineAr } from "@/lib/driverMode";
import { MISSION_READ_LIMIT_MS, startMissionPolling } from "@/lib/missionPoller";
import { useDriverMode } from "./useDriverMode";

/** Polls one URL every 2 to 3 seconds while the page is visible (slower when hidden), until `active` turns false (one last read is made then). Never throws. */
export function usePolled<T>(url: string | null, active: boolean): T | null {
  const [data, setData] = useState<T | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!url) { setData(null); urlRef.current = null; return; }
    if (urlRef.current !== url) { setData(null); urlRef.current = url; }
    let stopped = false;
    const read = async () => {
      // a read that does not answer is cut off; the loop below has its own limit as well (a hung read must not end the polling)
      const cut = new AbortController();
      const limit = setTimeout(() => cut.abort(), MISSION_READ_LIMIT_MS);
      try {
        const response = await fetch(url, { cache: "no-store", signal: cut.signal });
        const json = await response.json();
        if (!stopped && json?.success !== false) setData(json as T);
      } catch { /* the panel keeps what it has */ } finally { clearTimeout(limit); }
    };
    const stopLoop = startMissionPolling({ read, keepGoing: () => active, nextDelayMs: () => panelPollDelayMs(typeof document !== "undefined" && document.visibilityState === "hidden") });
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible" && active) void read(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; stopLoop(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible); };
  }, [url, active]);
  return data;
}

/**
 * What the mission plan panel shows now, from one of three sources in this order: the mission of the open job (running or finished), else the plan card on the table (the proposed stages),
 * else the planning steps of the turn that is being answered. Null when there is nothing to show: the panel opens only when there is a plan or a mission. A reload restores it: every source is
 * read from the server again.
 */
export function useMissionPanel(input: { jobId: string | null; jobLive: boolean; planQuote: Parameters<typeof contentFromPlanQuote>[0]; planningRequestId: string | null; planning: boolean }): MissionPanelContent | null {
  const driver = useDriverMode();
  const mission = usePolled<MissionStatusResponse>(input.jobId ? `/api/jobs/${encodeURIComponent(input.jobId)}/mission` : null, input.jobLive);
  const startedPlanningAt = useRef<number>(0);
  if (input.planning && !startedPlanningAt.current) startedPlanningAt.current = Date.now();
  if (!input.planning) startedPlanningAt.current = 0;
  const planning = usePolled<PlanningResponse>(input.planning && input.planningRequestId && !input.jobId ? `/api/chat/planning-events?requestId=${encodeURIComponent(input.planningRequestId)}` : null, input.planning);
  const fromMission = contentFromMission(mission, { closePageAr: driver === "cron" ? closePageLineAr(driver) : null });
  // The mission of an approved request never disappears: a read that fails, or a request that ended in seconds, keeps the last good view of it (until a new request is being planned).
  const lastMission = useRef<{ jobId: string; content: MissionPanelContent } | null>(null);
  if (input.planning) lastMission.current = null;
  if (input.jobId && fromMission) { lastMission.current = { jobId: input.jobId, content: fromMission }; return fromMission; }
  if (input.jobId && lastMission.current?.jobId === input.jobId && !input.planning) return lastMission.current.content;
  const fromPlan = contentFromPlanQuote(input.planQuote);
  if (fromPlan && !input.planning) return fromPlan;
  return contentFromPlanning(planning, startedPlanningAt.current || undefined);
}
