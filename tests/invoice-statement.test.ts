import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { SheetPageView } from "../src/components/admin/invoices/InvoiceSheet";
import { paginate } from "../src/lib/invoices/paginate";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import { STATEMENT_TITLE_AR } from "../src/lib/invoices/labels";
import { InvoiceError, createDocument, duplicateDocument, getSettings, listDocuments, loadDocument, saveDraft, setStatus, updateSeller, type InvoiceDb } from "../src/lib/server/invoices/service";
import { normalizeForStatement, type DocumentInput } from "../src/lib/invoices/validate";
import { InvoiceDbModel } from "./helpers/invoiceDb";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const PRICING = { instapayAddress: "iammagdy@instapay", creditValueE4: 1000 };
const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
let model: InvoiceDbModel;
let db: InvoiceDb;
beforeEach(() => { model = new InvoiceDbModel(); db = model as unknown as InvoiceDb; });
const code = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof InvoiceError ? e.code : `other:${String(e)}`; } };

/** What a careless client could send: prices, a discount, tax, points, a rate, payment text. A statement must keep none of it. */
const withMoney = (over: Partial<DocumentInput> = {}): DocumentInput => ({
  clientId: null, client: { company: "", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: "2026-11-14",
  show: { usd: false, points: true, egp: true }, rateE4: 507_500, discount: { kind: "percent", value: 1000 }, tax: { enabled: true, label: "ضريبة", bp: 1400 },
  notes: "ملاحظة", paymentInstructions: "الدفع عبر إنستا باي", showInstapayQr: true,
  batches: [{ key: "k", title: "كهروميكانيكا", summaryOnly: false }, { key: "p", title: "بترول", summaryOnly: false }],
  lines: [
    { batchKey: "k", itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 200, unitCc: 1200, hidden: false },
    { batchKey: "k", itemTypeId: null, itemTypeName: "مدير", description: "", quantity: 340, unitCc: 3500, hidden: false },
    { batchKey: "p", itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 80, unitCc: 1200, hidden: false },
  ],
  ...over,
});

describe("«بيان بيانات»: sectors and counts, no money at all", () => {
  it("normalizeForStatement strips every price, discount, tax, currency, rate and payment text", () => {
    const n = normalizeForStatement(withMoney());
    expect(n.lines.every((l) => l.unitCc === 0)).toBe(true);
    expect(n).toMatchObject({ show: { usd: true, points: false, egp: false }, rateE4: null, discount: { kind: "none", value: 0 }, tax: { enabled: false, bp: 0 }, paymentInstructions: "", showInstapayQr: false, dueDate: null });
    expect(n.lines.map((l) => l.quantity)).toEqual([200, 340, 80]); // the counts are untouched
  });

  it("created with no client: numbered STM-…, prices stored as 0, USD only, no rate, no payment text, counts kept", async () => {
    const id = await createDocument(db, ADMIN, "statement", withMoney(), PRICING);
    const { doc } = (await loadDocument(db, id))!;
    expect(doc.number).toBe("STM-2026-0001");
    expect(doc.docType).toBe("statement");
    expect(doc.lines.map((l) => [l.quantity, l.unitCc])).toEqual([[200, 0], [340, 0], [80, 0]]);
    expect(doc).toMatchObject({ rateE4: null, discountKind: "none", taxEnabled: false, paymentInstructions: "", showInstapayQr: false, show: { usd: true, points: false, egp: false } });
    expect(doc.client.company).toBe("");
  });

  it("a later save keeps it money-free, whatever the screen sends", async () => {
    const id = await createDocument(db, ADMIN, "statement", withMoney(), PRICING);
    await saveDraft(db, ADMIN, id, { ...withMoney({ rateE4: 600_000 }), expectedRevision: 1 }, PRICING);
    const { doc } = (await loadDocument(db, id))!;
    expect(doc.lines.every((l) => l.unitCc === 0)).toBe(true);
    expect(doc.rateE4).toBeNull();
  });

  it("the database refuses a price on a statement even if the app were bypassed (function and table rule)", async () => {
    const payload = { show_usd: true, batches: [], lines: [{ item_type_name: "شركة", quantity: 5, unit_price_usd_centi_cents: 1200 }] };
    const price = await model.rpc("invoice_create_document", { p_admin: ADMIN, p_type: "statement", p_payload: payload });
    expect(price.error.message).toContain("invoice_statement_no_prices");
    const money = await model.rpc("invoice_create_document", { p_admin: ADMIN, p_type: "statement", p_payload: { show_usd: true, show_points: true, rate_egp_per_usd_e4: 507500, batches: [], lines: [] } });
    expect(money.error.message).toMatch(/check/);
    const discount = await model.rpc("invoice_create_document", { p_admin: ADMIN, p_type: "statement", p_payload: { show_usd: true, discount_kind: "percent", discount_value: 100, batches: [], lines: [] } });
    expect(discount.error.message).toMatch(/check/);
    expect(model.tables.invoice_documents).toHaveLength(0);
  });

  it("it can be sent (locked, totals frozen at zero) and voided, but it can NEVER be marked paid; the quote cannot either", async () => {
    const id = await createDocument(db, ADMIN, "statement", withMoney(), PRICING);
    expect(await code(setStatus(db, ADMIN, id, { to: "sent" }, PRICING))).toBe("no error"); // no client needed
    const { doc } = (await loadDocument(db, id))!;
    expect(doc.status).toBe("sent");
    expect(doc.frozen!.total).toEqual({ usd: 0, points: null, egp: null });
    expect(await code(setStatus(db, ADMIN, id, { to: "paid", paidAt: "2026-11-02" }, PRICING))).toBe("invoice_bad_transition");
    const direct = await model.rpc("invoice_set_status", { p_id: id, p_admin: ADMIN, p_to: "paid", p_expected_revision: null, p_frozen: null, p_paid_at: "2026-11-02", p_reference: "", p_note: "" });
    expect(direct.error.message).toContain("invoice_bad_transition");
    const quote = await createDocument(db, ADMIN, "quote", withMoney({ show: { usd: true, points: false, egp: false }, rateE4: null, tax: { enabled: false, label: "ضريبة", bp: 0 } }), PRICING);
    await setStatus(db, ADMIN, quote, { to: "sent" }, PRICING);
    const viaDb = await model.rpc("invoice_set_status", { p_id: quote, p_admin: ADMIN, p_to: "paid", p_expected_revision: null, p_frozen: null, p_paid_at: "2026-11-02", p_reference: "", p_note: "" });
    expect(viaDb.error.message).toContain("invoice_bad_transition");
    expect(await code(setStatus(db, ADMIN, id, { to: "void" }, PRICING))).toBe("no error");
  });

  it("duplicating a statement gives a statement (still no money); the list shows it with the other documents", async () => {
    const id = await createDocument(db, ADMIN, "statement", withMoney(), PRICING);
    const copy = await duplicateDocument(db, ADMIN, id, PRICING);
    expect((await loadDocument(db, copy))!.doc).toMatchObject({ docType: "statement", number: "STM-2026-0002" });
    const list = await listDocuments(db, { docType: "statement" });
    expect(list.items.map((i) => i.number).sort()).toEqual(["STM-2026-0001", "STM-2026-0002"]);
    expect(list.unpaid.count).toBe(0); // a statement is never money owed
  });
});

describe("the printed statement", () => {
  const build = async () => {
    const id = await createDocument(db, ADMIN, "statement", withMoney(), PRICING);
    const { doc } = (await loadDocument(db, id))!;
    return { doc, m: buildSheetModel(doc, SELLER) };
  };

  it("is titled «بيان بالبيانات المستخرجة», has no currency, no price column, no totals, no payment, no client box", async () => {
    const { m } = await build();
    expect(m.statement).toBe(true);
    expect(m.docTypeAr).toBe(STATEMENT_TITLE_AR);
    expect(m.currencies).toEqual([]);
    expect(m.totalRows).toEqual([]);
    expect(m.groupSummary).toBeNull();
    expect(m.rateNote).toBeNull();
    expect(m.roundingNote).toBeNull();
    expect(m.showQr).toBe(false);
    expect(m.paymentInstructions).toBe("");
    expect(m.client).toEqual([]);
    expect(m.columns.qty).toBe("العدد");
    expect(m.rows.filter((r) => r.kind === "subtotal")).toEqual([]);
    expect(m.rows.filter((r) => r.kind === "line").map((r) => (r as { qty: string }).qty)).toEqual(["٢٠٠", "٣٤٠", "٨٠"]);
    expect(m.meta.map((x) => x.label)).toEqual(["رقم البيان", "تاريخ الإصدار"]);
  });

  it("renders sectors and counts only: no money word, no price header, no «إلى» box, Arabic digits", async () => {
    const { m } = await build();
    const html = renderToStaticMarkup(createElement(SheetPageView, { model: m, plan: paginate({ rowHeights: m.rows.map(() => 30), keepWithNext: m.rows.map((r) => r.kind === "heading"), pageBody: 800, firstPageReserve: 200, tableHead: 30, tails: m.notes ? [60] : [] }) }));
    const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("بيان بالبيانات المستخرجة");
    expect(text).toContain("كهروميكانيكا");
    expect(text).toContain("بترول");
    expect(text).toMatch(/العدد/);
    for (const word of ["الإجمالي", "المجموع", "سعر الوحدة", "دولار", "نقطة", "جنيه", "الخصم", "تعليمات الدفع", "سعر الصرف", "إلى"]) expect(text, word).not.toContain(word);
    expect(html).not.toContain("instapay-qr");
    expect(html).toContain("inv-first solo");
    const stripped = text.split(" ").filter((w) => !/@|\.(com|tech)\b/.test(w)).join(" ");
    expect(stripped).not.toMatch(/[0-9]/);
  });
});

describe("one saved exchange rate (settings), silent on every new document", () => {
  const doc = (rateE4: number | null): DocumentInput => withMoney({ rateE4, show: { usd: true, points: true, egp: false }, discount: { kind: "none", value: 0 }, tax: { enabled: false, label: "ضريبة", bp: 0 } });

  it("the first rate ever typed becomes the saved rate; a later document's own rate never overwrites it", async () => {
    expect((await getSettings(db)).lastRateE4).toBeNull();
    await createDocument(db, ADMIN, "invoice", doc(507_500), PRICING);
    expect((await getSettings(db)).lastRateE4).toBe(507_500);
    await createDocument(db, ADMIN, "invoice", doc(600_000), PRICING);
    expect((await getSettings(db)).lastRateE4).toBe(507_500);
  });

  it("the owner edits it in the settings (or clears it); documents already made keep the rate they were made with", async () => {
    const id = await createDocument(db, ADMIN, "invoice", doc(507_500), PRICING);
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "", rateE4: 520_000 });
    expect((await getSettings(db)).lastRateE4).toBe(520_000);
    expect((await loadDocument(db, id))!.doc.rateE4).toBe(507_500);
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "" }); // rate absent = unchanged
    expect((await getSettings(db)).lastRateE4).toBe(520_000);
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "", rateE4: null });
    expect((await getSettings(db)).lastRateE4).toBeNull();
  });

  it("the rate is frozen on the document at «مرسلة»: a later change of the saved rate changes nothing on it", async () => {
    const id = await createDocument(db, ADMIN, "invoice", doc(507_500), PRICING);
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "", rateE4: 900_000 });
    const { doc: d } = (await loadDocument(db, id))!;
    expect(d.rateE4).toBe(507_500);
    expect(d.frozen!.total).toMatchObject({ usd: 15260, points: 77_445 }); // 2400c + 11900c + 960c; each line rounded once at 50.75 (12,180 + 60,393 + 4,872), not at the later 90.00
  });
});
