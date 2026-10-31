"use client";

import { createPortal } from "react-dom";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import { paginate, pageLabel, type PagePlan } from "@/lib/invoices/paginate";
import type { SheetModel, SheetRow } from "@/lib/invoices/sheetModel";
import { TOPUP_INSTAPAY_QR_SRC } from "@/lib/topupConfig";
import { SHEET_CSS, SHEET_PAGE_HEIGHT_PX, SHEET_PAGE_WIDTH_PX } from "./sheetCss";

export const LOGO_SRC = "/brand/diger-wordmark.svg";
const digits = (n: number) => toArabicDigits(n);

/**
 * A number, date, phone or document number. The browser's bidi algorithm reorders digit groups separated by a hyphen or a space («INV-٢٠٢٦-٠٠٠١» would show
 * its groups backwards), so each part is its own left-to-right box: the order on the page is always the order written.
 */
const Num = ({ children }: { children: string }) => (
  <span className="num">{children.split(/([\s\-/])/).filter((t) => t !== "").map((t, i) => <span key={i} style={{ whiteSpace: "pre" }}>{t}</span>)}</span>
);

function colWidths(model: SheetModel): { idx: number; qty: number; desc: number; unit: number; total: number } {
  const n = model.currencies.length;
  const [unit, total] = n === 1 ? [16, 18] : n === 2 ? [12, 14] : [9.5, 11];
  const idx = 5, qty = 8;
  return { idx, qty, unit, total, desc: 100 - idx - qty - n * (unit + total) };
}

function Cols({ model }: { model: SheetModel }) {
  const w = colWidths(model);
  return (
    <colgroup>
      <col style={{ width: `${w.idx}%` }} /><col style={{ width: `${w.desc}%` }} /><col style={{ width: `${w.qty}%` }} />
      {model.currencies.map((c) => [<col key={`${c}u`} style={{ width: `${w.unit}%` }} />, <col key={`${c}t`} style={{ width: `${w.total}%` }} />])}
    </colgroup>
  );
}

function TableHead({ model }: { model: SheetModel }) {
  return (
    <thead data-m="head">
      <tr>
        <th>#</th><th>{model.columns.description}</th><th>{model.columns.qty}</th>
        {model.currencies.map((c, i) => [<th key={`${c}u`} className="m">{model.columns.unit[i]}</th>, <th key={`${c}t`} className="m">{model.columns.total[i]}</th>])}
      </tr>
    </thead>
  );
}

function RowView({ row, model }: { row: SheetRow; model: SheetModel }) {
  const span = 3 + model.currencies.length * 2;
  const money = (cells: string[], units?: string[]) => model.currencies.map((c, i) => [
    <td key={`${c}u`} className="m">{units ? <Num>{units[i]}</Num> : null}</td>,
    <td key={`${c}t`} className="m"><Num>{cells[i]}</Num></td>,
  ]);
  switch (row.kind) {
    case "heading": return <tr className="heading" data-m="row"><td colSpan={span}>{row.title}</td></tr>;
    case "line": return <tr className="line" data-m="row"><td><Num>{row.n}</Num></td><td>{row.description}</td><td><Num>{row.qty}</Num></td>{money(row.total, row.unit)}</tr>;
    case "aggregate": return <tr className="aggregate" data-m="row"><td></td><td colSpan={2}>{row.label}</td>{money(row.total)}</tr>;
    case "subtotal": return <tr className="subtotal" data-m="row"><td colSpan={3}>{row.label}</td>{money(row.total)}</tr>;
    case "batchSummary": return <tr className="batchSummary" data-m="row"><td></td><td>{row.title}</td><td>{row.count}</td>{money(row.total)}</tr>;
  }
}

function Header({ model }: { model: SheetModel }) {
  return (
    <header className="inv-head">
      <img src={LOGO_SRC} alt="ديجر" />
      <div className="title">
        <span>{model.docTypeAr}</span>
        {model.numberText ? <Num>{model.numberText}</Num> : null}
        {model.badge ? <span className={`inv-badge ${model.badge === "ملغية" ? "void" : model.badge === "مدفوعة" ? "paid" : ""}`}>{model.badge}</span> : null}
      </div>
    </header>
  );
}

function Footer({ model, label }: { model: SheetModel; label: string }) {
  return (
    <footer className="inv-foot">
      <span>{model.seller.name}{model.seller.website ? <> · <span className="ltr">{model.seller.website}</span></> : null}{model.seller.email ? <> · <span className="ltr">{model.seller.email}</span></> : null}</span>
      <span>{label}</span>
    </footer>
  );
}

function First({ model }: { model: SheetModel }) {
  return (
    <div className="inv-first" data-m="first">
      <div className="inv-box">
        <h3>من</h3>
        <div className="inv-seller-name">{model.seller.name}</div>
        <dl className="inv-kv">
          {model.seller.website ? <><dt>الموقع</dt><dd><span className="ltr">{model.seller.website}</span></dd></> : null}
          {model.seller.email ? <><dt>البريد</dt><dd><span className="ltr">{model.seller.email}</span></dd></> : null}
          {model.seller.extra.map((e) => <Fragment key={e.label}><dt>{e.label}</dt><dd>{e.value}</dd></Fragment>)}
        </dl>
        <h3 style={{ marginTop: 8 }}>التفاصيل</h3>
        <dl className="inv-kv">
          {model.meta.map((m) => <Fragment key={m.label}><dt>{m.label}</dt><dd>{/\d|٠|١|٢|٣|٤|٥|٦|٧|٨|٩/.test(m.value) ? <Num>{m.value}</Num> : m.value}</dd></Fragment>)}
        </dl>
      </div>
      <div className="inv-box">
        <h3>إلى</h3>
        <dl className="inv-kv">
          {model.client.length === 0 ? <><dt>الشركة</dt><dd>—</dd></> : null}
          {model.client.map((c) => <Fragment key={c.label}><dt>{c.label}</dt><dd>{c.label === "البريد الإلكتروني" ? <span className="ltr">{c.value}</span> : c.label === "الهاتف" ? <Num>{c.value}</Num> : c.value}</dd></Fragment>)}
        </dl>
      </div>
    </div>
  );
}

function SummaryTail({ model }: { model: SheetModel }) {
  const heads = model.currencyLabels.map((l) => <th key={l}>{l}</th>);
  return (
    <div className="inv-tail" data-m="tail">
      {model.groupSummary ? (
        <table className="inv-sum">
          <thead><tr><th className="caption" style={{ textAlign: "right", color: "#111827" }}>ملخص المراحل</th>{heads}</tr></thead>
          <tbody>{model.groupSummary.map((g, i) => <tr key={i}><td>{g.title}</td>{g.total.map((t, j) => <td key={j} className="m"><Num>{t}</Num></td>)}</tr>)}</tbody>
        </table>
      ) : null}
      <table className="inv-sum">
        <thead><tr><th></th>{heads}</tr></thead>
        <tbody>{model.totalRows.map((r, i) => <tr key={i} className={r.strong ? "strong" : ""}><td>{r.label}</td>{r.amounts.map((a, j) => <td key={j} className="m"><Num>{a}</Num></td>)}</tr>)}</tbody>
      </table>
      {model.rateNote ? <p className="inv-note">{model.rateNote}</p> : null}
      {model.roundingNote ? <p className="inv-note">{model.roundingNote}</p> : null}
    </div>
  );
}

export function hasNotesTail(model: SheetModel): boolean {
  return Boolean(model.notes || model.paymentInstructions || model.showQr);
}

function NotesTail({ model }: { model: SheetModel }) {
  return (
    <div className="inv-tail" data-m="tail">
      {model.notes ? <div style={{ marginBottom: 8 }}><div className="inv-pay"><div className="txt"><h4>ملاحظات</h4>{model.notes}</div></div></div> : null}
      {model.paymentInstructions || model.showQr ? (
        <div className="inv-pay">
          <div className="txt"><h4>تعليمات الدفع</h4>{model.paymentInstructions}</div>
          {model.showQr ? <img src={TOPUP_INSTAPAY_QR_SRC} alt="رمز الدفع عبر إنستا باي" /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The pages themselves: pure layout from the model and a page plan (no measuring, no state). */
export function SheetPageView({ model, plan, pageRef }: { model: SheetModel; plan: PagePlan[]; pageRef?: (el: HTMLElement | null, index: number) => void }) {
  const tails = hasNotesTail(model) ? [SummaryTail, NotesTail] : [SummaryTail];
  return (
    <div className="inv-pages" data-testid="sheet-pages">
      {plan.map((p, pi) => (
        <section key={pi} className="inv-page" data-page={pi + 1} ref={(el) => pageRef?.(el, pi)}>
          {model.badge === "مسودة" || model.badge === "ملغية" ? <div className={`inv-watermark ${model.badge === "ملغية" ? "void" : ""}`} aria-hidden>{model.badge}</div> : null}
          <Header model={model} />
          <div className="inv-body">
            {pi === 0 ? <First model={model} /> : null}
            {p.rows.length ? (
              <table className={`inv-table c${model.currencies.length}`}>
                <Cols model={model} />
                <TableHead model={model} />
                <tbody>{p.rows.map((ri) => <RowView key={ri} row={model.rows[ri]} model={model} />)}</tbody>
              </table>
            ) : null}
            {p.tails.map((ti) => { const T = tails[ti]; return <T key={ti} model={model} />; })}
          </div>
          <Footer model={model} label={pageLabel(pi + 1, plan.length, digits)} />
        </section>
      ))}
    </div>
  );
}

interface Measured { pageBody: number; first: number; head: number; rows: number[]; tails: number[] }

function measureHost(host: HTMLElement): Measured {
  const q = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
  const body = host.querySelector<HTMLElement>(".inv-body");
  const pad = body ? parseFloat(getComputedStyle(body).paddingTop) || 0 : 0;
  const h = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().height : 0);
  return {
    pageBody: (body ? body.clientHeight : SHEET_PAGE_HEIGHT_PX) - pad - 6, // 6 px of safety
    first: h(host.querySelector('[data-m="first"]')),
    head: h(host.querySelector('[data-m="head"]')),
    rows: q('tr[data-m="row"]').map((el) => h(el) + 1),
    tails: q('[data-m="tail"]').map((el) => h(el)),
  };
}

/** Where the pages break, from the REAL heights in this browser (fonts loaded first). Also returns the hidden host that is measured. */
export function useSheetPlan(model: SheetModel, measureOverride?: () => Measured): { plan: PagePlan[] | null; host: React.ReactNode } {
  const hostRef = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<PagePlan[] | null>(null);
  useLayoutEffect(() => {
    let off = false;
    (async () => {
      try { await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready; } catch { /* measure anyway */ }
      if (off || !hostRef.current) return;
      const m = measureOverride ? measureOverride() : measureHost(hostRef.current);
      setPlan(paginate({ rowHeights: m.rows, keepWithNext: model.rows.map((r) => r.kind === "heading"), pageBody: m.pageBody, firstPageReserve: m.first, tableHead: m.head, tails: m.tails }));
    })();
    return () => { off = true; };
  }, [model, measureOverride]);
  const tails = hasNotesTail(model) ? [SummaryTail, NotesTail] : [SummaryTail];
  const host = (
    <div className="inv-measure-host" aria-hidden ref={hostRef}>
      <section className="inv-page">
        <Header model={model} />
        <div className="inv-body">
          <First model={model} />
          {model.rows.length ? (
            <table className={`inv-table c${model.currencies.length}`}>
              <Cols model={model} /><TableHead model={model} />
              <tbody>{model.rows.map((r, i) => <RowView key={i} row={r} model={model} />)}</tbody>
            </table>
          ) : null}
          {tails.map((T, i) => <T key={i} model={model} />)}
        </div>
        <Footer model={model} label="" />
      </section>
    </div>
  );
  return { plan, host };
}

/** Preview (scaled to the screen width: no sideways page scroll at 380 px), print / «Save as PDF», and one PNG per page. */
export function InvoiceExport({ model, fileBase }: { model: SheetModel; fileBase: string }) {
  const { plan, host } = useSheetPlan(model);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const pageEls = useRef<Array<HTMLElement | null>>([]);
  const [printRoot, setPrintRoot] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "inv-print-root";
    document.body.appendChild(el);
    setPrintRoot(el);
    return () => { el.remove(); };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setScale(Math.min(1, el.clientWidth / SHEET_PAGE_WIDTH_PX) || 1);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const savePng = useCallback(async (index: number) => {
    const node = pageEls.current[index];
    if (!node) return;
    const { toPng } = await import("html-to-image");
    const url = await toPng(node, { pixelRatio: 2, backgroundColor: "#ffffff", cacheBust: true, width: SHEET_PAGE_WIDTH_PX, height: SHEET_PAGE_HEIGHT_PX });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileBase}-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [fileBase]);

  const run = async (key: string, indexes: number[]) => {
    setError(""); setBusy(key);
    try {
      for (const i of indexes) { await savePng(i); await new Promise((r) => setTimeout(r, 350)); }
    } catch { setError("تعذّر إنشاء الصورة. جرّب «طباعة / حفظ PDF» أو أعد المحاولة."); }
    finally { setBusy(""); }
  };

  const count = plan?.length ?? 0;
  const totalHeight = count * SHEET_PAGE_HEIGHT_PX + Math.max(0, count - 1) * 16;
  const BTN = "min-h-[44px] rounded-xl border border-ln bg-sf px-4 text-[13px] font-semibold text-ink disabled:opacity-50";
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="invoice-export">
      <style>{SHEET_CSS}</style>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${BTN} bg-ink text-sf`} onClick={() => window.print()} disabled={!plan} data-testid="export-print">طباعة / حفظ PDF</button>
        <button type="button" className={BTN} onClick={() => run("all", Array.from({ length: count }, (_, i) => i))} disabled={!plan || Boolean(busy)} data-testid="export-png-all">{busy === "all" ? "جارٍ الإنشاء…" : "تنزيل كل الصفحات (PNG)"}</button>
        {count > 1 ? Array.from({ length: count }, (_, i) => (
          <button key={i} type="button" className={BTN} onClick={() => run(`p${i}`, [i])} disabled={Boolean(busy)} data-testid={`export-png-${i + 1}`}>{busy === `p${i}` ? "…" : `صفحة ${digits(i + 1)} (PNG)`}</button>
        )) : null}
        <span className="text-[13px] text-mut" role="status">{plan ? `عدد الصفحات: ${digits(count)}` : "جارٍ تجهيز الصفحات…"}</span>
      </div>
      {error ? <p role="alert" className="m-0 text-[13px] text-bad">{error}</p> : null}
      <div ref={wrapRef} className="w-full min-w-0 overflow-hidden rounded-xl border border-ln bg-bg p-0" style={{ direction: "rtl" }}>
        {plan ? (
          <div style={{ width: SHEET_PAGE_WIDTH_PX * scale, height: totalHeight * scale }}>
            <div style={{ width: SHEET_PAGE_WIDTH_PX, transform: `scale(${scale})`, transformOrigin: "top right" }}>
              <SheetPageView model={model} plan={plan} pageRef={(el, i) => { pageEls.current[i] = el; }} />
            </div>
          </div>
        ) : null}
      </div>
      {host}
      {printRoot && plan ? createPortal(<SheetPageView model={model} plan={plan} />, printRoot) : null}
    </div>
  );
}
