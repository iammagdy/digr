"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import { bareNounAr, countKindOfSlug, countPlainAr } from "@/lib/planCounts";
import { FAILURE_STATE_AR } from "@/lib/publicCopy";
import { decisionMakersPerRequestLineAr } from "@/lib/jobSizing";
import { estimateFormProblemAr, estimateSlug, type EstimateKind, type EstimateResult } from "@/lib/missionEstimate";
import type { SocialPlatformId } from "@/lib/socialTasks";
import { unitPriceLabelAr } from "@/lib/pointsFormat";
import { useOptionalUser } from "@/hooks/useUser";

/**
 * THE CALCULATOR: three choices (the platform, the type of data, the count) and ONE result. Every number comes from /api/calculator/estimate, which is pure code (no model, no provider); the expected
 * time is the plan card's own function (`expectedTimeOf`), so the calculator and the card never disagree for the same mission.
 */
const PLATFORMS: Array<{ id: string; label: string }> = [
  { id: "youtube", label: "يوتيوب" },
  { id: "facebook", label: "فيسبوك" },
  { id: "x", label: "إكس" },
  { id: "tiktok", label: "تيك توك" },
  { id: "companies", label: "شركات وصناع قرار" },
];

const KIND_LABEL: Record<EstimateKind, string> = { comments: "تعليقات", posts: "منشورات وتغريدات", videos: "فيديوهات", companies: "شركات", people: "صنّاع قرار" };
const COUNT_PRESETS = [50, 100, 500, 1000] as const;

/** The types of data a platform can serve, from the same function the price uses (a pair with no service is not offered). Two types that are the same service are offered once. */
export function kindsOfPlatform(platform: string): EstimateKind[] {
  if (platform === "companies") return ["companies", "people"];
  const seen = new Set<string>();
  const out: EstimateKind[] = [];
  for (const kind of ["comments", "posts", "videos"] as const) {
    const slug = estimateSlug(kind, platform as SocialPlatformId);
    if (slug && !seen.has(slug)) { seen.add(slug); out.push(kind); }
  }
  return out;
}

/** «تغريدات» on X, «منشورات» on the others. */
export const kindLabelOf = (kind: EstimateKind, platform: string): string => (kind === "posts" ? (platform === "x" ? "تغريدات" : "منشورات") : KIND_LABEL[kind]);

type Answer = { result: EstimateResult | null; expectedAr: string | null; summaryAr: string | null; missingAr: string[] };

const field = "min-h-12 w-full rounded-[14px] border border-ln2 bg-bg px-3.5 text-[15px] text-ink outline-none focus:border-ac";

export default function MissionEstimator() {
  const user = useOptionalUser();
  const [platform, setPlatform] = useState("youtube");
  const kinds = useMemo(() => kindsOfPlatform(platform), [platform]);
  const [kind, setKind] = useState<EstimateKind>("comments");
  const [volume, setVolume] = useState(toArabicDigits(100));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeKind = kinds.includes(kind) ? kind : kinds[0];
  const social = platform !== "companies";
  const toNumber = (value: string) => Number(value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d]/g, "")) || 0;
  const count = toNumber(volume);
  const formProblem = estimateFormProblemAr({ kind: activeKind, platform: social ? platform : "n/a", volume: count, budget: 0 });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/calculator/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: activeKind, platform: social ? platform : undefined, volume: count || undefined, openEnded: false }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setAnswer(null);
        setError(typeof data?.error === "string" ? data.error : "تعذّر الحساب الآن، حاول بعد قليل.");
      } else {
        setAnswer({ result: data.result ?? null, expectedAr: typeof data.expectedAr === "string" ? data.expectedAr : null, summaryAr: data.summaryAr ?? null, missingAr: Array.isArray(data.missingAr) ? data.missingAr : [] });
      }
    } catch {
      setAnswer(null);
      setError("تعذّر الحساب الآن، حاول بعد قليل.");
    } finally {
      setBusy(false);
    }
  }

  // The result follows the choices (after a pause of a third of a second); a missing choice is said in words. Nothing is deducted by it.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (formProblem) { setAnswer(null); setError(null); return; }
    const timer = setTimeout(() => { void submitRef.current(); }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, activeKind, count, formProblem]);

  const result = answer?.result ?? null;
  return (
    <section data-testid="mission-estimator" className="flex flex-col gap-5 rounded-[22px] border border-ln bg-sf p-5 min-[560px]:p-6">
      <div>
        <h2 className="m-0 font-display text-[24px] font-medium text-ink">كم تكلّف مهمتك؟</h2>
        <p className="mb-0 mt-2 text-sm font-light leading-[1.9] text-ink2">اختر المنصة ونوع البيانات والعدد، ونحسب لك التكلفة والوقت. الحساب هنا دون أي خصم من رصيدك، والرقم تقريبي.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 min-[720px]:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="estimate-platform" className="text-sm font-medium text-ink">المنصة</label>
          <select id="estimate-platform" value={platform} onChange={(event) => { setPlatform(event.target.value); setKind(kindsOfPlatform(event.target.value)[0]); }} className={field}>
            {PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="estimate-kind" className="text-sm font-medium text-ink">نوع البيانات</label>
          <select id="estimate-kind" value={activeKind} onChange={(event) => setKind(event.target.value as EstimateKind)} className={field}>
            {kinds.map((item) => <option key={item} value={item}>{kindLabelOf(item, platform)}</option>)}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="estimate-volume" className="text-sm font-medium text-ink">العدد المطلوب</label>
          <input id="estimate-volume" inputMode="numeric" value={volume} onChange={(event) => setVolume(event.target.value)} placeholder="مثال: ١٠٠" className={field} />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="أعداد جاهزة">
            {COUNT_PRESETS.map((n) => <button key={n} type="button" onClick={() => setVolume(toArabicDigits(n))} aria-pressed={count === n} className={`min-h-11 cursor-pointer rounded-full border px-3.5 text-[13px] text-ink ${count === n ? "border-gold bg-sf2" : "border-ln bg-bg"}`}>{toArabicDigits(n)}</button>)}
          </div>
        </div>
      </div>

      {formProblem ? <p role="status" data-testid="estimate-problem" className="m-0 rounded-[14px] border border-ln bg-bg p-4 text-sm text-ink">{formProblem}</p> : null}
      {error ? <p role="alert" className="m-0 rounded-[14px] border border-ln bg-bg p-4 text-sm text-ink">{error}</p> : null}

      {answer && !formProblem ? (
        <div role="status" data-testid="estimate-result" className="flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-5">
          {result?.status === "ok" ? (
            <>
              <p className="m-0 font-display text-[26px] font-medium leading-[1.5] text-ink">{answer.summaryAr}</p>
              <p className="m-0 text-xs text-mut">لعدد {countPlainAr(result.volume, countKindOfSlug(result.slug))}، بسعر {unitPriceLabelAr(result.unitPricePoints, bareNounAr(countKindOfSlug(result.slug)))}.</p>
              {answer.expectedAr ? (
                <p data-testid="estimate-duration" className="m-0 text-sm text-ink">الوقت المتوقع: <strong data-testid="estimate-time">{answer.expectedAr}</strong></p>
              ) : null}
              {result.notesAr.map((note) => <p key={note} className="m-0 text-xs font-light leading-[1.8] text-mut">{note}</p>)}
              {result.slug === "professional-people-search" ? (
                <p data-testid="people-per-request" className="m-0 text-xs font-light leading-[1.8] text-mut">{decisionMakersPerRequestLineAr(result.maxVolumeInOneJob)}</p>
              ) : null}
            </>
          ) : null}
          {result && result.status !== "ok" ? <p className="m-0 text-sm text-ink">{result.notesAr.join(" ")}</p> : null}
          <p className="m-0 text-xs font-light leading-[1.8] text-mut">لا يُخصم شيء إلا بعد موافقتك على الخطة. {FAILURE_STATE_AR}</p>
          {user
            ? <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center self-start rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ طلبك</Link>
            : <Link href="/register" className="inline-flex min-h-11 items-center self-start rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ بحسابك المجاني</Link>}
        </div>
      ) : null}
    </section>
  );
}
