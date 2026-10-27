"use client";

import { useState } from "react";
import { usePolled } from "@/hooks/useMissionPanel";
import { PANEL_TITLE_AR, contentFromMission, type MissionStatusResponse } from "@/lib/missionPanelContent";
import { MissionPlanBody } from "./MissionPlanPanel";

/** «خطة المهمة» of ONE request in «طلباتي»: opened on demand, always available for a past mission (the steps are rebuilt from what the server kept), live while the request runs. */
export default function MissionPlanInline({ jobId, live }: { jobId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const status = usePolled<MissionStatusResponse>(open ? `/api/jobs/${encodeURIComponent(jobId)}/mission` : null, open && live);
  const content = contentFromMission(status);
  return (
    <div data-testid="request-mission-plan">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink focus-visible:outline-2">
        {open ? "إخفاء " : "عرض "}{PANEL_TITLE_AR}
      </button>
      {open ? (
        <div className="mt-2 rounded-[18px] border border-ln bg-bg px-3.5 py-2" data-testid="request-mission-plan-body">
          {content ? <MissionPlanBody content={content} /> : <p className="m-0 py-2 text-[13px] text-mut">جارٍ تحميل خطة المهمة…</p>}
        </div>
      ) : null}
    </div>
  );
}
