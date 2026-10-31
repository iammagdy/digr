"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { fmtDateAr, fmtEgp, fmtInt, fmtNumber, fmtPoints, fmtUsd } from "@/lib/invoices/format";
import { DOC_TYPE_AR, STATUS_AR } from "@/lib/invoices/labels";
import type { ListItem } from "@/lib/invoices/types";
import type { SavedClient } from "./ClientsPanel";
import { BTN, BTN_PRIMARY, INPUT, SECTION, StatusChip } from "./ui";

interface Unpaid { count: number; usd: number; points: number | null; egp: number | null }

/** The list: filters by status, type, client and text; the total still unpaid (issued invoices only). Cards, never a wide table, so it fits a 380 px phone. */
export function InvoiceList() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [unpaid, setUnpaid] = useState<Unpaid | null>(null);
  const [clients, setClients] = useState<SavedClient[]>([]);
  const [status, setStatus] = useState("");
  const [docType, setDocType] = useState("");
  const [clientId, setClientId] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (docType) p.set("docType", docType);
    if (clientId) p.set("clientId", clientId);
    if (q.trim()) p.set("q", q.trim());
    try {
      const r = await adminFetch<{ items: ListItem[]; unpaid: Unpaid }>(`/api/admin/invoices?${p.toString()}`);
      setItems(r.items); setUnpaid(r.unpaid); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل القائمة"); }
  }, [status, docType, clientId, q]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { adminFetch<{ clients: SavedClient[] }>("/api/admin/invoices/clients").then((r) => setClients(r.clients)).catch(() => {}); }, []);

  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="invoice-list">
      <section className={SECTION}>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/invoices/new?type=invoice" className={`${BTN_PRIMARY} inline-flex items-center`} data-testid="new-invoice">فاتورة جديدة</Link>
          <Link href="/admin/invoices/new?type=quote" className={`${BTN} inline-flex items-center`} data-testid="new-quote">عرض سعر جديد</Link>
        </div>
        {unpaid ? (
          <div className="rounded-xl border border-ln bg-bg p-3 text-[13px] leading-[1.9] text-ink" data-testid="unpaid-total">
            <span className="text-mut">غير مدفوع (فواتير مرسلة): </span>
            <strong>{fmtInt(unpaid.count)} فاتورة</strong>
            {unpaid.count > 0 ? <> — <strong><span dir="ltr">{fmtUsd(unpaid.usd)}</span> دولار</strong>{unpaid.points !== null ? <> · <span dir="ltr">{fmtPoints(unpaid.points)}</span> نقطة</> : null}{unpaid.egp !== null ? <> · <span dir="ltr">{fmtEgp(unpaid.egp)}</span> جنيه</> : null}</> : null}
          </div>
        ) : null}
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-4">
          <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
            <option value="">كل الحالات</option>
            {(["draft", "sent", "paid", "void"] as const).map((s) => <option key={s} value={s}>{STATUS_AR[s]}</option>)}
          </select>
          <select className={INPUT} value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="النوع">
            <option value="">الكل (عروض وفواتير)</option><option value="quote">{DOC_TYPE_AR.quote}</option><option value="invoice">{DOC_TYPE_AR.invoice}</option>
          </select>
          <select className={INPUT} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="العميل">
            <option value="">كل العملاء</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.company}</option>)}
          </select>
          <input className={INPUT} placeholder="بحث بالرقم أو الشركة" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
        </div>
      </section>
      {error ? <p role="alert" className="m-0 text-[13px] text-bad">{error}</p> : null}
      {items && items.length === 0 ? <p className="m-0 rounded-xl border border-ln p-4 text-[13px] text-mut">لا توجد وثائق بهذه المعايير.</p> : null}
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
        {(items ?? []).map((it) => (
          <li key={it.id}>
            <Link href={`/admin/invoices/${it.id}`} className="flex min-w-0 flex-col gap-1.5 rounded-[16px] border border-ln bg-sf p-3.5 no-underline" data-testid="invoice-row">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink"><span dir="ltr">{fmtNumber(it.number)}</span> · {DOC_TYPE_AR[it.docType]}</span>
                <StatusChip status={it.status} />
              </div>
              <div className="truncate text-[13px] text-ink2">{it.clientCompany || "— بدون عميل —"}</div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mut">
                <span>{fmtDateAr(it.issueDate)}{it.dueDate ? ` · الاستحقاق ${fmtDateAr(it.dueDate)}` : ""}</span>
                <span className="text-[13px] font-semibold text-ink">
                  {it.show.usd ? <><span dir="ltr">{fmtUsd(it.totalUsd)}</span> دولار</> : null}
                  {it.show.points && it.totalPoints !== null ? <>{it.show.usd ? " · " : ""}<span dir="ltr">{fmtPoints(it.totalPoints)}</span> نقطة</> : null}
                  {it.show.egp && it.totalEgp !== null ? <> · <span dir="ltr">{fmtEgp(it.totalEgp)}</span> جنيه</> : null}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
