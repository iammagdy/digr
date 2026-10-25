"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { formatAr } from "@/lib/arabicDigits";
import { compressReceipt } from "@/lib/receiptImage";
import { TOPUP_ERROR_MESSAGES } from "@/lib/topupErrors";
import { showsInstapayShortcuts, TOPUP_DEFAULT_POINTS, TOPUP_PRESET_POINTS, topupReviewSentenceAr } from "@/lib/topupConfig";
import { egpClipboardText, egpDueAr, egpDisplayAr, parseTopupPointsInput, pointsToEgp, topupAmountMessageAr, topupInputText, validateTopupPoints } from "@/lib/topupAmount";
import { InstapayShortcuts } from "./InstapayShortcuts";
import type { TopupRecord } from "./types";

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];

/** Design «اشحن عبر إنستاباي». Only amount preset and receipt image upload required. */
export default function TopupForm({
  initialPoints,
  creditValue,
  ipa,
  loadingIpa = false,
  ipaLoadFailed = false,
  onSubmitted,
  pendingCount,
  maxPending,
  reviewTimeAr,
  paymentLabelAr,
}: {
  /** A number of points to start from (the chat's «اشحن الفرق» link): a preset selects it, any other number opens the free amount. */
  initialPoints?: number;
  creditValue: number;
  ipa: string | null;
  loadingIpa?: boolean;
  ipaLoadFailed?: boolean;
  onSubmitted: (t: TopupRecord) => void;
  pendingCount: number;
  maxPending: number;
  /** The review time from the public settings, when the owner set one. */
  reviewTimeAr?: string | null;
  /** The label above the payment address, when the owner set one in the public settings. */
  paymentLabelAr?: string | null;
  existingRefs?: string[];
}) {
  const { user } = useUser();
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [amountCopied, setAmountCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // the amount: a preset, or the free amount («أخرى») typed as digits; the points are null while the box is empty
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState("");
  const [presetPoints, setPresetPoints] = useState<number>(TOPUP_DEFAULT_POINTS);
  useEffect(() => {
    if (!initialPoints || !Number.isFinite(initialPoints) || initialPoints <= 0) return;
    const whole = Math.round(initialPoints);
    if ((TOPUP_PRESET_POINTS as readonly number[]).includes(whole)) { setCustom(false); setPresetPoints(whole); }
    else { setCustom(true); setCustomText(topupInputText(whole)); }
  }, [initialPoints]);
  const points: number | null = custom ? parseTopupPointsInput(customText) : presetPoints;
  const problem = validateTopupPoints(points);
  const amountEgp = problem === null && points !== null ? pointsToEgp(points, creditValue) : null;
  // a message only once something was typed: an empty free amount just keeps the button off
  const amountMessage = problem && (custom ? customText !== "" : true) ? topupAmountMessageAr(problem, creditValue) : "";

  const copyAmount = async () => {
    if (amountEgp === null) return;
    try {
      await navigator.clipboard?.writeText(egpClipboardText(amountEgp));
    } catch {
      /* clipboard blocked */
    }
    setAmountCopied(true);
    setTimeout(() => setAmountCopied(false), 1800);
  };

  const copy = async () => {
    if (!ipa) return;
    try {
      await navigator.clipboard?.writeText(ipa);
    } catch {
      /* clipboard blocked */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    if (!ALLOWED.includes(f.type)) {
      setErr(TOPUP_ERROR_MESSAGES.file_invalid_type);
      return;
    }
    const small = await compressReceipt(f);
    if (small.size > MAX_RECEIPT_BYTES) {
      setErr(TOPUP_ERROR_MESSAGES.file_oversized);
      return;
    }
    setFile(small);
  };

  async function submit() {
    if (sending || !user) return;
    if (!navigator.onLine) {
      return setErr(TOPUP_ERROR_MESSAGES.network_offline);
    }
    if (!file) {
      return setErr(TOPUP_ERROR_MESSAGES.receipt_missing);
    }
    if (!ipa) {
      return setErr(TOPUP_ERROR_MESSAGES.payment_details_not_configured);
    }
    if (amountEgp === null) {
      return setErr(amountMessage || topupAmountMessageAr("invalid", creditValue));
    }
    if (pendingCount >= maxPending) {
      return setErr(`لديك ${formatAr(maxPending)} طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.`);
    }

    setSending(true);
    setErr("");
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop() || "png";
      const receiptFileId = `${user.id}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("receipts")
        .upload(receiptFileId, file, { contentType: file.type, upsert: true });

      if (uploadErr) {
        throw new Error("تعذر رفع إيصال التحويل: " + uploadErr.message);
      }

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/topup/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          amountEgp,
          receiptFileId,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || TOPUP_ERROR_MESSAGES.server_error);
      }

      const doc: TopupRecord = {
        $id: data.topupId,
        id: data.topupId,
        amountEgp,
        reference: data.reference || `rcpt_${data.topupId}`,
        senderName: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "عميل ديجر",
        senderPhone: user.user_metadata?.phone || "غير مسجل",
        receiptFileId,
        status: "pending",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        rejectReason: null,
        credits: null,
      };

      setFile(null);
      onSubmitted(doc);
    } catch (e) {
      setErr(e instanceof Error ? e.message : TOPUP_ERROR_MESSAGES.server_error);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4 rounded-[22px] border border-ln bg-sf p-[18px]">
      <h2 className="m-0 text-[15px] font-semibold text-ink">اشحن عبر إنستاباي</h2>

      <div className="flex flex-wrap gap-2" data-testid="topup-presets">
        {TOPUP_PRESET_POINTS.map((preset) => {
          const on = !custom && presetPoints === preset;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => { setCustom(false); setPresetPoints(preset); }}
              aria-pressed={on}
              className="flex min-h-16 min-w-[110px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] transition-all duration-[250ms]"
              style={{
                border: `1px solid ${on ? "var(--ac)" : "var(--ln)"}`,
                background: on ? "var(--ac)" : "transparent",
                color: on ? "var(--onac)" : "var(--ink)",
              }}
            >
              <span className="text-lg font-medium">{formatAr(preset)}</span>
              <span className="text-[11px] font-light opacity-75">{egpDisplayAr(pointsToEgp(preset, creditValue))} ج.م</span>
            </button>
          );
        })}
        <button
          type="button"
          data-testid="topup-custom"
          onClick={() => setCustom(true)}
          aria-pressed={custom}
          className="flex min-h-16 min-w-[110px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] transition-all duration-[250ms]"
          style={{
            border: `1px solid ${custom ? "var(--ac)" : "var(--ln)"}`,
            background: custom ? "var(--ac)" : "transparent",
            color: custom ? "var(--onac)" : "var(--ink)",
          }}
        >
          <span className="text-lg font-medium">أخرى</span>
        </button>
      </div>

      {custom && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-mut">عدد النقاط</span>
          <input
            data-testid="topup-custom-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            value={customText}
            onChange={(e) => setCustomText(topupInputText(parseTopupPointsInput(e.target.value)))}
            aria-invalid={problem !== null && customText !== ""}
            className="min-h-14 w-full rounded-[18px] border border-ln bg-bg px-[18px] text-right text-lg text-ink outline-none transition-colors focus:border-ln2"
          />
        </label>
      )}

      {amountMessage && (
        <p data-testid="topup-amount-message" role="alert" className="-mt-1 mb-0 text-[13px] leading-[1.8] text-bad">{amountMessage}</p>
      )}

      {amountEgp !== null && (
        <div data-testid="topup-egp-due" className="flex flex-col gap-2 rounded-[20px] bg-sf2 px-[18px] py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <p data-testid="topup-egp-due-text" className="m-0 text-[26px] font-semibold leading-[1.4] text-ink">{egpDueAr(amountEgp)}</p>
            <button
              type="button"
              data-testid="topup-copy-amount"
              onClick={copyAmount}
              className="min-h-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf px-4 text-[13px] text-ink"
            >
              {amountCopied ? "تم النسخ" : "نسخ المبلغ"}
            </button>
          </div>
          <p className="m-0 text-xs font-light leading-[1.8] text-mut">اكتب هذا المبلغ بنفسك عند التحويل؛ رابط إنستاباي لا يحمل المبلغ.</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2.5 rounded-[20px] bg-sf2 px-[18px] py-3.5">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-light text-fnt">{paymentLabelAr || "عنوان الدفع اللحظي · منصة ديجر"}</p>
          {loadingIpa ? (
            <p className="mb-0 mt-1 animate-pulse text-sm text-mut">جاري تحميل بيانات الدفع...</p>
          ) : ipa ? (
            <p className="mb-0 mt-1 truncate text-base text-ink" dir="ltr">{ipa}</p>
          ) : ipaLoadFailed ? (
            <p role="alert" className="mb-0 mt-1 text-sm text-bad">تعذر تحميل بيانات الدفع الآن. أعد تحميل الصفحة أو تواصل مع الدعم.</p>
          ) : (
            <p className="mb-0 mt-1 text-sm text-mut">بيانات الدفع قيد التهيئة حالياً — يرجى التواصل مع فريق الدعم</p>
          )}
        </div>
        <button
          type="button"
          onClick={copy}
          disabled={loadingIpa || !ipa}
          className="min-h-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf px-4 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? "تم النسخ" : "نسخ"}
        </button>
      </div>

      {showsInstapayShortcuts(ipa) && <InstapayShortcuts />}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => (file ? setFile(null) : fileRef.current?.click())}
        className="flex min-h-[58px] cursor-pointer items-center justify-center gap-2 rounded-[20px] text-[13px] font-light"
        style={{
          border: `1px ${file ? "solid" : "dashed"} var(--ln2)`,
          background: file ? "color-mix(in oklab, var(--gold) 10%, transparent)" : "transparent",
          color: file ? "var(--ink)" : "var(--mut)",
        }}
      >
        {file ? `✓ ${file.name} · اضغط للإزالة` : "+ صورة إيصال التحويل (مطلوب) · حتى ٥ م.ب"}
      </button>

      {err && (
        <p
          role="alert"
          className="-mt-1.5 mb-0 rounded-2xl px-4 py-3 text-[13px] leading-[1.8] text-bad"
          style={{
            background: "color-mix(in oklab, var(--bad) 12%, transparent)",
            animation: "up .3s both",
          }}
        >
          {err}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={sending || problem !== null}
        className="min-h-[58px] cursor-pointer rounded-full border-0 bg-ac text-[15px] text-onac disabled:opacity-60"
      >
        {sending ? "جارٍ الإرسال…" : problem === null && points !== null ? `إرسال طلب شحن ${pointsAr(points)}` : "إرسال طلب شحن"}
      </button>
      <p data-testid="topup-review-time" className="m-0 text-center text-xs font-light text-fnt">
        {topupReviewSentenceAr(reviewTimeAr)}
      </p>
    </div>
  );
}
