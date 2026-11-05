"use client";

import { browserFetch } from "@/lib/agentMission/stage4/browserFetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { APPROVE_CONSENT_AR, APPROVING_AR, FILE_WORKFLOW_REFRESH_EVENT, approveButtonAr, fetchApprovalAvailable, sendApproval, type ApproveResult } from "@/lib/agentMission/stage4/addonApprovalClient";

/**
 * LAUNCH ROUND, WORKSTREAM 2: THE APPROVAL BUTTON under a waiting review or edit request. It shows the price the page already shows («اعتمد الطلب واحجز N نقطة»), says in one sentence what approving does, and sends the request id and that number. It is drawn ONLY when the server says approval is
 * offered (the route answers 404 while DIGER_STAGE4_APPROVAL is off: then this draws NOTHING and the page is exactly what it was). The button is disabled while the request is in flight (the server is idempotent as well), an answer that may have moved money says so and is never «nothing was held»,
 * and after any answer the page's status panel is told to re-read the truth from the server.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-ink px-5 text-[13px] text-bg focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto";

export interface ApproveAddonBodyProps {
  status: "idle" | "ready" | "approving" | "done";
  points: number;
  result?: ApproveResult | null;
  onApprove?: () => void;
}

export function ApproveAddonBody({ status, points, result = null, onApprove }: ApproveAddonBodyProps) {
  if (status === "idle") return null;
  const approving = status === "approving";
  return (
    <div data-testid="approve-addon" dir="rtl" className="flex flex-col gap-2">
      <p data-testid="approve-consent" className="m-0 text-[13px] leading-[1.9] text-ink2">{APPROVE_CONSENT_AR}</p>
      {status !== "done" || (result && result.state !== "approved" && result.state !== "already_approved") ? (
        <button type="button" data-testid="approve-button" className={BTN} disabled={approving} aria-busy={approving ? true : undefined} onClick={onApprove}>
          {approving ? APPROVING_AR : approveButtonAr(points)}
        </button>
      ) : null}
      {result ? <p data-testid="approve-result" data-state={result.state} role={result.state === "approved" || result.state === "already_approved" ? "status" : "alert"} className="m-0 text-[13px] leading-[1.9] text-ink">{result.message}</p> : null}
    </div>
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function ApproveAddon({ missionId, requestId, points, onSettled }: { missionId: string; requestId: string; points: number; /** Called after any answer: the parent re-reads the waiting request (the truth) from the server. */ onSettled?: (r: ApproveResult) => void }) {
  const [status, setStatus] = useState<ApproveAddonBodyProps["status"]>("idle");
  const [result, setResult] = useState<ApproveResult | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    setResult(null);
    void fetchApprovalAvailable({ missionId, fetchFn: browserFetch, headers: authHeaders }).then((ok) => { if (alive) setStatus(ok ? "ready" : "idle"); });
    return () => { alive = false; };
  }, [missionId, requestId]);
  const onApprove = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("approving"); setResult(null);
    const r = await sendApproval({ missionId, requestId, expectedPoints: points, fetchFn: browserFetch, headers: authHeaders });
    setResult(r); setStatus("done");
    inFlight.current = false;
    try { window.dispatchEvent(new CustomEvent(FILE_WORKFLOW_REFRESH_EVENT)); } catch { /* the panel refreshes on its own reload */ }
    onSettled?.(r);
  }, [missionId, requestId, points, onSettled]);
  return <ApproveAddonBody status={status} points={points} result={result} onApprove={onApprove} />;
}
