import { beforeEach, describe, expect, it } from "vitest";
import {
  InvoiceError, convertQuote, createDocument, createItemType, duplicateDocument, getSettings, listDocuments, loadDocument, readPricingSettings, saveDraft, setStatus, updateItemType, updateSeller,
  type InvoiceDb,
} from "../src/lib/server/invoices/service";
import { computeTotals } from "../src/lib/invoices/totals";
import { totalsForDoc } from "../src/lib/invoices/totals";
import type { DocumentInput } from "../src/lib/invoices/validate";
import { InvoiceDbModel } from "./helpers/invoiceDb";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";
const PRICING = { instapayAddress: "iammagdy@instapay", creditValueE4: 1000 };

let model: InvoiceDbModel;
let db: InvoiceDb;
beforeEach(() => { model = new InvoiceDbModel(); db = model as unknown as InvoiceDb; });

const input = (over: Partial<DocumentInput> = {}): DocumentInput => ({
  clientId: null,
  client: { company: "شركة النور", contact: "أحمد", email: "a@alnour.com", phone: "+201001234567", address: "القاهرة" },
  issueDate: "2026-10-31", dueDate: "2026-11-14",
  show: { usd: true, points: true, egp: false }, rateE4: 507_500,
  discount: { kind: "percent", value: 1000 }, tax: { enabled: false, label: "ضريبة", bp: 0 },
  notes: "ملاحظة", paymentInstructions: "الدفع عبر إنستا باي", showInstapayQr: true,
  batches: [{ key: "b1", title: "المرحلة ١ — ٥٠ شركة", summaryOnly: false }],
  lines: [
    { batchKey: "b1", itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 250, unitCc: 1200, hidden: false },
    { batchKey: "b1", itemTypeId: null, itemTypeName: "مدير", description: "", quantity: 50, unitCc: 3500, hidden: true },
  ],
  ...over,
});

async function draft(type: "quote" | "invoice" = "invoice", over: Partial<DocumentInput> = {}): Promise<string> {
  return createDocument(db, ADMIN, type, input(over), PRICING);
}
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "no error"; } catch (e) { return e instanceof InvoiceError ? e.code : `other:${String(e)}`; } };

describe("numbering is made by the database: sequential, unique, never reused", () => {
  it("INV-2026-0001, 0002 and QUO-2026-0001 count separately", async () => {
    const a = await loadDocument(db, await draft("invoice"));
    const b = await loadDocument(db, await draft("invoice"));
    const q = await loadDocument(db, await draft("quote"));
    expect([a!.doc.number, b!.doc.number, q!.doc.number]).toEqual(["INV-2026-0001", "INV-2026-0002", "QUO-2026-0001"]);
  });
  it("a voided document's number is not reused", async () => {
    const first = await draft();
    await setStatus(db, ADMIN, first, { to: "void" }, PRICING);
    const second = await loadDocument(db, await draft());
    expect(second!.doc.number).toBe("INV-2026-0002");
  });
  it("a rejected create leaves no half document and no consumed state (the function is one transaction)", async () => {
    const bad = input({ lines: [{ batchKey: "nope", itemTypeId: null, itemTypeName: "", description: "", quantity: 1, unitCc: 1, hidden: false }] });
    // the schema layer refuses it before the database; the model refuses a payload that slips through
    const r = await model.rpc("invoice_create_document", { p_admin: ADMIN, p_type: "invoice", p_payload: { batches: [], lines: [{ batch_key: "x", quantity: 1, unit_price_usd_centi_cents: 1 }] } });
    expect(r.error.message).toContain("invoice_unknown_batch");
    expect(model.tables.invoice_documents).toHaveLength(0);
    expect(bad.lines).toHaveLength(1);
  });
  it("the counter restarts each year and keeps going past 9999 without cutting digits", async () => {
    model.now = () => new Date("2027-01-05T10:00:00Z");
    expect((await loadDocument(db, await draft()))!.doc.number).toBe("INV-2027-0001");
    model.tables.invoice_number_counters.find((c) => c.year === 2027)!.last_value = 9999;
    expect((await loadDocument(db, await draft()))!.doc.number).toBe("INV-2027-10000");
  });
});

describe("a draft is edited freely; a stale screen cannot overwrite a newer one", () => {
  it("save bumps the revision and replaces lines and batches", async () => {
    const id = await draft();
    const r = await saveDraft(db, ADMIN, id, { ...input({ lines: [{ batchKey: null, itemTypeId: null, itemTypeName: "شركة", description: "x", quantity: 3, unitCc: 45, hidden: false }], batches: [] }), expectedRevision: 1 }, PRICING);
    expect(r).toBe(2);
    const { doc } = (await loadDocument(db, id))!;
    expect(doc.revision).toBe(2);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ quantity: 3, unitCc: 45 });
    expect(doc.batches).toHaveLength(0);
  });
  it("an older revision is refused with «تغيّرت الوثيقة»", async () => {
    const id = await draft();
    await saveDraft(db, ADMIN, id, { ...input(), expectedRevision: 1 }, PRICING);
    expect(await code(saveDraft(db, ADMIN, id, { ...input(), expectedRevision: 1 }, PRICING))).toBe("invoice_stale");
  });
  it("the point value and the Instapay address come from the server settings, not from the screen", async () => {
    const id = await createDocument(db, ADMIN, "invoice", input(), { instapayAddress: "iammagdy@instapay", creditValueE4: 1200 });
    const { doc } = (await loadDocument(db, id))!;
    expect(doc.creditValueE4).toBe(1200);
    expect(doc.instapayAddress).toBe("iammagdy@instapay");
  });
});

describe("«مرسلة»: totals are frozen, the document is locked, every change is logged with the admin", () => {
  it("freezes the same numbers the sheet computes, per line and per document", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    const { doc, events } = (await loadDocument(db, id))!;
    expect(doc.status).toBe("sent");
    expect(doc.lockedAt).not.toBeNull();
    const live = computeTotals(doc.lines, doc);
    expect(doc.frozen).toEqual(live);
    expect(doc.frozen!.subtotal).toEqual({ usd: 4750, points: 24106, egp: 241063 });
    expect(doc.frozen!.total.usd).toBe(4275);
    expect(doc.lines.map((l) => l.frozenPoints)).toEqual([15225, 8881]);
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.adminId])).toEqual([[null, "draft", ADMIN], ["draft", "sent", ADMIN]]);
  });
  it("refuses edits to lines, prices, rate and client after it is sent (app and database), and direct writes", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    expect(await code(saveDraft(db, ADMIN, id, { ...input({ rateE4: 600_000 }), expectedRevision: 2 }, PRICING))).toBe("invoice_locked");
    const direct = await db.from("invoice_lines").update({ quantity: 1 }).eq("document_id", id);
    expect(direct.error?.code).toBe("42501");
    const directDoc = await db.from("invoice_documents").update({ rate_egp_per_usd_e4: 1 }).eq("id", id);
    expect(directDoc.error?.code).toBe("42501");
    const rpc = await model.rpc("invoice_save_draft", { p_id: id, p_admin: ADMIN, p_expected_revision: 2, p_payload: {} });
    expect(rpc.error.message).toContain("invoice_locked");
  });
  it("a later change of the rate or of the item types never alters an issued document's printed numbers", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    const before = totalsForDoc((await loadDocument(db, id))!.doc);
    await db.from("invoice_settings").update({ last_rate_egp_per_usd_e4: 900_000 }).eq("id", true);
    const row = model.tables.invoice_documents.find((d) => d.id === id)!;
    row.rate_egp_per_usd_e4 = 900_000; // even if the stored rate column were touched, the printed numbers are the frozen ones
    const after = totalsForDoc((await loadDocument(db, id))!.doc);
    expect(after).toEqual(before);
  });
  it("needs at least one line (the client is optional since INVOICES SIMPLE 1), and re-saves the Instapay text as of the moment of sending", async () => {
    // owner feedback (INVOICES SIMPLE 1): the client is OPTIONAL, so a document with no client can be sent; it still needs a line
    expect(await code(setStatus(db, ADMIN, await draft("invoice", { client: { company: "", contact: "", email: "", phone: "", address: "" } }), { to: "sent" }, PRICING))).toBe("no error");
    expect(await code(setStatus(db, ADMIN, await draft("invoice", { lines: [], batches: [] }), { to: "sent" }, PRICING))).toBe("invoice_no_lines");
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, { instapayAddress: "other@instapay", creditValueE4: 1000 });
    expect((await loadDocument(db, id))!.doc.instapayAddress).toBe("other@instapay");
  });
  it("refuses to send when the screen is stale", async () => {
    const id = await draft();
    expect(await code(setStatus(db, ADMIN, id, { to: "sent", expectedRevision: 7 }, PRICING))).toBe("invoice_stale");
  });
  it("a frozen payload that does not match the lines is refused by the database", async () => {
    const id = await draft();
    const lines = model.tables.invoice_lines.filter((l) => l.document_id === id);
    const r = await model.rpc("invoice_set_status", { p_id: id, p_admin: ADMIN, p_to: "sent", p_expected_revision: 1, p_frozen: { lines: lines.map((l) => ({ id: l.id, points: 1, egp: 1 })), totals: { subtotal_usd_cents: 1 } }, p_paid_at: null, p_reference: null, p_note: "" });
    expect(r.error.message).toContain("invoice_stale");
    expect(model.tables.invoice_documents.find((d) => d.id === id)!.status).toBe("draft");
  });
});

describe("«مدفوعة» is final; «ملغية» is final; the log is append-only", () => {
  it("paid needs a date, records the reference and the admin, and cannot be undone", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    expect(await code(setStatus(db, OTHER_ADMIN, id, { to: "paid" }, PRICING))).toBe("invoice_paid_date_required");
    await setStatus(db, OTHER_ADMIN, id, { to: "paid", paidAt: "2026-11-02", reference: "IPN-77" }, PRICING);
    const { doc, events } = (await loadDocument(db, id))!;
    expect(doc).toMatchObject({ status: "paid", paidAt: "2026-11-02", paymentReference: "IPN-77" });
    expect(events.at(-1)).toMatchObject({ fromStatus: "sent", toStatus: "paid", adminId: OTHER_ADMIN, paidAt: "2026-11-02", paymentReference: "IPN-77" });
    expect(await code(setStatus(db, ADMIN, id, { to: "void" }, PRICING))).toBe("invoice_bad_transition");
    expect(await code(setStatus(db, ADMIN, id, { to: "paid", paidAt: "2026-11-03" }, PRICING))).toBe("invoice_bad_transition");
  });
  it("a draft can be paid? no. Only an issued invoice; a quote is never marked paid", async () => {
    const d = await draft("invoice");
    expect(await code(setStatus(db, ADMIN, d, { to: "paid", paidAt: "2026-11-02" }, PRICING))).toBe("invoice_bad_transition");
    const q = await draft("quote");
    await setStatus(db, ADMIN, q, { to: "sent" }, PRICING);
    expect(await code(setStatus(db, ADMIN, q, { to: "paid", paidAt: "2026-11-02" }, PRICING))).toBe("invoice_bad_transition");
  });
  it("void is final and writes its event", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    await setStatus(db, ADMIN, id, { to: "void", note: "خطأ في السعر" }, PRICING);
    const { doc, events } = (await loadDocument(db, id))!;
    expect(doc.status).toBe("void");
    expect(events.at(-1)).toMatchObject({ toStatus: "void", note: "خطأ في السعر", adminId: ADMIN });
    expect(await code(setStatus(db, ADMIN, id, { to: "sent" }, PRICING))).toBe("invoice_bad_transition");
    expect(await code(saveDraft(db, ADMIN, id, { ...input(), expectedRevision: 2 }, PRICING))).toBe("invoice_locked");
  });
  it("the status log cannot be written or changed directly", async () => {
    const id = await draft();
    const ins = await db.from("invoice_status_events").insert({ document_id: id, to_status: "paid", admin_id: ADMIN });
    expect(ins.error?.code).toBe("42501");
    const upd = await db.from("invoice_status_events").update({ to_status: "paid" }).eq("document_id", id);
    expect(upd.error?.code).toBe("42501");
  });
});

describe("quote -> invoice and duplicate", () => {
  it("only an issued quote converts; the new invoice has the lines, its own number and the quote's frozen rate", async () => {
    const q = await draft("quote", { rateE4: 512_345 });
    expect(await code(convertQuote(db, ADMIN, q, PRICING))).toBe("quote_not_issued");
    await setStatus(db, ADMIN, q, { to: "sent" }, PRICING);
    const newId = await convertQuote(db, ADMIN, q, PRICING, "2026-12-01");
    const { doc: inv, events } = (await loadDocument(db, newId))!;
    expect(inv).toMatchObject({ docType: "invoice", status: "draft", convertedFromId: q, rateE4: 512_345, issueDate: "2026-12-01", dueDate: null });
    expect(inv.number).toBe("INV-2026-0001");
    expect(inv.lines.map((l) => [l.quantity, l.unitCc, l.hidden])).toEqual([[250, 1200, false], [50, 3500, true]]);
    expect(events[0]).toMatchObject({ toStatus: "draft", note: "converted_from_quote", adminId: ADMIN });
    // the quote is untouched
    expect((await loadDocument(db, q))!.doc.status).toBe("sent");
  });
  it("the rate may be changed only while the new invoice is a draft", async () => {
    const q = await draft("quote", { rateE4: 512_345 });
    await setStatus(db, ADMIN, q, { to: "sent" }, PRICING);
    const id = await convertQuote(db, ADMIN, q, PRICING);
    await saveDraft(db, ADMIN, id, { ...input({ rateE4: 520_000 }), expectedRevision: 1 }, PRICING);
    expect((await loadDocument(db, id))!.doc.rateE4).toBe(520_000);
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    expect(await code(saveDraft(db, ADMIN, id, { ...input({ rateE4: 530_000 }), expectedRevision: 3 }, PRICING))).toBe("invoice_locked");
  });
  it("converts once: a second conversion points to the first, unless that one was voided", async () => {
    const q = await draft("quote");
    await setStatus(db, ADMIN, q, { to: "sent" }, PRICING);
    const first = await convertQuote(db, ADMIN, q, PRICING);
    try { await convertQuote(db, ADMIN, q, PRICING); throw new Error("no error"); } catch (e) { expect((e as InvoiceError).code).toBe("already_converted"); expect((e as InvoiceError).extra).toEqual({ existingId: first }); }
    await setStatus(db, ADMIN, first, { to: "void" }, PRICING);
    expect(await code(convertQuote(db, ADMIN, q, PRICING))).toBe("no error");
  });
  it("an invoice cannot be converted", async () => {
    const id = await draft("invoice");
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    expect(await code(convertQuote(db, ADMIN, id, PRICING))).toBe("not_a_quote");
  });
  it("duplicate is the correction path: a void document becomes a new draft with a new number", async () => {
    const id = await draft();
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    await setStatus(db, ADMIN, id, { to: "void" }, PRICING);
    const copy = await duplicateDocument(db, ADMIN, id, PRICING, "2026-12-02");
    const { doc } = (await loadDocument(db, copy))!;
    expect(doc).toMatchObject({ status: "draft", docType: "invoice", duplicatedFromId: id, issueDate: "2026-12-02", number: "INV-2026-0002", rateE4: 507_500 });
    expect(doc.lines).toHaveLength(2);
  });
});

describe("the list and the unpaid total", () => {
  it("unpaid = issued invoices only (not drafts, not quotes, not paid, not void); filters work", async () => {
    const a = await draft("invoice");                      // sent, unpaid
    const b = await draft("invoice");                      // sent then paid
    const c = await draft("invoice");                      // stays draft
    const q = await draft("quote");                        // sent quote
    const v = await draft("invoice");                      // void
    for (const id of [a, b, q, v]) await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    await setStatus(db, ADMIN, b, { to: "paid", paidAt: "2026-11-02" }, PRICING);
    await setStatus(db, ADMIN, v, { to: "void" }, PRICING);
    const all = await listDocuments(db, {});
    expect(all.items).toHaveLength(5);
    expect(all.unpaid).toEqual({ count: 1, usd: 4275, points: 21695, egp: 216957 });
    expect((await listDocuments(db, { status: "draft" })).items.map((i) => i.id)).toEqual([c]);
    expect((await listDocuments(db, { docType: "quote" })).items.map((i) => i.id)).toEqual([q]);
    expect((await listDocuments(db, { q: "QUO-2026" })).items.map((i) => i.id)).toEqual([q]);
    // a draft's total in the list is computed live from its lines
    expect((await listDocuments(db, { status: "draft" })).items[0]).toMatchObject({ totalUsd: 4275, totalPoints: 21695 });
  });
});

describe("item types and the seller text", () => {
  it("a default price is edited freely and never changes a document already made (the line keeps its own price)", async () => {
    const t = await createItemType(db, ADMIN, { nameAr: "رابط حساب", unitCc: 45 });
    expect(t).toMatchObject({ nameAr: "رابط حساب", unitCc: 45 });
    const id = await draft("invoice", { lines: [{ batchKey: null, itemTypeId: t.id, itemTypeName: t.nameAr, description: "", quantity: 300, unitCc: t.unitCc, hidden: false }], batches: [] });
    await updateItemType(db, ADMIN, t.id, { nameAr: "رابط حساب", unitCc: 90 });
    expect((await loadDocument(db, id))!.doc.lines[0].unitCc).toBe(45);
    expect(await code(createItemType(db, ADMIN, { nameAr: "  رابط حساب ", unitCc: 1 }))).toBe("duplicate");
  });
  it("the seller text is editable; the tax and register lines are empty until filled", async () => {
    expect((await getSettings(db)).seller).toMatchObject({ name: "ديجر", website: "diger.tech", taxNumber: "", commercialRegister: "" });
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "hello@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "" });
    expect((await getSettings(db)).seller.email).toBe("hello@diger.tech");
  });
  it("the point value is read from the pricing settings as an integer (no float), with a safe default", async () => {
    const read = (credit: unknown, ipa = "x") => readPricingSettings(async () => ({ creditValueEgp: credit, ipa }));
    expect((await read(0.1)).creditValueE4).toBe(1000);
    expect((await read(0.12)).creditValueE4).toBe(1200);
    expect((await read("0.1")).creditValueE4).toBe(1000);
    expect((await read(undefined)).creditValueE4).toBe(1000);
    expect((await read(99999)).creditValueE4).toBe(1000);
    expect((await readPricingSettings(async () => { throw new Error("db down"); })).instapayAddress).toBe("");
  });
});
