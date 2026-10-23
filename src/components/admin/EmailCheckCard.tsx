"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/adminApi";

const SECTION = "flex flex-col gap-3.5 rounded-[22px] border border-ln bg-sf p-[18px]";
const BUTTON = "min-h-[46px] cursor-pointer rounded-full border border-ln2 bg-transparent px-[18px] text-[13px] font-semibold text-ink disabled:opacity-60";

const KINDS: Array<{ kind: "completion" | "partial" | "failed" | "started"; label: string }> = [
  { kind: "completion", label: "أرسل لي رسالة «اكتمال»" },
  { kind: "partial", label: "أرسل لي رسالة «اكتمال جزئي»" },
  { kind: "failed", label: "أرسل لي رسالة «تعذّر الطلب»" },
  { kind: "started", label: "أرسل لي رسالة «بدء الطلب»" },
];

interface Diagnosis {
  config: { supabaseUrl: boolean; serviceRoleKey: boolean };
  function: { state: string; labelAr: string };
  driver: { mode: string };
  senderAr: string;
}

/** Admin only: whether customer e-mail works, and a test e-mail to the admin's OWN address. Shows reasons, never a secret. */
export default function EmailCheckCard() {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function diagnose() {
    setBusy(true);
    setMessage("");
    try {
      setDiagnosis(await adminFetch<Diagnosis>("/api/admin/email-check"));
    } catch (e: any) {
      setMessage(e?.message || "تعذّر الفحص");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(kind: string) {
    setBusy(true);
    setMessage("");
    try {
      const r = await adminFetch<{ success: boolean; subject?: string; reasonAr?: string }>("/api/admin/email-check", { method: "POST", body: JSON.stringify({ kind }) });
      setMessage(r.success ? `أُرسلت الرسالة إلى بريدك: «${r.subject ?? ""}»` : `لم تُرسل: ${r.reasonAr ?? "سبب غير معروف"}`);
    } catch (e: any) {
      setMessage(e?.message || "تعذّر الإرسال");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={SECTION} data-testid="email-check-card">
      <div><p className="m-0 text-[11px] text-fnt">email · diagnostics</p><h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">فحص البريد الإلكتروني للعملاء</h2></div>
      <p className="m-0 text-xs text-fnt">الرسائل التجريبية تصل إلى بريد حسابك أنت فقط، وتُبنى بالكود نفسه الذي يبني رسائل العملاء.</p>
      <button type="button" onClick={diagnose} disabled={busy} className={`${BUTTON} self-start`}>افحص الإعداد</button>
      {diagnosis && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="email-check-result">
          <li>{diagnosis.config.supabaseUrl ? "عنوان مشروع Supabase مضبوط في التطبيق." : "عنوان مشروع Supabase غير مضبوط في التطبيق."}</li>
          <li>{diagnosis.config.serviceRoleKey ? "مفتاح الخدمة مضبوط في التطبيق." : "مفتاح الخدمة غير مضبوط في التطبيق."}</li>
          <li>{diagnosis.function.labelAr}</li>
          <li>{diagnosis.senderAr}</li>
          <li>{diagnosis.driver.mode === "cron" ? "المنفّذ الدائم مفعّل: يمكن للعميل إغلاق الصفحة." : "المنفّذ الدائم غير مفعّل: يُطلب من العميل إبقاء الصفحة مفتوحة."}</li>
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => <button key={k.kind} type="button" onClick={() => sendTest(k.kind)} disabled={busy} className={BUTTON}>{k.label}</button>)}
      </div>
      {message && <p role="status" className="m-0 text-[13px] font-medium text-ink" data-testid="email-check-message">{message}</p>}
    </section>
  );
}
