"use client";

import { useEffect, useState } from "react";
import { dayLabel } from "@/lib/dayLabel";
import { VERSIONS_HEADING_AR, VERSIONS_NOTE_AR, versionLabelAr, versionParentAr, type VersionSummary } from "@/lib/agentMission/stage4/versionLabels";

/**
 * STAGE 4, S2: THE FILE'S VERSIONS on the request's own page (never in the chat). It asks the versions route once; while the flag is off (the route answers 404), or the mission has no version, or the read fails, it draws NOTHING, so the page is what it
 * was. No download button: downloading one version needs `?version=N` on the download route (docs/STAGE-4.md section 9). No price, no action.
 */
export function VersionListBody({ versions }: { versions: ReadonlyArray<VersionSummary> }) {
  if (versions.length === 0) return null;
  return (
    <section data-testid="version-list" aria-label={VERSIONS_HEADING_AR} className="flex flex-col gap-2 rounded-[18px] border border-ln bg-sf p-4">
      <h2 className="m-0 text-[15px] font-medium text-ink">{VERSIONS_HEADING_AR}</h2>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">{VERSIONS_NOTE_AR}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {versions.map((v) => (
          <li key={v.version} data-testid="version-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink">
            <span className="font-medium">{versionLabelAr(v.version, v.reason)}</span>
            <span className="text-mut">{dayLabel(v.createdAt)}</span>
            {v.parent !== null ? <span className="text-mut">{versionParentAr(v.parent)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function VersionList({ missionId }: { missionId: string }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/missions/${encodeURIComponent(missionId)}/versions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.success && Array.isArray(j.versions)) setVersions(j.versions as VersionSummary[]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [missionId]);
  return <VersionListBody versions={versions} />;
}
