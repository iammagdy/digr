"use client";

import { useEffect, useState } from "react";
import { formatNumber } from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";

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
  quotedPoints: number;
  isAffordable: boolean;
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
  methodologyNotes?: string;
}

interface PlanQuoteCardProps {
  quote: PlanQuoteData;
  onStart: (quote: PlanQuoteData) => void;
  onSaveEdit: (quote: PlanQuoteData, newLimit: number, newParam: string, newFormats: string[]) => Promise<void>;
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

const FORMAT_LABEL: Record<string, string> = { xlsx: "Excel", pdf: "PDF", csv: "CSV" };

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

/** Design «الخطة والسعر». The price, balance check and expiry all come from the server quote; nothing is computed here beyond display. */
export default function PlanQuoteCard({
  quote,
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
  const initialParam = primaryItem?.params
    ? (primaryItem.params.query || primaryItem.params.keyword || primaryItem.params.topic || primaryItem.params.search || primaryItem.params.username || "")
    : "";
  const [editParamVal, setEditParamVal] = useState(initialParam);
  const [editFormats, setEditFormats] = useState<string[]>(quote.outputFormats || ["xlsx", "pdf", "csv"]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editError, setEditError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const expired = new Date(quote.expiresAt).getTime() <= now;
  const balance = available ?? quote.userBalance;
  const low = available !== null ? available < quote.quotedPoints : !quote.isAffordable;
  const shortPts = Math.max(0, quote.quotedPoints - balance);
  const shortEgp = Math.max(50, Math.ceil((shortPts * creditValue) / 50) * 50);
  const formats = (quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf", "csv"]).map((f) => FORMAT_LABEL[f] ?? f.toUpperCase());

  function toggleFormat(fmt: string) {
    if (editFormats.includes(fmt)) {
      if (editFormats.length > 1) setEditFormats(editFormats.filter((f) => f !== fmt));
    } else {
      setEditFormats([...editFormats, fmt]);
    }
  }

  async function handleSave() {
    setSavingEdit(true);
    setEditError("");
    try {
      await onSaveEdit(quote, editLimit, editParamVal, editFormats);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "فشل تحديث الخطة وعرض السعر");
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
          <p className="m-0 text-[34px] font-normal leading-none text-ink">
            {formatAr(quote.quotedPoints)}
            <span className="text-base text-mut" style={{ marginInlineStart: 8 }}>نقطة</span>
          </p>
          <p className="mb-0 mt-2 text-[13px] font-light text-mut">
            ≈ {formatAr(Number((quote.quotedPoints * creditValue).toFixed(2)))} ج.م {locked ? "" : `· رصيدك ${formatNumber(balance)} نقطة`}
          </p>
        </div>
        <p className="m-0 text-left text-[13px] font-light leading-[1.9] text-mut">
          حتى {formatAr(quote.targetVolumeMax)} سجل<br />
          {formats.join(" · ")}
          {!locked && !expired && expiryShort(quote.expiresAt, now) && <><br />{expiryShort(quote.expiresAt, now)}</>}
        </p>
      </div>

      <p className="mb-0 mt-[18px] border-t border-ln pt-4 text-[13px] font-light leading-[1.9] text-ink2">
        المنهجية: جمع البيانات العامة المتاحة للحساب فقط، مع توثيق تاريخ الجمع وفصل المطلوب عن المجمَّع فعليًا.
      </p>

      {isEditing && !locked && (
        <div className="mt-4 space-y-3 rounded-[18px] bg-sf2 p-3.5 text-xs">
          <div>
            <label htmlFor={`pq-param-${quote.quoteId}`} className="mb-1 block font-medium text-ink">الهدف المستهدف</label>
            <input
              id={`pq-param-${quote.quoteId}`} type="text" value={editParamVal} onChange={(e) => setEditParamVal(e.target.value)} dir="auto"
              className="min-h-11 w-full rounded-full border border-ln bg-sf px-4 text-base font-light text-ink outline-none focus:border-ln2"
            />
          </div>
          <div>
            <label htmlFor={`pq-limit-${quote.quoteId}`} className="mb-1 block font-medium text-ink">الحد الأقصى للسجلات</label>
            <input
              id={`pq-limit-${quote.quoteId}`} type="number" inputMode="numeric" min={1} max={10000} value={editLimit} onChange={(e) => setEditLimit(Number(e.target.value))}
              className="tnum min-h-11 w-full rounded-full border border-ln bg-sf px-4 text-base font-light text-ink outline-none focus:border-ln2"
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="الصيغ">
            {["xlsx", "pdf", "csv"].map((f) => (
              <button
                key={f} type="button" aria-pressed={editFormats.includes(f)} onClick={() => toggleFormat(f)}
                className="min-h-11 cursor-pointer rounded-full px-3.5 text-[13px] text-ink"
                style={{ border: `1px solid ${editFormats.includes(f) ? "var(--gold)" : "var(--ln)"}`, background: editFormats.includes(f) ? "var(--sf)" : "transparent" }}
              >
                {FORMAT_LABEL[f]}
              </button>
            ))}
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
            <button
              type="button"
              onClick={() => (quote.downscaledOffer && onAcceptDownscaled ? onAcceptDownscaled(quote.downscaledOffer.maxAffordableUnits) : setIsEditing(true))}
              disabled={quote.isDependent && !quote.downscaledOffer}
              className={`${SECONDARY_BTN} min-h-11`}
            >
              {quote.downscaledOffer ? `البدء بـ ${formatAr(quote.downscaledOffer.maxAffordableUnits)} سجل فقط` : "تعديل عدد السجلات"}
            </button>
          </div>
        </div>
      )}

      {!locked && expired && (
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

      {!locked && !low && !expired && (
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
            <button type="button" onClick={() => setIsEditing((v) => !v)} disabled={quote.isDependent} className={`${SECONDARY_BTN} min-h-11`}>
              {isEditing ? "إلغاء التعديل" : "تعديل"}
            </button>
          </div>
          <p className="mb-0 mt-3 text-xs font-light leading-[1.8] text-fnt">بالموافقة سيُحجز المبلغ تقديريًا — ولا يُخصم النهائي إلا بعد تسليم السجلات.</p>
        </>
      )}
    </div>
  );
}
