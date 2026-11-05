"use client";

import { browserFetch } from "@/lib/agentMission/stage4/browserFetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FILE_WORKFLOW_HEADING_AR, FILE_WORKFLOW_LOADING_AR, FILE_WORKFLOW_NONE_AR, FILE_WORKFLOW_RETRY_AR, workflowItemLinesAr, workflowItemTitleAr, workflowPhaseLabelAr, type FileWorkflowView } from "@/lib/agentMission/stage4/fileWorkflowLabels";
import { fetchFileWorkflow } from "@/lib/agentMission/stage4/fileWorkflowClient";
import { FILE_DELIVERED_EVENT, FILE_WORKFLOW_REFRESH_EVENT } from "@/lib/agentMission/stage4/addonApprovalClient";
import { WORKFLOW_POLL_MAX_MS, WORKFLOW_POLL_MS, finishedSince, needsPolling } from "@/lib/agentMission/stage4/workflowPolling";

/**
 * STAGE C: «حالة طلباتك على هذا الملف», the one place on the request's page that says, for every review or edit request on the file, WHICH state it is in: waiting for approval, approval being checked, approved and processing, delivered, charged but delivery pending, failed without a recorded charge,
 * cancelled, or closed after an approval attempt. The phase is decided on the server from the request's row and from what is verified published; this component only shows it. It has no button of its own except a retry, and no approval, payment or price control.
 * A request that is processing is announced politely, so the change to «delivered» is read out. While the feature is off (the route answers 404) it draws NOTHING.
 */
/** The page listens for this (re-exported here so the page itself imports no Stage 4 module: tests/stage4-isolation.test.ts). */
export { FILE_DELIVERED_EVENT };

const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 sm:w-auto";

export interface FileWorkflowBodyProps {
  status: "idle" | "loading" | "ready" | "error";
  view?: FileWorkflowView | null;
  error?: string | null;
  onRetry?: () => void;
}

export function FileWorkflowBody({ status, view = null, error = null, onRetry }: FileWorkflowBodyProps) {
  if (status === "idle") return null;
  const shell = (children: React.ReactNode) => (
    <section data-testid="file-workflow" aria-labelledby="file-workflow-heading" dir="rtl" className="flex flex-col gap-3 break-words rounded-[18px] border border-ln bg-sf p-4">
      <h2 id="file-workflow-heading" className="m-0 text-[15px] font-medium text-ink">{FILE_WORKFLOW_HEADING_AR}</h2>
      {children}
    </section>
  );
  if (status === "loading") return shell(<p role="status" aria-busy="true" data-testid="file-workflow-loading" className="m-0 text-[13px] leading-[1.9] text-ink2">{FILE_WORKFLOW_LOADING_AR}</p>);
  if (status === "error") {
    return shell(
      <div className="flex flex-col gap-2">
        <p role="alert" data-testid="file-workflow-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p>
        {onRetry ? <button type="button" data-testid="file-workflow-retry" className={BTN} onClick={onRetry}>{FILE_WORKFLOW_RETRY_AR}</button> : null}
      </div>,
    );
  }
  const items = view?.items ?? [];
  // a file with NO published version cannot be reviewed or edited: no promise of a next step is drawn for it
  if (items.length === 0 && view?.hasVersions === false) return null;
  if (items.length === 0) return shell(<p data-testid="file-workflow-none" className="m-0 text-[13px] leading-[1.9] text-ink2">{FILE_WORKFLOW_NONE_AR}</p>);
  return shell(
    <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="file-workflow-items">
      {items.map((item, i) => (
        <li key={i} data-phase={item.phase} aria-live={item.phase === "processing" ? "polite" : undefined} className="flex flex-col gap-1 rounded-[12px] border border-ln p-3 text-[13px] leading-[1.9] text-ink">
          <h3 className="m-0 text-[13px] font-medium text-ink">{workflowItemTitleAr(item)}</h3>
          <p className="m-0 font-medium text-ink">{workflowPhaseLabelAr(item.phase)}</p>
          {workflowItemLinesAr(item).map((line, j) => <p key={j} className="m-0 text-ink2">{line}</p>)}
        </li>
      ))}
    </ul>,
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function FileWorkflow({ missionId }: { missionId: string }) {
  const [status, setStatus] = useState<FileWorkflowBodyProps["status"]>("idle");
  const [view, setView] = useState<FileWorkflowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastView = useRef<FileWorkflowView | null>(null);
  const load = useCallback(async (alive: () => boolean, silent = false) => {
    if (!silent) { setStatus("loading"); setError(null); }
    const r = await fetchFileWorkflow({ missionId, fetchFn: browserFetch, headers: authHeaders });
    if (!alive()) return;
    if (r.state === "ok") {
      // something that was in flight is over: the versions, the report and the forms read the server again (no manual reload)
      if (finishedSince(lastView.current, r.view).length > 0) { try { window.dispatchEvent(new CustomEvent(FILE_DELIVERED_EVENT)); } catch { /* the page's own reload shows it */ } }
      lastView.current = r.view; setView(r.view); setStatus("ready"); setError(null);
    }
    else if (r.state === "off") { if (!silent) setStatus("idle"); }
    else if (!silent) { setError(r.message); setStatus("error"); } // a failed background look keeps what the customer already reads
  }, [missionId]);
  useEffect(() => {
    let alive = true;
    void load(() => alive);
    return () => { alive = false; };
  }, [load]);
  // while a request is in flight the panel asks again by itself (not while the tab is hidden, and for at most an hour)
  const inFlight = needsPolling(view);
  useEffect(() => {
    if (!inFlight) return;
    let alive = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > WORKFLOW_POLL_MAX_MS) { clearInterval(timer); return; }
      if (typeof document !== "undefined" && document.hidden) return;
      void load(() => alive, true);
    }, WORKFLOW_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [inFlight, load]);
  const onRetry = useCallback(() => { void load(() => true); }, [load]);
  // the approval button (launch round) fires this after any answer: the status of the file's requests is read again from the server
  useEffect(() => {
    const again = () => { void load(() => true, true); };
    window.addEventListener(FILE_WORKFLOW_REFRESH_EVENT, again);
    return () => window.removeEventListener(FILE_WORKFLOW_REFRESH_EVENT, again);
  }, [load]);
  return <FileWorkflowBody status={status} view={view} error={error} onRetry={onRetry} />;
}
