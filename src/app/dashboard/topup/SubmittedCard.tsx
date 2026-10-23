"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { formatDate, formatTime } from "@/lib/honestDisplay";
import { statusBadge, USER_STATUS, type TopupRecord } from "./types";

const OK = "var(--ok)", BAD = "var(--bad)", GOLD = "var(--gold)";

/** Design «تم استلام طلب الشحن بنجاح»: drawn check, 3 live steps, request details, status. */
export default function SubmittedCard({
  topup, creditValue, onBack, onContinue,
}: { topup: TopupRecord; creditValue: number; onBack: () => void; onContinue: () => void }) {
  const st = topup.status;
  /* approved: the points the ledger row recorded; never recomputed here, and never shown as ٠ when not known yet */
  const pts: number | null = st === "approved" ? (topup.credits && topup.credits > 0 ? topup.credits : null) : Math.floor(topup.amountEgp / creditValue);
  const ring = st === "rejected" ? BAD : st === "approved" ? OK : GOLD;
  const icon = st === "rejected" ? "M27 27 L49 49 M49 27 L27 49" : "M24 39 l10 10 l19 -21";
  const stepDef = st === "approved" ? [2, 2, 2] : st === "rejected" ? [2, 3, 0] : [2, 1, 0];
  const labels = ["تم الإرسال", st === "rejected" ? "مرفوض" : "مراجعة الإدارة", "إضافة النقاط"];
  const title = st === "approved" ? pts === null ? "تم اعتماد الطلب وإضافة النقاط" : `تم اعتماد الطلب وإضافة ${pointsAr(pts)}` : st === "rejected" ? "تم رفض طلب الشحن" : "تم استلام طلب الشحن بنجاح";
  const sub = st === "approved" ? "أُضيفت النقاط إلى رصيدك ويمكنك استخدامها في أبحاثك الآن." : st === "rejected" ? "راجع سبب الرفض وأرسل طلباً جديداً بإيصال تحويل صحيح ومكتمل." : "سيتم مراجعته واعتماد النقاط لمحفظتك فور التحقق.";
  const badge = statusBadge(st);
  const when = `${formatDate(topup.createdAt)}، ${formatTime(topup.createdAt)}`;
  const rows: Array<[string, string, "rtl" | "ltr"]> = [
    ["المبلغ المحوّل", `${formatAr(st === "approved" && topup.confirmedAmountEgp ? topup.confirmedAmountEgp : topup.amountEgp)} ج.م`, "rtl"],
    [st === "approved" ? "النقاط المضافة" : "النقاط المتوقعة", pts === null ? "—" : pointsAr(pts), "rtl"],
    ["اسم المحوِّل", topup.senderName || "—", "rtl"],
    ["رقم الموبايل", topup.senderPhone || "—", "ltr"],
    ["نوع الطلب", "شحن عبر إنستاباي", "rtl"],
    ["الإيصال", topup.receiptFileId ? "مرفق" : "بدون إيصال", "rtl"],
    ["تاريخ الطلب", when, "rtl"],
  ];

  return (
    <div
      data-topup-card="1"
      className="mt-12 flex flex-col items-center rounded-[30px] border border-ln bg-sf px-[22px] pb-6 pt-[30px] text-center"
      style={{ boxShadow: "var(--shadow)", animation: "up .6s both" }}
    >
      <div className="relative h-[76px] w-[76px]">
        <span className="absolute inset-0 rounded-full" style={{ border: `1px solid ${ring}`, animation: "ring 3s ease-out infinite" }} />
        <svg viewBox="0 0 76 76" width="76" height="76" className="block" aria-hidden="true">
          <circle cx="38" cy="38" r="36" fill="none" stroke={ring} strokeWidth="1.5" />
          <path d={icon} fill="none" stroke={ring} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ strokeDasharray: 60, strokeDashoffset: 60, animation: "drawCk .7s .25s cubic-bezier(.2,.7,.2,1) forwards" }} />
        </svg>
      </div>
      <h2 className="mb-0 mt-[18px] font-display text-[34px] font-medium leading-tight text-ink [text-wrap:balance]">{title}</h2>
      <p className="mb-0 mt-2 max-w-[380px] text-sm font-light leading-[1.9] text-mut [text-wrap:pretty]">{sub}</p>

      <ol className="mt-[22px] grid w-full list-none grid-cols-3 gap-1 p-0" aria-label="مراحل الطلب">
        {labels.map((label, i) => {
          const s = stepDef[i];
          const c = s === 3 ? BAD : s === 2 ? (st === "approved" ? OK : GOLD) : s === 1 ? GOLD : "var(--ln2)";
          return (
            <li key={label} className="flex flex-col items-center gap-2">
              <span
                className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-xs"
                style={{ border: `1.5px solid ${c}`, background: s >= 2 ? c : "transparent", color: s >= 2 ? "#fff" : c, animation: s === 1 ? "breathe 1.6s ease-in-out infinite" : "none" }}
              >
                {s === 3 ? "✕" : s === 2 ? "✓" : toArabicDigits(i + 1)}
              </span>
              <span className="text-xs leading-[1.5]" style={{ color: s ? "var(--ink)" : "var(--fnt)" }}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-[22px] w-full border-t border-ln text-right">
        {rows.map(([k, v, dir]) => (
          <div key={k} className="flex min-h-12 items-center justify-between gap-3 border-b border-ln text-sm">
            <span className="font-light text-mut">{k}</span>
            <span dir={dir} className="max-w-[240px] truncate font-medium text-ink font-mono" title={v}>{v.length > 24 ? v.slice(0, 20) + "…" : v}</span>
          </div>
        ))}
        <div className="flex min-h-12 items-center justify-between gap-3 text-sm">
          <span className="font-light text-mut">الحالة</span>
          <span className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: badge.bg, color: badge.fg }}>{USER_STATUS[st]}</span>
        </div>
        {st === "rejected" && topup.rejectReason && (
          <p className="mb-0 mt-3 text-xs leading-[1.7] text-bad">سبب الرفض: {topup.rejectReason}</p>
        )}
      </div>
      <p className="mb-0 mt-3.5 text-xs font-light leading-[1.8] text-fnt">النقاط النهائية تُحسب من المبلغ الذي يؤكده فريق الإدارة — نقطة لكل {formatAr(creditValue, 2)} ج.م.</p>
      <div className="mt-[18px] flex w-full flex-col gap-2">
        <button type="button" onClick={onBack} className="min-h-14 cursor-pointer rounded-full border-0 bg-ac text-[15px] text-onac">العودة للمحفظة</button>
        <button type="button" onClick={onContinue} className="min-h-[52px] cursor-pointer rounded-full border border-ln2 bg-transparent text-sm text-ink">متابعة البحث</button>
      </div>
    </div>
  );
}
