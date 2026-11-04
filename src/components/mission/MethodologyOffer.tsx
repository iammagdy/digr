"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBalance } from "@/hooks/useBalance";
import { toArabicDigits } from "@/lib/arabicDigits";
import { GENERIC_ITEM_NOUN, countAr } from "@/lib/agentMission/itemNoun";
import { fileNameFromDisposition } from "@/lib/downloadName";
import { METHODOLOGY_POINTS } from "@/lib/methodologyOffer";
import { pointsAr } from "@/lib/pointsFormat";

/**
 * THE DATA-COLLECTION METHODOLOGY OF A DELIVERED REQUEST (round 21): the line with its price before anything is asked of the customer, the confirmation inside the page, the purchase through the EXISTING route and ledger row (`/api/jobs/<id>/methodology`, `chg_meth_<jobId>`),
 * and the file saved under its own Arabic name (the site's header, never the storage link's). A purchase is ONE charge for the request: once bought, the same button downloads again and charges nothing.
 * The price shown is `METHODOLOGY_POINTS`; the page names it in the request (`expectedPoints`) and the server refuses any other.
 */
export const METHODOLOGY_PRICE_LINE_AR = `منهجية الجمع لهذا الطلب: ${toArabicDigits(METHODOLOGY_POINTS)} نقطة`;
export const METHODOLOGY_BOUGHT_LINE_AR = "اشتريت منهجية الجمع لهذا الطلب؛ التحميل مجاني ولا يُخصم شيء مرة أخرى.";
export const METHODOLOGY_CONFIRM_LINE_AR = `سيُخصم ${pointsAr(METHODOLOGY_POINTS)} من رصيدك مرة واحدة لهذا الطلب، ولن يُخصم شيء آخر. هل تؤكد؟`;

const BTN = "min-h-11 cursor-pointer rounded-full border px-5 text-[13px] focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-0 bg-ac text-onac`;
const BTN_PLAIN = `${BTN} border-ln2 bg-transparent text-ink`;

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export type OfferStep = "idle" | "confirm" | "busy";

/** The offer as drawn: pure (no network), so it renders the same on the server and in the tests. */
export function MethodologyOfferBody({ titleAr, deliveredUnits, purchased, step = "idle", error = null, onAsk = () => undefined, onConfirm = () => undefined, onCancel = () => undefined, onDownload = () => undefined }: {
  titleAr?: string; deliveredUnits?: number; purchased: boolean; step?: OfferStep; error?: string | null;
  onAsk?: () => void; onConfirm?: () => void; onCancel?: () => void; onDownload?: () => void;
}) {
  return (
    <div dir="rtl" data-testid="methodology-offer" data-state={purchased ? "bought" : step} className="flex flex-col gap-2 rounded-[14px] border border-ln bg-bg p-3">
      {titleAr ? <p className="m-0 text-[13px] font-semibold leading-[1.8] text-ink" data-testid="methodology-offer-title">{titleAr}{deliveredUnits ? <span className="font-light text-mut"> · {countAr(deliveredUnits, GENERIC_ITEM_NOUN)}</span> : null}</p> : null}
      <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="methodology-offer-price">{purchased ? METHODOLOGY_BOUGHT_LINE_AR : METHODOLOGY_PRICE_LINE_AR}</p>
      {step === "confirm" && !purchased ? <p role="alert" className="m-0 text-[13px] font-semibold leading-[1.8] text-ink" data-testid="methodology-offer-confirm-line">{METHODOLOGY_CONFIRM_LINE_AR}</p> : null}
      <div className="flex flex-wrap gap-2">
        {purchased
          ? <button type="button" className={BTN_PRIMARY} disabled={step === "busy"} onClick={onDownload} data-testid="methodology-offer-download">{step === "busy" ? "جارٍ التجهيز…" : "تحميل المنهجية"}</button>
          : step === "confirm" || step === "busy"
            ? <>
                <button type="button" className={BTN_PRIMARY} disabled={step === "busy"} onClick={onConfirm} data-testid="methodology-offer-confirm">{step === "busy" ? "جارٍ التجهيز…" : "تأكيد وطلب المنهجية"}</button>
                <button type="button" className={BTN_PLAIN} disabled={step === "busy"} onClick={onCancel} data-testid="methodology-offer-cancel">إلغاء</button>
              </>
            : <button type="button" className={BTN_PRIMARY} onClick={onAsk} data-testid="methodology-offer-ask">اطلب منهجية الجمع</button>}
      </div>
      {error ? <p role="alert" className="m-0 text-[13px] leading-[1.8]" style={{ color: "var(--bad)" }} data-testid="methodology-offer-error">{error}{/رصيد/.test(error) ? <> <a href="/dashboard/topup" className="text-ac">اشحن رصيدك</a></> : null}</p> : null}
    </div>
  );
}

/** Saves the bought file: the site's own response, saved under the name of its Content-Disposition (Arabic, from `filename*`). */
async function saveMethodologyFile(jobId: string): Promise<string | null> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/methodology?file=1`, { headers: await authHeaders(), cache: "no-store" });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return String(json?.error || "تعذّر تنزيل المنهجية الآن.");
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = fileNameFromDisposition(res.headers.get("Content-Disposition")) || "منهجية جمع البيانات.pdf";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(blobUrl); link.remove(); }, 30000);
  return null;
}

/** One delivered request's methodology: the price line, the confirmation, the purchase and the download. `onCharged` runs after a first purchase (the page refreshes its balance). */
export function MethodologyOffer({ jobId, titleAr, deliveredUnits, purchased: boughtAlready = false, onCharged }: { jobId: string; titleAr?: string; deliveredUnits?: number; purchased?: boolean; onCharged?: () => void }) {
  const [bought, setBought] = useState(boughtAlready);
  const [step, setStep] = useState<OfferStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useBalance();
  useEffect(() => { if (boughtAlready) setBought(true); }, [boughtAlready]);

  // The purchase: confirmed in the page, through the existing route (the price the page showed is named in the request). A bought request is fetched again here too: the route builds the file again and charges nothing (its ledger row exists).
  async function buy() {
    if (step === "busy") return;
    setStep("busy");
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/methodology`, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ confirmed: true, expectedPoints: METHODOLOGY_POINTS }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) { setError(String(json?.error || "تعذّر تجهيز المنهجية الآن؛ لم يُخصم شيء.")); setStep(bought ? "idle" : "confirm"); return; }
      setBought(true);
      if (Number(json.chargedPoints) > 0) { onCharged?.(); void refresh(); }
      const saveError = await saveMethodologyFile(jobId);
      if (saveError) setError(saveError);
      setStep("idle");
    } catch {
      setError("تعذّر الاتصال الآن؛ حاول بعد قليل. لم يُخصم شيء.");
      setStep(bought ? "idle" : "confirm");
    }
  }

  return <MethodologyOfferBody titleAr={titleAr} deliveredUnits={deliveredUnits} purchased={bought} step={step} error={error} onAsk={() => setStep("confirm")} onConfirm={() => void buy()} onCancel={() => setStep("idle")} onDownload={() => void buy()} />;
}

/** The chooser the chat draws under the methodology answer: the customer's delivered requests, each with its price line and button. */
export function MethodologyChooser({ onCharged }: { onCharged?: () => void }) {
  const [list, setList] = useState<Array<{ jobId: string; titleAr: string; deliveredUnits: number; purchased: boolean }> | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/missions/methodology", { headers: await authHeaders(), cache: "no-store" });
        const json = await res.json().catch(() => null);
        if (alive) setList(json?.success && Array.isArray(json.missions) ? json.missions : []);
      } catch { if (alive) setList([]); }
    })();
    return () => { alive = false; };
  }, []);
  if (list === null) return <div dir="rtl" data-testid="methodology-chooser" role="status" className="mt-3 rounded-[14px] border border-ln bg-sf p-3 text-[13px] text-ink2">جارٍ تجهيز قائمة طلباتك…</div>;
  if (list.length === 0) return <div dir="rtl" data-testid="methodology-chooser" className="mt-3 rounded-[14px] border border-ln bg-sf p-3 text-[13px] leading-[1.8] text-ink2">لا يوجد لديك طلب مُسلَّم تُكتب له منهجية جمع حاليًا.</div>;
  return (
    <section dir="rtl" data-testid="methodology-chooser" aria-label="اختر الطلب" className="mt-3 flex w-full max-w-[640px] flex-col gap-2 rounded-[18px] border border-ln bg-sf p-3.5">
      {list.map((m) => <MethodologyOffer key={m.jobId} jobId={m.jobId} titleAr={m.titleAr} deliveredUnits={m.deliveredUnits} purchased={m.purchased} onCharged={onCharged} />)}
    </section>
  );
}
