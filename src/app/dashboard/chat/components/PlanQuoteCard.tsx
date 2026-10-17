"use client";

import { useEffect, useState } from "react";
import { formatNumber } from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";
import { getQuoteApprovalState } from "@/lib/quoteApprovalState";
import { getCustomerMethodologyNote } from "@/lib/customerMethodology";

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
  requestedVolumeMax?: number;
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
  expiresAt: string;
  /** Loaded from plans_quotes when a saved conversation is restored. */
  status?: string;
  methodologyNotes?: string;
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
    newIndustry?: string
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

const FORMAT_LABEL: Record<string, string> = { xlsx: "ملف Excel", pdf: "ملف PDF", csv: "ملف بيانات نصي" };

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
  quote,
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
}: PlanQuoteCardProps) {
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
  const titleTopic = socialContentTopicFromTitle(conversationTitle);
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

  const approvalState = getQuoteApprovalState(quote.status, quote.expiresAt, now);
  const expired = !approvalState.canApprove;
  const balance = available ?? quote.userBalance;
  const low = available !== null ? available < quote.quotedPoints : !quote.isAffordable;
  const shortPts = Math.max(0, quote.quotedPoints - balance);
  const expectedPoints = quote.expectedPoints ?? Math.ceil(quote.unitPricePoints * quote.targetVolumeMax);
  const shortEgp = Math.max(50, Math.ceil((shortPts * creditValue) / 50) * 50);
  const formats = (quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf", "csv"]).map((f) => FORMAT_LABEL[f] ?? f.toUpperCase());

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
      await onSaveEdit(quote, editLimit, editParamVal, editFormats, editCountry, editIndustry);
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
      } else if (rawMsg.length > 0 && !rawMsg.includes("TypeError") && !rawMsg.includes("SyntaxError")) {
        safeMsg = rawMsg;
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
            ≈ {formatAr(Number((expectedPoints * creditValue).toFixed(2)))} ج.م {locked ? "" : `· رصيدك ${formatAr(balance)} نقطة`}
          </p>
        </div>
        <p className="m-0 text-left text-[13px] font-light leading-[1.9] text-mut">
          حتى {formatAr(quote.targetVolumeMax)} سجل<br />
          {!locked && !expired && expiryShort(quote.expiresAt, now) && <>{expiryShort(quote.expiresAt, now)}</>}
        </p>
      </div>

      {quote.pointsCapConstrained && (
        <p className="mb-0 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] leading-[1.8] text-amber-950">
          {quote.targetVolumeMax < (quote.requestedVolumeMax || quote.targetVolumeMax)
            ? `تم ضبط العدد من ${formatAr(quote.requestedVolumeMax || quote.targetVolumeMax)} إلى ${formatAr(quote.targetVolumeMax)} سجل حتى يظل السعر والحجز مع احتياطي التنفيذ ضمن سقف ${formatAr(quote.pointsCap || 600)} نقطة.`
            : `العدد المطلوب ${formatAr(quote.targetVolumeMax)} أشخاص يناسب سقف السعر. تم تحديد الحجز عند ${formatAr(quote.quotedPoints)} نقطة، ويشمل احتياطي التنفيذ ضمن سقف ${formatAr(quote.pointsCap || 600)} نقطة.`} يمكنك تقليل العدد أكثر إذا أردت.
        </p>
      )}

      {/* Interpreted Parameters: Country, Industry, Target Volume */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-ln bg-sf2/70 px-3 py-2 text-[12px]">
        <div className="flex items-center gap-1.5">
          <span className="text-mut">الدولة / النطاق:</span>
          <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink">
            {interpreted.countryAr}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-mut">{scopeLabel}</span>
          <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink">
            {displayIndustry}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-mut">العدد المطلوب:</span>
          <span className="rounded-md border border-ln bg-bg px-2 py-0.5 font-medium text-ink">
            حتى {formatAr(quote.targetVolumeMax)} سجل
          </span>
        </div>
      </div>

      {/* Execution Steps */}
      <div className="mt-3.5 space-y-2 rounded-xl border border-ln bg-sf2/40 p-3 text-[12.5px]">
        <p className="m-0 font-medium text-ink">خطوات التنفيذ المنهجية:</p>
        <ul className="m-0 list-inside space-y-1 pr-1 font-light text-ink2">
          <li className="flex items-start gap-2">
            <span className="text-ac font-bold">١.</span>
            <span>{isPeoplePlan
              ? `البحث عن صناع القرار والمهنيين في ${interpreted.countryAr} ضمن المصادر المتاحة.`
              : isSocialContentPlan
                ? `البحث عن ${isVideoPlan ? "الفيديوهات" : "المحتوى"} المنشور حول «${displayIndustry}» على المنصة المحددة.`
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

      {/* Deliverable format choices chips directly on the main card */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mut text-[12px]">صيغ التسليم المعتمدة:</span>
        {(quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "csv", "pdf"]).map((fmt) => (
          <span
            key={fmt}
            className="inline-flex items-center gap-1 rounded-full border border-ln bg-sf2 px-2.5 py-1 text-ink text-[12px] font-medium"
          >
            {FORMAT_LABEL[fmt] ?? fmt.toUpperCase()}
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
            رصيدك <strong>{formatNumber(balance)}</strong> نقطة — تحتاج <strong className="text-goldT">{formatNumber(shortPts)} نقطة</strong> إضافية لتنفيذ الحجم الكامل ({formatAr(quote.targetVolumeMax)} سجل).
          </p>
          {quote.downscaledOffer && (
            <p className="m-0 text-xs font-light leading-[1.8] text-ink">
              خيار فوري: يمكنك بدء البحث بعدد مخفض حتى <strong>{formatAr(quote.downscaledOffer.maxAffordableUnits)}</strong> سجل مقابل {formatAr(quote.downscaledOffer.affordableQuotedPoints)} نقطة متوفرة في رصيدك.
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
              : "هذا العرض لم يعد صالحاً للموافقة. استخدم أحدث عرض سعر في هذه المحادثة."}
          </p>
        </div>
      )}

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
          </div>
          <p className="mb-0 mt-3 text-xs font-light leading-[1.8] text-fnt">بعد الموافقة يبدأ البحث، ويُخصم فقط مقابل السجلات المطابقة التي تم تسليمها.</p>
        </>
      )}
    </div>
  );
}
