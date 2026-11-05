"use client";

import { useCallback, useEffect, useState } from "react";
import { dayLabel } from "@/lib/dayLabel";
import { createClient } from "@/lib/supabase/client";
import { VERSIONS_HEADING_AR, VERSIONS_NOTE_AR, VERSION_DOWNLOADING_AR, VERSION_DOWNLOAD_BUTTON_AR, versionDownloadLabelAr, versionParentAr, versionTitleAr, type VersionSummary } from "@/lib/agentMission/stage4/versionLabels";
import { downloadVersionFile } from "@/lib/agentMission/stage4/versionDownload";

/**
 * STAGE 4, S2: THE FILE'S VERSIONS on the request's own page (never in the chat). It asks the versions route once; while the flag is off (the route answers 404), or the mission has no version, or the read fails, it draws NOTHING, so the page is what it
 * was. MONEY PR 7b (2B-2 task 1): each published version has a «تحميل الملف» button that asks the file route for that version's Excel (`?version=N`, docs/MONEY-PR-7A.md section 14). No price, no charge, no other action.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60 sm:w-auto";

export interface VersionDownloadFailure { version: number; message: string }

export function VersionListBody({ versions, onDownload, busy = null, failed = null }: { versions: ReadonlyArray<VersionSummary>; onDownload?: (version: number) => void; busy?: number | null; failed?: VersionDownloadFailure | null }) {
  if (versions.length === 0) return null;
  return (
    <section data-testid="version-list" aria-label={VERSIONS_HEADING_AR} className="flex flex-col gap-2 rounded-[18px] border border-ln bg-sf p-4">
      <h2 className="m-0 text-[15px] font-medium text-ink">{VERSIONS_HEADING_AR}</h2>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">{VERSIONS_NOTE_AR}</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {versions.map((v) => (
          <li key={v.version} data-testid="version-row" className="flex flex-col gap-2 text-[13px] text-ink sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{versionTitleAr(v.version, v.reason)}</span>
              <span className="text-mut">{dayLabel(v.createdAt)}</span>
              {v.parent !== null ? <span className="text-mut">{versionParentAr(v.parent)}</span> : null}
            </div>
            {onDownload ? (
              <button type="button" data-testid="version-download" className={BTN} disabled={busy !== null} aria-busy={busy === v.version ? true : undefined} aria-label={versionDownloadLabelAr(v.version)} onClick={() => onDownload(v.version)}>
                {busy === v.version ? VERSION_DOWNLOADING_AR : VERSION_DOWNLOAD_BUTTON_AR}
              </button>
            ) : null}
            {failed && failed.version === v.version ? <p role="alert" data-testid="version-download-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{failed.message}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

/** The browser's save: an object link on a temporary anchor, released after a while (the same way the mission card saves its file). */
function saveBlob(blob: Blob, name: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(blobUrl); link.remove(); }, 30000);
}

export default function VersionList({ missionId }: { missionId: string }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<VersionDownloadFailure | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/missions/${encodeURIComponent(missionId)}/versions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.success && Array.isArray(j.versions)) setVersions(j.versions as VersionSummary[]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [missionId]);
  const onDownload = useCallback(async (version: number) => {
    setBusy(version);
    setFailed(null);
    const r = await downloadVersionFile({ missionId, version, fetchFn: fetch, headers: authHeaders, save: saveBlob });
    if (!r.ok) setFailed({ version, message: r.message });
    setBusy(null);
  }, [missionId]);
  return <VersionListBody versions={versions} onDownload={onDownload} busy={busy} failed={failed} />;
}
