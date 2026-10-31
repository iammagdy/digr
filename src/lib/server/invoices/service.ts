import { computeTotals, toFrozenPayload } from "@/lib/invoices/totals";
import { CREDIT_VALUE_DEFAULT_E4, CREDIT_VALUE_MAX_E4, CREDIT_VALUE_MIN_E4, parseScaled } from "@/lib/invoices/money";
import { documentInputSchema, inputFromDoc, parseInput, toSqlPayload, type DocumentInput } from "@/lib/invoices/validate";
import type { DocType, DocView, ListItem, SellerBlock, StatusEvent } from "@/lib/invoices/types";
import { todayCairo } from "@/lib/invoices/dates";
import { rowToDoc, rowToEvent, rowToListItem } from "./rows";

/**
 * The invoice data layer. It touches ONLY the invoice_* tables and the three invoice_* SQL functions (plus ONE read of the public pricing settings row
 * for the Instapay address and the point value). It never reads or writes the wallet: no ledger, balance, mission, reserve or charge table.
 * Every document write is a call to a SQL function (one transaction, row locked, status event written with the admin id).
 */
export interface InvoiceDb {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
}

export class InvoiceError extends Error {
  constructor(public code: string, public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

const DB_ERRORS: Record<string, [number, string]> = {
  invoice_locked: [409, "الوثيقة مقفلة بعد الإرسال ولا تُعدَّل. للتصحيح ألغِها وانسخها كوثيقة جديدة."],
  invoice_stale: [409, "تغيّرت الوثيقة منذ فتحتها. أعد تحميل الصفحة ثم حاول مرة أخرى."],
  invoice_not_found: [404, "الوثيقة غير موجودة."],
  invoice_bad_transition: [409, "هذا التغيير في الحالة غير مسموح به."],
  invoice_status_via_function_only: [409, "هذا التغيير في الحالة غير مسموح به."],
  invoice_no_lines: [400, "أضف بندًا واحدًا على الأقل قبل الإرسال."],
  invoice_paid_date_required: [400, "تاريخ الدفع مطلوب."],
  invoice_too_large: [400, "عدد البنود أو المراحل أكبر من الحد المسموح."],
  invoice_unknown_batch: [400, "بند يشير إلى مرحلة غير موجودة."],
  invoice_frozen_required: [400, "تعذّر تثبيت الأرقام. راجع سعر الصرف وأعد المحاولة."],
};

/** Turns a database error into an Arabic InvoiceError (never the raw message, never a table or column name). */
export function dbError(error: any): InvoiceError {
  const message = String(error?.message ?? "");
  for (const [code, [status, text]] of Object.entries(DB_ERRORS)) if (message.includes(code)) return new InvoiceError(code, status, text);
  if (error?.code === "23505") return new InvoiceError("duplicate", 409, "هذا الاسم مستخدم من قبل.");
  if (error?.code === "23514" || error?.code === "22P02" || error?.code === "23503") return new InvoiceError("invalid", 400, "بيانات غير صالحة. راجع الحقول وحاول مرة أخرى.");
  return new InvoiceError("db", 500, "تعذّر تنفيذ العملية الآن. أعد المحاولة بعد قليل.");
}

async function ok<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw dbError(error);
  return data;
}

export { todayCairo };

// ---------- settings (seller text, remembered rate) and defaults ----------

export interface PricingSettings { instapayAddress: string; creditValueE4: number }

/** ONE read-only look at the public pricing settings row (Instapay address and point value). `readRow` is the admin adapter's getRow. */
export async function readPricingSettings(readRow: () => Promise<any>): Promise<PricingSettings> {
  let row: any = null;
  try { row = await readRow(); } catch { row = null; }
  const credit = row?.creditValueEgp ?? row?.credit_value_egp;
  const e4 = credit === undefined || credit === null ? null : parseScaled(String(credit), 4);
  return { instapayAddress: String(row?.ipa ?? "").trim().slice(0, 120), creditValueE4: e4 && e4 >= CREDIT_VALUE_MIN_E4 && e4 <= CREDIT_VALUE_MAX_E4 ? e4 : CREDIT_VALUE_DEFAULT_E4 };
}

export interface InvoiceSettings { seller: SellerBlock; lastRateE4: number | null }

export async function getSettings(db: InvoiceDb): Promise<InvoiceSettings> {
  const rows = await ok<any[]>(db.from("invoice_settings").select("*").limit(1));
  const r = rows?.[0] ?? {};
  return {
    seller: { name: r.seller_name_ar ?? "ديجر", email: r.seller_email ?? "", website: r.seller_website ?? "", taxNumber: r.seller_tax_number ?? "", commercialRegister: r.seller_commercial_register ?? "" },
    lastRateE4: r.last_rate_egp_per_usd_e4 === null || r.last_rate_egp_per_usd_e4 === undefined ? null : Number(r.last_rate_egp_per_usd_e4),
  };
}

export async function updateSeller(db: InvoiceDb, adminId: string, input: { sellerName: string; sellerEmail: string; sellerWebsite: string; sellerTaxNumber: string; sellerCommercialRegister: string }): Promise<void> {
  await ok(db.from("invoice_settings").update({
    seller_name_ar: input.sellerName, seller_email: input.sellerEmail, seller_website: input.sellerWebsite,
    seller_tax_number: input.sellerTaxNumber || null, seller_commercial_register: input.sellerCommercialRegister || null,
    updated_at: new Date().toISOString(), updated_by: adminId,
  }).eq("id", true));
}

async function rememberRate(db: InvoiceDb, rateE4: number | null): Promise<void> {
  if (rateE4 === null) return;
  try { await db.from("invoice_settings").update({ last_rate_egp_per_usd_e4: rateE4 }).eq("id", true); } catch { /* only a convenience */ }
}

// ---------- reading documents ----------

export async function loadDocument(db: InvoiceDb, id: string): Promise<{ doc: DocView; events: StatusEvent[] } | null> {
  const rows = await ok<any[]>(db.from("invoice_documents").select("*").eq("id", id).limit(1));
  if (!rows?.length) return null;
  const [batches, lines, events] = await Promise.all([
    ok<any[]>(db.from("invoice_batches").select("*").eq("document_id", id)),
    ok<any[]>(db.from("invoice_lines").select("*").eq("document_id", id)),
    ok<any[]>(db.from("invoice_status_events").select("*").eq("document_id", id).order("id", { ascending: true })),
  ]);
  return { doc: rowToDoc(rows[0], batches ?? [], lines ?? []), events: (events ?? []).map(rowToEvent) };
}

export interface ListFilter { status?: string; clientId?: string; docType?: string; q?: string; limit?: number; offset?: number }

export async function listDocuments(db: InvoiceDb, f: ListFilter = {}): Promise<{ items: ListItem[]; unpaid: { count: number; usd: number; points: number | null; egp: number | null } }> {
  const limit = Math.min(Math.max(Math.floor(f.limit ?? 50), 1), 100);
  const offset = Math.max(Math.floor(f.offset ?? 0), 0);
  let query = db.from("invoice_documents").select("*").order("created_at", { ascending: false });
  if (f.status && ["draft", "sent", "paid", "void"].includes(f.status)) query = query.eq("status", f.status);
  if (f.docType && ["quote", "invoice"].includes(f.docType)) query = query.eq("doc_type", f.docType);
  if (f.clientId) query = query.eq("client_id", f.clientId);
  const rows = await ok<any[]>(query.range(offset, offset + limit - 1));
  const needle = (f.q ?? "").trim().toLowerCase();
  const picked = (rows ?? []).filter((r) => !needle || `${r.number} ${r.client_company}`.toLowerCase().includes(needle));
  const drafts = picked.filter((r) => r.status === "draft").map((r) => r.id);
  const draftLines = drafts.length ? await ok<any[]>(db.from("invoice_lines").select("*").in("document_id", drafts)) : [];
  const items = picked.map((r) => {
    if (r.status !== "draft" && r.total_usd_cents !== null && r.total_usd_cents !== undefined) {
      return rowToListItem(r, { usd: Number(r.total_usd_cents), points: r.total_points === null ? null : Number(r.total_points), egp: r.total_egp_qirsh === null ? null : Number(r.total_egp_qirsh) });
    }
    const lines = (draftLines ?? []).filter((l) => l.document_id === r.id).map((l) => ({ quantity: Number(l.quantity), unitCc: Number(l.unit_price_usd_centi_cents) }));
    const t = computeTotals(lines, {
      rateE4: r.rate_egp_per_usd_e4 === null ? null : Number(r.rate_egp_per_usd_e4), creditValueE4: Number(r.credit_value_e4) || CREDIT_VALUE_DEFAULT_E4,
      discountKind: r.discount_kind, discountValue: Number(r.discount_value), taxEnabled: Boolean(r.tax_enabled), taxLabel: r.tax_label, taxBp: Number(r.tax_bp),
    });
    return rowToListItem(r, t.total);
  });

  // the unpaid figure: issued invoices («مرسلة») only; quotes are never money owed
  const open = await ok<any[]>(db.from("invoice_documents").select("total_usd_cents,total_points,total_egp_qirsh").eq("doc_type", "invoice").eq("status", "sent").limit(5000));
  const list = open ?? [];
  const sum = (key: string): number | null => (list.some((r) => r[key] === null || r[key] === undefined) ? null : list.reduce((s, r) => s + Number(r[key]), 0));
  return { items, unpaid: { count: list.length, usd: list.reduce((s, r) => s + Number(r.total_usd_cents ?? 0), 0), points: sum("total_points"), egp: sum("total_egp_qirsh") } };
}

// ---------- writing documents (every write is one SQL function call) ----------

export async function createDocument(db: InvoiceDb, adminId: string, docType: DocType, input: DocumentInput, pricing: PricingSettings, extra: { convertedFrom?: string; duplicatedFrom?: string; creditValueE4?: number } = {}): Promise<string> {
  const payload = toSqlPayload(input, { creditValueE4: extra.creditValueE4 ?? pricing.creditValueE4, instapayAddress: pricing.instapayAddress });
  const id = await ok<string>(db.rpc("invoice_create_document", {
    p_admin: adminId, p_type: docType, p_payload: payload, p_converted_from: extra.convertedFrom ?? null, p_duplicated_from: extra.duplicatedFrom ?? null,
  }));
  await rememberRate(db, input.rateE4);
  return id;
}

async function currentRow(db: InvoiceDb, id: string): Promise<any> {
  const rows = await ok<any[]>(db.from("invoice_documents").select("id,status,revision,credit_value_e4,doc_type").eq("id", id).limit(1));
  if (!rows?.length) throw new InvoiceError("invoice_not_found", 404, DB_ERRORS.invoice_not_found[1]);
  return rows[0];
}

export async function saveDraft(db: InvoiceDb, adminId: string, id: string, input: DocumentInput, pricing: PricingSettings): Promise<number> {
  const row = await currentRow(db, id);
  if (row.status !== "draft") throw new InvoiceError("invoice_locked", 409, DB_ERRORS.invoice_locked[1]);
  const revision = input.expectedRevision ?? Number(row.revision);
  const payload = toSqlPayload(input, { creditValueE4: Number(row.credit_value_e4) || CREDIT_VALUE_DEFAULT_E4, instapayAddress: pricing.instapayAddress });
  const next = await ok<number>(db.rpc("invoice_save_draft", { p_id: id, p_admin: adminId, p_expected_revision: revision, p_payload: payload }));
  await rememberRate(db, input.rateE4);
  return Number(next);
}

export interface StatusRequest { to: "sent" | "paid" | "void"; expectedRevision?: number; paidAt?: string; reference?: string; note?: string }

/**
 * «مرسلة»: re-saves the draft exactly as stored (so the Instapay text and every field are the ones frozen), computes the totals with the pure money code,
 * and asks the database to freeze them (the database re-checks the line count and the USD sum). «مدفوعة» and «ملغية» only change the status.
 * Nothing here touches points, a wallet or the ledger.
 */
export async function setStatus(db: InvoiceDb, adminId: string, id: string, req: StatusRequest, pricing: PricingSettings): Promise<void> {
  const loaded = await loadDocument(db, id);
  if (!loaded) throw new InvoiceError("invoice_not_found", 404, DB_ERRORS.invoice_not_found[1]);
  const { doc } = loaded;
  if (req.to === "sent") {
    if (doc.status !== "draft") throw new InvoiceError("invoice_bad_transition", 409, DB_ERRORS.invoice_bad_transition[1]);
    if (req.expectedRevision !== undefined && req.expectedRevision !== doc.revision) throw new InvoiceError("invoice_stale", 409, DB_ERRORS.invoice_stale[1]);
    if (!doc.client.company) throw new InvoiceError("client_required", 400, "اسم الشركة (العميل) مطلوب قبل الإرسال.");
    if (!doc.lines.length) throw new InvoiceError("invoice_no_lines", 400, DB_ERRORS.invoice_no_lines[1]);
    const again = parseInput(documentInputSchema, inputFromDoc(doc));
    if (!again.ok) throw new InvoiceError("invalid", 400, again.error);
    const revision = await saveDraft(db, adminId, id, { ...again.value, expectedRevision: doc.revision }, pricing);
    const fresh = await loadDocument(db, id);
    if (!fresh) throw new InvoiceError("invoice_not_found", 404, DB_ERRORS.invoice_not_found[1]);
    const totals = computeTotals(fresh.doc.lines, fresh.doc);
    await ok(db.rpc("invoice_set_status", {
      p_id: id, p_admin: adminId, p_to: "sent", p_expected_revision: revision, p_frozen: toFrozenPayload(fresh.doc.lines.map((l) => l.key), totals),
      p_paid_at: null, p_reference: null, p_note: req.note ?? "",
    }));
    return;
  }
  if (req.to === "paid") {
    if (doc.docType !== "invoice") throw new InvoiceError("invoice_bad_transition", 409, "تسجيل الدفع للفواتير فقط.");
    if (!req.paidAt) throw new InvoiceError("invoice_paid_date_required", 400, DB_ERRORS.invoice_paid_date_required[1]);
  }
  await ok(db.rpc("invoice_set_status", {
    p_id: id, p_admin: adminId, p_to: req.to, p_expected_revision: null, p_frozen: null,
    p_paid_at: req.to === "paid" ? req.paidAt : null, p_reference: req.to === "paid" ? req.reference ?? "" : null, p_note: req.note ?? "",
  }));
}

/** A copy as a new DRAFT of the same type (the correction path after «ملغية»): same client, batches, lines, display options and rate; issue date today. */
export async function duplicateDocument(db: InvoiceDb, adminId: string, id: string, pricing: PricingSettings, today: string = todayCairo()): Promise<string> {
  const loaded = await loadDocument(db, id);
  if (!loaded) throw new InvoiceError("invoice_not_found", 404, DB_ERRORS.invoice_not_found[1]);
  const input = copyInput(loaded.doc, today);
  return createDocument(db, adminId, loaded.doc.docType, input, pricing, { duplicatedFrom: id, creditValueE4: loaded.doc.creditValueE4 });
}

/** An issued quote -> a NEW invoice draft with the quote's lines and its FROZEN rate (the rate the client approved); the owner may change it only while the invoice is a draft. */
export async function convertQuote(db: InvoiceDb, adminId: string, id: string, pricing: PricingSettings, today: string = todayCairo()): Promise<string> {
  const loaded = await loadDocument(db, id);
  if (!loaded) throw new InvoiceError("invoice_not_found", 404, DB_ERRORS.invoice_not_found[1]);
  const { doc } = loaded;
  if (doc.docType !== "quote") throw new InvoiceError("not_a_quote", 409, "التحويل لعروض الأسعار فقط.");
  if (doc.status !== "sent" && doc.status !== "paid") throw new InvoiceError("quote_not_issued", 409, "أرسل عرض السعر أولًا ثم حوّله إلى فاتورة.");
  const existing = await ok<any[]>(db.from("invoice_documents").select("id,status").eq("converted_from_id", id).limit(10));
  const live = (existing ?? []).find((r) => r.status !== "void");
  if (live) throw new InvoiceError("already_converted", 409, "تم تحويل عرض السعر هذا إلى فاتورة من قبل.", { existingId: String(live.id) });
  const input = copyInput(doc, today);
  return createDocument(db, adminId, "invoice", input, pricing, { convertedFrom: id, creditValueE4: doc.creditValueE4 });
}

function copyInput(doc: DocView, today: string): DocumentInput {
  const base = inputFromDoc(doc);
  return { ...base, issueDate: today, dueDate: null };
}

// ---------- item types ----------

export interface ItemType { id: string; nameAr: string; unitCc: number; sortOrder: number; isActive: boolean }
const toType = (r: any): ItemType => ({ id: String(r.id), nameAr: r.name_ar, unitCc: Number(r.default_unit_price_usd_centi_cents), sortOrder: Number(r.sort_order), isActive: Boolean(r.is_active) });

export async function listItemTypes(db: InvoiceDb): Promise<ItemType[]> {
  const rows = await ok<any[]>(db.from("invoice_item_types").select("*").order("sort_order", { ascending: true }));
  return (rows ?? []).map(toType);
}
export async function createItemType(db: InvoiceDb, adminId: string, i: { nameAr: string; unitCc: number; sortOrder?: number }): Promise<ItemType> {
  const rows = await ok<any[]>(db.from("invoice_item_types").insert({ name_ar: i.nameAr, default_unit_price_usd_centi_cents: i.unitCc, sort_order: i.sortOrder ?? 100, updated_by: adminId }).select("*"));
  return toType(rows[0]);
}
export async function updateItemType(db: InvoiceDb, adminId: string, id: string, i: { nameAr: string; unitCc: number; sortOrder?: number; isActive?: boolean }): Promise<ItemType> {
  const patch: Record<string, unknown> = { name_ar: i.nameAr, default_unit_price_usd_centi_cents: i.unitCc, updated_at: new Date().toISOString(), updated_by: adminId };
  if (i.sortOrder !== undefined) patch.sort_order = i.sortOrder;
  if (i.isActive !== undefined) patch.is_active = i.isActive;
  const rows = await ok<any[]>(db.from("invoice_item_types").update(patch).eq("id", id).select("*"));
  if (!rows?.length) throw new InvoiceError("not_found", 404, "نوع البند غير موجود.");
  return toType(rows[0]);
}

// ---------- clients ----------

export interface Client { id: string; company: string; contact: string; email: string; phone: string; address: string; notes: string; archived: boolean }
const toClient = (r: any): Client => ({ id: String(r.id), company: r.company_name, contact: r.contact_name, email: r.email, phone: r.phone, address: r.address, notes: r.notes, archived: Boolean(r.archived) });
const clientRow = (adminId: string, c: { company: string; contact: string; email: string; phone: string; address: string; notes: string; archived?: boolean }) => ({
  company_name: c.company, contact_name: c.contact, email: c.email, phone: c.phone, address: c.address, notes: c.notes, ...(c.archived === undefined ? {} : { archived: c.archived }), updated_by: adminId,
});

export async function listClients(db: InvoiceDb): Promise<Client[]> {
  const rows = await ok<any[]>(db.from("invoice_clients").select("*").order("company_name", { ascending: true }));
  return (rows ?? []).map(toClient);
}
export async function createClient(db: InvoiceDb, adminId: string, c: Parameters<typeof clientRow>[1]): Promise<Client> {
  const rows = await ok<any[]>(db.from("invoice_clients").insert(clientRow(adminId, c)).select("*"));
  return toClient(rows[0]);
}
export async function updateClient(db: InvoiceDb, adminId: string, id: string, c: Parameters<typeof clientRow>[1]): Promise<Client> {
  const rows = await ok<any[]>(db.from("invoice_clients").update({ ...clientRow(adminId, c), updated_at: new Date().toISOString() }).eq("id", id).select("*"));
  if (!rows?.length) throw new InvoiceError("not_found", 404, "العميل غير موجود.");
  return toClient(rows[0]);
}
