"use client";

import Link from "next/link";
import { useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import { FAILURE_STATE_AR } from "@/lib/publicCopy";
import { decisionMakersPerRequestLineAr } from "@/lib/jobSizing";
import type { EstimateKind, EstimateResult } from "@/lib/missionEstimate";

/**
 * The public estimate form: describe the request (structured fields, or a free-text sentence) and get an approximate price in
 * points and Egyptian pounds. All numbers come from /api/calculator/estimate, which is pure code (no model, no provider).
 */
const KINDS: Array<{ id: EstimateKind; label: string }> = [
  { id: "comments", label: "تعليقات" },
  { id: "posts", label: "منشورات وتغريدات" },
  { id: "videos", label: "فيديوهات" },
  { id: "companies", label: "شركات" },
  { id: "people", label: "صنّاع قرار" },
];

const PLATFORMS: Array<{ id: string; label: string }> = [
  { id: "youtube", label: "يوتيوب" },
  { id: "facebook", label: "فيسبوك" },
  { id: "x", label: "إكس" },
  { id: "tiktok", label: "تيك توك" },
];

type Answer = {
  result: EstimateResult | null;
  summaryAr: string | null;
  understoodAr: string | null;
  missingAr: string[];
};

const field = "min-h-12 rounded-[14px] border border-ln2 bg-bg px-3.5 text-sm text-ink outline-none";

export default function MissionEstimator() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<EstimateKind>("comments");
  const [platform, setPlatform] = useState("youtube");
  const [volume, setVolume] = useState("");
  const [budget, setBudget] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const social = kind === "comments" || kind === "posts" || kind === "videos";

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/calculator/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setAnswer(null);
        setError(typeof data?.error === "string" ? data.error : "تعذّر الحساب الآن، حاول بعد قليل.");
      } else {
        setAnswer({ result: data.result ?? null, summaryAr: data.summaryAr ?? null, understoodAr: data.understoodAr ?? null, missingAr: Array.isArray(data.missingAr) ? data.missingAr : [] });
      }
    } catch {
      setAnswer(null);
      setError("تعذّر الحساب الآن، حاول بعد قليل.");
    } finally {
      setBusy(false);
    }
  }

  const toNumber = (value: string) => Number(value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d]/g, "")) || 0;
  const result = answer?.result ?? null;

  return (
    <section data-testid="mission-estimator" className="flex flex-col gap-5 rounded-[22px] border border-ln bg-sf p-6">
      <div>
        <h2 className="m-0 font-display text-[24px] font-medium text-ink">كم يكلّف طلبك؟</h2>
        <p className="mb-0 mt-2 text-sm font-light leading-[1.9] text-ink2">اكتب طلبك بكلماتك، أو اختر من الخيارات. الحساب يتم هنا دون أي خصم من رصيدك، والرقم تقريبي.</p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => { event.preventDefault(); if (text.trim()) void submit({ text }); }}
      >
        <label htmlFor="estimate-text" className="text-sm font-medium text-ink">اكتب طلبك</label>
        <textarea
          id="estimate-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={600}
          rows={3}
          placeholder="مثال: عايز ٥٠٠ تعليق من فيديوهات على يوتيوب"
          className="rounded-[14px] border border-ln2 bg-bg p-3.5 text-sm leading-[1.9] text-ink outline-none"
        />
        <button type="submit" disabled={busy || !text.trim()} className="min-h-11 self-start rounded-full bg-ac px-5 text-sm text-onac disabled:opacity-50">احسب من الوصف</button>
      </form>

      <form
        className="grid grid-cols-1 gap-3 border-t border-ln pt-5 min-[720px]:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit({ kind, platform: social ? platform : undefined, volume: toNumber(volume) || undefined, budgetPoints: toNumber(budget) || undefined, openEnded: !toNumber(volume) && !toNumber(budget) });
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="estimate-kind" className="text-sm font-medium text-ink">نوع البيانات</label>
          <select id="estimate-kind" value={kind} onChange={(event) => setKind(event.target.value as EstimateKind)} className={field}>
            {KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        {social ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="estimate-platform" className="text-sm font-medium text-ink">المنصة</label>
            <select id="estimate-platform" value={platform} onChange={(event) => setPlatform(event.target.value)} className={field}>
              {PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <label htmlFor="estimate-volume" className="text-sm font-medium text-ink">العدد المطلوب</label>
          <input id="estimate-volume" inputMode="numeric" value={volume} onChange={(event) => setVolume(event.target.value)} placeholder="مثال: ٥٠٠" className={field} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="estimate-budget" className="text-sm font-medium text-ink">أو ميزانيتك بالنقاط (اختياري)</label>
          <input id="estimate-budget" inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="مثال: ٤٠٠" className={field} />
        </div>
        <div className="min-[720px]:col-span-2">
          <button type="submit" disabled={busy} className="min-h-11 rounded-full border border-ln2 bg-bg px-5 text-sm text-ink disabled:opacity-50">احسب من الخيارات</button>
        </div>
      </form>

      {error ? <p role="alert" className="m-0 rounded-[14px] border border-ln bg-bg p-4 text-sm text-ink">{error}</p> : null}

      {answer ? (
        <div role="status" data-testid="estimate-result" className="flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-5">
          {answer.understoodAr ? <p className="m-0 text-sm font-light leading-[1.9] text-ink2">{answer.understoodAr}</p> : null}
          {result?.status === "ok" ? (
            <>
              <p className="m-0 font-display text-[26px] font-medium leading-[1.4] text-ink">{answer.summaryAr}</p>
              <p className="m-0 text-xs text-mut">لعدد {toArabicDigits(result.volume)} سجل، بسعر {toArabicDigits(result.unitPricePoints)} نقطة للسجل.</p>
            </>
          ) : null}
          {result && result.status !== "ok" ? <p className="m-0 text-sm text-ink">{result.notesAr.join(" ")}</p> : null}
          {result?.status === "ok" ? result.notesAr.map((note) => <p key={note} className="m-0 text-xs font-light leading-[1.8] text-mut">{note}</p>) : null}
          {result?.status === "ok" && result.slug === "professional-people-search" ? (
            <p data-testid="people-per-request" className="m-0 text-xs font-light leading-[1.8] text-mut">{decisionMakersPerRequestLineAr(result.maxVolumeInOneJob)}</p>
          ) : null}
          {!result && answer.missingAr.length ? <p className="m-0 text-sm text-ink">{answer.missingAr.join(" ")}</p> : null}
          {result?.status === "ok" && answer.missingAr.length ? <p className="m-0 text-xs text-mut">{answer.missingAr.join(" ")}</p> : null}
          <p className="m-0 text-xs font-light leading-[1.8] text-mut">لا يُخصم شيء إلا بعد موافقتك على الخطة. {FAILURE_STATE_AR}</p>
          <Link href="/register" className="inline-flex min-h-11 items-center self-start rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ بحسابك المجاني</Link>
        </div>
      ) : null}
    </section>
  );
}
