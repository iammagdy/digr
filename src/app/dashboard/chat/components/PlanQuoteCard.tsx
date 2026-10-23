"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { customerFacingFailure } from "@/lib/customerError";
import { useEffect, useMemo, useState } from "react";
import { formatNumber } from "@/lib/honestDisplay";
import { formatAr, normalizeDigits as toLatinDigits } from "@/lib/arabicDigits";
import { CAPACITY_LIMITED_REASON_AR, volumeLimitStatementAr } from "@/lib/jobCaps";
import { defaultVolumeStatementAr, type DefaultNoun } from "@/lib/planDefaults";
import { socialTopicForDisplay } from "@/lib/socialTopicDisplay";
import { getQuoteApprovalState, isQuotePlanComplete, planApprovalNoteAr } from "@/lib/quoteApprovalState";
import { quoteScopeGaps, planScopeRows, scrubQuoteTexts } from "@/lib/quoteScopeGaps";
import { getCustomerMethodologyNote } from "@/lib/customerMethodology";
import { CUSTOMER_FORMAT_LABEL_AR } from "@/lib/customerFormatLabels";
import { missionStepsAr } from "@/lib/dependentSteps";
import { JOB_MAX_POINTS_CAP } from "@/lib/jobPointsCap";
import { balanceVerdictAr } from "@/lib/balanceVerdict";
import { chargeForUnits, pointsDisplay, pricePer100Points } from "@/lib/recordPricing";

export interface PlanItem {
  capabilitySlug: string;
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
}

export interface PlanQuoteData {
  quoteId: string;
  planHash?: string;
  summaryAr: string;
  items?: PlanItem[];
  targetVolumeMax: number;
  unitPricePoints: number;
  expectedPoints?: number;
  quotedPoints: number;
  isAffordable: boolean;
  pointsCapConstrained?: boolean;
  /** The live extraction capacity (not the points cap) cut the count (set by the server). */
  capacityConstrained?: boolean;
  /** The service's own per-request ceiling cut the count (not the balance, not the points cap): the number it holds (set by the server). */
  serviceCeilingUnits?: number;
  /** The sentence the server wrote for why the plan holds fewer records than asked (the service's ceiling, what the posts read can reach, the capacity). */
  volumeLimitLineAr?: string;
  /** One plain verdict on the balance, from the quote (set by the server; the card recomputes it from the live balance). */
  balanceVerdictAr?: string;
  requestedVolumeMax?: number;
  /** What the customer asked, when the plan holds fewer records than that (set by the server). */
  askedVolumeMax?: number;
  /** What a channels mission covers when that differs from what the template said (fewer channels, a lower top): plain sentences from code. */
  coverageLinesAr?: string[];
  /** The parts of a request that mixes what we sell with what we do not: the priced part, and each part left out with its reason. */
  partsAr?: Array<{ labelAr: string; included: boolean; reasonAr?: string }>;
  /** The count is a default the plan chose because the customer left it open (set by the server): the card says so, never «you asked for». */
  defaultCap?: { noun: DefaultNoun; units: number; wordAr?: string };
  pointsCap?: number;
  userBalance: number;
  downscaledOffer?: {
    maxAffordableUnits: number;
    affordableQuotedPoints: number;
    rawCostPoints: number;
  };
  isDependent?: boolean;
  stepCostRanges?: Array<{
    stepId: string;
    capabilitySlug: string;
    labelAr?: string;
    minUnits: number;
    maxUnits: number;
    minPoints: number;
    maxPoints: number;
  }>;
  outputFormats: string[];
  /** Large or vague plans: a small priced sample first («استكشاف»). Computed by the server. */
  explorationOffer?: { sampleUnits: number; samplePoints: number; sampleExpectedPoints: number; fullUnits: number; fullQuotedPoints: number; fullEstimatePoints?: number };
  /** This quote is the rest of a request after a delivered sample: what the sample delivered and cost, and the approximate total with it. */
  afterSample?: { deliveredInSample: number; sampleChargedPoints: number; remainingUnits: number; approximateTotalPoints: number };
  /** This quote is the sample; the figures describe the full plan it explores. */
  exploration?: { fullVolume: number; fullQuotedPoints: number };
  expiresAt: string;
  /** Loaded from plans_quotes when a saved conversation is restored. */
  status?: string;
  methodologyNotes?: string;
  /** One sentence: what the assistant understood from the request (built by code). */
  understoodAr?: string;
  /** The period a feed plan applies, why (a known event) and any date that was corrected. */
  window?: { labelAr: string; source: string; reasonAr?: string; noteAr?: string };
  /** How long the mission will take: a range written by code from real numbers (never a promise), labelled as an estimate. */
  duration?: { rangeAr: string; labelAr: string; driversAr: string; promiseAr: string; longNoteAr?: string; closePageAr?: string };
}

interface PlanQuoteCardProps {
  quote: PlanQuoteData;
  conversationTitle?: string;
  onStart: (quote: PlanQuoteData) => void;
  onSaveEdit: (
    quote: PlanQuoteData,
    newLimit: number,
    newParam: string,
    newFormats: string[],
    newCountry?: string,
    newIndustry?: string,
    pointsCap?: number
  ) => Promise<void>;
  onAcceptDownscaled?: (units: number) => void;
  isStarting: boolean;
  /** Live available points (ledger sum). null while unknown: the quote's own snapshot is used. */
  available: number | null;
  /** EGP value of one point (settings_public.creditValueEgp). */
  creditValue: number;
  /** «اشحن {الفرق} والعودة هنا»: shortfall in EGP, rounded up to the next 50. */
  onTopupShort: (shortEgp: number) => void;
  /** «تحديث السعر»: recompute the quote on the server (an expired quote is never accepted). */
  onRefresh: (quote: PlanQuoteData) => Promise<void>;
  /** The plan was approved and a run exists: show the quote read-only. */
  locked?: boolean;
  /** «استكشاف أولًا»: replace this quote by a small priced sample of the same plan. */
  onExplore?: (quote: PlanQuoteData) => Promise<void> | void;
}

export function formatExpiry(expiresAt: string): string {
  try {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(ms)) return "";
    if (ms <= 0) return "انتهت صلاحية عرض السعر";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `ينتهي عرض السعر خلال ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    return `ينتهي عرض السعر خلال ${hours} ساعة`;
  } catch {
    return "";
  }
}

const FORMAT_LABEL = CUSTOMER_FORMAT_LABEL_AR;

/** «ينتهي العرض خلال ٢٨ دقيقة» */
function expiryShort(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return "";
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return `ينتهي العرض خلال ${formatAr(mins)} دقيقة`;
  return `ينتهي العرض خلال ${formatAr(Math.floor(mins / 60))} ساعة`;
}

const PRIMARY_BTN =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border-0 bg-ac text-onac focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY_BTN =
  "cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-50";

const EDIT_PLAN_BTN_LABEL = "تعديل الخطة";
export const _LEGACY_EDIT_BTN_LABEL = "تعديل";

import { extractParamDisplayString, extractInterpretedParameters, industryDisplayLabelAr, socialContentTopicFromTitle } from "@/lib/planParameters";
export { extractParamDisplayString, extractInterpretedParameters };

/** Design «الخطة والسعر». The price, balance check and expiry all come from the server quote; nothing is computed here beyond display. */
export default function PlanQuoteCard({
  quote: storedQuote,
  conversationTitle = "",
  onStart,
  onSaveEdit,
  onAcceptDownscaled,
  isStarting,
  available,
  creditValue,
  onTopupShort,
  onRefresh,
  locked = false,
  onExplore,
}: PlanQuoteCardProps) {
  const quote = useMemo(() => scrubQuoteTexts(storedQuote), [storedQuote]);
  const [isEditing, setIsEditing] = useState(false);
  const [editLimit, setEditLimit] = useState(quote.targetVolumeMax || 1);
  const primaryItem = quote.items?.[0];
  const capabilitySlug = (primaryItem?.capabilitySlug || "").toLowerCase();
  const isPeoplePlan = capabilitySlug.includes("people");
  const isCompanyPlan = /compan|b2b/.test(capabilitySlug);
  const isVideoPlan = /video|videos|tiktok|youtube|reels/.test(capabilitySlug);
  const isSocialContentPlan = isVideoPlan || /post|posts|social|instagram|facebook|reddit|twitter/.test(capabilitySlug);
  const interpreted = extractInterpretedParameters(primaryItem?.params, quote.summaryAr, isPeoplePlan);
  const initialParam = extractParamDisplayString(primaryItem?.params, quote.summaryAr, isPeoplePlan);
  // A social plan names its topic from its own parameters; the title (cut at fifty characters) is only a fallback, and a cut title is ignored.
  const titleTopic = isSocialContentPlan
    ? socialTopicForDisplay({ params: primaryItem?.params, conversationTitle, trending: primaryItem?.params?.trending === true })
    : socialContentTopicFromTitle(conversationTitle);
  const displayIndustry = isPeoplePlan
    ? interpreted.industryAr
    : isSocialContentPlan
      ? (titleTopic || initialParam || "الموضوع المطلوب")
      : industryDisplayLabelAr(interpreted.industryAr);
  const scopeLabel = isPeoplePlan ? "نوع البحث:" : isSocialContentPlan ? "موضوع المحتوى:" : "النشاط / التخصص:";
  const [editParamVal, setEditParamVal] = useState(isSocialContentPlan ? displayIndustry : initialParam);
  const [editCountry, setEditCountry] = useState(interpreted.countryAr);
  const [editIndustry, setEditIndustry] = useState(displayIndustry);
  const [editFormats, setEditFormats] = useState<string[]>(quote.outputFormats || ["xlsx", "pdf", "csv"]);
  // The customer's own budget cap in points (optional): empty keeps the plan as quoted.
  const [editCap, setEditCap] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editError, setEditError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const pItem = quote.items?.[0];
    const people = (pItem?.capabilitySlug || "").toLowerCase().includes("people");
    const inter = extractInterpretedParameters(pItem?.params, quote.summaryAr, people);
    setEditParamVal(isSocialContentPlan ? displayIndustry : extractParamDisplayString(pItem?.params, quote.summaryAr, people));
    setEditCountry(inter.countryAr);
    setEditIndustry(people ? inter.industryAr : industryDisplayLabelAr(inter.industryAr));
    setEditLimit(quote.targetVolumeMax || 1);
    setEditFormats(quote.outputFormats || ["xlsx", "pdf", "csv"]);
  }, [quote]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const baseApprovalState = getQuoteApprovalState(quote.status, quote.expiresAt, now);
  // Never shrink silently: what was asked, what fits one job now, and why (one plain sentence from the plan's own numbers).
  const defaultStatement = quote.defaultCap && (quote.items?.length ?? 1) <= 1
    ? defaultVolumeStatementAr({ noun: quote.defaultCap.noun, defaultUnits: quote.defaultCap.units, fittedUnits: quote.targetVolumeMax, quotedPoints: quote.quotedPoints, pointsCap: quote.pointsCap || JOB_MAX_POINTS_CAP, wordAr: quote.defaultCap.wordAr })
    : null;
  const capacityCut = Boolean(quote.capacityConstrained && !quote.pointsCapConstrained);
  const volumeLimit = defaultStatement ? null : quote.volumeLimitLineAr ? quote.volumeLimitLineAr : (quote.items?.length ?? 1) <= 1
    ? volumeLimitStatementAr({
        askedUnits: Math.max(quote.askedVolumeMax ?? 0, quote.requestedVolumeMax ?? 0),
        fittedUnits: quote.targetVolumeMax,
        ...(quote.capacityConstrained && !quote.pointsCapConstrained ? { reason: "capacity" as const, reservedPoints: quote.quotedPoints } : {}),
        ...(quote.serviceCeilingUnits && !quote.capacityConstrained ? { reason: "service" as const } : {}),
      })
    : null;
  const planComplete = isQuotePlanComplete(quote.items) && quoteScopeGaps(quote.items).length === 0;
  const approvalState = { ...baseApprovalState, canApprove: baseApprovalState.canApprove && planComplete };
  const expired = !approvalState.canApprove;
  const balance = available ?? quote.userBalance;
  const low = available !== null ? available < quote.quotedPoints : !quote.isAffordable;
  const shortPts = Math.max(0, quote.quotedPoints - balance);
  const expectedPoints = quote.expectedPoints ?? chargeForUnits(quote.targetVolumeMax, quote.unitPricePoints);
  const shortEgp = Math.max(50, Math.ceil((shortPts * creditValue) / 50) * 50);
  const formats = (quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf", "csv"]).map((f) => FORMAT_LABEL[f] || "ملف بيانات");

  function toggleFormat(fmt: string) {
    if (editFormats.includes(fmt)) {
      if (editFormats.length > 1) setEditFormats(editFormats.filter((f) => f !== fmt));
    } else {
      setEditFormats([...editFormats, fmt]);
    }
  }

  function handleOpenEdit() {
    const pItem = quote.items?.[0];
    const people = (pItem?.capabilitySlug || "").toLowerCase().includes("people");
    const inter = extractInterpretedParameters(pItem?.params, quote.summaryAr, people);
    setEditParamVal(isSocialContentPlan ? displayIndustry : extractParamDisplayString(pItem?.params, quote.summaryAr, people));
    setEditCountry(inter.countryAr);
    setEditIndustry(people ? inter.industryAr : industryDisplayLabelAr(inter.industryAr));
    setEditLimit(quote.targetVolumeMax || 1);
    setEditFormats(quote.outputFormats || ["xlsx", "pdf", "csv"]);
    setEditError("");
    setIsEditing((v) => !v);
  }

  async function handleSave() {
    setSavingEdit(true);
    setEditError("");
    try {
      const capValue = Number(toLatinDigits(editCap));
      await onSaveEdit(quote, editLimit, editParamVal, editFormats, editCountry, editIndustry, editCap.trim() && Number.isFinite(capValue) && capValue > 0 ? Math.floor(capValue) : undefined);
      setEditCap("");
      setIsEditing(false);
    } catch (err: any) {
      const rawMsg = err instanceof Error ? err.message : String(err || "");
      let safeMsg = "فشل تحديث الخطة وعرض السعر. يرجى المحاولة مرة أخرى.";
      if (rawMsg.includes("is not a function") || rawMsg.includes("undefined") || rawMsg.includes("null") || rawMsg.includes("trim")) {
        safeMsg = "تعذر تحديث الخطة بسبب تنسيق غير صالح في المعاملات. يرجى مراجعة القيمة المدخلة.";
      } else if (rawMsg.includes("غير مصرح") || rawMsg.includes("401") || rawMsg.includes("403")) {
        safeMsg = "انتهت الجلسة أو غير مصرح. يرجى تسجيل الدخول والمحاولة مرة أخرى.";
      } else if (rawMsg.includes("صلاحية") || rawMsg.includes("expired")) {
        safeMsg = "انتهت صلاحية عرض السعر. يرجى تحديث السعر أولاً.";
      } else if (rawMsg.length > 0) {
        safeMsg = customerFacingFailure(err, { fallback: safeMsg }).text;
      }
      setEditError(safeMsg);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try { await onRefresh(quote); } finally { setRefreshing(false); }
  }

  return (
    <div className="mt-[18px] rounded-2xl border border-ln bg-sf p-4" style={{ animation: "up .6s both" }} aria-label="خطة البحث وعرض السعر" dir="rtl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="m-0 text-xs text-mut mb-1 font-medium">التكلفة المتوقعة</p>
          <p className="m-0 text-[34px] font-normal leading-none text-ink">
            {formatAr(expectedPoints)}
            <span className="text-base text-mut" style={{ marginInlineStart: 8 }}>نقطة</span>
          </p>
          <p className="mb-0 mt-2 text-[13px] font-light text-mut">
            ≈ {formatAr(Number((expectedPoints * creditValue).toFixed(2)))} ج.م {locked ? "" : `· رصيدك ${pointsAr(balance)}`}
          </p>
        </div>
        <p className="m-0 text-left text-[13px] font-light leading-[1.9] text-mut">
          حتى {formatAr(quote.targetVolumeMax)} سجل<br />
          {!locked && !expired && expiryShort(quote.expiresAt, now) && <>{expiryShort(quote.expiresAt, now)}</>}
        </p>
      </div>

      <p className="mb-0 mt-3 text-[12px] font-light leading-[1.9] text-mut" data-testid="plan-cap-line">
        سقف هذا الطلب: حتى {pointsAr(quote.quotedPoints)}، ولا يُخصم أكثر منه، ويُخصم فقط مقابل ما يُسلَّم. {locked ? "" : "تقدر تخفضه من «تعديل الخطة»."}
      </p>

      {quote.unitPricePoints > 0 && (quote.items?.length ?? 1) <= 1 ? (
        <p className="mb-0 mt-2 text-[12px] font-light leading-[1.9] text-mut" data-testid="plan-unit-price">
          سعر السجل الواحد حوالي {pointsAr(Number(pointsDisplay(quote.unitPricePoints)))}، أي {pointsAr(pricePer100Points(quote.unitPricePoints))} لكل ١٠٠ سجل (تقديري).
        </p>
      ) : null}

      {quote.understoodAr && (
        <p className="mb-0 mt-3 text-[13px] font-light leading-[1.9] text-ink" data-testid="plan-understood">{quote.understoodAr}</p>
      )}

      {quote.partsAr && quote.partsAr.some((part) => !part.included) ? (
        <ul data-testid="plan-parts" className="mb-0 mt-3 list-none space-y-1 rounded-xl border border-sand-200 bg-sand-50/70 p-3 text-[12.5px] leading-[1.9] text-ink">
          {quote.partsAr.map((part) => (
            <li key={part.labelAr} data-testid={part.included ? "plan-part-included" : "plan-part-not-sold"}>
              <span className="font-bold">{part.labelAr}</span>
              {" — "}
              {part.included ? "مشمول في هذا السعر" : `غير مُسعَّر${part.reasonAr ? `: ${part.reasonAr}` : ""}`}
            </li>
          ))}
        </ul>
      ) : null}

      {quote.coverageLinesAr?.length ? (
        <ul data-testid="plan-coverage" className="mb-0 mt-3 list-none space-y-1 p-0 text-[12.5px] font-light leading-[1.9] text-ink">
          {quote.coverageLinesAr.map((line) => (<li key={line}>{line}</li>))}
        </ul>
      ) : null}

      {defaultStatement ? (
        <p data-testid="plan-default-volume" className="mb-0 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.8] text-amber-950">
          {defaultStatement}
        </p>
      ) : null}

      {volumeLimit ? (
        <p data-testid="plan-volume-limit" className="mb-0 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.8] text-amber-950">
          {volumeLimit} {capacityCut ? CAPACITY_LIMITED_REASON_AR : quote.serviceCeilingUnits || quote.volumeLimitLineAr?.includes("هذا حدّ") ? "" : "يمكنك تقليل العدد أكثر إذا أردت."}
        </p>
      ) : quote.pointsCapConstrained && !defaultStatement ? (
        <p className="mb-0 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.8] text-amber-950">
          {quote.targetVolumeMax < (quote.requestedVolumeMax || quote.targetVolumeMax)
            ? `تم ضبط العدد من ${formatAr(quote.requestedVolumeMax || quote.targetVolumeMax)} إلى ${formatAr(quote.targetVolumeMax)} سجل حتى يظل السعر والحجز مع احتياطي التنفيذ ضمن سقف ${pointsAr(quote.pointsCap || JOB_MAX_POINTS_CAP)}.`
            : `العدد المطلوب ${formatAr(quote.targetVolumeMax)} أشخاص يناسب سقف السعر. تم تحديد الحجز عند ${pointsAr(quote.quotedPoints)}، ويشمل احتياطي التنفيذ ضمن سقف ${pointsAr(quote.pointsCap || JOB_MAX_POINTS_CAP)}.`} يمكنك تقليل العدد أكثر إذا أردت.
        </p>
      ) : null}

      {/* Interpreted Parameters: Chips from planScopeRows */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px]">
        {planScopeRows(quote.items, conversationTitle).map((chip, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <span className="text-mut">{chip.label}</span>
            <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink">
              {chip.value}
            </span>
          </div>
        ))}
      </div>

      {quote.afterSample && (
        <p className="mb-0 mt-3 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9] text-ink2" data-testid="plan-after-sample">
          هذا هو الباقي من طلبك بعد العينة: {formatAr(quote.afterSample.remainingUnits)} سجل دون ما وصلك فيها ({formatAr(quote.afterSample.deliveredInSample)} سجل، خُصم عنها {pointsAr(quote.afterSample.sampleChargedPoints)}). الإجمالي التقريبي مع العينة حوالي {pointsAr(quote.afterSample.approximateTotalPoints)}.
        </p>
      )}

      <p data-testid="plan-balance-verdict" className="mb-0 mt-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9] text-ink2">
        {balanceVerdictAr({ balance, quotedPoints: quote.quotedPoints, expectedPoints, targetVolumeMax: quote.targetVolumeMax, downscaledOffer: quote.downscaledOffer })}
      </p>

      {quote.duration && (
        <div className="mt-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9]" data-testid="plan-duration">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-mut">المدة المتوقعة</span>
            <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink" data-testid="plan-duration-range">{quote.duration.rangeAr}</span>
            <span className="rounded-md border border-ln px-1.5 py-0.5 text-[11px] text-mut">{quote.duration.labelAr}</span>
          </div>
          <p className="mb-0 mt-1 font-light text-ink2">{quote.duration.driversAr}</p>
          {quote.duration.longNoteAr && <p className="mb-0 mt-1 font-light text-ink2" data-testid="plan-duration-long">{quote.duration.longNoteAr}</p>}
          <p className="mb-0 mt-1 font-light text-ink2" data-testid="plan-duration-promise">{quote.duration.promiseAr}</p>
          {quote.duration.closePageAr && <p className="mb-0 mt-1 font-light text-ink2" data-testid="plan-duration-close">{quote.duration.closePageAr}</p>}
        </div>
      )}

      {quote.window && (
        <div className="mt-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9]" data-testid="plan-window">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-mut">الفترة الزمنية</span>
            <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink">{quote.window.labelAr}</span>
          </div>
          {quote.window.reasonAr && <p className="mb-0 mt-1 font-light text-ink2">{quote.window.reasonAr}</p>}
          {quote.window.noteAr && <p className="mb-0 mt-1 font-light text-ink2">{quote.window.noteAr}</p>}
        </div>
      )}

      {/* A channel mission (channels, then their top videos, then the comments) shows its own steps */}
      {Array.isArray(primaryItem?.params?.channels) && primaryItem.params.channels.length > 0 ? (
        <div className="mt-3.5 space-y-2 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px]" data-testid="mission-steps">
          <p className="m-0 font-medium text-ink">خطوات التنفيذ:</p>
          <ol className="m-0 list-none space-y-1 p-0 font-light text-ink2">
            {missionStepsAr(primaryItem.params, quote.targetVolumeMax).map((line, i) => (
              <li key={i} className="flex items-start gap-2"><span className="font-bold text-ac">{formatAr(i + 1)}.</span><span>{line}</span></li>
            ))}
          </ol>
        </div>
      ) : (
      <div className="mt-3.5 space-y-2 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px]">
        <p className="m-0 font-medium text-ink">خطوات التنفيذ المنهجية:</p>
        <ul className="m-0 list-inside space-y-1 pr-1 font-light text-ink2">
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">١.</span>
            <span>{isPeoplePlan
              ? `البحث عن صناع القرار والمهنيين في ${interpreted.countryAr} ضمن المصادر المتاحة.`
              : isSocialContentPlan
                ? primaryItem?.params?.trending === true
                  ? `البحث عن ${displayIndustry} على المنصة المحددة ضمن النطاق ${interpreted.countryAr}.`
                  : `البحث عن ${isVideoPlan ? "الفيديوهات" : "المحتوى"} المنشور حول «${displayIndustry}» على المنصة المحددة.`
                : `استخراج السجلات الأولية من المصادر المتاحة للنطاق المحدد (${interpreted.countryAr} · ${displayIndustry}).`}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">٢.</span>
            <span>{isPeoplePlan
              ? "تنظيم الأسماء والمسميات الوظيفية والبريد الإلكتروني المهني والهاتف المكتبي عند توافر كل حقل."
              : isSocialContentPlan
                ? `فرز النتائج حسب صلتها بموضوع «${displayIndustry}» والفترة الزمنية المطلوبة.`
                : isCompanyPlan
                  ? "تدقيق الملاءمة ومراجعة الشركات واستبعاد الأنشطة غير المطابقة."
                  : "مراجعة النتائج واستبعاد السجلات غير المرتبطة بموضوع البحث."}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">٣.</span>
            <span>{isPeoplePlan
              ? "توضيح حالة توفر الاسم والمسمى والبريد الإلكتروني المهني والهاتف المكتبي؛ لا يعني ذلك تحققًا مستقلًا من الحقول."
              : isSocialContentPlan
                ? "إزالة النتائج المكررة وتنظيم الروابط والتواريخ والبيانات المتاحة في المصدر."
                : isCompanyPlan
                  ? "إزالة التكرار ومراجعة بيانات التواصل المتاحة في المصدر."
                  : "إزالة التكرار وتنظيم الحقول المتاحة في المصدر."}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">٤.</span>
            <span>تجهيز الملفات المطلوبة ({formats.join("، ")}) وتوضيح منهجية التنفيذ ومصادر البيانات وحدود التغطية.</span>
          </li>
        </ul>
      </div>
      )}

      {/* Deliverable format choices chips directly on the main card */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mut text-[12px]">صيغ التسليم المعتمدة:</span>
        {(quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "csv", "pdf"]).map((fmt) => (
          <span
            key={fmt}
            className="inline-flex items-center gap-1 rounded-full border border-ln bg-sf2 px-2.5 py-1 text-ink text-[12px] font-medium"
          >
            {FORMAT_LABEL[fmt] || "ملف بيانات"}
          </span>
        ))}
      </div>

      {/* Financial Guarantee & Accounting Clarity Box */}
      <div className="mt-3.5 rounded-xl border border-ln bg-sf2/70 p-3 text-xs leading-[1.8] text-mut">
        <p className="m-0 font-medium text-ink">التكلفة المتوقعة تشمل السجلات المطلوبة. بعد التسليم، يُخصم فقط مقابل السجلات المطابقة التي وصلت إليك.</p>
        {(primaryItem?.capabilitySlug?.includes("people") || quote.summaryAr?.includes("صناع") || quote.summaryAr?.includes("قرار") || quote.summaryAr?.includes("مسؤول") || quote.summaryAr?.includes("مدير")) && (
          <p className="m-0 mt-1.5 text-ink2 border-t border-ln pt-1.5">
            تنويه صناع القرار: تتضمن السجلات الأسماء والمسميات الوظيفية وروابط الملفات المهنية، مع توضيح ما إذا كان كل حقل موجودًا أو غير موجود في السجل. وجود البريد لا يعني التحقق من صحته. لا يُحاسب العميل على أي حقل غير متوفر.
          </p>
        )}
      </div>

      <p className="mb-0 mt-[14px] border-t border-ln pt-3 text-[13px] font-light leading-[1.9] text-ink2">
        المنهجية: {getCustomerMethodologyNote(isPeoplePlan, isCompanyPlan)}
      </p>

      {isEditing && !locked && (
        <div className="mt-4 space-y-3 rounded-[18px] bg-sf2 p-3.5 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label htmlFor={`pq-country-${quote.quoteId}`} className="mb-1 block font-medium text-ink">الدولة / النطاق الجغرافي</label>
              <input
                id={`pq-country-${quote.quoteId}`} type="text" value={editCountry} onChange={(e) => setEditCountry(e.target.value)} dir="auto"
                className="min-h-11 w-full rounded-xl border border-ln bg-sf px-3 text-sm font-light text-ink outline-none focus:border-ln2"
              />
            </div>
            {!isSocialContentPlan && <div>
              <label htmlFor={`pq-industry-${quote.quoteId}`} className="mb-1 block font-medium text-ink">{isPeoplePlan ? "نوع البحث" : "النشاط / التخصص الرئيسي"}</label>
              <input
                id={`pq-industry-${quote.quoteId}`} type="text" value={editIndustry} onChange={(e) => setEditIndustry(e.target.value)} dir="auto"
                className="min-h-11 w-full rounded-xl border border-ln bg-sf px-3 text-sm font-light text-ink outline-none focus:border-ln2"
              />
            </div>}
          </div>
          <div>
            <label htmlFor={`pq-param-${quote.quoteId}`} className="mb-1 block font-medium text-ink">{isPeoplePlan ? "الفئة المهنية" : isSocialContentPlan ? "موضوع المحتوى / الاستعلام" : "الكلمات المفتاحية / الاستعلام"}</label>
            <input
              id={`pq-param-${quote.quoteId}`} type="text" value={editParamVal} onChange={(e) => setEditParamVal(e.target.value)} dir="auto"
              className="min-h-11 w-full rounded-xl border border-ln bg-sf px-3 text-sm font-light text-ink outline-none focus:border-ln2"
            />
          </div>
          <div>
            <label htmlFor={`pq-limit-${quote.quoteId}`} className="mb-1 block font-medium text-ink">العدد الأقصى المطلوب (سجلات)</label>
            <input
              id={`pq-limit-${quote.quoteId}`} type="number" inputMode="numeric" min={1} max={10000} value={editLimit} onChange={(e) => setEditLimit(Number(e.target.value))}
              className="tnum min-h-11 w-full rounded-xl border border-ln bg-sf px-3 text-sm font-light text-ink outline-none focus:border-ln2"
            />
          </div>
          <div>
            <label className="mb-1 block font-medium text-ink">صيغ التسليم</label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="الصيغ">
              {["xlsx", "pdf", "csv"].map((f) => (
                <button
                  key={f} type="button" aria-pressed={editFormats.includes(f)} onClick={() => toggleFormat(f)}
                  className="min-h-10 cursor-pointer rounded-xl px-3.5 text-[13px] text-ink"
                  style={{ border: `1px solid ${editFormats.includes(f) ? "var(--gold)" : "var(--ln)"}`, background: editFormats.includes(f) ? "var(--sf)" : "transparent" }}
                >
                  {FORMAT_LABEL[f]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor={`pq-cap-${quote.quoteId}`} className="mb-1 block font-medium text-ink">حد أقصى للنقاط (اختياري)</label>
            <input
              id={`pq-cap-${quote.quoteId}`} type="text" inputMode="numeric" value={editCap} onChange={(e) => setEditCap(e.target.value)} dir="ltr"
              placeholder={formatAr(quote.quotedPoints)}
              className="tnum min-h-11 w-full rounded-xl border border-ln bg-sf px-3 text-sm font-light text-ink outline-none focus:border-ln2"
            />
            <p className="mb-0 mt-1 font-light leading-[1.8] text-mut">يتوقف الطلب عند هذا الحد، ولا يُخصم أكثر منه، ويُخصم فقط مقابل ما يُسلَّم.</p>
          </div>
          {editError && <p role="alert" className="m-0 text-xs text-bad">{editError}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => setIsEditing(false)} className="min-h-11 cursor-pointer border-0 bg-transparent px-3 text-xs text-mut">إلغاء</button>
            <button type="button" onClick={handleSave} disabled={savingEdit} className={`${PRIMARY_BTN} min-h-11 px-5 text-xs`}>
              {savingEdit ? "جاري التحديث..." : "حفظ التعديل"}
            </button>
          </div>
        </div>
      )}

      {!locked && low && !expired && (
        <div className="mt-[18px] flex flex-col gap-3 rounded-[18px] px-4 py-3.5" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)", animation: "up .4s both" }}>
          <p className="m-0 text-sm leading-[1.8] text-ink">
            رصيدك <strong>{pointsAr(balance, formatNumber)}</strong> — تحتاج <strong className="text-goldT">{pointsAr(shortPts, formatNumber)}</strong> إضافية لتنفيذ الحجم الكامل ({formatAr(quote.targetVolumeMax)} سجل).
          </p>
          {quote.downscaledOffer && (
            <p className="m-0 text-xs font-light leading-[1.8] text-ink">
              خيار فوري: يمكنك بدء البحث بعدد مخفض حتى <strong>{formatAr(quote.downscaledOffer.maxAffordableUnits)}</strong> سجل مقابل {pointsAr(quote.downscaledOffer.affordableQuotedPoints)} متوفرة في رصيدك.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onTopupShort(shortEgp)} className={`${PRIMARY_BTN} min-h-11 min-w-[180px] flex-1 text-[13px]`}>
              شحن الرصيد ({formatAr(shortEgp)} ج.م) والبدء
            </button>
            {quote.downscaledOffer && (
              <button
                type="button"
                data-testid="edit-plan-downscaled-btn"
                id={`edit-plan-downscaled-btn-${quote.quoteId}`}
                aria-label={`البدء بـ ${formatAr(quote.downscaledOffer.maxAffordableUnits)} سجل فقط`}
                onClick={() => onAcceptDownscaled && onAcceptDownscaled(quote.downscaledOffer!.maxAffordableUnits)}
                disabled={quote.isDependent}
                className={`${SECONDARY_BTN} min-h-11`}
              >
                البدء بـ {formatAr(quote.downscaledOffer.maxAffordableUnits)} سجل فقط
              </button>
            )}
            <button
              type="button"
              data-testid="edit-plan-btn"
              id={`edit-plan-btn-${quote.quoteId}`}
              aria-label={isEditing ? "إلغاء التعديل" : "تعديل خطة البحث"}
              onClick={handleOpenEdit}
              disabled={quote.isDependent}
              className={`${SECONDARY_BTN} min-h-11`}
            >
              {isEditing ? "إلغاء التعديل" : EDIT_PLAN_BTN_LABEL}
            </button>
          </div>
        </div>
      )}

      {!locked && approvalState.inactiveStatus && (
        <div role="status" className="mt-[18px] flex items-center rounded-[18px] bg-sf2 px-4 py-3.5">
          <p className="m-0 text-sm leading-[1.8] text-ink">
            {quote.status === "unknown"
              ? "تعذر التأكد من صلاحية عرض السعر. أعد تحميل المحادثة قبل الموافقة."
              : quote.status === "accepted"
                ? planApprovalNoteAr({ locked, status: quote.status, expiredByTime: false, planComplete })
                : "هذا العرض لم يعد صالحاً للموافقة. استخدم أحدث عرض سعر في هذه المحادثة."}
          </p>
        </div>
      )}

      {(() => {
        // The states that used to hide the button without a word: an incomplete plan, and a plan shown read-only beside a running request.
        const note = approvalState.inactiveStatus ? null : planApprovalNoteAr({ locked, status: quote.status, expiredByTime: baseApprovalState.expiredByTime, planComplete });
        return note ? <div role="status" data-testid="plan-approval-note" className="mt-[18px] flex items-center rounded-[18px] bg-sf2 px-4 py-3.5"><p className="m-0 text-sm leading-[1.8] text-ink">{note}</p></div> : null;
      })()}

      {!locked && approvalState.expiredByTime && !approvalState.inactiveStatus && (
        <div className="mt-[18px] flex flex-wrap items-center justify-between gap-3 rounded-[18px] bg-sf2 px-4 py-3.5" style={{ animation: "up .4s both" }}>
          <p className="m-0 text-sm leading-[1.8] text-ink">انتهت صلاحية عرض السعر. نحتاج تحديثه قبل الموافقة.</p>
          <button type="button" onClick={handleRefresh} disabled={refreshing} className={`${PRIMARY_BTN} min-h-11 whitespace-nowrap px-[18px] text-[13px]`}>
            {refreshing ? (
              <span className="h-4 w-4 rounded-full border-2 border-onac/30 border-t-onac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : null}
            تحديث السعر
          </button>
        </div>
      )}

      {!locked && !low && approvalState.canApprove && (
        <>
          <div className="mt-[18px] flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onStart(quote)}
              disabled={isStarting || quote.isDependent}
              className={`${PRIMARY_BTN} min-h-11 min-w-[200px] flex-1 text-[13px]`}
            >
              {isStarting ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-onac/30 border-t-onac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  جاري البدء...
                </>
              ) : (
                "أوافق وابدأ البحث"
              )}
            </button>
            <button
              type="button"
              data-testid="edit-plan-btn"
              id={`edit-plan-btn-${quote.quoteId}`}
              aria-label={isEditing ? "إلغاء التعديل" : "تعديل خطة البحث"}
              onClick={handleOpenEdit}
              disabled={quote.isDependent}
              className={`${SECONDARY_BTN} min-h-11`}
            >
              {isEditing ? "إلغاء التعديل" : EDIT_PLAN_BTN_LABEL}
            </button>
            {quote.explorationOffer && onExplore && !quote.exploration && (
              <button
                type="button"
                data-testid="explore-first-btn"
                onClick={() => void onExplore(quote)}
                disabled={isStarting || quote.isDependent}
                className={`${SECONDARY_BTN} min-h-11`}
              >
                عينة أولًا: {formatAr(quote.explorationOffer.sampleUnits)} سجل بحجز {pointsAr(quote.explorationOffer.samplePoints)}
              </button>
            )}
          </div>
          {quote.exploration && (
            <p className="mb-0 mt-3 text-xs font-light leading-[1.8] text-fnt">هذه عينة استكشافية من خطتك الأكبر ({formatAr(quote.exploration.fullVolume)} سجل). بعد اكتمالها نقدّر لك الحجم الكامل من أرقامها.</p>
          )}
          <p className="mb-0 mt-3 text-xs font-light leading-[1.8] text-fnt">بعد الموافقة يبدأ البحث، ويُخصم فقط مقابل السجلات المطابقة التي تم تسليمها.</p>
        </>
      )}
    </div>
  );
}
