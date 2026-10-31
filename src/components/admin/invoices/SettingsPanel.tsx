"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { BTN_PRIMARY, Field, INPUT, SECTION } from "./ui";

interface Settings { seller: { name: string; email: string; website: string; taxNumber: string; commercialRegister: string }; instapayAddress: string }

/** The seller text on every document. The tax and register lines print only when filled. The Instapay address is read from the payment settings (not edited here). */
export function SettingsPanel() {
  const { toast } = useAdmin();
  const [form, setForm] = useState<Settings["seller"] | null>(null);
  const [ipa, setIpa] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const r = await adminFetch<Settings>("/api/admin/invoices/settings"); setForm(r.seller); setIpa(r.instapayAddress); }
    catch (e) { toast(e instanceof Error ? e.message : "تعذّر التحميل"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  if (!form) return <p className="text-[13px] text-mut">جارٍ التحميل…</p>;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adminFetch("/api/admin/invoices/settings", { method: "PUT", body: JSON.stringify({ sellerName: form.name, sellerEmail: form.email, sellerWebsite: form.website, sellerTaxNumber: form.taxNumber, sellerCommercialRegister: form.commercialRegister }) });
      toast("تم الحفظ");
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setBusy(false); }
  };
  return (
    <form className={SECTION} onSubmit={save} data-testid="invoice-settings-panel">
      <h2 className="m-0 text-base font-semibold text-ink">بيانات البائع في الوثائق</h2>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">تظهر في رأس كل وثيقة وتذييلها. الوثائق المرسلة سابقًا لا تتغير.</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="الاسم"><input className={INPUT} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="البريد الإلكتروني"><input className={INPUT} dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="الموقع"><input className={INPUT} dir="ltr" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
        <Field label="الرقم الضريبي (اختياري، يُطبع إن وُجد)"><input className={INPUT} value={form.taxNumber} onChange={(e) => setForm({ ...form, taxNumber: e.target.value })} /></Field>
        <Field label="السجل التجاري (اختياري، يُطبع إن وُجد)"><input className={INPUT} value={form.commercialRegister} onChange={(e) => setForm({ ...form, commercialRegister: e.target.value })} /></Field>
      </div>
      <p className="m-0 text-xs leading-6 text-mut">عنوان إنستا باي المحفوظ في إعدادات الدفع: <span dir="ltr">{ipa || "—"}</span>. يُنسخ إلى كل مسودة عند حفظها، ولا يُعدَّل من هنا.</p>
      <div><button type="submit" className={BTN_PRIMARY} disabled={busy}>حفظ</button></div>
    </form>
  );
}
