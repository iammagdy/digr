"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { todayCairo } from "@/lib/invoices/dates";
import { emptyForm, emptyLine, formFromDoc, formToInput, formToPreview, rateIsMissing, type DocForm } from "@/lib/invoices/form";
import { fmtDateAr, fmtInt, fmtNumber, fmtRate, fmtUsd } from "@/lib/invoices/format";
import { CONFIRM_AR, DOC_TYPE_AR, STATUS_AR } from "@/lib/invoices/labels";
import { parseScaled } from "@/lib/invoices/money";
import { SECTOR_SUGGESTIONS, addSector, applyAssist, countText, otherLines, quickFields, removeSector, renameSector, setCount, zeroPriceNames, type AssistSector, type ItemTypeLite } from "@/lib/invoices/sectors";
import { buildSheetModel } from "@/lib/invoices/sheetModel";
import { totalsForDoc } from "@/lib/invoices/totals";
import type { DocStatus, DocType, DocView, SellerBlock, StatusEvent } from "@/lib/invoices/types";
import { showsInstapayShortcuts } from "@/lib/topupConfig";
import type { SavedClient } from "./ClientsPanel";
import { InvoiceExport, useInvoiceExport } from "./InvoiceSheet";
import { BTN, BTN_DANGER, BTN_PRIMARY, ConfirmDialog, Field, INPUT, SECTION, StatusChip } from "./ui";

interface ItemType extends ItemTypeLite { isActive: boolean }
interface Meta { seller: SellerBlock; lastRateE4: number | null; instapayAddress: string; creditValueE4: number; defaultPaymentInstructions: string }
interface Loaded { doc: DocView; events: StatusEvent[]; seller: SellerBlock }

const MODES: Array<[DocType, string]> = [["invoice", "فاتورة"], ["quote", "عرض سعر"], ["statement", "بيان بيانات"]];
const CHIP = "min-h-[44px] rounded-full border px-4 text-[13px] font-semibold";
/** «قطاع واحد» / «قطاعين» / «٣ قطاعات» / «١١ قطاعًا». */
export function sectorsPhrase(n: number): string {
  if (n === 1) return "قطاع واحد";
  if (n === 2) return "قطاعين";
  return `${fmtInt(n)} ${n <= 10 ? "قطاعات" : "قطاعًا"}`;
}

/**
 * The simple builder: ONE screen. A short form (client, sectors with four number boxes, currency) and the REAL sheet always visible under it (beside it on a
 * desktop), updating as the owner types. Discount, tax, notes, payment text, hiding lines and the like are behind «خيارات إضافية».
 * Prices fill from the item types; the total is always the one money library's. After «مرسلة» everything is read-only (the database refuses changes too).
 * Nothing here reads or writes the wallet.
 */
export function InvoiceBuilder({ id, initialType }: { id?: string; initialType?: DocType }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [types, setTypes] = useState<ItemType[]>([]);
  const [clients, setClients] = useState<SavedClient[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [version, setVersion] = useState(0);

  const loadDoc = useCallback(async () => {
    if (!id) return;
    try {
      setLoaded(await adminFetch<Loaded>(`/api/admin/invoices/${id}`));
      setVersion((v) => v + 1);
      setError("");
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
      } catch (e) { setError(e instanceof Error ? e.message : "تعذّر التحميل"); }
    })();
    void loadDoc();
  }, [loadDoc]);

  if (!meta || (id && !loaded)) {
    return error ? <p role="alert" className="text-[13px] text-bad">{error}</p> : <p className="text-[13px] text-mut">جارٍ التحميل…</p>;
  }
  return (
    <BuilderView key={`${loaded?.doc.id ?? "new"}:${version}`} meta={meta} types={types} clients={clients} setClients={setClients} loaded={loaded} initialType={initialType ?? "invoice"}
      showMore={showMore} setShowMore={setShowMore} reload={loadDoc} initialError={error} />
  );
}

function BuilderView({ meta, types, clients, setClients, loaded, initialType, showMore, setShowMore, reload, initialError }: {
  meta: Meta; types: ItemType[]; clients: SavedClient[]; setClients: (f: (c: SavedClient[]) => SavedClient[]) => void; loaded: Loaded | null; initialType: DocType;
  showMore: boolean; setShowMore: (v: boolean) => void; reload: () => Promise<void>; initialError: string;
}) {
  const { toast } = useAdmin();
  const router = useRouter();
  const [form, setForm] = useState<DocForm>(() => loaded ? formFromDoc(loaded.doc) : { ...emptyForm(initialType, todayCairo(), { rateE4: meta.lastRateE4, payment: meta.defaultPaymentInstructions }), showUsd: false, showPoints: true });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "sent" | "paid" | "void">(null);
  const [paidAt, setPaidAt] = useState(todayCairo());
  const [paidRef, setPaidRef] = useState("");
  const [assistText, setAssistText] = useState("");
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistMsg, setAssistMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const status: DocStatus = loaded?.doc.status ?? "draft";
  const locked = status !== "draft";
  const statement = form.docType === "statement";
  const quick = useMemo(() => quickFields(types), [types]);
  const set = (patch: Partial<DocForm>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  const update = (fn: (f: DocForm) => DocForm) => { setForm((f) => fn(f)); setDirty(true); };

  const doc = useMemo<DocView>(() => (locked && loaded ? loaded.doc : formToPreview(form, {
    id: loaded?.doc.id ?? null, number: loaded?.doc.number ?? "", status, revision: loaded?.doc.revision ?? 1,
    creditValueE4: loaded?.doc.creditValueE4 ?? meta.creditValueE4, instapayAddress: loaded?.doc.instapayAddress ?? meta.instapayAddress,
  })), [form, loaded, locked, status, meta]);
  const totals = useMemo(() => totalsForDoc(doc), [doc]);
  const model = useMemo(() => buildSheetModel(doc, loaded?.seller ?? meta.seller), [doc, loaded, meta]);
  const shownModel = useDeferredValue(model);
  const x = useInvoiceExport(shownModel, loaded?.doc.number || "draft");

  const zero = useMemo(() => (statement || locked ? [] : zeroPriceNames(form)), [form, statement, locked]);
  const rateMissing = !statement && rateIsMissing(form);
  const eligibleQr = showsInstapayShortcuts(doc.instapayAddress);
  const others = (key: string | null) => otherLines(form, key, quick);

  // ----- saving and status -----
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
      setDirty(false);
      if (!loaded) router.replace(`/admin/invoices/${saved.id}`); else await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setBusy(false); }
  };

  const askSend = () => {
    const r = formToInput(form);
    if (!r.ok) { setError(r.error); return; }
    if (!form.lines.length) { setError("أضف قطاعًا وأرقامًا قبل الإرسال."); return; }
    setError(""); setConfirm("sent");
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
      if (!loaded) router.replace(`/admin/invoices/${target}`); else await reload();
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

  // ----- the Claude helper: a draft only, nothing is saved -----
  const runAssist = async () => {
    if (!assistText.trim() || assistBusy) return;
    setAssistBusy(true); setAssistMsg(null);
    try {
      const r = await adminFetch<{ sectors: AssistSector[] }>("/api/admin/invoices/assist", { method: "POST", body: JSON.stringify({ text: assistText }) });
      update((f) => applyAssist(f, r.sectors, types));
      setAssistText("");
      setAssistMsg({ ok: true, text: `أضفت ${sectorsPhrase(r.sectors.length)} إلى المسودة. راجع الأرقام وعدّلها، ثم اضغط «حفظ مسودة».` });
    } catch (e) { setAssistMsg({ ok: false, text: e instanceof Error ? e.message : "تعذّر ترتيب النص." }); }
    finally { setAssistBusy(false); }
  };

  const pickClient = (clientId: string) => {
    const c = clients.find((v) => v.id === clientId);
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

  const toggleCurrency = (key: "showUsd" | "showPoints" | "showEgp") => {
    const next = { ...form, [key]: !form[key] };
    if (!next.showUsd && !next.showPoints && !next.showEgp) return; // one currency at least
    set({ [key]: next[key] } as Partial<DocForm>);
  };

  const lineIndex = (key: string) => doc.lines.findIndex((l) => l.key === key);
  const money = (key: string) => totals.lines[lineIndex(key)];
  const sectorTotal = (key: string | null): string => {
    const idx = doc.lines.map((l, i) => (l.batchKey === key ? i : -1)).filter((i) => i >= 0);
    const cur = model.currencies[0];
    const sum = idx.reduce((s, i) => s + (cur === "points" ? totals.lines[i].points ?? 0 : cur === "egp" ? totals.lines[i].egp ?? 0 : totals.lines[i].usd), 0);
    return cur === "points" ? `${toArabicDigits(String(sum).replace(/\B(?=(\d{3})+(?!\d))/g, "٬"))} نقطة` : `${fmtUsd(sum)} ${cur === "egp" ? "جنيه" : "دولار"}`;
  };
  const curLabel = (c: string) => (c === "points" ? "نقطة" : c === "egp" ? "جنيه" : "دولار");

  const groups: Array<{ key: string | null; title: string }> = [];
  if (form.lines.some((l) => l.batchKey === null)) groups.push({ key: null, title: "بنود بدون قطاع" });
  form.batches.forEach((b) => groups.push({ key: b.key, title: b.title }));

  const numLabel = loaded ? fmtNumber(loaded.doc.number) : "";
  const typeLabel = statement ? "بيان بيانات" : DOC_TYPE_AR[form.docType];

  const preview = (
    <section className={SECTION} ref={previewRef} data-testid="preview-section" aria-label="معاينة الوثيقة">
      <h3 className="m-0 text-sm font-semibold text-ink">المعاينة <span className="text-xs font-normal text-mut">(تتحدث وأنت تكتب)</span></h3>
      {x.element}
    </section>
  );

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3.5 lg:grid-cols-2 lg:items-start" data-testid="invoice-builder">
      <div className="flex min-w-0 flex-col gap-3.5">
        <section className={SECTION}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 text-base font-semibold text-ink" data-testid="builder-title">{typeLabel}{numLabel ? <> <span dir="ltr">{numLabel}</span></> : " جديد"}</h2>
              <StatusChip status={status} />
            </div>
            <Link href="/admin/invoices" className="text-[13px] text-mut">العودة إلى القائمة</Link>
          </div>
          {!loaded ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="نوع الوثيقة" data-testid="mode-switch">
              {MODES.map(([t, label]) => (
                <button key={t} type="button" aria-pressed={form.docType === t} onClick={() => set({ docType: t })}
                  className={`${CHIP} ${form.docType === t ? "border-ink bg-ink text-sf" : "border-ln bg-sf text-ink"}`} data-testid={`mode-${t}`}>{label}</button>
              ))}
            </div>
          ) : null}
          {statement ? <p className="m-0 text-xs leading-6 text-mut" data-testid="statement-note">بيان بالبيانات المستخرجة: قطاعات وأعداد فقط، بدون أسعار ولا إجماليات، ولا يحتاج عميلًا. لا يُسجَّل عليه دفع.</p> : null}
          {loaded?.doc.convertedFromId ? <p className="m-0 text-xs text-mut">محوّلة من <Link href={`/admin/invoices/${loaded.doc.convertedFromId}`}>عرض سعر</Link>. سعر الصرف هو سعر عرض السعر الذي وافق عليه العميل.</p> : null}
          {locked ? <p className="m-0 rounded-xl border border-ln bg-bg p-3 text-[13px] leading-[1.9] text-ink2" data-testid="locked-note">الوثيقة مقفلة ولا يمكن تعديلها. للتصحيح: ألغِها ثم انسخها كوثيقة جديدة.</p> : null}
          {error ? <p role="alert" className="m-0 text-[13px] text-bad" data-testid="builder-error">{error}</p> : null}
        </section>

        <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
          <section className={SECTION} data-testid="assist-section">
            <label htmlFor="assist-text" className="text-sm font-semibold text-ink">اكتب اللي عملته</label>
            <textarea id="assist-text" className={`${INPUT} min-h-[84px] py-2`} value={assistText} maxLength={2000} onChange={(e) => setAssistText(e.target.value)} data-testid="assist-text"
              placeholder="مثال: سحبت ٢٠٠ شركة كهروميكانيكا ومعاهم ٣٤٠ مدير، و٨٠ شركة بترول و١٢٠ شركة مقاولات" />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN_PRIMARY} disabled={assistBusy || !assistText.trim()} onClick={runAssist} data-testid="assist-run">{assistBusy ? "جارٍ الترتيب…" : "رتّبهالي"}</button>
              <span className="text-[11px] text-mut">مساعد Claude يقرأ الأعداد فقط: الأسعار من «أنواع البنود» والإجمالي من النظام. لا يُحفظ شيء قبل «حفظ مسودة».</span>
            </div>
            {assistMsg ? <p role={assistMsg.ok ? "status" : "alert"} className={`m-0 text-[13px] ${assistMsg.ok ? "text-ok" : "text-bad"}`} data-testid="assist-msg">{assistMsg.text}</p> : null}
          </section>

          <section className={SECTION}>
            <h3 className="m-0 text-sm font-semibold text-ink">العميل <span className="text-xs font-normal text-mut">(اختياري)</span></h3>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <input className={INPUT} value={form.company} onChange={(e) => set({ company: e.target.value, clientId: null })} placeholder="اسم الشركة العميلة" aria-label="اسم الشركة" data-testid="client-company" />
              {clients.length ? (
                <select className={`${INPUT} sm:max-w-[200px]`} value={form.clientId ?? ""} onChange={(e) => pickClient(e.target.value)} aria-label="عميل محفوظ">
                  <option value="">عميل محفوظ…</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
                </select>
              ) : null}
            </div>
          </section>

          <section className={SECTION} data-testid="sectors-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold text-ink">القطاعات</h3>
              <button type="button" className={BTN_PRIMARY} onClick={() => update((f) => addSector(f))} data-testid="add-sector">+ إضافة قطاع</button>
            </div>
            {groups.length === 0 ? <p className="m-0 text-[13px] leading-[1.9] text-mut">اضغط «إضافة قطاع» ثم اكتب اسم القطاع وعدد الشركات والمديرين والإيميلات وأرقام الهاتف. الخانة الفارغة لا تُضاف.</p> : null}
            <datalist id="sector-names">{SECTOR_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist>
            {groups.map((g) => (
              <div key={g.key ?? "loose"} className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-ln p-3" data-testid="sector-card">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {g.key ? (
                    <input className={`${INPUT} flex-1`} list="sector-names" value={g.title} onChange={(e) => update((f) => renameSector(f, g.key as string, e.target.value))} placeholder="القطاع (مثل: كهروميكانيكا)" aria-label="القطاع" data-testid="sector-name" />
                  ) : <strong className="flex-1 text-[13px] text-ink">{g.title}</strong>}
                  {!statement && model.currencies.length ? <span className="text-[13px] font-semibold text-ink" data-testid="sector-total" dir="ltr">{sectorTotal(g.key)}</span> : null}
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2">
                  {quick.map((q) => {
                    const line = form.lines.find((l) => l.batchKey === g.key && l.itemTypeId === q.type.id);
                    const m = line ? money(line.key) : null;
                    const unitZero = line ? parseScaled(line.unit, 2) === 0 : false;
                    return (
                      <div key={q.type.id} className="flex min-w-0 flex-col gap-1 rounded-xl border border-ln bg-bg p-2" data-testid={`quick-${q.name}`}>
                        <label className="text-xs font-semibold text-mut" htmlFor={`q-${g.key}-${q.type.id}`}>عدد {q.label}</label>
                        <input id={`q-${g.key}-${q.type.id}`} className={INPUT} inputMode="numeric" dir="ltr" placeholder="٠" value={toArabicDigits(countText(form, g.key, q.type.id))}
                          onChange={(e) => update((f) => setCount(f, g.key, q.type, e.target.value))} data-testid={`count-${q.name}`} />
                        {line && !statement ? (
                          <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-mut">
                            <span>×</span>
                            <input className="min-h-[36px] w-[64px] rounded-lg border border-ln bg-sf px-2 text-base text-ink outline-none" inputMode="decimal" dir="ltr" value={toArabicDigits(line.unit)} aria-label={`سعر ${q.name} بالسنت`}
                              onChange={(e) => update((f) => ({ ...f, lines: f.lines.map((l) => (l.key === line.key ? { ...l, unit: e.target.value } : l)) }))} data-testid={`price-${q.name}`} />
                            <span>سنت</span>
                            {m ? <strong className="text-ink" dir="ltr">= {fmtUsd(m.usd)}</strong> : null}
                            {unitZero ? <span className="w-full text-bad">السعر صفر</span> : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {others(g.key).length ? <p className="m-0 text-[11px] text-mut">+ {fmtInt(others(g.key).length)} بند آخر في هذا القطاع، تجدها في «خيارات إضافية».</p> : null}
                {g.key ? <div><button type="button" className={BTN} onClick={() => update((f) => removeSector(f, g.key as string))} data-testid="remove-sector">حذف القطاع</button></div> : null}
              </div>
            ))}
            {zero.length ? (
              <p role="alert" className="m-0 rounded-xl border border-bad p-3 text-[13px] leading-[1.9] text-bad" data-testid="zero-price-warning">
                تنبيه: سعر ({zero.join("، ")}) ما زال صفرًا، فلا يدخل في الإجمالي. اكتب السعر في الخانة الصغيرة بجوار العدد، أو من <Link href="/admin/invoices#types">«أنواع البنود»</Link> مرة واحدة فتُملأ تلقائيًا.
              </p>
            ) : null}
          </section>

          {!statement ? (
            <section className={SECTION} data-testid="currency-section">
              <h3 className="m-0 text-sm font-semibold text-ink">العملة</h3>
              <div className="flex flex-wrap gap-2" role="group" aria-label="العملات المعروضة">
                <button type="button" aria-pressed={form.showPoints} onClick={() => toggleCurrency("showPoints")} className={`${CHIP} ${form.showPoints ? "border-ink bg-ink text-sf" : "border-ln bg-sf text-ink"}`} data-testid="show-points">نقاط</button>
                <button type="button" aria-pressed={form.showEgp} onClick={() => toggleCurrency("showEgp")} className={`${CHIP} ${form.showEgp ? "border-ink bg-ink text-sf" : "border-ln bg-sf text-ink"}`} data-testid="show-egp">جنيه</button>
                <button type="button" aria-pressed={form.showUsd} onClick={() => toggleCurrency("showUsd")} className={`${CHIP} ${form.showUsd ? "border-ink bg-ink text-sf" : "border-ln bg-sf text-ink"}`} data-testid="show-usd">دولار</button>
              </div>
              {(form.showPoints || form.showEgp) && form.rate.trim() === "" ? (
                <Field label="سعر الصرف: كم جنيه يساوي دولارًا واحدًا؟ (مرة واحدة، يُحفظ ولا يُطلب منك بعدها)">
                  <input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(form.rate)} onChange={(e) => set({ rate: e.target.value })} placeholder="مثل ٥٠.٧٥" data-testid="rate" />
                </Field>
              ) : null}
              {rateMissing ? <p role="status" className="m-0 text-xs leading-6 text-bad" data-testid="rate-missing">اكتب سعر الصرف لتظهر النقاط والجنيه. الظاهر الآن بالدولار.</p> : null}
              {(form.showPoints || form.showEgp) && !rateMissing && parseScaled(form.rate, 4) !== null ? (
                <p className="m-0 text-xs leading-6 text-mut" data-testid="rate-note">سعر الصرف المحفوظ: <span dir="ltr">{fmtRate(parseScaled(form.rate, 4) as number)}</span> جنيه للدولار (يتغير من «بيانات البائع»، ويُثبَّت على الوثيقة عند الإرسال).</p>
              ) : null}
            </section>
          ) : null}

          <section className={SECTION}>
            <button type="button" className={BTN} aria-expanded={showMore} onClick={() => setShowMore(!showMore)} data-testid="toggle-more">{showMore ? "إخفاء الخيارات الإضافية" : "خيارات إضافية"}</button>
            {showMore ? (
              <div className="flex min-w-0 flex-col gap-3.5" data-testid="more-options">
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="تاريخ الإصدار"><input className={INPUT} type="date" value={form.issueDate} onChange={(e) => set({ issueDate: e.target.value })} /></Field>
                  {!statement ? <Field label={form.docType === "invoice" ? "تاريخ الاستحقاق" : "صالح حتى"}><input className={INPUT} type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field> : null}
                  <Field label="المسؤول"><input className={INPUT} value={form.contact} onChange={(e) => set({ contact: e.target.value })} /></Field>
                  <Field label="البريد الإلكتروني"><input className={INPUT} type="email" dir="ltr" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
                  <Field label="الهاتف"><input className={INPUT} type="tel" dir="ltr" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
                  <Field label="العنوان"><input className={INPUT} value={form.address} onChange={(e) => set({ address: e.target.value })} /></Field>
                </div>
                <div><button type="button" className={BTN} onClick={saveClient}>حفظ العميل للمرات القادمة</button></div>

                {!statement ? (
                  <>
                    {(form.showPoints || form.showEgp) ? (
                      <Field label="سعر الصرف لهذه الوثيقة (جنيه لكل دولار)" hint="يبدأ من السعر المحفوظ في «بيانات البائع». تغييره هنا لهذه الوثيقة فقط.">
                        <input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(form.rate)} onChange={(e) => set({ rate: e.target.value })} data-testid="rate-doc" />
                      </Field>
                    ) : null}
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="الخصم">
                        <select className={INPUT} value={form.discountKind} onChange={(e) => set({ discountKind: e.target.value as DocForm["discountKind"] })} data-testid="discount-kind">
                          <option value="none">بدون خصم</option><option value="percent">نسبة مئوية</option><option value="amount">مبلغ ثابت (بالدولار)</option>
                        </select>
                      </Field>
                      {form.discountKind !== "none" ? <Field label={form.discountKind === "percent" ? "نسبة الخصم (٪)" : "مبلغ الخصم (دولار)"}><input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(form.discount)} onChange={(e) => set({ discount: e.target.value })} data-testid="discount-value" /></Field> : null}
                    </div>
                    <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="h-5 w-5" checked={form.taxEnabled} onChange={(e) => set({ taxEnabled: e.target.checked })} data-testid="tax-enabled" />إضافة سطر ضريبة (مغلق افتراضيًا)</label>
                    {form.taxEnabled ? (
                      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="اسم السطر"><input className={INPUT} value={form.taxLabel} onChange={(e) => set({ taxLabel: e.target.value })} /></Field>
                        <Field label="النسبة (٪)"><input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(form.tax)} onChange={(e) => set({ tax: e.target.value })} /></Field>
                      </div>
                    ) : null}
                  </>
                ) : null}

                <Field label="ملاحظات"><textarea className={`${INPUT} min-h-[70px] py-2`} value={form.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={1000} /></Field>
                {!statement ? (
                  <>
                    <Field label="تعليمات الدفع" hint="تُملأ من عنوان إنستا باي المحفوظ في الإعدادات."><textarea className={`${INPUT} min-h-[70px] py-2`} value={form.payment} onChange={(e) => set({ payment: e.target.value })} maxLength={600} /></Field>
                    <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="h-5 w-5" checked={form.showQr} onChange={(e) => set({ showQr: e.target.checked })} disabled={!eligibleQr} data-testid="show-qr" />إظهار رمز الدفع (QR)</label>
                    {!eligibleQr ? <p className="m-0 text-xs leading-6 text-mut">الرمز لا يظهر لأن عنوان إنستا باي المحفوظ ليس العنوان الذي يطابقه الرمز.</p> : null}
                  </>
                ) : null}

                {form.batches.length ? (
                  <div className="flex min-w-0 flex-col gap-2" data-testid="summary-only-list">
                    <h4 className="m-0 text-xs font-semibold text-mut">عرض القطاع كملخص فقط (اسم وعدد وإجمالي)</h4>
                    {form.batches.map((b) => (
                      <label key={b.key} className="flex min-h-[44px] items-center gap-2 text-[13px] text-ink">
                        <input type="checkbox" className="h-5 w-5" checked={b.summaryOnly} onChange={(e) => update((f) => ({ ...f, batches: f.batches.map((v) => (v.key === b.key ? { ...v, summaryOnly: e.target.checked } : v)) }))} />{b.title || "قطاع بلا اسم"}
                      </label>
                    ))}
                  </div>
                ) : null}

                {form.lines.length ? (
                  <div className="flex min-w-0 flex-col gap-2" data-testid="line-details">
                    <h4 className="m-0 text-xs font-semibold text-mut">تفاصيل البنود (السعر، الإخفاء، الوصف)</h4>
                    {form.lines.map((l) => {
                      const sector = form.batches.find((b) => b.key === l.batchKey)?.title || "بدون قطاع";
                      return (
                        <div key={l.key} className="flex min-w-0 flex-col gap-2 rounded-xl border border-ln bg-bg p-2.5" data-testid="line-card">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mut"><span>{sector}</span><span>{l.itemTypeName || "بند"}</span></div>
                          <input className={INPUT} value={l.description} onChange={(e) => update((f) => ({ ...f, lines: f.lines.map((v) => (v.key === l.key ? { ...v, description: e.target.value } : v)) }))} placeholder="وصف (اختياري)" aria-label="الوصف" />
                          <div className="grid min-w-0 grid-cols-2 gap-2">
                            <Field label="الكمية"><input className={INPUT} inputMode="numeric" dir="ltr" value={toArabicDigits(l.qty)} onChange={(e) => update((f) => ({ ...f, lines: f.lines.map((v) => (v.key === l.key ? { ...v, qty: e.target.value } : v)) }))} data-testid="line-qty" /></Field>
                            {!statement ? <Field label="سعر الوحدة (سنت)"><input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(l.unit)} onChange={(e) => update((f) => ({ ...f, lines: f.lines.map((v) => (v.key === l.key ? { ...v, unit: e.target.value } : v)) }))} data-testid="line-unit" /></Field> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
                            <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={l.hidden} onChange={(e) => update((f) => ({ ...f, lines: f.lines.map((v) => (v.key === l.key ? { ...v, hidden: e.target.checked } : v)) }))} data-testid="line-hidden" />إخفاء من الوثيقة{statement ? "" : " (يُحتسب في الإجمالي)"}</label>
                            <button type="button" className={BTN} onClick={() => update((f) => ({ ...f, lines: f.lines.filter((v) => v.key !== l.key) }))}>حذف البند</button>
                          </div>
                        </div>
                      );
                    })}
                    <div><button type="button" className={BTN} onClick={() => update((f) => ({ ...f, lines: [...f.lines, { ...emptyLine(f.batches[0]?.key ?? null) }] }))}>+ بند آخر</button></div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </fieldset>

        {!statement && model.totalRows.length ? (
          <section className={SECTION} data-testid="totals-section">
            <h3 className="m-0 text-sm font-semibold text-ink">الإجمالي</h3>
            <dl className="m-0 grid min-w-0 grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px] text-ink">
              {model.totalRows.map((r, i) => (
                <div key={i} className="contents">
                  <dt className={r.strong ? "font-bold" : "text-mut"}>{r.label}</dt>
                  <dd className={`m-0 text-left ${r.strong ? "text-base font-bold" : ""}`}>{r.amounts.map((a, j) => <span key={j} className="ms-3" dir="ltr">{a} <span className="text-mut">{curLabel(model.currencies[j])}</span></span>)}</dd>
                </div>
              ))}
            </dl>
            {model.roundingNote ? <p className="m-0 text-xs leading-6 text-mut">{model.roundingNote}</p> : null}
          </section>
        ) : null}

        <section className={SECTION} data-testid="status-section">
          <div className="flex flex-wrap gap-2" data-testid="builder-actions">
            {!locked ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={askSend} data-testid="send">إرسال (مرسلة)</button> : null}
            {status === "sent" && form.docType === "invoice" ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => setConfirm("paid")} data-testid="mark-paid">تسجيل الدفع</button> : null}
            {status === "sent" && form.docType === "quote" ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => go("convert")} data-testid="convert">تحويل إلى فاتورة</button> : null}
            {loaded && (status === "draft" || status === "sent") ? <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => setConfirm("void")} data-testid="void">إلغاء الوثيقة (ملغية)</button> : null}
            {loaded ? <button type="button" className={BTN} disabled={busy} onClick={() => go("duplicate")} data-testid="duplicate">نسخ كوثيقة جديدة</button> : null}
          </div>
          {!locked ? <p className="m-0 text-[11px] leading-6 text-mut">«إرسال» يقفل الوثيقة ويثبّت أرقامها وسعر الصرف. قبل ذلك كل شيء قابل للتعديل.</p> : null}
        </section>

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
      </div>

      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-3">
        {preview}
        <div className="sticky bottom-0 z-30 grid grid-cols-2 gap-2 rounded-2xl border border-ln bg-sf p-2 sm:grid-cols-4" data-testid="action-bar">
          <button type="button" className={BTN} onClick={() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} data-testid="btn-preview">معاينة</button>
          {!locked ? <button type="button" className={BTN} disabled={busy} onClick={onSave} data-testid="save-draft">{dirty ? "حفظ مسودة •" : "حفظ مسودة"}</button> : <span />}
          <button type="button" className={BTN} disabled={!x.ready || Boolean(x.busy)} onClick={() => x.downloadPng()} data-testid="btn-png">{x.busy ? "جارٍ الإنشاء…" : "تنزيل صورة"}</button>
          <button type="button" className={BTN_PRIMARY} disabled={!x.ready} onClick={x.print} data-testid="btn-pdf">تنزيل PDF</button>
        </div>
        {x.error ? <p role="alert" className="m-0 text-[13px] text-bad">{x.error}</p> : null}
        <p className="m-0 text-[11px] leading-6 text-mut">«تنزيل PDF» يفتح نافذة الطباعة: اختر «حفظ كـ PDF». «تنزيل صورة» ينزّل صفحة PNG لكل صفحة من الوثيقة.</p>
      </div>

      {confirm ? (
        <ConfirmDialog title={CONFIRM_AR[confirm].title} body={CONFIRM_AR[confirm].body} confirmLabel={CONFIRM_AR[confirm].action} danger={confirm === "void"} busy={busy} onCancel={() => !busy && setConfirm(null)} onConfirm={() => changeStatus(confirm)}>
          {confirm === "sent" && !statement && form.lines.length > 0 && totals.total.usd === 0 ? <p role="alert" className="m-0 text-[13px] leading-[1.9] text-bad" data-testid="zero-total-warning">تنبيه: إجمالي الوثيقة صفر. هل نسيت الأسعار؟ بعد الإرسال لا يمكن تعديلها.</p> : null}
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

export { InvoiceExport };
