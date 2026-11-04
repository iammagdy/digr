"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { REVIEW_ASKING_AR, REVIEW_BUTTON_AR, REVIEW_HEADING_AR, REVIEW_INTRO_AR, REVIEW_PICK_AR, reviewQuoteLinesAr, type ReviewQuoteView, type ReviewVersionChoice } from "@/lib/agentMission/stage4/reviewPreviewLabels";
import { fetchReviewQuote, fetchReviewVersions } from "@/lib/agentMission/stage4/reviewPreviewClient";
import { versionTitleAr } from "@/lib/agentMission/stage4/versionLabels";

/**
 * MONEY PR 7c (2B-2 task 2): THE REVIEW-PRICE PREVIEW on the request's own page, under the versions list. «مراجعة الملف» asks the server for the quote of the chosen version (the latest by default) and shows exactly what the server answered:
 * which version, how many cells, the price in points, and that nothing was charged. The browser computes no price. There is NO approval button and nothing is created, held or charged. While the feature is off (the route answers 404), or the mission has
 * no published version, or the list cannot be read, it draws NOTHING, so the page is what it was.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60 sm:w-auto";
const SELECT = "min-h-11 w-full rounded-[12px] border border-ln2 bg-transparent px-3 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-60 sm:w-auto";

export function ReviewQuoteBody({ versions, selected, onSelect, onAsk, busy = false, quote = null, error = null }: { versions: ReadonlyArray<ReviewVersionChoice>; selected: number | null; onSelect: (version: number) => void; onAsk: () => void; busy?: boolean; quote?: ReviewQuoteView | null; error?: string | null }) {
  if (versions.length === 0) return null;
  const lines = quote ? reviewQuoteLinesAr(quote) : [];
  return (
    <section data-testid="review-quote" aria-label={REVIEW_HEADING_AR} className="flex flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4">
      <h2 className="m-0 text-[15px] font-medium text-ink">{REVIEW_HEADING_AR}</h2>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">{REVIEW_INTRO_AR}</p>
      {versions.length > 1 ? (
        <label className="flex flex-col gap-1 text-[13px] text-ink">
          <span>{REVIEW_PICK_AR}</span>
          <select data-testid="review-version" className={SELECT} value={selected ?? ""} disabled={busy} onChange={(e) => onSelect(Number(e.target.value))}>
            {versions.map((v) => <option key={v.version} value={v.version}>{versionTitleAr(v.version, v.reason)}</option>)}
          </select>
        </label>
      ) : null}
      <button type="button" data-testid="review-ask" className={BTN} disabled={busy || selected === null} aria-busy={busy ? true : undefined} onClick={onAsk}>
        {busy ? REVIEW_ASKING_AR : REVIEW_BUTTON_AR}
      </button>
      {error ? <p role="alert" data-testid="review-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p> : null}
      <div data-testid="review-result" aria-live="polite" className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
        {lines.map((line, i) => <p key={i} className={i === 0 ? "m-0 font-medium" : "m-0 text-ink2"}>{line}</p>)}
      </div>
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
  useEffect(() => {
    let alive = true;
    fetchReviewVersions({ missionId, fetchFn: fetch, headers: authHeaders }).then((list) => {
      if (!alive) return;
      setVersions(list);
      setSelected(list.length > 0 ? list[list.length - 1].version : null);
    });
    return () => { alive = false; };
  }, [missionId]);
  const onSelect = useCallback((version: number) => { setSelected(version); setQuote(null); setError(null); }, []);
  const onAsk = useCallback(async () => {
    if (selected === null) return;
    setBusy(true); setQuote(null); setError(null);
    const r = await fetchReviewQuote({ missionId, version: selected, fetchFn: fetch, headers: authHeaders });
    if (r.ok) setQuote(r.quote); else setError(r.message);
    setBusy(false);
  }, [missionId, selected]);
  return <ReviewQuoteBody versions={versions} selected={selected} onSelect={onSelect} onAsk={onAsk} busy={busy} quote={quote} error={error} />;
}
