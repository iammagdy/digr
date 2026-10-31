import { showsInstapayShortcuts } from "@/lib/topupConfig";
import { arabicizeText, fmtDateAr, fmtEgp, fmtInt, fmtNumber, fmtPercent, fmtPhone, fmtPoints, fmtPointValue, fmtRate, fmtUnitUsd, fmtUsd } from "./format";
import { CURRENCY_AR, CURRENCY_ORDER, DOC_TYPE_AR, ROUNDING_NOTE_AR, STATEMENT_TITLE_AR } from "./labels";
import { unitAt, unitDecimals, fmtFixed } from "./unitColumn";
import { egpIsDerivedFromPoints, totalsForDoc } from "./totals";
import type { Currency, DocView, Money, SellerBlock } from "./types";

/**
 * Everything the printed sheet shows, as plain strings, in the order it shows it. Pure: the React sheet only lays it out.
 * Rules (checked by tests/invoice-sheet.test.ts):
 *  - every printed row adds up to the printed totals, in every currency shown;
 *  - a hidden line is NEVER dropped from a total: the lines of its group that are hidden are shown as one aggregate row «بنود أخرى (n)»;
 *  - a summary-only batch is one row (title, count, subtotal);
 *  - an issued document prints the numbers frozen at issue.
 */
export type SheetRow =
  | { kind: "heading"; title: string }
  | { kind: "line"; n: string; description: string; qty: string; unit: string[]; total: string[] }
  | { kind: "aggregate"; label: string; total: string[] }
  | { kind: "subtotal"; label: string; total: string[] }
  | { kind: "batchSummary"; title: string; count: string; total: string[] };

export interface SheetTotalRow { label: string; amounts: string[]; strong?: boolean }

export interface SheetModel {
  /** a data statement: sectors and counts only, no price column, no totals, no payment block */
  statement: boolean;
  docTypeAr: string;
  numberText: string;
  badge: string | null;
  seller: { name: string; email: string; website: string; extra: Array<{ label: string; value: string }> };
  client: Array<{ label: string; value: string }>;
  meta: Array<{ label: string; value: string }>;
  currencies: Currency[];
  currencyLabels: string[];
  columns: { description: string; qty: string; unit: string[]; total: string[] };
  rows: SheetRow[];
  groupSummary: Array<{ title: string; total: string[] }> | null;
  totalRows: SheetTotalRow[];
  rateNote: string | null;
  roundingNote: string | null;
  notes: string;
  paymentInstructions: string;
  showQr: boolean;
}

function currenciesOf(doc: DocView): Currency[] {
  return CURRENCY_ORDER.filter((c) => doc.show[c]);
}

function fmtMoney(cur: Currency, money: Money): string {
  if (cur === "usd") return fmtUsd(money.usd);
  if (cur === "points") return money.points === null ? "—" : fmtPoints(money.points);
  return money.egp === null ? "—" : fmtEgp(money.egp);
}

function sumMoney(list: Money[]): Money {
  const nulls = (key: "points" | "egp") => list.some((m) => m[key] === null);
  return {
    usd: list.reduce((s, m) => s + m.usd, 0),
    points: nulls("points") ? null : list.reduce((s, m) => s + (m.points as number), 0),
    egp: nulls("egp") ? null : list.reduce((s, m) => s + (m.egp as number), 0),
  };
}

/** Display options that are never stored with the document: `phaseSummary: false` hides the sector summary table (the saved document always keeps it). */
export interface SheetOptions { phaseSummary?: boolean }

export function buildSheetModel(doc: DocView, seller: SellerBlock, qrAllowed: boolean = showsInstapayShortcuts(doc.instapayAddress), options: SheetOptions = {}): SheetModel {
  const statement = doc.docType === "statement";
  const currencies = statement ? [] : currenciesOf(doc);
  const totals = totalsForDoc(doc);
  const fm = (m: Money) => currencies.map((c) => fmtMoney(c, m));
  const rate = doc.rateE4;

  // the unit column of each money currency: the fewest decimals at which quantity x the shown unit equals every PRINTED line total (see unitColumn.ts)
  const summaryOnlyKeys = new Set(doc.batches.filter((b) => b.summaryOnly).map((b) => b.key));
  const printedIdx = doc.lines.map((l, i) => (l.hidden || (l.batchKey !== null && summaryOnlyKeys.has(l.batchKey)) ? -1 : i)).filter((i) => i >= 0);
  const decimals: Partial<Record<Currency, { decimals: number; ok: boolean }>> = {};
  for (const c of currencies) {
    if (c === "usd" || rate === null) continue;
    decimals[c] = unitDecimals(c, printedIdx.map((i) => ({ quantity: doc.lines[i].quantity, unitCc: doc.lines[i].unitCc, totalMinor: (c === "points" ? totals.lines[i].points : totals.lines[i].egp) ?? 0 })), rate, doc.creditValueE4, egpIsDerivedFromPoints(doc));
  }
  const unitText = (cc: number, cur: Currency): string => {
    if (cur === "usd") return fmtUnitUsd(cc);
    if (rate === null) return "—";
    const d = (decimals[cur] as { decimals: number }).decimals;
    return fmtFixed(unitAt(cur, cc, rate, doc.creditValueE4, d), d);
  };

  // groups: lines that belong to no batch first, then each batch in order
  const groups: Array<{ title: string | null; summaryOnly: boolean; idx: number[] }> = [];
  const loose = doc.lines.map((l, i) => (l.batchKey === null ? i : -1)).filter((i) => i >= 0);
  if (loose.length) groups.push({ title: null, summaryOnly: false, idx: loose });
  for (const b of doc.batches) groups.push({ title: b.title, summaryOnly: b.summaryOnly, idx: doc.lines.map((l, i) => (l.batchKey === b.key ? i : -1)).filter((i) => i >= 0) });

  const rows: SheetRow[] = [];
  const summary: Array<{ title: string; total: string[] }> = [];
  let visibleNo = 0;
  for (const g of groups) {
    const groupTotal = sumMoney(g.idx.map((i) => totals.lines[i]));
    summary.push({ title: arabicizeText(g.title ?? "بنود بدون مرحلة"), total: fm(groupTotal) });
    if (g.title !== null && g.summaryOnly) {
      rows.push({ kind: "batchSummary", title: arabicizeText(g.title), count: g.idx.length ? `${fmtInt(g.idx.length)} بند` : "", total: fm(groupTotal) });
      continue;
    }
    if (g.title !== null) rows.push({ kind: "heading", title: arabicizeText(g.title) });
    const hidden: number[] = [];
    for (const i of g.idx) {
      const line = doc.lines[i];
      if (line.hidden) { hidden.push(i); continue; }
      visibleNo += 1;
      const label = arabicizeText([line.itemTypeName, line.description].filter(Boolean).join(" — "));
      rows.push({ kind: "line", n: fmtInt(visibleNo), description: label, qty: fmtInt(line.quantity), unit: currencies.map((c) => unitText(line.unitCc, c)), total: fm(totals.lines[i]) });
    }
    if (hidden.length) rows.push({ kind: "aggregate", label: `بنود أخرى (${fmtInt(hidden.length)})`, total: fm(sumMoney(hidden.map((i) => totals.lines[i]))) });
    if (g.title !== null && !statement) rows.push({ kind: "subtotal", label: arabicizeText(`إجمالي ${g.title}`), total: fm(groupTotal) });
  }

  const totalRows: SheetTotalRow[] = statement ? [] : [{ label: "المجموع الفرعي", amounts: fm(totals.subtotal) }];
  const minus = (cells: string[]) => cells.map((c) => `−${c}`);
  if (!statement && doc.discountKind !== "none") {
    totalRows.push({ label: doc.discountKind === "percent" ? `الخصم (${fmtPercent(doc.discountValue)})` : "الخصم", amounts: minus(fm(totals.discount)) });
  }
  if (!statement && doc.taxEnabled) totalRows.push({ label: `${arabicizeText(doc.taxLabel)} (${fmtPercent(doc.taxBp)})`, amounts: fm(totals.tax) });
  if (!statement) totalRows.push({ label: doc.docType === "invoice" ? "الإجمالي المستحق" : "الإجمالي", amounts: fm(totals.total), strong: true });

  const badge = doc.status === "draft" ? "مسودة" : doc.status === "void" ? "ملغية" : doc.status === "paid" ? "مدفوعة" : null;

  const numberLabel = doc.docType === "invoice" ? "رقم الفاتورة" : doc.docType === "statement" ? "رقم البيان" : "رقم العرض";
  const meta: SheetModel["meta"] = [{ label: numberLabel, value: doc.number ? fmtNumber(doc.number) : "—" }];
  if (doc.issueDate) meta.push({ label: "تاريخ الإصدار", value: fmtDateAr(doc.issueDate) });
  if (doc.dueDate && !statement) meta.push({ label: doc.docType === "invoice" ? "تاريخ الاستحقاق" : "صالح حتى", value: fmtDateAr(doc.dueDate) });
  if (doc.status === "paid" && doc.paidAt) meta.push({ label: "تاريخ الدفع", value: fmtDateAr(doc.paidAt) });

  const client: SheetModel["client"] = [];
  if (doc.client.company) client.push({ label: "الشركة", value: arabicizeText(doc.client.company) });
  if (doc.client.contact) client.push({ label: "المسؤول", value: arabicizeText(doc.client.contact) });
  if (doc.client.email) client.push({ label: "البريد الإلكتروني", value: arabicizeText(doc.client.email) });
  if (doc.client.phone) client.push({ label: "الهاتف", value: fmtPhone(doc.client.phone) });
  if (doc.client.address) client.push({ label: "العنوان", value: arabicizeText(doc.client.address) });

  const extra: SheetModel["seller"]["extra"] = [];
  if (seller.taxNumber) extra.push({ label: "الرقم الضريبي", value: arabicizeText(seller.taxNumber) });
  if (seller.commercialRegister) extra.push({ label: "السجل التجاري", value: arabicizeText(seller.commercialRegister) });

  const usesRate = !statement && (doc.show.points || doc.show.egp);
  const rateNote = usesRate && rate !== null
    ? `سعر الصرف المعتمد: ١ دولار = ${fmtRate(rate)} جنيه مصري، وقيمة النقطة ${fmtPointValue(doc.creditValueE4)} جنيه.`
    : null;

  return {
    statement,
    docTypeAr: statement ? STATEMENT_TITLE_AR : DOC_TYPE_AR[doc.docType],
    numberText: doc.number ? fmtNumber(doc.number) : "",
    badge,
    seller: { name: arabicizeText(seller.name), email: seller.email, website: seller.website, extra },
    client,
    meta,
    currencies,
    currencyLabels: currencies.map((c) => CURRENCY_AR[c]),
    columns: {
      description: "البيان",
      qty: statement ? "العدد" : "الكمية",
      unit: currencies.map((c) => `سعر الوحدة (${CURRENCY_AR[c]})`),
      total: currencies.map((c) => `الإجمالي (${CURRENCY_AR[c]})`),
    },
    rows,
    groupSummary: doc.batches.length > 0 && !statement && options.phaseSummary !== false ? summary : null,
    totalRows,
    rateNote,
    roundingNote: !statement && Object.values(decimals).some((d) => d && !d.ok) ? ROUNDING_NOTE_AR : null,
    notes: arabicizeText(doc.notes),
    paymentInstructions: statement ? "" : arabicizeText(doc.paymentInstructions),
    showQr: !statement && qrAllowed && doc.showInstapayQr && Boolean(doc.paymentInstructions || doc.instapayAddress),
  };
}
