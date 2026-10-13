"use client";

import { useRef, useState } from "react";
import { Functions, ID, Permission, Role, Storage } from "appwrite";
import { client, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { EG_MOBILE_RE, formatAr, isThreePartName, normalizeDigits, normalizePhone, normalizeSenderName } from "@/lib/arabicDigits";
import { compressReceipt } from "@/lib/receiptImage";
import { DATABASE_ID, RECEIPTS_BUCKET, TOPUPS_COLLECTION } from "@/lib/constants";
import { TOPUP_PRESETS_EGP } from "@/lib/pricing";
import type { TopupRecord } from "./types";

const storage = new Storage(client);
const functions = new Functions(client);
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];

const FIELD =
  "min-h-[58px] w-full rounded-[20px] border border-ln bg-bg px-5 text-base font-light text-ink outline-none transition-colors focus:border-ln2";

/** Design «اشحن عبر Instapay». Validation copy matches the design and the server's messages. */
export default function TopupForm({
  amount, onAmount, creditValue, ipa, onSubmitted, existingRefs, pendingCount, maxPending,
}: {
  amount: number;
  onAmount: (n: number) => void;
  creditValue: number;
  ipa: string | null;
  onSubmitted: (t: TopupRecord) => void;
  existingRefs: string[];
  pendingCount: number;
  maxPending: number;
}) {
  const { user } = useUser();
  const [sName, setSName] = useState("");
  const [sPhone, setSPhone] = useState("");
  const [ref, setRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const points = Math.floor(amount / creditValue);

  const copy = async () => {
    if (!ipa) return;
    try { await navigator.clipboard?.writeText(ipa); } catch { /* clipboard blocked */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    if (!ALLOWED.includes(f.type)) { setErr("صيغة الملف غير مدعومة. الصيغ المسموحة: PNG, JPG, PDF"); return; }
    const small = await compressReceipt(f);
    if (small.size > MAX_RECEIPT_BYTES) { setErr("حجم الإيصال يجب ألا يتجاوز 5 ميجابايت"); return; }
    setFile(small);
  };

  async function submit() {
    if (sending || !user) return;
    const reference = normalizeDigits(ref).trim();
    const name = normalizeSenderName(sName);
    const phone = normalizePhone(sPhone);
    if (!navigator.onLine) return setErr("أنت غير متصل بالإنترنت. لن يُرسل الطلب حتى يعود الاتصال.");
    if (!ipa) return setErr("الشحن غير متاح حاليًا — يرجى التواصل مع فريق الدعم.");
    if (!isThreePartName(name)) return setErr("اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي");
    if (!EG_MOBILE_RE.test(phone)) return setErr("رقم الموبايل غير صحيح — ١١ رقمًا يبدأ بـ 01");
    if (reference.length < 3) return setErr("رقم العملية مطلوب");
    if (!file) return setErr("صورة إيصال التحويل مطلوبة لمراجعة الطلب");
    if (existingRefs.includes(reference)) return setErr("رقم العملية مستخدم مسبقاً في طلب آخر.");
    if (pendingCount >= maxPending) return setErr(`لديك ${maxPending} طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.`);

    setSending(true);
    setErr("");
    try {
      const uploaded = await storage.createFile(RECEIPTS_BUCKET, ID.unique(), file, [Permission.read(Role.user(user.$id))]);
      const execution = await functions.createExecution(
        "submit-topup",
        JSON.stringify({ amountEgp: amount, reference, senderName: name, senderPhone: phone, receiptFileId: uploaded.$id }),
        false,
      );
      const res = JSON.parse(execution.responseBody || "{}");
      if (!res.success) throw new Error(res.error || "فشل إرسال طلب الشحن");
      const doc = await databases.getDocument(DATABASE_ID, TOPUPS_COLLECTION, res.topupId);
      setRef(""); setSName(""); setSPhone(""); setFile(null);
      onSubmitted(doc as unknown as TopupRecord);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "حدث خطأ أثناء إرسال طلب الشحن");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4 rounded-[22px] border border-ln bg-sf p-[18px]">
      <h2 className="m-0 text-[15px] font-semibold text-ink">اشحن عبر Instapay</h2>

      <div className="flex flex-wrap gap-2">
        {TOPUP_PRESETS_EGP.map((egp) => {
          const on = amount === egp;
          return (
            <button
              key={egp} type="button" onClick={() => onAmount(egp)} aria-pressed={on}
              className="flex min-h-16 min-w-[110px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] transition-all duration-[250ms]"
              style={{ border: `1px solid ${on ? "var(--ac)" : "var(--ln)"}`, background: on ? "var(--ac)" : "transparent", color: on ? "var(--onac)" : "var(--ink)" }}
            >
              <span className="text-lg font-medium">{formatAr(Math.floor(egp / creditValue))}</span>
              <span className="text-[11px] font-light opacity-75">{formatAr(egp)} ج.م</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2.5 rounded-[20px] bg-sf2 px-[18px] py-3.5">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-light text-fnt">عنوان الدفع اللحظي (IPA) · منصة Diger</p>
          <p className="mb-0 mt-1 truncate text-base text-ink" dir="ltr">{ipa ?? "—"}</p>
        </div>
        <button type="button" onClick={copy} disabled={!ipa} className="min-h-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf px-4 text-[13px] text-ink disabled:opacity-50">
          {copied ? "تم النسخ" : "نسخ"}
        </button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-mut">اسم المحوِّل الثلاثي (كما يظهر في إنستاباي)</span>
        <input type="text" autoComplete="name" value={sName} onChange={(e) => { setSName(e.target.value); setErr(""); }} placeholder="أحمد محمد علي" className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-mut">رقم الموبايل المحوَّل منه</span>
        <input type="tel" dir="ltr" inputMode="tel" autoComplete="tel" value={sPhone} onChange={(e) => { setSPhone(e.target.value); setErr(""); }} placeholder="01012345678" className={`${FIELD} text-left`} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] text-mut">رقم العملية المرجعي</span>
        <input
          type="text" dir="ltr" inputMode="numeric" value={ref} onChange={(e) => { setRef(e.target.value); setErr(""); }} placeholder="418290384729"
          className={`${FIELD} text-left`} style={{ borderColor: err ? "var(--bad)" : undefined }}
        />
      </label>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
      <button
        type="button" onClick={() => (file ? setFile(null) : fileRef.current?.click())}
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
        <p role="alert" className="-mt-1.5 mb-0 rounded-2xl px-4 py-3 text-[13px] leading-[1.8] text-bad" style={{ background: "color-mix(in oklab, var(--bad) 12%, transparent)", animation: "up .3s both" }}>{err}</p>
      )}

      <button
        type="button" onClick={submit} disabled={sending}
        className="min-h-[58px] cursor-pointer rounded-full border-0 bg-ac text-[15px] text-onac disabled:opacity-60"
      >
        {sending ? "جارٍ الإرسال…" : `إرسال طلب شحن ${formatAr(points)} نقطة`}
      </button>
      <p className="m-0 text-center text-xs font-light text-fnt">بعد التحويل، يراجع فريق الإدارة الرقم المرجعي ويعتمد الرصيد في محفظتك.</p>
    </div>
  );
}
