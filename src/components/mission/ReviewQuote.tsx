"use client";

import { browserFetch } from "@/lib/agentMission/stage4/browserFetch";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { REVIEW_ASKING_AR, REVIEW_BUTTON_AR, REVIEW_HEADING_AR, REVIEW_INTRO_AR, REVIEW_PICK_AR, reviewQuoteLinesAr, type ReviewQuoteView, type ReviewVersionChoice } from "@/lib/agentMission/stage4/reviewPreviewLabels";
import { fetchReviewQuote, fetchReviewVersions } from "@/lib/agentMission/stage4/reviewPreviewClient";
import { REVIEW_CANCELLED_AR, REVIEW_CANCEL_BUTTON_AR, REVIEW_CANCELLING_AR, REVIEW_PREPARE_BUTTON_AR, REVIEW_PREPARING_AR, reviewRequestLinesAr, type ReviewRequestView } from "@/lib/agentMission/stage4/reviewRequestLabels";
import ApproveAddon from "./ApproveAddon";
import type { ApproveResult } from "@/lib/agentMission/stage4/addonApprovalClient";
import { cancelReviewRequest, fetchReviewRequest, prepareReviewRequest } from "@/lib/agentMission/stage4/reviewRequestClient";
import { versionTitleAr } from "@/lib/agentMission/stage4/versionLabels";

/**
 * MONEY PR 7c + 7d (2B-2 tasks 2 and 3): THE REVIEW SECTION on the request's own page, under the versions list.
 *   1. «مراجعة الملف» asks the server for the quote of the chosen version and shows exactly what it answered (the version, the cells, the price, that nothing was charged). The browser computes no price.
 *   2. After a valid quote «تجهيز طلب المراجعة» makes a review request that WAITS for approval: nothing is held or charged. The page finds it again after a refresh and offers «إلغاء الطلب» while it is unpaid.
 * The approval button (ApproveAddon, behind DIGER_STAGE4_APPROVAL) is drawn under the waiting request and nothing else here approves. While the feature is off (the routes answer 404), or the mission has no published version and no waiting request, it draws NOTHING, so the page is what it was.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60 sm:w-auto";
const SELECT = "min-h-11 w-full rounded-[12px] border border-ln2 bg-transparent px-3 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-60 sm:w-auto";

export interface ReviewQuoteBodyProps {
  versions: ReadonlyArray<ReviewVersionChoice>; selected: number | null; onSelect: (version: number) => void; onAsk: () => void;
  busy?: boolean; quote?: ReviewQuoteView | null; error?: string | null;
  /** The request that waits for approval (found again after a refresh, or just made). */
  waiting?: ReviewRequestView | null; onPrepare?: () => void; preparing?: boolean; onCancel?: () => void; cancelling?: boolean; notice?: string | null;
  /** The approval button (launch round): drawn under the waiting request only when the container passes it (it draws nothing while the approval is off). */
  approval?: React.ReactNode;
}

export function ReviewQuoteBody({ versions, selected, onSelect, onAsk, busy = false, quote = null, error = null, waiting = null, onPrepare, preparing = false, onCancel, cancelling = false, notice = null, approval = null }: ReviewQuoteBodyProps) {
  if (versions.length === 0 && !waiting) return null;
  const alert = error ? <p role="alert" data-testid="review-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p> : null;
  if (waiting) {
    return (
      <section data-testid="review-quote" aria-label={REVIEW_HEADING_AR} className="flex flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4">
        <h2 className="m-0 text-[15px] font-medium text-ink">{REVIEW_HEADING_AR}</h2>
        <div data-testid="review-request" aria-live="polite" className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
          {reviewRequestLinesAr(waiting).map((line, i) => <p key={i} className={i === 0 ? "m-0 font-medium" : "m-0 text-ink2"}>{line}</p>)}
        </div>
        {approval}
        {onCancel ? (
          <button type="button" data-testid="review-cancel" className={BTN} disabled={cancelling} aria-busy={cancelling ? true : undefined} onClick={onCancel}>
            {cancelling ? REVIEW_CANCELLING_AR : REVIEW_CANCEL_BUTTON_AR}
          </button>
        ) : null}
        {alert}
      </section>
    );
  }
  const lines = quote ? reviewQuoteLinesAr(quote) : [];
  const locked = busy || preparing;
  return (
    <section data-testid="review-quote" aria-label={REVIEW_HEADING_AR} className="flex flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4">
      <h2 className="m-0 text-[15px] font-medium text-ink">{REVIEW_HEADING_AR}</h2>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">{REVIEW_INTRO_AR}</p>
      {versions.length > 1 ? (
        <label className="flex flex-col gap-1 text-[13px] text-ink">
          <span>{REVIEW_PICK_AR}</span>
          <select data-testid="review-version" className={SELECT} value={selected ?? ""} disabled={locked} onChange={(e) => onSelect(Number(e.target.value))}>
            {versions.map((v) => <option key={v.version} value={v.version}>{versionTitleAr(v.version, v.reason)}</option>)}
          </select>
        </label>
      ) : null}
      <button type="button" data-testid="review-ask" className={BTN} disabled={locked || selected === null} aria-busy={busy ? true : undefined} onClick={onAsk}>
        {busy ? REVIEW_ASKING_AR : REVIEW_BUTTON_AR}
      </button>
      {alert}
      {notice ? <p data-testid="review-notice" className="m-0 text-[13px] leading-[1.9] text-ink2">{notice}</p> : null}
      <div data-testid="review-result" aria-live="polite" className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
        {lines.map((line, i) => <p key={i} className={i === 0 ? "m-0 font-medium" : "m-0 text-ink2"}>{line}</p>)}
      </div>
      {onPrepare && quote?.state === "offer" ? (
        <button type="button" data-testid="review-prepare" className={BTN} disabled={preparing} aria-busy={preparing ? true : undefined} onClick={onPrepare}>
          {preparing ? REVIEW_PREPARING_AR : REVIEW_PREPARE_BUTTON_AR}
        </button>
      ) : null}
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

export default function ReviewQuote({ missionId }: { missionId: string }) {
  const [versions, setVersions] = useState<ReviewVersionChoice[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<ReviewQuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<ReviewRequestView | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // the list of published versions and the request that already waits (a refresh finds it again), asked together
    Promise.all([fetchReviewVersions({ missionId, fetchFn: browserFetch, headers: authHeaders }), fetchReviewRequest({ missionId, fetchFn: browserFetch, headers: authHeaders })]).then(([list, request]) => {
      if (!alive) return;
      setVersions(list);
      setSelected(list.length > 0 ? list[list.length - 1].version : null);
      setWaiting(request);
    });
    return () => { alive = false; };
  }, [missionId]);
  const onSelect = useCallback((version: number) => { setSelected(version); setQuote(null); setError(null); setNotice(null); }, []);
  const onAsk = useCallback(async () => {
    if (selected === null) return;
    setBusy(true); setQuote(null); setError(null); setNotice(null);
    const r = await fetchReviewQuote({ missionId, version: selected, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) setQuote(r.quote); else setError(r.message);
    setBusy(false);
  }, [missionId, selected]);
  const onPrepare = useCallback(async () => {
    if (selected === null) return;
    setPreparing(true); setError(null); setNotice(null);
    const r = await prepareReviewRequest({ missionId, version: selected, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) { setWaiting(r.request); setQuote(null); }
    else {
      setError(r.message);
      // another tab may have made a request in the meantime: whatever waits is shown
      const found = await fetchReviewRequest({ missionId, fetchFn: browserFetch, headers: authHeaders });
      if (found) { setWaiting(found); setQuote(null); setError(null); }
    }
    setPreparing(false);
  }, [missionId, selected]);
  const onCancel = useCallback(async () => {
    if (!waiting) return;
    setCancelling(true); setError(null);
    const r = await cancelReviewRequest({ missionId, requestId: waiting.id, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) { setWaiting(null); setQuote(null); setNotice(REVIEW_CANCELLED_AR); }
    else { setError(r.message); setWaiting(await fetchReviewRequest({ missionId, fetchFn: browserFetch, headers: authHeaders })); }
    setCancelling(false);
  }, [missionId, waiting]);
  // after the approval's answer the waiting request is read again from the server: an approved one no longer waits (the status panel tells its state), an uncertain one is back to waiting
  const onApprovalSettled = useCallback((r: ApproveResult) => {
    // a refusal or an UNCERTAIN answer keeps the request and the button on screen (its alert is the only place the customer reads «the points may be held»); only a request that was approved leaves the waiting state, and its sentence stays as a notice
    if (r.state !== "approved" && r.state !== "already_approved") return;
    setNotice(r.message);
    void fetchReviewRequest({ missionId, fetchFn: browserFetch, headers: authHeaders }).then((found) => setWaiting(found));
  }, [missionId]);
  return <ReviewQuoteBody versions={versions} selected={selected} onSelect={onSelect} onAsk={onAsk} busy={busy} quote={quote} error={error} waiting={waiting} onPrepare={onPrepare} preparing={preparing} onCancel={onCancel} cancelling={cancelling} notice={notice} approval={waiting ? <ApproveAddon missionId={missionId} requestId={waiting.id} points={waiting.points} onSettled={onApprovalSettled} /> : null} />;
}
