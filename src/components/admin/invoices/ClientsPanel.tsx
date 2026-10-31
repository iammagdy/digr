"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { BTN, BTN_PRIMARY, Field, INPUT, SECTION } from "./ui";

export interface SavedClient { id: string; company: string; contact: string; email: string; phone: string; address: string; notes: string; archived: boolean }
const blank = { company: "", contact: "", email: "", phone: "", address: "", notes: "" };

/** Saved clients, reusable in documents. A document keeps its own copy of the text, so editing a client never changes a document already made. */
export function ClientsPanel() {
  const { toast } = useAdmin();
  const [clients, setClients] = useState<SavedClient[] | null>(null);
  const [form, setForm] = useState<{ id: string | null } & typeof blank>({ id: null, ...blank });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setClients((await adminFetch<{ clients: SavedClient[] }>("/api/admin/invoices/clients")).clients); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل العملاء"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { id, ...body } = form;
      await adminFetch(id ? `/api/admin/invoices/clients/${id}` : "/api/admin/invoices/clients", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
      toast("تم الحفظ");
      setForm({ id: null, ...blank });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setBusy(false); }
  };
  const archive = async (c: SavedClient, archived: boolean) => {
    try {
      await adminFetch(`/api/admin/invoices/clients/${c.id}`, { method: "PATCH", body: JSON.stringify({ company: c.company, contact: c.contact, email: c.email, phone: c.phone, address: c.address, notes: c.notes, archived }) });
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر التنفيذ"); }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="clients-panel">
      <form className={SECTION} onSubmit={submit}>
        <h2 className="m-0 text-base font-semibold text-ink">{form.id ? "تعديل عميل" : "عميل جديد"}</h2>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="اسم الشركة"><input className={INPUT} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} required /></Field>
          <Field label="المسؤول"><input className={INPUT} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></Field>
          <Field label="البريد الإلكتروني"><input className={INPUT} type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="الهاتف"><input className={INPUT} type="tel" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="العنوان"><input className={INPUT} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="ملاحظات داخلية (لا تظهر في الوثيقة)"><input className={INPUT} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BTN_PRIMARY} disabled={busy}>حفظ</button>
          {form.id ? <button type="button" className={BTN} onClick={() => setForm({ id: null, ...blank })}>إلغاء التعديل</button> : null}
        </div>
      </form>
      <section className={SECTION}>
        <h3 className="m-0 text-sm font-semibold text-ink">العملاء المحفوظون</h3>
        {error ? <p role="alert" className="m-0 text-[13px] text-bad">{error}</p> : null}
        {clients && clients.length === 0 ? <p className="m-0 text-[13px] text-mut">لا يوجد عملاء بعد.</p> : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {(clients ?? []).map((c) => (
            <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-ln p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">{c.company}{c.archived ? " (مؤرشف)" : ""}</div>
                <div className="truncate text-xs text-mut">{[c.contact, c.email, c.phone].filter(Boolean).join(" · ")}</div>
              </div>
              <button type="button" className={BTN} onClick={() => setForm({ id: c.id, company: c.company, contact: c.contact, email: c.email, phone: c.phone, address: c.address, notes: c.notes })}>تعديل</button>
              <button type="button" className={BTN} onClick={() => archive(c, !c.archived)}>{c.archived ? "استرجاع" : "أرشفة"}</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
