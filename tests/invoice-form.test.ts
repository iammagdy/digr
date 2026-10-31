import { describe, expect, it } from "vitest";
import { emptyForm, emptyLine, formFromDoc, formToInput, formToPreview } from "../src/lib/invoices/form";
import { cleanText, inputFromDoc, toSqlPayload } from "../src/lib/invoices/validate";
import type { DocView } from "../src/lib/invoices/types";

const doc = (): DocView => ({
  id: "d", docType: "invoice", number: "INV-2026-0001", status: "draft", revision: 3,
  client: { id: null, company: "شركة النور", contact: "أحمد", email: "a@b.com", phone: "+201001234567", address: "القاهرة" },
  issueDate: "2026-10-31", dueDate: "2026-11-14", show: { usd: true, points: true, egp: false }, rateE4: 507_500, creditValueE4: 1000,
  discountKind: "percent", discountValue: 1250, taxEnabled: true, taxLabel: "ضريبة", taxBp: 1400,
  notes: "ن", paymentInstructions: "ع", instapayAddress: "iammagdy@instapay", showInstapayQr: true, paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null,
  batches: [{ key: "b1", title: "المرحلة ١", summaryOnly: true }],
  lines: [
    { key: "l1", batchKey: "b1", itemTypeId: null, itemTypeName: "بريد إلكتروني", description: "", quantity: 300, unitCc: 45, hidden: false },
    { key: "l2", batchKey: null, itemTypeId: null, itemTypeName: "شركة", description: "x", quantity: 250, unitCc: 1200, hidden: true },
  ],
  frozen: null,
});

describe("the builder's text fields become exact integers", () => {
  it("a document survives form -> input -> form without a single digit changing (0.0045 dollar (0.45 cent) stays 45, 50.75 stays 507500, 12.5% stays 1250)", () => {
    const f = formFromDoc(doc());
    expect(f.lines[0]).toMatchObject({ qty: "300", unit: "0.0045" });
    expect(f.rate).toBe("50.75");
    expect(f.discount).toBe("12.5");
    const r = formToInput(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({ rateE4: 507_500, discount: { kind: "percent", value: 1250 }, tax: { enabled: true, bp: 1400 } });
    expect(r.input.lines.map((l) => [l.quantity, l.unitCc, l.hidden])).toEqual([[300, 45, false], [250, 1200, true]]);
    expect(r.input).toEqual({ ...inputFromDoc(doc()) });
  });

  it("typed Arabic-Indic digits and the Arabic decimal mark are read as numbers", () => {
    const f = formFromDoc(doc());
    f.lines[0].qty = "٣٠٠";
    f.lines[0].unit = "٠٫٠٠٤٥";
    f.rate = "٥٠٫٧٥";
    const r = formToInput(f);
    expect(r.ok && r.input.lines[0]).toMatchObject({ quantity: 300, unitCc: 45 });
    expect(r.ok && r.input.rateE4).toBe(507_500);
  });

  it("a fixed discount is typed in dollars and stored in cents", () => {
    const f = formFromDoc({ ...doc(), discountKind: "amount", discountValue: 12_345 });
    expect(f.discount).toBe("123.45");
    const r = formToInput(f);
    expect(r.ok && r.input.discount).toEqual({ kind: "amount", value: 12_345 });
  });

  it("says what is wrong, in Arabic, before anything is sent", () => {
    const base = () => formFromDoc(doc());
    const err = (mutate: (f: ReturnType<typeof base>) => void): string => { const f = base(); mutate(f); const r = formToInput(f); return r.ok ? "" : r.error; };
    expect(err((f) => { f.lines[0].qty = "0"; })).toMatch(/الكمية/);
    expect(err((f) => { f.lines[0].qty = "1.5"; })).toMatch(/الكمية/);
    expect(err((f) => { f.lines[0].unit = "0.00455"; })).toMatch(/سعر الوحدة/);
    expect(err((f) => { f.lines[0].unit = "abc"; })).toMatch(/سعر الوحدة/);
    expect(err((f) => { f.rate = "50.12345"; })).toMatch(/سعر الصرف/);
    expect(err((f) => { f.rate = ""; })).toMatch(/سعر الصرف/); // points shown but no rate
    expect(err((f) => { f.discount = "150"; })).toMatch(/١٠٠٪/);
    expect(err((f) => { f.showUsd = false; f.showPoints = false; f.showEgp = false; })).toMatch(/عملة/);
    expect(err((f) => { f.dueDate = "2026-10-01"; })).toMatch(/الاستحقاق/);
    expect(err((f) => { f.tax = "x"; })).toMatch(/الضريبة/);
  });

  it("the live preview never breaks while typing: an unreadable number counts as 0", () => {
    const f = formFromDoc(doc());
    f.lines[0].qty = "";
    f.lines[0].unit = "0.004";
    f.rate = "5";
    f.discount = "zzz";
    const preview = formToPreview(f, { id: "d", number: "INV-2026-0001", status: "draft", revision: 3, instapayAddress: "iammagdy@instapay" });
    expect(preview.lines[0]).toMatchObject({ quantity: 0, unitCc: 40 });
    expect(preview.discountValue).toBe(0);
    expect(Number.isInteger(preview.rateE4 as number) || preview.rateE4 === null).toBe(true);
  });

  it("a new document starts as a draft with the last rate and the payment text from the settings, and USD only", () => {
    const f = emptyForm("quote", "2026-10-31", { rateE4: 507_500, payment: "الدفع" });
    expect(f).toMatchObject({ docType: "quote", rate: "50.75", payment: "الدفع", showUsd: true, showPoints: false, showEgp: false, taxEnabled: false, discountKind: "none", showQr: true });
    expect(emptyLine(null)).toMatchObject({ qty: "1", unit: "0", hidden: false });
  });
});

describe("the SQL payload", () => {
  it("carries integers only; the point value and the Instapay address come from the server, whatever the screen says", () => {
    const r = formToInput(formFromDoc(doc()));
    if (!r.ok) throw new Error("input");
    const p = toSqlPayload(r.input, { creditValueE4: 1200, instapayAddress: "iammagdy@instapay" });
    expect(p).toMatchObject({ rate_egp_per_usd_e4: 507_500, credit_value_e4: 1200, instapay_address: "iammagdy@instapay", discount_kind: "percent", discount_value: 1250, tax_bp: 1400 });
    const numbers = JSON.stringify(p).match(/:-?\d+\.\d+/g);
    expect(numbers).toBeNull(); // no decimal number anywhere in the payload
    expect((p.lines as Array<Record<string, unknown>>)[0]).toMatchObject({ quantity: 300, unit_price_usd_centi_cents: 45, batch_key: "b1" });
  });
});

describe("free text is cleaned on the way in", () => {
  it("removes emoji, zero-width and direction-override characters; keeps Arabic, digits and common symbols", () => {
    expect(cleanText("  شركة \u{1F600} النور‮  ")).toBe("شركة  النور");
    expect(cleanText("a‎b‏c⁦d⁩e﻿")).toBe("abcde");
    expect(cleanText("© 2026 ™")).toBe("© 2026 ™");
    expect(cleanText("1️⃣")).toBe("1");
    expect(cleanText("بريد@شركة.com")).toBe("بريد@شركة.com");
  });
});
