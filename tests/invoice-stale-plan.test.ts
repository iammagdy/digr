import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SheetPageView } from "../src/components/admin/invoices/InvoiceSheet";
import { paginate } from "../src/lib/invoices/paginate";
import { buildSheetModel, type SheetModel } from "../src/lib/invoices/sheetModel";
import type { DocView, LineInput } from "../src/lib/invoices/types";

/**
 * Found in the browser (not by the earlier tests): switching a document to «بيان بيانات», or deleting a row, rendered the NEW document with the page plan measured
 * for the OLD one, and the whole builder crashed («Element type is invalid») because a row or block number pointed past the end. The sheet now never crashes on a
 * stale plan, and the preview keeps each plan together with the model it was measured for.
 */
const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
const line = (key: string, qty: number): LineInput => ({ key, batchKey: null, itemTypeId: null, itemTypeName: "شركة", description: "", quantity: qty, unitCc: 1200, hidden: false });
const doc = (over: Partial<DocView>): DocView => ({
  id: "x", docType: "invoice", number: "INV-2026-0001", status: "draft", revision: 1,
  client: { id: null, company: "شركة", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: null, show: { usd: true, points: false, egp: false },
  rateE4: null, creditValueE4: 1000, discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0, notes: "ملاحظة", paymentInstructions: "دفع", instapayAddress: "iammagdy@instapay", showInstapayQr: true,
  paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null, batches: [], lines: [line("a", 1), line("b", 2), line("c", 3), line("d", 4)], frozen: null, ...over,
});
const planFor = (m: SheetModel) => paginate({ rowHeights: m.rows.map(() => 30), keepWithNext: m.rows.map(() => false), pageBody: 800, firstPageReserve: 200, tableHead: 30, tails: m.statement ? [] : [100, 60] });
const render = (m: SheetModel, plan: ReturnType<typeof planFor>) => renderToStaticMarkup(createElement(SheetPageView, { model: m, plan }));

describe("a page plan measured for another document never crashes the sheet", () => {
  const big = buildSheetModel(doc({}), SELLER);
  const oldPlan = planFor(big);

  it("an invoice plan (4 rows, 2 blocks after the table) on a statement (no block after the table) renders", () => {
    const statement = buildSheetModel(doc({ docType: "statement", notes: "", lines: [line("a", 1)] }), SELLER);
    expect(oldPlan[0].tails.length).toBeGreaterThan(0);
    expect(() => render(statement, oldPlan)).not.toThrow();
    expect(render(statement, oldPlan)).toContain("بيان بالبيانات المستخرجة");
  });

  it("a plan for 4 rows on a document with 1 row, and on a document with none, renders (a deleted row)", () => {
    expect(() => render(buildSheetModel(doc({ lines: [line("a", 1)] }), SELLER), oldPlan)).not.toThrow();
    expect(() => render(buildSheetModel(doc({ lines: [] }), SELLER), oldPlan)).not.toThrow();
  });

  it("a plan for a document with notes on one with no notes and no payment block renders", () => {
    expect(() => render(buildSheetModel(doc({ notes: "", paymentInstructions: "", showInstapayQr: false }), SELLER), oldPlan)).not.toThrow();
  });
});
