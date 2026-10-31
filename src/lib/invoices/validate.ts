import { z } from "zod";
import { CREDIT_VALUE_DEFAULT_E4, MAX_BATCHES, MAX_LINE_CENTS, MAX_LINES, MAX_QUANTITY, MAX_UNIT_CC, RATE_MAX_E4, RATE_MIN_E4, lineCents } from "./money";
import type { DocView } from "./types";

/** User text goes through here before it is stored or printed: no emoji, no hidden direction marks or control characters. */
export function cleanText(value: string): string {
  return value
    .replace(/(?![©®™])\p{Extended_Pictographic}|️|⃣|‍/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‎‏‪-‮⁦-⁩﻿]/g, "")
    .trim();
}

const text = (max: number) => z.string().max(max).transform(cleanText);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
});
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const batchSchema = z.object({ key: z.string().min(1).max(60), title: text(120).refine((t) => t.length >= 1), summaryOnly: z.boolean() });
const lineSchema = z.object({
  batchKey: z.string().min(1).max(60).nullable(),
  itemTypeId: uuid.nullable(),
  itemTypeName: text(80),
  description: text(500),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  unitCc: z.number().int().min(0).max(MAX_UNIT_CC),
  hidden: z.boolean(),
});

export const documentInputSchema = z
  .object({
    clientId: uuid.nullable(),
    client: z.object({ company: text(160), contact: text(160), email: text(200), phone: text(60), address: text(400) }),
    issueDate: isoDate,
    dueDate: isoDate.nullable(),
    show: z.object({ usd: z.boolean(), points: z.boolean(), egp: z.boolean() }),
    rateE4: z.number().int().min(RATE_MIN_E4).max(RATE_MAX_E4).nullable(),
    discount: z.object({ kind: z.enum(["none", "amount", "percent"]), value: z.number().int().min(0).max(MAX_LINE_CENTS) }),
    tax: z.object({ enabled: z.boolean(), label: text(60), bp: z.number().int().min(0).max(10000) }),
    notes: text(1000),
    paymentInstructions: text(600),
    showInstapayQr: z.boolean(),
    batches: z.array(batchSchema).max(MAX_BATCHES),
    lines: z.array(lineSchema).max(MAX_LINES),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    const bad = (message: string, path: Array<string | number> = []) => ctx.addIssue({ code: "custom", message, path });
    if (!d.show.usd && !d.show.points && !d.show.egp) bad("اختر عملة واحدة على الأقل للعرض.", ["show"]);
    if ((d.show.points || d.show.egp) && d.rateE4 === null) bad("سعر الصرف مطلوب عند عرض النقاط أو الجنيه.", ["rateE4"]);
    if (d.dueDate && d.dueDate < d.issueDate) bad("تاريخ الاستحقاق قبل تاريخ الإصدار.", ["dueDate"]);
    if (d.discount.kind === "percent" && d.discount.value > 10000) bad("نسبة الخصم أكبر من ١٠٠٪.", ["discount", "value"]);
    if (d.discount.kind === "none" && d.discount.value !== 0) bad("قيمة خصم دون نوع.", ["discount", "value"]);
    const keys = new Set<string>();
    d.batches.forEach((b, i) => { if (keys.has(b.key)) bad("مفتاح مرحلة مكرر.", ["batches", i]); keys.add(b.key); });
    d.lines.forEach((l, i) => {
      if (l.batchKey !== null && !keys.has(l.batchKey)) bad("بند يشير إلى مرحلة غير موجودة.", ["lines", i, "batchKey"]);
      if (lineCents(l.quantity, l.unitCc) > MAX_LINE_CENTS) bad("إجمالي البند أكبر من الحد المسموح.", ["lines", i]);
    });
  });
export type DocumentInput = z.infer<typeof documentInputSchema>;

export const statusInputSchema = z.object({
  to: z.enum(["sent", "paid", "void"]),
  expectedRevision: z.number().int().min(1).optional(),
  paidAt: isoDate.optional(),
  reference: text(200).optional(),
  note: text(500).optional(),
});

export const itemTypeInputSchema = z.object({
  nameAr: text(80).refine((s) => s.length >= 1, "الاسم مطلوب"),
  unitCc: z.number().int().min(0).max(MAX_UNIT_CC),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

export const clientInputSchema = z.object({
  company: text(160).refine((s) => s.length >= 1, "اسم الشركة مطلوب"),
  contact: text(160), email: text(200), phone: text(60), address: text(400), notes: text(1000),
  archived: z.boolean().optional(),
});

export const settingsInputSchema = z.object({
  sellerName: text(120).refine((s) => s.length >= 1),
  sellerEmail: text(200), sellerWebsite: text(200),
  sellerTaxNumber: text(60), sellerCommercialRegister: text(60),
  /** the saved exchange rate (EGP per USD x 10,000): absent = unchanged, null = cleared */
  rateE4: z.number().int().min(RATE_MIN_E4).max(RATE_MAX_E4).nullable().optional(),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The first problem, in Arabic, with the field it concerns (never an internal path or a stack). */
export function parseInput<T>(schema: z.ZodType<T>, body: unknown): ParseResult<T> {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  const custom = issue.code === "custom" && issue.message && !/^Invalid/.test(issue.message) ? issue.message : "";
  return { ok: false, error: custom || `قيمة غير صالحة في الحقل «${issue.path.join(".") || "الطلب"}».` };
}

/**
 * A data statement («بيان بيانات») carries NO money: every unit price is 0, no discount, no tax, dollars only, no rate, no payment text or QR.
 * Applied on every create and save of a statement, so even a hand-made request cannot store a price on one (the database refuses it too).
 */
export function normalizeForStatement(input: DocumentInput): DocumentInput {
  return {
    ...input,
    show: { usd: true, points: false, egp: false },
    rateE4: null,
    discount: { kind: "none", value: 0 },
    tax: { enabled: false, label: input.tax.label, bp: 0 },
    paymentInstructions: "",
    showInstapayQr: false,
    dueDate: null,
    lines: input.lines.map((l) => ({ ...l, unitCc: 0 })),
  };
}

/** The document as the API input shape again (for re-saving, converting, duplicating). */
export function inputFromDoc(doc: DocView): DocumentInput {
  return {
    clientId: doc.client.id,
    client: { company: doc.client.company, contact: doc.client.contact, email: doc.client.email, phone: doc.client.phone, address: doc.client.address },
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    show: { ...doc.show },
    rateE4: doc.rateE4,
    discount: { kind: doc.discountKind, value: doc.discountValue },
    tax: { enabled: doc.taxEnabled, label: doc.taxLabel, bp: doc.taxBp },
    notes: doc.notes,
    paymentInstructions: doc.paymentInstructions,
    showInstapayQr: doc.showInstapayQr,
    batches: doc.batches.map((b) => ({ key: b.key, title: b.title, summaryOnly: b.summaryOnly })),
    lines: doc.lines.map((l) => ({ batchKey: l.batchKey, itemTypeId: l.itemTypeId, itemTypeName: l.itemTypeName, description: l.description, quantity: l.quantity, unitCc: l.unitCc, hidden: l.hidden })),
  };
}

/** The jsonb the SQL functions take. The point value and the Instapay address come from the SERVER (settings), never from the browser. */
export function toSqlPayload(input: DocumentInput, server: { creditValueE4: number; instapayAddress: string }): Record<string, unknown> {
  return {
    client_id: input.clientId,
    client_company: input.client.company, client_contact: input.client.contact, client_email: input.client.email,
    client_phone: input.client.phone, client_address: input.client.address,
    issue_date: input.issueDate, due_date: input.dueDate,
    show_usd: input.show.usd, show_points: input.show.points, show_egp: input.show.egp,
    rate_egp_per_usd_e4: input.rateE4,
    credit_value_e4: server.creditValueE4 || CREDIT_VALUE_DEFAULT_E4,
    discount_kind: input.discount.kind, discount_value: input.discount.value,
    tax_enabled: input.tax.enabled, tax_label: input.tax.label || "ضريبة", tax_bp: input.tax.bp,
    notes: input.notes, payment_instructions: input.paymentInstructions,
    instapay_address: server.instapayAddress, show_instapay_qr: input.showInstapayQr,
    batches: input.batches.map((b) => ({ key: b.key, title: b.title, summary_only: b.summaryOnly })),
    lines: input.lines.map((l) => ({
      batch_key: l.batchKey, item_type_id: l.itemTypeId, item_type_name: l.itemTypeName, description: l.description,
      quantity: l.quantity, unit_price_usd_centi_cents: l.unitCc, hidden: l.hidden,
    })),
  };
}
