"use client";

import { stagesOfPlanQuote } from "@/lib/missionPanelContent";
import { X_ACCOUNT_FILTER_STEP_AR, pageChannelOfItem, socialFilterStepAr, socialSearchStepAr, xAccountOfItem, xAccountReadStepAr } from "@/lib/planMethodSteps";
import { RETIRED_QUOTE_AR } from "@/lib/chat/retiredQuoteCopy";
import { pointsAr } from "@/lib/pointsFormat";
import { useMemo } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { capacityReasonAr, volumeLimitStatementAr } from "@/lib/jobCaps";
import { defaultVolumeStatementAr, type DefaultNoun } from "@/lib/planDefaults";
import { socialTopicForDisplay } from "@/lib/socialTopicDisplay";
import { planApprovalNoteAr } from "@/lib/quoteApprovalState";
import { planScopeRows, scrubQuoteTexts } from "@/lib/quoteScopeGaps";
import { getCustomerMethodologyNote } from "@/lib/customerMethodology";
import { CUSTOMER_FORMAT_LABEL_AR } from "@/lib/customerFormatLabels";
import { withoutCsvFormat } from "@/lib/customerFiles";
import { missionStepsAr } from "@/lib/dependentSteps";
import { JOB_MAX_POINTS_CAP } from "@/lib/jobPointsCap";
import { balanceVerdictAr } from "@/lib/balanceVerdict";
import { chargeForUnits, pointsDisplay, pricePer100Points } from "@/lib/recordPricing";
import { CONTACT_AVAILABILITY_AR, CONTACT_EMAIL_BILLING_AR } from "@/lib/contactExpectation";
import { priceVsHoldLineAr, unitPriceLineAr } from "@/lib/planExplanation";
import { countPlainAr, planCountLineAr, planCountPartsAr } from "@/lib/planCounts";
import { customerFacingCapabilityLabel } from "@/lib/customerFacingRequestLabels";
import { planPdfLineAr } from "@/lib/methodologyOffer";

export interface PlanItem {
  capabilitySlug: string;
  /** The price of one record of this service, from the priced quote (set by the server). */
  unitPricePoints?: number;
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
  capacityCause?: "balance" | "daily" | "user";
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
  /** This plan answers the retry button: a NEW offer of the failed request's plan (set by the server), with the records it starts from. */
  retryOffer?: { reusedRows: number };
  /** The same plan as a recent completed request of this customer (set by the server): the card warns and offers the old result. */
  duplicateOf?: { jobId: string; conversationId: string | null; deliveredUnits: number; completedAt: string | null };
  /** One sentence (built by code): why the price per record or the title differs from the plan priced just before this one. */
  changeNoteAr?: string;
  /** One sentence: what the assistant understood from the request (built by code). */
  understoodAr?: string;
  /** A plan the model planner made (set by the server): its edit offers the volume, the formats and the points cap (validated and priced again by code), and up to three REAL sample rows are shown before approval. */
  modelPlanned?: boolean;
  sampleRows?: { columns: Array<{ key: string; titleAr: string }>; rows: Array<Record<string, unknown>> };
  /** The period a feed plan applies, why (a known event) and any date that was corrected. */
  window?: { labelAr: string; source: string; reasonAr?: string; noteAr?: string };
  /** How long the mission will take: a range written by code from real numbers (never a promise), labelled as an estimate. */
  duration?: { rangeAr: string; labelAr: string; driversAr: string; promiseAr: string; longNoteAr?: string; closePageAr?: string };
}

interface PlanQuoteCardProps {
  quote: PlanQuoteData;
  conversationTitle?: string;
  available: number | null;
  creditValue: number;
  /** The plan was approved and a run exists: show the quote read-only. */
  locked?: boolean;
  /** «افتح النتيجة القديمة»: open the earlier result of the same request instead of paying for it again. */
  onOpenPrevious?: (previous: { jobId: string; conversationId: string | null }) => void;
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

const SECONDARY_BTN =
  "cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-50";

import { extractParamDisplayString, extractInterpretedParameters, industryDisplayLabelAr, planActivityLabelAr, scopePartsAr, socialContentTopicFromTitle, valueOrEmpty } from "@/lib/planParameters";
export { extractParamDisplayString, extractInterpretedParameters };

/** Design «الخطة والسعر». The price, balance check and expiry all come from the server quote; nothing is computed here beyond display. */
export default function PlanQuoteCard({
  quote: storedQuote,
  conversationTitle = "",
  available,
  creditValue,
  locked = false,
  onOpenPrevious,
}: PlanQuoteCardProps) {
  const quote = useMemo(() => scrubQuoteTexts(storedQuote), [storedQuote]);
  const primaryItem = quote.items?.[0];
  const modelStages = stagesOfPlanQuote(quote as any);
  const capabilitySlug = (primaryItem?.capabilitySlug || "").toLowerCase();
  const isPeoplePlan = capabilitySlug.includes("people");
  const isCompanyPlan = /compan|b2b/.test(capabilitySlug);
  const isVideoPlan = /video|videos|tiktok|youtube|reels/.test(capabilitySlug);
  // A plan read from a page (its link or name is the channel): the sentences say the posts come from that page, never a topic search.
  const pageChannelOfPlan = pageChannelOfItem(primaryItem);
  // The posts of ONE X account («@handle»): the card names the account, never a topic.
  const xAccountOfPlan = xAccountOfItem(primaryItem);
  const isSocialContentPlan = isVideoPlan || /post|posts|social|instagram|facebook|reddit|twitter/.test(capabilitySlug);
  const interpreted = extractInterpretedParameters(primaryItem?.params, quote.summaryAr, isPeoplePlan);
  const initialParam = extractParamDisplayString(primaryItem?.params, quote.summaryAr, isPeoplePlan);
  // A social plan names its topic from its own parameters; the title (cut at fifty characters) is only a fallback, and a cut title is ignored.
  const titleTopic = isSocialContentPlan
    ? socialTopicForDisplay({ params: primaryItem?.params, conversationTitle, trending: primaryItem?.params?.trending === true })
    : socialContentTopicFromTitle(conversationTitle);
  // The country and the activity as sentences and fields use them: a missing one is empty (never the validation sentence «يلزم تحديد …»).
  const countryShown = valueOrEmpty(interpreted.countryAr);
  const displayIndustry = isPeoplePlan
    ? interpreted.industryAr
    : xAccountOfPlan
      ? xAccountOfPlan
      : isSocialContentPlan
      ? (titleTopic || initialParam || "الموضوع المطلوب")
      : planActivityLabelAr(primaryItem?.params) || valueOrEmpty(industryDisplayLabelAr(interpreted.industryAr));
  const scopeLabel = isPeoplePlan ? "نوع البحث:" : xAccountOfPlan ? "الحساب:" : isSocialContentPlan ? "موضوع المحتوى:" : "النشاط / التخصص:";
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
  const balance = available ?? quote.userBalance;
  const expectedPoints = quote.expectedPoints ?? chargeForUnits(quote.targetVolumeMax, quote.unitPricePoints);
  const formats = withoutCsvFormat(quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf", "csv"]).map((f) => FORMAT_LABEL[f] || "ملف بيانات");

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
        <p className="m-0 text-start text-[13px] font-light leading-[1.9] text-mut min-[520px]:text-end">
          {planCountLineAr(quote.items, quote.targetVolumeMax)}
        </p>
      </div>

      <p className="mb-0 mt-3 text-[12px] font-light leading-[1.9] text-ink2" data-testid="plan-price-vs-hold">
        {priceVsHoldLineAr({ targetVolumeMax: quote.targetVolumeMax, unitPricePoints: quote.unitPricePoints, expectedPoints, quotedPoints: quote.quotedPoints, severalServices: (quote.items?.length ?? 1) > 1 })}
      </p>

      {(quote.items?.length ?? 1) > 1 && quote.items?.some((item) => Number(item.unitPricePoints) > 0) ? (
        <p className="mb-0 mt-2 text-[12px] font-light leading-[1.9] text-mut" data-testid="plan-unit-price">
          {unitPriceLineAr(quote.items!, quote.unitPricePoints, customerFacingCapabilityLabel)}
        </p>
      ) : null}

      {quote.unitPricePoints > 0 && (quote.items?.length ?? 1) <= 1 ? (
        <p className="mb-0 mt-2 text-[12px] font-light leading-[1.9] text-mut" data-testid="plan-unit-price">
          سعر السجل الواحد حوالي {pointsAr(Number(pointsDisplay(quote.unitPricePoints)))}، أي {pointsAr(pricePer100Points(quote.unitPricePoints))} لكل ١٠٠ سجل (تقديري).
        </p>
      ) : null}

      {quote.understoodAr && (
        <p className="mb-0 mt-3 text-[13px] font-light leading-[1.9] text-ink" data-testid="plan-understood">{quote.understoodAr}</p>
      )}

      {quote.sampleRows && quote.sampleRows.rows.length > 0 && (
        <div className="mt-3 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9]" data-testid="plan-sample-rows">
          <p className="mb-1 mt-0 font-medium text-ink">نماذج حقيقية من البيانات (للاطلاع قبل الموافقة)</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-start">
              <thead>
                <tr>{quote.sampleRows.columns.map((c) => <th key={c.key} className="px-2 py-1 text-start font-medium text-ink2">{c.titleAr}</th>)}</tr>
              </thead>
              <tbody>
                {quote.sampleRows.rows.map((row, i) => (
                  <tr key={i}>{quote.sampleRows!.columns.map((c) => <td key={c.key} className="px-2 py-1 align-top font-light text-ink">{toArabicDigits(String(row[c.key] ?? ""))}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
          {volumeLimit} {capacityCut ? capacityReasonAr(quote.capacityCause) : quote.serviceCeilingUnits || quote.volumeLimitLineAr?.includes("هذا حدّ") ? "" : "يمكنك تقليل العدد أكثر إذا أردت."}
        </p>
      ) : quote.pointsCapConstrained && !defaultStatement ? (
        <p className="mb-0 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.8] text-amber-950">
          {quote.targetVolumeMax < (quote.requestedVolumeMax || quote.targetVolumeMax)
            ? `تم ضبط ${(quote.items?.length ?? 1) > 1 ? `الطلب إلى ${planCountPartsAr(quote.items)}` : `العدد من ${formatAr(quote.requestedVolumeMax || quote.targetVolumeMax)} إلى ${formatAr(quote.targetVolumeMax)} سجل`} حتى يظل السعر والحجز مع احتياطي التنفيذ ضمن سقف ${pointsAr(quote.pointsCap || JOB_MAX_POINTS_CAP)}.`
            : `العدد المطلوب ${formatAr(quote.targetVolumeMax)} أشخاص يناسب سقف السعر. تم تحديد الحجز عند ${pointsAr(quote.quotedPoints)}، ويشمل احتياطي التنفيذ ضمن سقف ${pointsAr(quote.pointsCap || JOB_MAX_POINTS_CAP)}.`}
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
          هذا هو الباقي من طلبك بعد العينة: {countPlainAr(quote.afterSample.remainingUnits, "records")} دون ما وصلك فيها ({countPlainAr(quote.afterSample.deliveredInSample, "records")}، خُصم عنها {pointsAr(quote.afterSample.sampleChargedPoints)}). الإجمالي التقريبي مع العينة حوالي {pointsAr(quote.afterSample.approximateTotalPoints)}.
        </p>
      )}

      <p data-testid="plan-balance-verdict" className="mb-0 mt-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9] text-ink2">
        {/* Enough balance: one short verdict (the hold and the charge are in the sentence above); not enough: the full verdict with the largest size that fits. */}
        {balance >= quote.quotedPoints ? `يكفي رصيدك (${pointsAr(balance)}).` : balanceVerdictAr({ balance, quotedPoints: quote.quotedPoints, expectedPoints, targetVolumeMax: quote.targetVolumeMax, downscaledOffer: quote.downscaledOffer })}
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

      {/* Which platform the plan covers and why (the customer named none), and the official channel / page the search found, for the customer to confirm by approving */}
      {typeof primaryItem?.params?._modelStep?.platformChoiceAr === "string" && primaryItem.params._modelStep.platformChoiceAr ? (
        <p className="mb-0 mt-3 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px] font-light text-ink2" data-testid="platform-choice">{primaryItem.params._modelStep.platformChoiceAr}</p>
      ) : null}
      {Array.isArray(primaryItem?.params?._modelStep?.foundEntities) && primaryItem.params._modelStep.foundEntities.length > 0 ? (
        <div className="mt-3 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px]" data-testid="found-entities">
          <p className="m-0 font-medium text-ink">لقينا:</p>
          <ul className="m-0 mt-1 list-none space-y-1 p-0 font-light text-ink2">
            {primaryItem.params._modelStep.foundEntities.map((e: any, i: number) => <li key={i}>{e.kindAr}: <span className="font-medium text-ink">{e.nameAr}</span> <span dir="ltr" className="text-mut">{e.id}</span></li>)}
          </ul>
          <p className="m-0 mt-1 text-[12px] text-mut">لو دي مش المقصودة، قل لنا قبل الموافقة وهنغيّرها.</p>
        </div>
      ) : null}

      {/* A channel mission (channels, then their top videos, then the comments) shows its own steps */}
      {modelStages ? (
        <div className="mt-3.5 space-y-2 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px]" data-testid="mission-stages">
          <p className="m-0 font-medium text-ink">مراحل المهمة:</p>
          <ol className="m-0 list-none space-y-1.5 p-0 font-light text-ink2">
            {modelStages.map((stage, i) => (
              <li key={i} className="flex items-start gap-2" data-testid="mission-stage-line">
                <span className="font-bold text-ac">{formatAr(i + 1)}.</span>
                <span>{stage.titleAr}{stage.effVolume > 0 ? ` — حتى ${formatAr(stage.effVolume)} ${stage.deliver ? "صفًا يصلك" : "صفًا تُستخدم في المرحلة التالية"}` : ""}{stage.askedPerParent && stage.perParent ? ` (${formatAr(stage.perParent)} لكل عنصر، لأن المصدر أعطى ذلك في العينة وليس ${formatAr(stage.askedPerParent)})` : ""}</span>
              </li>
            ))}
          </ol>
          <p className="m-0 text-[12px] text-ink2" data-testid="mission-stages-total">المجموع الذي يصلك: {formatAr(modelStages.reduce((n, stage) => n + (stage.deliver ? stage.effVolume : 0), 0))} صفًا.</p>
          <p className="m-0 text-[12px] text-mut">بعد الموافقة تتحوّل هذه المراحل إلى «خطة المهمة» وتتابع تقدّم كل مرحلة بنفسك.</p>
        </div>
      ) : Array.isArray(primaryItem?.params?.channels) && primaryItem.params.channels.length > 0 ? (
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
              ? `البحث عن صناع القرار والمهنيين${countryShown ? ` في ${countryShown}` : ""} ضمن المصادر المتاحة.`
              : xAccountOfPlan
                ? xAccountReadStepAr(xAccountOfPlan)
              : isSocialContentPlan
                ? socialSearchStepAr({ isVideoPlan, trending: primaryItem?.params?.trending === true, displayIndustry, countryAr: countryShown, pageChannel: pageChannelOfPlan })
                : (() => {
                    const scope = scopePartsAr(countryShown, displayIndustry);
                    return `استخراج السجلات الأولية من المصادر المتاحة${scope ? ` للنطاق المحدد (${scope})` : ""}.`;
                  })()}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">٢.</span>
            <span>{isPeoplePlan
              ? "تنظيم الأسماء والمسميات الوظيفية والبريد الإلكتروني المهني والهاتف المكتبي عند توافر كل حقل."
              : xAccountOfPlan
                ? X_ACCOUNT_FILTER_STEP_AR
              : isSocialContentPlan
                ? socialFilterStepAr({ pageChannel: pageChannelOfPlan, displayIndustry })
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
        {withoutCsvFormat(quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf"]).map((fmt) => (
          <span
            key={fmt}
            className="inline-flex items-center gap-1 rounded-full border border-ln bg-sf2 px-2.5 py-1 text-ink text-[12px] font-medium"
          >
            {FORMAT_LABEL[fmt] || "ملف بيانات"}
          </span>
        ))}
      </div>

      <p data-testid="plan-pdf-line" className="mb-0 mt-2 text-[12px] font-light leading-[1.9] text-mut">{planPdfLineAr(quote.outputFormats)}</p>

      {/* The decision-makers notice (the deduct-on-delivered sentence is not repeated here: it is said once, above). */}
      {(primaryItem?.capabilitySlug?.includes("people") || quote.summaryAr?.includes("صناع") || quote.summaryAr?.includes("قرار") || quote.summaryAr?.includes("مسؤول") || quote.summaryAr?.includes("مدير")) && (
        <div className="mt-3.5 rounded-xl border border-ln bg-sf2/70 p-3 text-xs leading-[1.8] text-mut">
          <p className="m-0 text-ink2">
            تنويه صناع القرار: تتضمن السجلات الأسماء والمسميات الوظيفية وروابط الملفات المهنية، مع توضيح ما إذا كان كل حقل موجودًا أو غير موجود في السجل. وجود البريد لا يعني التحقق من صحته. لا يُحاسب العميل على أي حقل غير متوفر. {CONTACT_AVAILABILITY_AR} {CONTACT_EMAIL_BILLING_AR}
          </p>
        </div>
      )}

      <p className="mb-0 mt-[14px] border-t border-ln pt-3 text-[13px] font-light leading-[1.9] text-ink2">
        المنهجية: {getCustomerMethodologyNote(isPeoplePlan, isCompanyPlan)}
      </p>

      {!locked && quote.retryOffer ? (
        <p data-testid="plan-retry-offer" className="mb-0 mt-3 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9] text-ink2">
          عرض جديد لإعادة المحاولة بنفس خطتك السابقة{quote.retryOffer.reusedRows > 0 ? `، وسيبدأ مما جُمع سابقًا (${formatAr(quote.retryOffer.reusedRows)} سجل)` : ""}. لا يبدأ شيء ولا يُحجز رصيد قبل موافقتك.
        </p>
      ) : null}

      {!locked && quote.duplicateOf && onOpenPrevious ? (
        <div data-testid="plan-duplicate-warning" role="status" className="mb-0 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.9] text-amber-950">
          <p className="m-0"><strong>عندك نفس الطلب ده.</strong> وصلتك نتيجته قبل كده ({countPlainAr(quote.duplicateOf.deliveredUnits, "records")})، وفتحها لا يكلّفك شيئًا.</p>
          <button type="button" data-testid="plan-duplicate-open" onClick={() => onOpenPrevious({ jobId: quote.duplicateOf!.jobId, conversationId: quote.duplicateOf!.conversationId })} className={`${SECONDARY_BTN} min-h-11`}>افتح النتيجة القديمة</button>
        </div>
      ) : null}

      {!locked && quote.changeNoteAr ? (
        <p data-testid="plan-change-note" className="mb-0 mt-3 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px] leading-[1.9] text-ink2">{quote.changeNoteAr}</p>
      ) : null}

      {quote.status === "accepted" ? (
        <p role="status" className="mb-0 mt-4 text-sm leading-[1.8] text-ink">
          {planApprovalNoteAr({ locked: false, status: "accepted", expiredByTime: false, planComplete: true })}
        </p>
      ) : !locked && (
        <p role="status" className="mb-0 mt-4 text-sm leading-[1.8] text-ink">{RETIRED_QUOTE_AR}</p>
      )}

    </div>
  );
}
