"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { adminFetch } from "@/lib/adminApi";
import { startVisiblePolling } from "@/lib/visiblePolling";
import { adminDetailDelayMs } from "@/lib/agentMission/adminPolling";
import { MissionInspector, type Inspection } from "@/components/admin/MissionInspector";
import { CardSkeleton, ErrorState } from "@/components/admin/ui";

/**
 * /admin/missions/<id>: the read-only inspector of ONE mission (DT-20261118-06 PR 2). Opened by link from the agent console and from the requests list, or by URL. It polls only while the mission can still change (adminDetailDelayMs) and
 * only while the tab is visible; the first read carries `first=1` so that the audit log records who opened it ONCE, never once per poll.
 */
export default function MissionInspectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useRef<string | null>(null);
  const opened = useRef(false);

  const load = useCallback(async () => {
    const first = !opened.current;
    opened.current = true;
    try {
      const d = await adminFetch<Inspection>(`/api/admin/missions/${encodeURIComponent(id)}/inspect${first ? "?first=1" : ""}`);
      status.current = d.mission.status;
      setData(d); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل المهمة"); }
  }, [id]);

  useEffect(() => {
    opened.current = false; status.current = null;
    void load();
    return startVisiblePolling(() => { void load(); }, () => adminDetailDelayMs(status.current));
  }, [load]);

  return (
    <div data-screen-label="Mission inspector" className="flex flex-col gap-3.5">
      <p className="m-0 text-xs"><Link href="/admin/agent" className="text-info">← الوكيل</Link></p>
      {error && !data && <ErrorState title={error} onRetry={() => { opened.current = true; void load(); }} />}
      {!data && !error && <><CardSkeleton height={140} /><CardSkeleton height={220} /></>}
      {data && <MissionInspector data={data} />}
    </div>
  );
}
