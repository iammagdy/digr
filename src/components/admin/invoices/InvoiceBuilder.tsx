"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { todayCairo } from "@/lib/invoices/dates";
import { emptyForm, emptyLine, formFromDoc, formToInput, formToPreview, newKey, type DocForm } from "@/lib/invoices/form";
import { fmtDateAr, fmtEgp, fmtInt, fmtNumber, fmtPoints, fmtUsd } from "@/lib/invoices/format";
import { CONFIRM_AR, DOC_TYPE_AR, STATUS_AR } from "@/lib/invoices/labels";
import { formatScaled } from "@/lib/invoices/money";
import { buildSheetModel } from "@/lib/invoices/sheetModel";
import { totalsForDoc } from "@/lib/invoices/totals";
import type { DocStatus, DocType, DocView, SellerBlock, StatusEvent } from "@/lib/invoices/types";
import { showsInstapayShortcuts } from "@/lib/topupConfig";
import type { SavedClient } from "./ClientsPanel";
import { InvoiceExport } from "./InvoiceSheet";
import { BTN, BTN_DANGER, BTN_PRIMARY, ConfirmDialog, Field, INPUT, SECTION, StatusChip } from "./ui";

interface ItemType { id: string; nameAr: string; unitCc: number; isActive: boolean }
interface Meta { seller: SellerBlock; lastRateE4: number | null; instapayAddress: string; creditValueE4: number; defaultPaymentInstructions: string }
interface Loaded { doc: DocView; events: StatusEvent[]; seller: SellerBlock }

/**
 * The document builder: client, display currencies and rate, batches and lines (hide / summary only), discount, tax, notes, payment text, then the
 * live sheet with print and PNG. A draft is edited freely; after «مرسلة» the whole form is read-only (the database refuses changes too).
 * Nothing here reads or writes the wallet: sending or paying only changes the document's own status.
 */
export function InvoiceBuilder({ id, initialType }: { id?: string; initialType?: DocType }) {
  const { toast } = useAdmin();
  const router = useRouter();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [types, setTypes] = useState<ItemType[]>([]);
  const [clients, setClients] = useState<SavedClient[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<DocForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "sent" | "paid" | "void">(null);
  const [paidAt, setPaidAt] = useState(todayCairo());
  const [paidRef, setPaidRef] = useState("");
  const [showExport, setShowExport] = useState(false);

  const status: DocStatus = loaded?.doc.status ?? "draft";
  const locked = status !== "draft";

  const loadDoc = useCallback(async () => {
    if (!id) return;
    try {
      const r = await adminFetch<Loaded>(`/api/admin/invoices/${id}`);
      setLoaded(r); setForm(formFromDoc(r.doc)); setDirty(false); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل الوثيقة"); }
  }, [id]);

  useEffect(() => {
    (async () => {
      try {
        const [m, t, c] = await Promise.all([
          adminFetch<Meta>("/api/admin/invoices/settings"),
          adminFetch<{ types: ItemType[] }>("/api/admin/invoices/types"),
          adminFetch<{ clients: SavedClient[] }>("/api/admin/invoices/clients"),
        ]);
        setMeta(m); setTypes(t.types.filter((x) => x.isActive)); setClients(c.clients.filter((x) => !x.archived));
        if (!id) setForm(emptyForm(initialType ?? "invoice", todayCairo(), { rateE4: m.lastRateE4, payment: m.defaultPaymentInstructions }));
      } catch (e) { setError(e instanceof Error ? e.message : "تعذّر التحميل"); }
    })();
    void loadDoc();
  }, [id, initialType, loadDoc]);

  const set = (patch: Partial<DocForm>) => { setForm((f) => (f ? { ...f, ...patch } : f)); setDirty(true); };

  const doc = useMemo<DocView | null>(() => {
    if (!form || !meta) return null;
    if (locked && loaded) return loaded.doc;
    return formToPreview(form, { id: loaded?.doc.id ?? null, number: loaded?.doc.number ?? "", status, revision: loaded?.doc.revision ?? 1, creditValueE4: loaded?.doc.creditValueE4 ?? meta.creditValueE4, instapayAddress: loaded?.doc.instapayAddress ?? meta.instapayAddress });
  }, [form, meta, loaded, locked, status]);
  const totals = useMemo(() => (doc ? totalsForDoc(doc) : null), [doc]);
  const model = useMemo(() => (doc && meta ? buildSheetModel(doc, loaded?.seller ?? meta.seller) : null), [doc, meta, loaded]);

  if (!form || !meta || !doc || !totals || !model) {
    return error ? <p role="alert" className="text-[13px] text-bad">{error}</p> : <p className="text-[13px] text-mut">جارٍ التحميل…</p>;
  }

  const eligibleQr = showsInstapayShortcuts(doc.instapayAddress);

  // ----- actions -----
  const save = async (): Promise<{ id: string; revision: number } | null> => {
    const r = formToInput(form);
    if (!r.ok) { setError(r.error); return null; }
    setError("");
    if (!loaded) {
      const res = await adminFetch<{ id: string }>("/api/admin/invoices", { method: "POST", body: JSON.stringify({ docType: form.docType, ...r.input }) });
      return { id: res.id, revision: 1 };
    }
    const res = await adminFetch<{ revision: number }>(`/api/admin/invoices/${loaded.doc.id}`, { method: "PUT", body: JSON.stringify({ ...r.input, expectedRevision: loaded.doc.revision }) });
    return { id: loaded.doc.id as string, revision: res.revision };
  };

  const onSave = async () => {
    setBusy(true);
    try {
      const saved = await save();
      if (!saved) return;
      toast("تم حفظ المسودة");
      if (!loaded) router.replace(`/admin/invoices/${saved.id}`); else await loadDoc();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setBusy(false); }
  };

  const changeStatus = async (to: "sent" | "paid" | "void") => {
    setBusy(true); setError("");
    try {
      let target = loaded?.doc.id ?? null;
      let revision = loaded?.doc.revision;
      if (to === "sent") {
        const saved = await save();
        if (!saved) { setConfirm(null); return; }
        target = saved.id; revision = saved.revision;
      }
      if (!target) return;
      await adminFetch(`/api/admin/invoices/${target}/status`, { method: "POST", body: JSON.stringify({ to, expectedRevision: to === "sent" ? revision : undefined, paidAt: to === "paid" ? paidAt : undefined, reference: to === "paid" ? paidRef : undefined }) });
      toast(to === "sent" ? "أُرسلت الوثيقة وقُفلت" : to === "paid" ? "سُجّل الدفع" : "أُلغيت الوثيقة");
      setConfirm(null);
      if (!loaded) router.replace(`/admin/invoices/${target}`); else await loadDoc();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر التنفيذ"); setConfirm(null); } finally { setBusy(false); }
  };

  const go = async (path: "convert" | "duplicate") => {
    if (!loaded) return;
    setBusy(true); setError("");
    try {
      const r = await adminFetch<{ id: string }>(`/api/admin/invoices/${loaded.doc.id}/${path}`, { method: "POST" });
      router.push(`/admin/invoices/${r.id}`);
    } catch (e) {
      const existing = (e as { existingId?: string }).existingId;
      setError(e instanceof Error ? e.message : "تعذّر التنفيذ");
      if (existing) router.push(`/admin/invoices/${existing}`);
    } finally { setBusy(false); }
  };

  // ----- lines and batches -----
  const addBatch = () => {
    const key = newKey("b");
    set({ batches: [...form.batches, { key, title: `المرحلة ${fmtInt(form.batches.length + 1)}`, summaryOnly: false }], lines: [...form.lines, emptyLine(key)] });
  };
  const removeBatch = (key: string) => set({ batches: form.batches.filter((b) => b.key !== key), lines: form.lines.map((l) => (l.batchKey === key ? { ...l, batchKey: null } : l)) });
  const patchBatch = (key: string, p: Partial<DocForm["batches"][number]>) => set({ batches: form.batches.map((b) => (b.key === key ? { ...b, ...p } : b)) });
  const patchLine = (key: string, p: Partial<DocForm["lines"][number]>) => set({ lines: form.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) });
  const pickType = (key: string, typeId: string) => {
    const t = types.find((x) => x.id === typeId);
    if (!t) { patchLine(key, { itemTypeId: null, itemTypeName: "" }); return; }
    patchLine(key, { itemTypeId: t.id, itemTypeName: t.nameAr, unit: formatScaled(t.unitCc, 2) });
  };
  const pickClient = (clientId: string) => {
    const c = clients.find((x) => x.id === clientId);
    if (!c) { set({ clientId: null }); return; }
    set({ clientId: c.id, company: c.company, contact: c.contact, email: c.email, phone: c.phone, address: c.address });
  };
  const saveClient = async () => {
    if (!form.company.trim()) { toast("اكتب اسم الشركة أولًا"); return; }
    try {
      const r = await adminFetch<{ client: SavedClient }>("/api/admin/invoices/clients", { method: "POST", body: JSON.stringify({ company: form.company, contact: form.contact, email: form.email, phone: form.phone, address: form.address, notes: "" }) });
      setClients((list) => [...list, r.client]);
      set({ clientId: r.client.id });
      toast("حُفظ العميل");
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر حفظ العميل"); }
  };

  const groups: Array<{ key: string | null; title: string; summaryOnly: boolean }> = [];
  if (form.lines.some((l) => l.batchKey === null) || form.batches.length === 0) groups.push({ key: null, title: "بنود بدون مرحلة", summaryOnly: false });
  for (const b of form.batches) groups.push({ key: b.key, title: b.title, summaryOnly: b.summaryOnly });

  const lineMoney = (key: string) => totals.lines[doc.lines.findIndex((l) => l.key === key)];
  const groupTotal = (key: string | null) => {
    const idx = doc.lines.map((l, i) => (l.batchKey === key ? i : -1)).filter((i) => i >= 0);
    return { usd: idx.reduce((s, i) => s + totals.lines[i].usd, 0), points: doc.show.points && doc.rateE4 !== null ? idx.reduce((s, i) => s + (totals.lines[i].points ?? 0), 0) : null };
  };

  const numLabel = loaded ? fmtNumber(loaded.doc.number) : "";
  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="invoice-builder">
      <section className={SECTION}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="m-0 text-base font-semibold text-ink">{DOC_TYPE_AR[form.docType]}{numLabel ? <> <span dir="ltr">{numLabel}</span></> : " جديد"}</h2>
            <StatusChip status={status} />
          </div>
          <Link href="/admin/invoices" className="text-[13px] text-mut">العودة إلى القائمة</Link>
        </div>
        {loaded?.doc.convertedFromId ? <p className="m-0 text-xs text-mut">محوّلة من <Link href={`/admin/invoices/${loaded.doc.convertedFromId}`}>عرض سعر</Link>. سعر الصرف هو سعر عرض السعر الذي وافق عليه العميل.</p> : null}
        {locked ? <p className="m-0 rounded-xl border border-ln bg-bg p-3 text-[13px] leading-[1.9] text-ink2" data-testid="locked-note">الوثيقة مقفلة ولا يمكن تعديلها. للتصحيح: ألغِها ثم انسخها كوثيقة جديدة.</p> : null}
        {error ? <p role="alert" className="m-0 text-[13px] text-bad" data-testid="builder-error">{error}</p> : null}
        {!locked && dirty ? <p className="m-0 text-xs text-goldT">تعديلات غير محفوظة.</p> : null}
        <div className="flex flex-wrap gap-2" data-testid="builder-actions">
          {!locked ? <button type="button" className={BTN} disabled={busy} onClick={onSave} data-testid="save-draft">حفظ المسودة</button> : null}
          {!locked ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => { const r = formToInput(form); if (!r.ok) setError(r.error); else if (!form.company.trim()) setError("اسم الشركة (العميل) مطلوب قبل الإرسال."); else if (!form.lines.length) setError("أضف بندًا واحدًا على الأقل قبل الإرسال."); else { setError(""); setConfirm("sent"); } }} data-testid="send">إرسال (مرسلة)</button> : null}
          {status === "sent" && form.docType === "invoice" ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => setConfirm("paid")} data-testid="mark-paid">تسجيل الدفع</button> : null}
          {status === "sent" && form.docType === "quote" ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => go("convert")} data-testid="convert">تحويل إلى فاتورة</button> : null}
          {loaded && (status === "draft" || status === "sent") ? <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => setConfirm("void")} data-testid="void">إلغاء الوثيقة (ملغية)</button> : null}
          {loaded ? <button type="button" className={BTN} disabled={busy} onClick={() => go("duplicate")} data-testid="duplicate">نسخ كوثيقة جديدة</button> : null}
          <button type="button" className={BTN} onClick={() => setShowExport((v) => !v)} data-testid="toggle-export">{showExport || locked ? "إخفاء المعاينة" : "معاينة وتصدير"}</button>
        </div>
      </section>

      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
        <section className={SECTION}>
          <h3 className="m-0 text-sm font-semibold text-ink">العميل</h3>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <select className={INPUT} value={form.clientId ?? ""} onChange={(e) => pickClient(e.target.value)} aria-label="عميل محفوظ">
              <option value="">— اختر عميلًا محفوظًا —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
            </select>
            <button type="button" className={`${BTN} shrink-0`} onClick={saveClient}>حفظ كعميل</button>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="اسم الشركة"><input className={INPUT} value={form.company} onChange={(e) => set({ company: e.target.value })} data-testid="client-company" /></Field>
            <Field label="المسؤول"><input className={INPUT} value={form.contact} onChange={(e) => set({ contact: e.target.value })} /></Field>
            <Field label="البريد الإلكتروني"><input className={INPUT} type="email" dir="ltr" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="الهاتف"><input className={INPUT} type="tel" dir="ltr" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="العنوان"><input className={INPUT} value={form.address} onChange={(e) => set({ address: e.target.value })} /></Field>
          </div>
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-sm font-semibold text-ink">التواريخ والعملة</h3>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="تاريخ الإصدار"><input className={INPUT} type="date" value={form.issueDate} onChange={(e) => set({ issueDate: e.target.value })} /></Field>
            <Field label={form.docType === "invoice" ? "تاريخ الاستحقاق" : "صالح حتى"}><input className={INPUT} type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field>
          </div>
          <div className="flex flex-wrap gap-4 text-[13px] text-ink" role="group" aria-label="العملات المعروضة">
            <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={form.showUsd} onChange={(e) => set({ showUsd: e.target.checked })} />دولار</label>
            <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={form.showPoints} onChange={(e) => set({ showPoints: e.target.checked })} data-testid="show-points" />نقاط</label>
            <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={form.showEgp} onChange={(e) => set({ showEgp: e.target.checked })} />جنيه مصري</label>
          </div>
          <Field label="سعر الصرف (جنيه لكل دولار)" hint={form.showPoints || form.showEgp ? "يُثبَّت على الوثيقة عند الإرسال، ولا يغيّر أي تعديل لاحق على السعر وثيقة مرسلة. النقطة = ٠٫١٠ جنيه." : "مطلوب فقط عند عرض النقاط أو الجنيه."}>
            <input className={INPUT} inputMode="decimal" dir="ltr" value={form.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="مثل 50.75" data-testid="rate" />
          </Field>
        </section>

        <section className={SECTION} data-testid="lines-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold text-ink">البنود والمراحل</h3>
            <button type="button" className={BTN} onClick={addBatch} data-testid="add-batch">إضافة مرحلة</button>
          </div>
          {groups.map((g) => {
            const gl = form.lines.filter((l) => l.batchKey === g.key);
            const gt = groupTotal(g.key);
            return (
              <div key={g.key ?? "loose"} className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-ln p-3" data-testid="line-group">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {g.key ? <input className={`${INPUT} flex-1`} value={g.title} onChange={(e) => patchBatch(g.key as string, { title: e.target.value })} aria-label="اسم المرحلة" /> : <strong className="flex-1 text-[13px] text-ink">{g.title}</strong>}
                  <span className="text-[13px] font-semibold text-ink" data-testid="group-total"><span dir="ltr">{fmtUsd(gt.usd)}</span> دولار{gt.points !== null ? <> · <span dir="ltr">{fmtPoints(gt.points)}</span> نقطة</> : null}</span>
                </div>
                {g.key ? (
                  <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
                    <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={g.summaryOnly} onChange={(e) => patchBatch(g.key as string, { summaryOnly: e.target.checked })} />عرض المرحلة كملخص فقط (عنوان وعدد وإجمالي)</label>
                    <button type="button" className={BTN} onClick={() => removeBatch(g.key as string)}>حذف المرحلة (تبقى بنودها بدون مرحلة)</button>
                  </div>
                ) : null}
                {gl.map((l) => {
                  const money = lineMoney(l.key);
                  return (
                    <div key={l.key} className="flex min-w-0 flex-col gap-2 rounded-xl border border-ln bg-bg p-2.5" data-testid="line-card">
                      <select className={INPUT} value={l.itemTypeId ?? ""} onChange={(e) => pickType(l.key, e.target.value)} aria-label="نوع البند">
                        <option value="">— نوع البند —</option>
                        {types.map((t) => <option key={t.id} value={t.id}>{t.nameAr}</option>)}
                      </select>
                      <input className={INPUT} value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} placeholder="الوصف (اختياري)" aria-label="الوصف" />
                      <div className="grid min-w-0 grid-cols-3 gap-2">
                        <Field label="الكمية"><input className={INPUT} inputMode="numeric" dir="ltr" value={l.qty} onChange={(e) => patchLine(l.key, { qty: e.target.value })} data-testid="line-qty" /></Field>
                        <Field label="سعر الوحدة (سنت)"><input className={INPUT} inputMode="decimal" dir="ltr" value={l.unit} onChange={(e) => patchLine(l.key, { unit: e.target.value })} data-testid="line-unit" /></Field>
                        <Field label="الإجمالي"><div className="flex min-h-[46px] items-center text-[13px] font-semibold text-ink" data-testid="line-total"><span dir="ltr">{fmtUsd(money.usd)}</span></div></Field>
                      </div>
                      {money.points !== null && doc.show.points ? <p className="m-0 text-xs text-mut">= <span dir="ltr">{fmtPoints(money.points)}</span> نقطة{doc.show.egp && money.egp !== null ? <> · <span dir="ltr">{fmtEgp(money.egp)}</span> جنيه</> : null}</p> : null}
                      <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
                        <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={l.hidden} onChange={(e) => patchLine(l.key, { hidden: e.target.checked })} data-testid="line-hidden" />إخفاء من الوثيقة (يُحتسب في الإجمالي)</label>
                        {form.batches.length ? (
                          <select className={`${INPUT} max-w-[220px]`} value={l.batchKey ?? ""} onChange={(e) => patchLine(l.key, { batchKey: e.target.value || null })} aria-label="المرحلة">
                            <option value="">بدون مرحلة</option>
                            {form.batches.map((b) => <option key={b.key} value={b.key}>{b.title}</option>)}
                          </select>
                        ) : null}
                        <button type="button" className={BTN} onClick={() => set({ lines: form.lines.filter((x) => x.key !== l.key) })}>حذف البند</button>
                      </div>
                    </div>
                  );
                })}
                <div><button type="button" className={BTN} onClick={() => set({ lines: [...form.lines, emptyLine(g.key)] })} data-testid="add-line">إضافة بند</button></div>
              </div>
            );
          })}
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-sm font-semibold text-ink">الخصم والضريبة</h3>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="الخصم">
              <select className={INPUT} value={form.discountKind} onChange={(e) => set({ discountKind: e.target.value as DocForm["discountKind"] })} data-testid="discount-kind">
                <option value="none">بدون خصم</option><option value="percent">نسبة مئوية</option><option value="amount">مبلغ ثابت (بالدولار)</option>
              </select>
            </Field>
            {form.discountKind !== "none" ? <Field label={form.discountKind === "percent" ? "نسبة الخصم (٪)" : "مبلغ الخصم (دولار)"}><input className={INPUT} inputMode="decimal" dir="ltr" value={form.discount} onChange={(e) => set({ discount: e.target.value })} data-testid="discount-value" /></Field> : null}
          </div>
          <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="h-5 w-5" checked={form.taxEnabled} onChange={(e) => set({ taxEnabled: e.target.checked })} data-testid="tax-enabled" />إضافة سطر ضريبة (مغلق افتراضيًا)</label>
          {form.taxEnabled ? (
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="اسم السطر"><input className={INPUT} value={form.taxLabel} onChange={(e) => set({ taxLabel: e.target.value })} /></Field>
              <Field label="النسبة (٪)"><input className={INPUT} inputMode="decimal" dir="ltr" value={form.tax} onChange={(e) => set({ tax: e.target.value })} /></Field>
            </div>
          ) : null}
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-sm font-semibold text-ink">ملاحظات وتعليمات الدفع</h3>
          <Field label="ملاحظات"><textarea className={`${INPUT} min-h-[84px] py-2`} value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} /></Field>
          <Field label="تعليمات الدفع" hint="تُملأ من عنوان إنستا باي المحفوظ في الإعدادات، ويمكنك تعديلها قبل الإرسال."><textarea className={`${INPUT} min-h-[84px] py-2`} value={form.payment} onChange={(e) => set({ payment: e.target.value })} maxLength={600} /></Field>
          <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="h-5 w-5" checked={form.showQr} onChange={(e) => set({ showQr: e.target.checked })} disabled={!eligibleQr} data-testid="show-qr" />إظهار رمز الدفع (QR) في الوثيقة</label>
          {!eligibleQr ? <p className="m-0 text-xs leading-6 text-mut">الرمز لا يظهر لأن عنوان إنستا باي المحفوظ ليس العنوان الذي يطابقه الرمز.</p> : null}
        </section>
      </fieldset>

      <section className={SECTION} data-testid="totals-section">
        <h3 className="m-0 text-sm font-semibold text-ink">الإجماليات</h3>
        <dl className="m-0 grid min-w-0 grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px] text-ink">
          {model.totalRows.map((r, i) => (
            <div key={i} className="contents">
              <dt className={r.strong ? "font-bold" : "text-mut"}>{r.label}</dt>
              <dd className={`m-0 text-left ${r.strong ? "font-bold" : ""}`}>{r.amounts.map((a, j) => <span key={j} className="ms-3" dir="ltr">{a} <span className="text-mut">{model.currencyLabels[j]}</span></span>)}</dd>
            </div>
          ))}
        </dl>
        {model.roundingNote ? <p className="m-0 text-xs leading-6 text-mut">{model.roundingNote}</p> : null}
      </section>

      {showExport || locked ? <section className={SECTION}><h3 className="m-0 text-sm font-semibold text-ink">المعاينة والتصدير</h3><InvoiceExport model={model} fileBase={loaded?.doc.number || "draft"} /></section> : null}

      {loaded && loaded.events.length ? (
        <section className={SECTION} data-testid="status-log">
          <h3 className="m-0 text-sm font-semibold text-ink">سجل الحالة (لا يُعدَّل)</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs text-ink2">
            {loaded.events.map((e) => (
              <li key={e.id}>{e.fromStatus ? `${STATUS_AR[e.fromStatus]} ← ` : ""}<strong>{STATUS_AR[e.toStatus]}</strong> · {fmtDateAr(e.createdAt.slice(0, 10))} · المسؤول <span dir="ltr">{e.adminId.slice(0, 8)}</span>{e.paymentReference ? ` · المرجع ${e.paymentReference}` : ""}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {confirm ? (
        <ConfirmDialog title={CONFIRM_AR[confirm].title} body={CONFIRM_AR[confirm].body} confirmLabel={CONFIRM_AR[confirm].action} danger={confirm === "void"} busy={busy} onCancel={() => !busy && setConfirm(null)} onConfirm={() => changeStatus(confirm)}>
          {confirm === "paid" ? (
            <div className="grid grid-cols-1 gap-3">
              <Field label="تاريخ الدفع"><input className={INPUT} type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} data-testid="paid-at" /></Field>
              <Field label="مرجع الدفع (اختياري)"><input className={INPUT} value={paidRef} onChange={(e) => setPaidRef(e.target.value)} data-testid="paid-ref" /></Field>
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
