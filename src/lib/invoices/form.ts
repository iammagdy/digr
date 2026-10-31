import { toArabicDigits } from "@/lib/arabicDigits";
import { fmtRate } from "./format";
import { CREDIT_VALUE_DEFAULT_E4, RATE_MAX_E4, RATE_MIN_E4, formatScaled, parseScaled } from "./money";
import { parseUnitUsd, unitUsdText } from "./priceInput";
import type { BatchInput, DiscountKind, DocStatus, DocType, DocView, LineInput } from "./types";
import { documentInputSchema, parseInput, type DocumentInput } from "./validate";

/** The builder's form: every number is the TEXT the owner typed; it becomes an integer only here (parseScaled: no float). */
/** `unit` is the unit price TEXT IN US DOLLARS («0.12» = 12 cents, up to 4 decimals); it becomes hundredths of a cent only in the strict/tolerant conversions below. */
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
      qty: String(l.quantity), unit: unitUsdText(l.unitCc), hidden: l.hidden,
    })),
  };
}

/** The tolerant read for the live preview only: an unreadable price shows as 0 AND `unitErrors` puts a red message next to its box, so it is never a silent 0. */
const unitCcOf = (text: string): number => { const r = parseUnitUsd(text); return r.ok ? r.cc : 0; };

/** The red message for every price box whose text cannot be stored exactly (line key -> Arabic sentence). A data statement has no prices. */
export function unitErrors(form: DocForm): Record<string, string> {
  if (form.docType === "statement") return {};
  const out: Record<string, string> = {};
  for (const l of form.lines) {
    const r = parseUnitUsd(l.unit);
    if (!r.ok) out[l.key] = r.error;
  }
  return out;
}

/** The exchange-rate box is on screen whenever points or EGP are shown (never hidden by what is typed in it, so a second digit can always be typed). */
export function showRateBox(f: Pick<DocForm, "docType" | "showPoints" | "showEgp">): boolean {
  return f.docType !== "statement" && (f.showPoints || f.showEgp);
}

/** A typo guard, not a rule: a rate far from the usual range (the owner typed «5» meaning «50») gets a visible question next to the box. */
export function rateSanityWarning(text: string): string | null {
  const rate = parseScaled(text, 4);
  if (rate === null || rate < RATE_MIN_E4 || rate > RATE_MAX_E4) return null;
  const LOW = 20 * 10_000, HIGH = 200 * 10_000;
  if (rate >= LOW && rate <= HIGH) return null;
  const guess = rate < LOW ? rate * 10 : Math.round(rate / 10);
  const hint = guess >= LOW && guess <= HIGH && guess >= RATE_MIN_E4 ? ` هل تقصد ${fmtRate(guess)}؟` : " راجعه قبل المتابعة.";
  return `تأكد من سعر الصرف: المكتوب ${fmtRate(rate)} جنيه للدولار.${hint}`;
}

const intOr = (text: string, scale: number): number | null => (text.trim() === "" ? 0 : parseScaled(text, scale));

/** The strict conversion used by «حفظ»: the same schema as the server, so an error is caught before the request. */
export function formToInput(form: DocForm): { ok: true; input: DocumentInput } | { ok: false; error: string } {
  // a data statement («بيان بيانات») has no money: whatever is left in the money fields of the form is ignored
  const f: DocForm = form.docType === "statement" ? { ...form, showUsd: true, showPoints: false, showEgp: false, rate: "", discountKind: "none", discount: "", taxEnabled: false, tax: "" } : form;
  const rate = f.rate.trim() === "" ? null : parseScaled(f.rate, 4);
  if (f.rate.trim() !== "" && rate === null) return { ok: false, error: "سعر الصرف غير صالح (حتى ٤ منازل عشرية)." };
  const lines: DocumentInput["lines"] = [];
  for (let i = 0; i < f.lines.length; i++) {
    const l = f.lines[i];
    const quantity = parseScaled(l.qty, 0);
    const unit = parseUnitUsd(l.unit);
    if (quantity === null || quantity < 1) return { ok: false, error: `الكمية في البند ${toArabicDigits(i + 1)} غير صالحة (رقم صحيح ١ أو أكثر).` };
    if (!unit.ok) return { ok: false, error: `سعر الوحدة في البند ${toArabicDigits(i + 1)}: ${unit.error}` };
    lines.push({ batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description, quantity, unitCc: unit.cc, hidden: l.hidden });
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

/** Points or EGP are wanted but no usable rate is typed or saved. */
export function rateIsMissing(f: Pick<DocForm, "showPoints" | "showEgp" | "rate">): boolean {
  return (f.showPoints || f.showEgp) && (f.rate.trim() === "" || parseScaled(f.rate, 4) === null);
}

/** A tolerant DocView for the live preview: a number that cannot be read yet counts as 0, so typing never breaks the preview. */
export function formToPreview(form: DocForm, base: { id: string | null; number: string; status: DocStatus; revision: number; creditValueE4?: number; instapayAddress: string }): DocView {
  const f: DocForm = form.docType === "statement" ? { ...form, showUsd: true, showPoints: false, showEgp: false, rate: "", discountKind: "none", discount: "", taxEnabled: false, tax: "" } : form;
  const rate = f.rate.trim() === "" ? null : parseScaled(f.rate, 4);
  const lines: LineInput[] = f.lines.map((l) => ({
    key: l.key, batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description,
    quantity: Math.max(0, parseScaled(l.qty, 0) ?? 0), unitCc: unitCcOf(l.unit), hidden: l.hidden,
  }));
  const discountRaw = f.discountKind === "none" ? 0 : intOr(f.discount, 2) ?? 0;
  const discountValue = f.discountKind === "percent" ? Math.min(discountRaw, 10000) : discountRaw;
  return {
    id: base.id, docType: f.docType, number: base.number, status: base.status, revision: base.revision,
    client: { id: f.clientId, company: f.company, contact: f.contact, email: f.email, phone: f.phone, address: f.address },
    issueDate: f.issueDate, dueDate: f.dueDate || null,
    // Points and EGP need a rate. Without one the dollar total is shown instead (never an empty totals box); the builder says why next to the field.
    show: { usd: f.showUsd || rateIsMissing(f) || (!f.showPoints && !f.showEgp), points: f.showPoints && rate !== null, egp: f.showEgp && rate !== null },
    rateE4: rate, creditValueE4: base.creditValueE4 ?? CREDIT_VALUE_DEFAULT_E4,
    discountKind: f.discountKind, discountValue,
    taxEnabled: f.taxEnabled, taxLabel: f.taxLabel || "ضريبة", taxBp: f.taxEnabled ? Math.min(intOr(f.tax, 2) ?? 0, 10000) : 0,
    notes: f.notes, paymentInstructions: f.payment, instapayAddress: base.instapayAddress, showInstapayQr: f.showQr,
    paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null,
    batches: f.batches, lines, frozen: null,
  };
}
