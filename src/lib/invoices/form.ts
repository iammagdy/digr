import { CREDIT_VALUE_DEFAULT_E4, formatScaled, parseScaled } from "./money";
import type { BatchInput, DiscountKind, DocStatus, DocType, DocView, LineInput } from "./types";
import { documentInputSchema, parseInput, type DocumentInput } from "./validate";

/** The builder's form: every number is the TEXT the owner typed; it becomes an integer only here (parseScaled: no float). */
export interface LineForm { key: string; batchKey: string | null; itemTypeId: string | null; itemTypeName: string; description: string; qty: string; unit: string; hidden: boolean }
export interface DocForm {
  docType: DocType;
  clientId: string | null;
  company: string; contact: string; email: string; phone: string; address: string;
  issueDate: string; dueDate: string;
  showUsd: boolean; showPoints: boolean; showEgp: boolean;
  /** EGP per USD, e.g. «50.75» */
  rate: string;
  discountKind: DiscountKind;
  /** percent («10», «12.5») or US dollars for a fixed discount */
  discount: string;
  taxEnabled: boolean; taxLabel: string; tax: string;
  notes: string; payment: string; showQr: boolean;
  batches: BatchInput[];
  lines: LineForm[];
}

let counter = 0;
export const newKey = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function emptyLine(batchKey: string | null): LineForm {
  return { key: newKey("l"), batchKey, itemTypeId: null, itemTypeName: "", description: "", qty: "1", unit: "0", hidden: false };
}

export function emptyForm(docType: DocType, today: string, defaults: { rateE4: number | null; payment: string }): DocForm {
  return {
    docType, clientId: null, company: "", contact: "", email: "", phone: "", address: "",
    issueDate: today, dueDate: "", showUsd: true, showPoints: false, showEgp: false,
    rate: defaults.rateE4 === null ? "" : formatScaled(defaults.rateE4, 4),
    discountKind: "none", discount: "", taxEnabled: false, taxLabel: "ضريبة", tax: "",
    notes: "", payment: defaults.payment, showQr: true, batches: [], lines: [],
  };
}

export function formFromDoc(doc: DocView): DocForm {
  return {
    docType: doc.docType, clientId: doc.client.id,
    company: doc.client.company, contact: doc.client.contact, email: doc.client.email, phone: doc.client.phone, address: doc.client.address,
    issueDate: doc.issueDate, dueDate: doc.dueDate ?? "",
    showUsd: doc.show.usd, showPoints: doc.show.points, showEgp: doc.show.egp,
    rate: doc.rateE4 === null ? "" : formatScaled(doc.rateE4, 4),
    discountKind: doc.discountKind,
    discount: doc.discountKind === "none" ? "" : formatScaled(doc.discountValue, 2),
    taxEnabled: doc.taxEnabled, taxLabel: doc.taxLabel, tax: doc.taxEnabled ? formatScaled(doc.taxBp, 2) : "",
    notes: doc.notes, payment: doc.paymentInstructions, showQr: doc.showInstapayQr,
    batches: doc.batches.map((b) => ({ ...b })),
    lines: doc.lines.map((l) => ({
      key: l.key, batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description,
      qty: String(l.quantity), unit: formatScaled(l.unitCc, 2), hidden: l.hidden,
    })),
  };
}

const intOr = (text: string, scale: number): number | null => (text.trim() === "" ? 0 : parseScaled(text, scale));

/** The strict conversion used by «حفظ»: the same schema as the server, so an error is caught before the request. */
export function formToInput(f: DocForm): { ok: true; input: DocumentInput } | { ok: false; error: string } {
  const rate = f.rate.trim() === "" ? null : parseScaled(f.rate, 4);
  if (f.rate.trim() !== "" && rate === null) return { ok: false, error: "سعر الصرف غير صالح (حتى ٤ منازل عشرية)." };
  const lines: DocumentInput["lines"] = [];
  for (let i = 0; i < f.lines.length; i++) {
    const l = f.lines[i];
    const quantity = parseScaled(l.qty, 0);
    const unitCc = parseScaled(l.unit, 2);
    if (quantity === null || quantity < 1) return { ok: false, error: `الكمية في البند ${i + 1} غير صالحة (رقم صحيح ١ أو أكثر).` };
    if (unitCc === null) return { ok: false, error: `سعر الوحدة في البند ${i + 1} غير صالح (بالسنت، حتى منزلتين عشريتين).` };
    lines.push({ batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description, quantity, unitCc, hidden: l.hidden });
  }
  let discountValue = 0;
  if (f.discountKind !== "none") {
    const v = intOr(f.discount, 2);
    if (v === null) return { ok: false, error: "قيمة الخصم غير صالحة." };
    discountValue = v; // percent -> basis points, dollars -> cents: both are the text with two decimals
  }
  let taxBp = 0;
  if (f.taxEnabled) {
    const v = intOr(f.tax, 2);
    if (v === null) return { ok: false, error: "نسبة الضريبة غير صالحة." };
    taxBp = v;
  }
  const parsed = parseInput(documentInputSchema, {
    clientId: f.clientId,
    client: { company: f.company, contact: f.contact, email: f.email, phone: f.phone, address: f.address },
    issueDate: f.issueDate, dueDate: f.dueDate ? f.dueDate : null,
    show: { usd: f.showUsd, points: f.showPoints, egp: f.showEgp },
    rateE4: rate,
    discount: { kind: f.discountKind, value: discountValue },
    tax: { enabled: f.taxEnabled, label: f.taxLabel, bp: taxBp },
    notes: f.notes, paymentInstructions: f.payment, showInstapayQr: f.showQr,
    batches: f.batches, lines,
  });
  return parsed.ok ? { ok: true, input: parsed.value } : { ok: false, error: parsed.error };
}

/** A tolerant DocView for the live preview: a number that cannot be read yet counts as 0, so typing never breaks the preview. */
export function formToPreview(f: DocForm, base: { id: string | null; number: string; status: DocStatus; revision: number; creditValueE4?: number; instapayAddress: string }): DocView {
  const rate = f.rate.trim() === "" ? null : parseScaled(f.rate, 4);
  const lines: LineInput[] = f.lines.map((l) => ({
    key: l.key, batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description,
    quantity: Math.max(0, parseScaled(l.qty, 0) ?? 0), unitCc: parseScaled(l.unit, 2) ?? 0, hidden: l.hidden,
  }));
  const discountRaw = f.discountKind === "none" ? 0 : intOr(f.discount, 2) ?? 0;
  const discountValue = f.discountKind === "percent" ? Math.min(discountRaw, 10000) : discountRaw;
  return {
    id: base.id, docType: f.docType, number: base.number, status: base.status, revision: base.revision,
    client: { id: f.clientId, company: f.company, contact: f.contact, email: f.email, phone: f.phone, address: f.address },
    issueDate: f.issueDate, dueDate: f.dueDate || null,
    show: { usd: f.showUsd || (!f.showPoints && !f.showEgp), points: f.showPoints && rate !== null, egp: f.showEgp && rate !== null },
    rateE4: rate, creditValueE4: base.creditValueE4 ?? CREDIT_VALUE_DEFAULT_E4,
    discountKind: f.discountKind, discountValue,
    taxEnabled: f.taxEnabled, taxLabel: f.taxLabel || "ضريبة", taxBp: f.taxEnabled ? Math.min(intOr(f.tax, 2) ?? 0, 10000) : 0,
    notes: f.notes, paymentInstructions: f.payment, instapayAddress: base.instapayAddress, showInstapayQr: f.showQr,
    paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null,
    batches: f.batches, lines, frozen: null,
  };
}
