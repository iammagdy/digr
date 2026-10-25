"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { compressReceipt } from "@/lib/receiptImage";
import { TOPUP_ERROR_MESSAGES } from "@/lib/topupErrors";
import { showsInstapayShortcuts, TOPUP_DEFAULT_POINTS, TOPUP_MAX_POINTS, TOPUP_MIN_POINTS, TOPUP_PRESET_POINTS, topupReviewSentenceAr } from "@/lib/topupConfig";
import { egpClipboardText, egpDisplayAr, parseTopupPointsInput, pointsToEgp, topupAmountMessageAr, topupInputText, validateTopupPoints } from "@/lib/topupAmount";
import { topupStepsDone } from "@/lib/topupSteps";
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
  // UI only: the amount that was copied last; step ٢ shows as done while it is still the amount on the screen
  const [copiedAmount, setCopiedAmount] = useState<number | null>(null);
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
    setCopiedAmount(amountEgp);
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

  const stepDone = topupStepsDone({ amountValid: problem === null && points !== null, amountCopied: amountEgp !== null && copiedAmount === amountEgp, receiptAttached: file !== null });
  const submitLabel = sending
    ? "جارٍ الإرسال…"
    : problem !== null || points === null
      ? "اختر مبلغًا صالحًا"
      : file
        ? `إرسال طلب شحن ${pointsAr(points)}`
        : `أرفق الإيصال لإرسال ${pointsAr(points)}`;

  return (
    <section className="overflow-hidden rounded-[24px] border border-ln bg-sf">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-5 min-[480px]:px-6">
        <h2 className="m-0 text-[22px] font-bold text-ac">اشحن عبر إنستاباي</h2>
      </div>

      <div className="flex flex-col gap-3.5 px-4 pb-6 pt-5 min-[480px]:px-6">
        <StepHeader n={1} done={stepDone[0]} title="اختر عدد النقاط" />
        <div className="grid grid-cols-5 gap-2" data-testid="topup-presets">
          {TOPUP_PRESET_POINTS.map((preset) => {
            const on = !custom && presetPoints === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => { setCustom(false); setPresetPoints(preset); }}
                aria-pressed={on}
                className={PRESET_BUTTON}
                style={presetStyle(on)}
              >
                <span className="text-[15px] font-bold leading-[1.3] min-[480px]:text-[17px]">{formatAr(preset)}</span>
                <span className="whitespace-nowrap text-[10px] opacity-80 min-[480px]:text-xs">{egpDisplayAr(pointsToEgp(preset, creditValue))} ج.م</span>
              </button>
            );
          })}
          <button
            type="button"
            data-testid="topup-custom"
            onClick={() => setCustom(true)}
            aria-pressed={custom}
            className={PRESET_BUTTON}
            style={presetStyle(custom)}
          >
            <span className="text-[15px] font-bold leading-[1.3] min-[480px]:text-[17px]">أخرى</span>
            <span className="whitespace-nowrap text-[10px] opacity-80 min-[480px]:text-xs">مبلغ تختاره</span>
          </button>
        </div>

        {custom && (
          <div className="flex max-w-[360px] flex-col gap-1.5">
            <label htmlFor="topup-custom-points" className="text-[13px] text-mut">عدد النقاط</label>
            <div className="flex items-center rounded-xl border bg-bg px-3.5 transition-colors focus-within:border-ink2" style={{ borderColor: amountMessage ? "var(--bad)" : "var(--ln2)" }}>
              <input
                id="topup-custom-points"
                data-testid="topup-custom-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                value={customText}
                onChange={(e) => setCustomText(topupInputText(parseTopupPointsInput(e.target.value)))}
                aria-invalid={problem !== null && customText !== ""}
                className="min-h-12 min-w-0 flex-1 border-0 bg-transparent text-right text-lg font-semibold text-ink outline-none"
              />
              <span className="ps-2 text-[13px] text-mut">نقطة</span>
            </div>
            {!amountMessage && <p className="m-0 text-xs text-mut">{`من ${formatAr(TOPUP_MIN_POINTS)} إلى ${formatAr(TOPUP_MAX_POINTS)} نقطة · أرقام صحيحة فقط`}</p>}
          </div>
        )}

        {amountMessage && (
          <p data-testid="topup-amount-message" role="alert" className="m-0 text-xs leading-[1.8] text-bad">{amountMessage}</p>
        )}
      </div>

      <div className="flex flex-col gap-4 border-t border-ln px-4 py-6 min-[480px]:px-6">
        <StepHeader n={2} done={stepDone[1]} title="حوّل المبلغ من تطبيق إنستاباي" />
        <div className="flex flex-wrap items-stretch gap-4">
          <div className="flex min-w-0 flex-[3_1_320px] flex-col gap-3">
            <div data-testid="topup-egp-due" className="flex flex-wrap items-center justify-between gap-3.5 rounded-[18px] bg-sf2 px-[22px] py-5">
              <div>
                <p className="m-0 text-[13px] text-mut">ستحوّل</p>
                <p data-testid="topup-egp-due-text" className="m-0 text-[44px] font-bold leading-[1.15]" style={{ color: amountEgp === null ? "var(--fnt)" : "var(--ac)" }}>
                  {amountEgp === null ? "—" : `${egpDisplayAr(amountEgp)} جنيه`}
                </p>
                <p className="m-0 min-h-[1.5em] text-xs text-mut">{amountEgp !== null && points !== null ? `مقابل ${pointsAr(points)}` : ""}</p>
              </div>
              <button
                type="button"
                data-testid="topup-copy-amount"
                onClick={copyAmount}
                disabled={amountEgp === null}
                className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-5 text-sm font-semibold text-onac disabled:cursor-not-allowed disabled:opacity-50"
              >
                {amountCopied ? "تم النسخ" : "نسخ المبلغ"}
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-[18px] border border-ln px-[18px] py-3.5">
              <div className="min-w-0">
                <p className="m-0 text-xs text-mut">{paymentLabelAr || "عنوان الدفع اللحظي · منصة ديجر"}</p>
                {loadingIpa ? (
                  <p className="mb-0 mt-1 animate-pulse text-sm text-mut">جاري تحميل بيانات الدفع...</p>
                ) : ipa ? (
                  <p className="mb-0 mt-1 break-all font-mono text-base font-semibold text-ink min-[480px]:text-xl" dir="ltr">{ipa}</p>
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
                className="min-h-11 shrink-0 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-[13px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                {copied ? "تم النسخ" : "نسخ"}
              </button>
            </div>

            <p className="m-0 rounded-xl bg-warning-bg px-3.5 py-2.5 text-xs leading-[1.8] text-warning [text-wrap:pretty]">الرابط لا يحمل المبلغ — اكتب المبلغ المنسوخ بنفسك في إنستاباي قبل التأكيد.</p>
          </div>

          {showsInstapayShortcuts(ipa) && (
            <div className="min-w-0 flex-[2_1_240px]">
              <InstapayShortcuts />
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-ln px-4 py-6 min-[480px]:px-6">
        <StepHeader n={3} done={stepDone[2]} title="ارفع الإيصال وأرسل الطلب" />
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
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => (file ? setFile(null) : fileRef.current?.click())}
            className="flex min-h-14 min-w-0 flex-[1_1_240px] cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-[13px]"
            style={{
              border: `1px ${file ? "solid" : "dashed"} ${file ? "var(--ok)" : "var(--ln2)"}`,
              background: file ? "color-mix(in oklab, var(--ok) 10%, transparent)" : "transparent",
              color: file ? "var(--ink)" : "var(--mut)",
            }}
          >
            {file ? `✓ ${file.name} · اضغط للإزالة` : "+ صورة إيصال التحويل (مطلوب) · حتى ٥ م.ب"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={sending || problem !== null}
            data-testid="topup-submit"
            className="min-h-14 min-w-0 flex-[1_1_240px] cursor-pointer rounded-full border-0 bg-ac px-4 text-[15px] font-semibold text-onac"
            style={{ opacity: sending || problem !== null || !file ? 0.6 : 1 }}
          >
            {submitLabel}
          </button>
        </div>

        {err && (
          <p
            role="alert"
            className="m-0 rounded-2xl px-4 py-3 text-[13px] leading-[1.8] text-bad"
            style={{
              background: "color-mix(in oklab, var(--bad) 12%, transparent)",
              animation: "up .3s both",
            }}
          >
            {err}
          </p>
        )}

        <p data-testid="topup-review-time" className="m-0 text-xs font-light text-fnt">
          {topupReviewSentenceAr(reviewTimeAr)}
        </p>
      </div>
    </section>
  );
}

const PRESET_BUTTON = "flex min-h-16 min-w-0 cursor-pointer flex-col items-center justify-center rounded-[14px] px-1 py-2.5 transition-all duration-[250ms]";
const presetStyle = (on: boolean) => ({
  border: `1px solid ${on ? "var(--ac)" : "var(--ln2)"}`,
  background: on ? "var(--ac)" : "var(--sf)",
  color: on ? "var(--onac)" : "var(--ink)",
});

/** A numbered step of the top-up card: the circle is filled while the step is done (shown only; the server never reads it). */
function StepHeader({ n, done, title }: { n: number; done: boolean; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        data-testid={`topup-step-${n}`}
        data-done={done ? "true" : "false"}
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold ${done ? "bg-ac text-onac" : "bg-sf2 text-ink2"}`}
      >
        {toArabicDigits(n)}
      </span>
      <span className="text-base font-semibold text-ink">{title}</span>
    </div>
  );
}
