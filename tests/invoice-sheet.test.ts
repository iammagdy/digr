import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SheetPageView, hasNotesTail } from "../src/components/admin/invoices/InvoiceSheet";
import { SHEET_CSS, SHEET_PAGE_HEIGHT_PX, SHEET_PAGE_WIDTH_PX } from "../src/components/admin/invoices/sheetCss";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { paginate, type PagePlan } from "../src/lib/invoices/paginate";
import { buildSheetModel, type SheetModel } from "../src/lib/invoices/sheetModel";
import { computeTotals } from "../src/lib/invoices/totals";
import type { BatchInput, DocView, LineInput, Money, Totals } from "../src/lib/invoices/types";

const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };

const line = (key: string, batchKey: string | null, name: string, quantity: number, unitCc: number, hidden = false, description = ""): LineInput =>
  ({ key, batchKey, itemTypeId: null, itemTypeName: name, description, quantity, unitCc, hidden });

const doc = (over: Partial<DocView> = {}): DocView => ({
  id: "x", docType: "invoice", number: "INV-2026-0001", status: "sent", revision: 2,
  client: { id: null, company: "شركة النور", contact: "أحمد", email: "ahmed@alnour.com", phone: "+201001234567", address: "١٢ شارع التحرير" },
  issueDate: "2026-10-31", dueDate: "2026-11-14", show: { usd: true, points: true, egp: false }, rateE4: 507_500, creditValueE4: 1000,
  discountKind: "percent", discountValue: 1000, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0,
  notes: "ملاحظة 12", paymentInstructions: "الدفع عبر إنستا باي على العنوان: iammagdy@instapay", instapayAddress: "iammagdy@instapay", showInstapayQr: true,
  paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null, batches: [], lines: [], frozen: null, ...over,
});

/** A printed cell back to its minor-unit integer: «٣٤.٩٩» -> 3499 (USD / EGP), «١٧٬٧٥٩» -> 17759 (points). */
function minor(cell: string, decimals: number): number {
  const ascii = cell.replace(/−/g, "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٬/g, "");
  const [i, f = ""] = ascii.split(".");
  return Number(i + f.padEnd(decimals, "0"));
}
const decimalsOf = (label: string) => (label === "نقطة" ? 0 : 2);

/** The sum, per shown currency, of every amount a reader can see in the table rows (lines, aggregates, summary-only batches). */
function shownSum(model: SheetModel): number[] {
  const sums = model.currencies.map(() => 0);
  for (const row of model.rows) {
    if (row.kind === "line" || row.kind === "aggregate" || row.kind === "batchSummary") row.total.forEach((c, i) => { sums[i] += minor(c, decimalsOf(model.currencyLabels[i])); });
  }
  return sums;
}
const subtotalOf = (model: SheetModel) => model.totalRows[0].amounts.map((c, i) => minor(c, decimalsOf(model.currencyLabels[i])));

const bigDoc = (): DocView => {
  const batches: BatchInput[] = [1, 2, 3, 4, 5].map((i) => ({ key: `b${i}`, title: `المرحلة ${i} — ٥٠ شركة`, summaryOnly: i === 5 }));
  const lines: LineInput[] = [];
  batches.forEach((b, bi) => { for (let j = 1; j <= 13; j++) lines.push(line(`${b.key}-${j}`, b.key, j % 3 === 0 ? "مدير" : j % 3 === 1 ? "شركة" : "بريد إلكتروني", 10 + j, j % 3 === 0 ? 3500 : j % 3 === 1 ? 1200 : 45, bi === 1 && j > 9)); });
  return doc({ batches, lines, show: { usd: true, points: true, egp: true } });
};

describe("what is shown always adds up to the totals (no hidden extra charge)", () => {
  it("every visible row, aggregate row and summary row sums to the printed subtotal in every currency", () => {
    for (const d of [doc({ lines: [line("a", null, "شركة", 250, 1200), line("b", null, "مدير", 50, 3500)] }), bigDoc()]) {
      const model = buildSheetModel(d, SELLER);
      expect(shownSum(model)).toEqual(subtotalOf(model));
      const t = computeTotals(d.lines, d);
      expect(subtotalOf(model)).toEqual([t.subtotal.usd, ...(d.show.points ? [t.subtotal.points!] : []), ...(d.show.egp ? [t.subtotal.egp!] : [])]);
    }
  });

  it("hidden lines still count; the reader sees one clear aggregate row instead", () => {
    const d = doc({ batches: [{ key: "b", title: "المرحلة ١", summaryOnly: false }], lines: [line("1", "b", "شركة", 10, 1200, false, "ظاهر"), line("2", "b", "مدير", 4, 3500, true, "مخفي-أ"), line("3", "b", "مدير", 6, 3500, true, "مخفي-ب")] });
    const model = buildSheetModel(d, SELLER);
    const rows = model.rows;
    expect(rows.filter((r) => r.kind === "line")).toHaveLength(1);
    const aggregate = rows.find((r) => r.kind === "aggregate");
    expect(aggregate).toMatchObject({ label: "بنود أخرى (٢)" });
    // the hidden lines' text is nowhere, their money is in the aggregate and in the subtotal
    expect(JSON.stringify(model)).not.toContain("مخفي");
    const t = computeTotals(d.lines, d);
    expect(minor((aggregate as { total: string[] }).total[0], 2)).toBe(t.lines[1].usd + t.lines[2].usd);
    expect(subtotalOf(model)[0]).toBe(t.lines[0].usd + t.lines[1].usd + t.lines[2].usd);
    expect(shownSum(model)).toEqual(subtotalOf(model));
    // the batch subtotal row includes the hidden lines too
    const sub = rows.find((r) => r.kind === "subtotal") as { total: string[] };
    expect(minor(sub.total[0], 2)).toBe(subtotalOf(model)[0]);
  });

  it("a summary-only batch is ONE row (title, count, subtotal) and its lines do not appear", () => {
    const model = buildSheetModel(bigDoc(), SELLER);
    const summary = model.rows.filter((r) => r.kind === "batchSummary");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ title: "المرحلة ٥ — ٥٠ شركة", count: "١٣ بند" });
    expect(model.rows.filter((r) => r.kind === "line")).toHaveLength(13 * 4 - 4); // four batches of 13 minus the 4 hidden ones of batch 2
    expect(model.groupSummary).toHaveLength(5);
    const groupSum = model.groupSummary!.reduce((s, g) => s + minor(g.total[0], 2), 0);
    expect(groupSum).toBe(subtotalOf(model)[0]);
  });

  it("lines that belong to no batch are a group of their own and are summarised too", () => {
    const d = doc({ batches: [{ key: "b", title: "المرحلة ١", summaryOnly: false }], lines: [line("1", null, "شركة", 1, 1200), line("2", "b", "مدير", 1, 3500)] });
    const model = buildSheetModel(d, SELLER);
    expect(model.groupSummary!.map((g) => g.title)).toEqual(["بنود بدون مرحلة", "المرحلة ١"]);
    expect(model.groupSummary!.reduce((s, g) => s + minor(g.total[0], 2), 0)).toBe(subtotalOf(model)[0]);
  });

  it("discount, tax and total rows follow the money rules (tax off by default)", () => {
    const model = buildSheetModel(doc({ lines: [line("a", null, "شركة", 100, 1000)], show: { usd: true, points: false, egp: false }, rateE4: null }), SELLER);
    expect(model.totalRows.map((r) => r.label)).toEqual(["المجموع الفرعي", "الخصم (١٠٪)", "الإجمالي المستحق"]);
    expect(model.totalRows.map((r) => r.amounts[0])).toEqual(["١٠.٠٠", "−١.٠٠", "٩.٠٠"]);
    const taxed = buildSheetModel(doc({ lines: [line("a", null, "شركة", 100, 1000)], show: { usd: true, points: false, egp: false }, rateE4: null, taxEnabled: true, taxLabel: "ضريبة", taxBp: 1400 }), SELLER);
    expect(taxed.totalRows.map((r) => r.label)).toEqual(["المجموع الفرعي", "الخصم (١٠٪)", "ضريبة (١٤٪)", "الإجمالي المستحق"]);
    expect(taxed.totalRows.at(-1)!.amounts[0]).toBe("١٠.٢٦");
  });

  it("an issued document prints the numbers frozen at issue, whatever the live inputs say now", () => {
    const lines = [line("a", null, "شركة", 250, 1200)];
    const frozen: Totals = computeTotals(lines, doc({ lines }));
    const changedRate = doc({ lines, rateE4: 900_000, frozen });
    const model = buildSheetModel(changedRate, SELLER);
    expect(model.totalRows.at(-1)!.amounts).toEqual(["٢٧.٠٠", "١٣٬٧٠٢"]); // 3000 cents less 10% = $27.00; 15,225 points less 1,523 = 13,702 (the rate at issue, not 900,000)
    const draftSameInputs = buildSheetModel({ ...changedRate, status: "draft", frozen: null }, SELLER);
    expect(draftSameInputs.totalRows.at(-1)!.amounts).not.toEqual(model.totalRows.at(-1)!.amounts); // a draft is live, an issued one is frozen
  });

  it("the rounding footnote appears only when no number of decimals makes quantity x unit match a printed line total within half a cent (INVOICE AGENT 2: the unit column shows the decimals it needs; see tests/invoice-display-polish.test.ts)", () => {
    const exact = buildSheetModel(doc({ lines: [line("a", null, "شركة", 250, 1200)], show: { usd: true, points: false, egp: false }, rateE4: null }), SELLER);
    expect(exact.roundingNote).toBeNull();
    // 3 x 0.0045 dollar: the unit is shown with its four decimals, so 3 x 0.0045 = 0.0135 matches the printed 0.01 to within half a cent: no note any more
    const fraction = buildSheetModel(doc({ lines: [line("a", null, "بريد", 3, 45)], show: { usd: true, points: false, egp: false }, rateE4: null }), SELLER);
    expect(fraction.roundingNote).toBeNull();
    // 250 x 60.9 points = 15,225: the unit shows 60.9 (it used to show 61 and needed the note)
    const points = buildSheetModel(doc({ lines: [line("a", null, "شركة", 250, 1200)] }), SELLER);
    expect(points.roundingNote).toBeNull();
    // a line whose cents were rounded by half a cent (10,001 x 0.005 dollar = 50.005 -> 5001 cents) is within the tolerance (half a cent): no note either
    const half = buildSheetModel(doc({ lines: [line("a", null, "x", 10001, 50)], show: { usd: true, points: true, egp: false } }), SELLER);
    expect(half.roundingNote).toBeNull();
  });
});

describe("the page plan: where A4 pages break", () => {
  const base = { keepWithNext: [] as boolean[], pageBody: 800, firstPageReserve: 200, tableHead: 30 };
  it("1 page when it fits, 2 and 3+ pages as it grows; numbers of rows per page add up", () => {
    const run = (n: number, tails = [150, 120]) => paginate({ ...base, rowHeights: Array(n).fill(30), keepWithNext: Array(n).fill(false), tails });
    expect(run(5)).toHaveLength(1);
    expect(run(25).length).toBe(2);
    const three = run(60);
    expect(three.length).toBe(3);
    for (const n of [0, 1, 5, 25, 60, 200]) {
      const plan = run(n);
      expect(plan.flatMap((p) => p.rows)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(plan.flatMap((p) => p.tails)).toEqual([0, 1]);
    }
  });
  it("an empty document is still one page", () => {
    expect(paginate({ ...base, rowHeights: [], tails: [100] })).toEqual([{ rows: [], tails: [0] }]);
  });
  it("the repeated header makes later pages hold fewer rows than the page height alone would allow", () => {
    const plan = paginate({ ...base, rowHeights: Array(70).fill(30), keepWithNext: Array(70).fill(false), tails: [] });
    expect(plan[0].rows.length).toBe(Math.floor((800 - 200 - 30) / 30));
    expect(plan[1].rows.length).toBe(Math.floor((800 - 30) / 30));
  });
  it("a batch heading never ends a page alone", () => {
    const heights = Array(30).fill(30);
    const keep = heights.map((_, i) => i === 18); // row 18 is a heading
    const plan = paginate({ ...base, rowHeights: heights, keepWithNext: keep, tails: [] });
    const firstPage = plan[0].rows;
    expect(firstPage.at(-1)).not.toBe(18);
    expect(plan[1].rows[0]).toBe(18);
  });
  it("the totals block and the notes block are kept whole, in order, on a new page when they do not fit", () => {
    // 12 rows leave 210 px: the totals block (150) fits, the notes block (400) does not and moves, whole, to the next page
    const plan = paginate({ ...base, rowHeights: Array(12).fill(30), keepWithNext: Array(12).fill(false), tails: [150, 400] });
    expect(plan.length).toBe(2);
    expect(plan[0].tails).toEqual([0]);
    expect(plan[1]).toEqual({ rows: [], tails: [1] });
  });
});

describe("the sheet itself: A4 pages, logo on every page, «صفحة ١ من ٣», Arabic digits, no emoji, no internal terms", () => {
  const model = buildSheetModel(bigDoc(), SELLER);
  // a deterministic plan: 3 pages
  const plan: PagePlan[] = paginate({ rowHeights: model.rows.map(() => 30), keepWithNext: model.rows.map((r) => r.kind === "heading"), pageBody: 800, firstPageReserve: 220, tableHead: 36, tails: hasNotesTail(model) ? [180, 100] : [180] });
  const html = renderToStaticMarkup(createElement(SheetPageView, { model, plan }));
  const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

  it("has as many pages as the plan, each an A4 section with the Diger logo and its own «صفحة n من N»", () => {
    expect(plan.length).toBe(3);
    expect(html.match(/<section class="inv-page"/g)).toHaveLength(3);
    expect(html.match(/<img src="\/brand\/diger-wordmark\.svg"/g)).toHaveLength(3);
    for (const [n, label] of [[1, "صفحة ١ من ٣"], [2, "صفحة ٢ من ٣"], [3, "صفحة ٣ من ٣"]] as const) expect(html, String(n)).toContain(label);
    expect(readFileSync("public/brand/diger-wordmark.svg", "utf8")).toContain("<svg"); // the existing logo asset
  });

  it("repeats the column header on every page that has rows, and puts the parties only on page 1", () => {
    const withRows = plan.filter((p) => p.rows.length).length;
    expect(html.match(/<thead data-m="head">/g)).toHaveLength(withRows);
    expect(html.match(/data-m="first"/g)).toHaveLength(1);
  });

  it("every digit is Arabic-Indic (e-mail and web addresses excepted), with no emoji", () => {
    const stripped = text.split(" ").filter((w) => !/@|\.(com|tech)\b/.test(w)).join(" ");
    expect(stripped).not.toMatch(/[0-9]/);
    expect(stripped).toMatch(/[٠-٩]/);
    expect(text).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
  });

  it("the document is titled «فاتورة» and is never called a tax invoice", () => {
    const taxed = buildSheetModel(doc({ lines: [line("a", null, "شركة", 1, 1200)], taxEnabled: true, taxBp: 1400, taxLabel: "ضريبة" }), SELLER);
    const t = renderToStaticMarkup(createElement(SheetPageView, { model: taxed, plan: [{ rows: [0], tails: [0, 1] }] }));
    expect(t).toContain("فاتورة");
    expect(t).not.toMatch(/ضريبية|tax invoice/i);
    expect(JSON.stringify(taxed)).not.toMatch(/ضريبية/);
  });

  it("shows no provider, endpoint, vendor, internal id or cost wording", () => {
    const deny = /treg|firecrawl|context\.dev|openai|anthropic|claude|haiku|companyenrich|apify|endpoint|provider|vendor|supabase|heroku|vercel|تكلفة|المزود|مزود|\bcost\b|margin|هامش/i;
    expect(text).not.toMatch(deny);
    expect(JSON.stringify(model)).not.toMatch(deny);
    // the document's own ids are not printed either
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("the seller block prints name, e-mail and website; tax and register lines only when filled", () => {
    expect(text).toContain("ديجر");
    expect(text).toContain("support@diger.tech");
    expect(text).toContain("diger.tech");
    expect(text).not.toMatch(/الرقم الضريبي|السجل التجاري/);
    const filled = renderToStaticMarkup(createElement(SheetPageView, { model: buildSheetModel(bigDoc(), { ...SELLER, taxNumber: "123-456", commercialRegister: "٧٨٩" }), plan }));
    expect(filled).toMatch(/الرقم الضريبي/);
    expect(filled).toMatch(/السجل التجاري/);
    expect(filled).toContain("١٢٣-٤٥٦"); // typed digits are shown Arabic-Indic
  });

  it("the Instapay QR shows only for the matching saved address, and only when the document's toggle is on", () => {
    const base = { lines: [line("a", null, "شركة", 1, 1200)] };
    expect(buildSheetModel(doc({ ...base }), SELLER).showQr).toBe(true);
    expect(buildSheetModel(doc({ ...base, showInstapayQr: false }), SELLER).showQr).toBe(false);
    expect(buildSheetModel(doc({ ...base, instapayAddress: "someone-else@instapay" }), SELLER).showQr).toBe(false);
    expect(buildSheetModel(doc({ ...base, instapayAddress: "" }), SELLER).showQr).toBe(false);
    const shown = renderToStaticMarkup(createElement(SheetPageView, { model: buildSheetModel(doc({ ...base }), SELLER), plan: [{ rows: [0], tails: [0, 1] }] }));
    expect(shown).toContain('src="/instapay-qr.jpeg"');
  });

  it("badges: draft and void documents say so on the sheet; an issued one does not", () => {
    expect(buildSheetModel(doc({ status: "draft", lines: [] }), SELLER).badge).toBe("مسودة");
    expect(buildSheetModel(doc({ status: "void", lines: [] }), SELLER).badge).toBe("ملغية");
    expect(buildSheetModel(doc({ status: "sent", lines: [] }), SELLER).badge).toBeNull();
  });

  it("a quote is titled «عرض سعر» and says «صالح حتى»", () => {
    const q = buildSheetModel(doc({ docType: "quote", number: "QUO-2026-0001", lines: [] }), SELLER);
    expect(q.docTypeAr).toBe("عرض سعر");
    expect(q.meta.map((m) => m.label)).toContain("صالح حتى");
  });
});

describe("print and image export: the CSS and the geometry", () => {
  it("A4 with no margin, one page element per sheet, a page break after each, nothing else printed, and the page width fits a phone when scaled", () => {
    expect(SHEET_CSS).toContain("@page { size: A4; margin: 0; }");
    expect(SHEET_CSS).toMatch(/\.inv-page \{[^}]*width: 210mm; height: 297mm/);
    expect(SHEET_CSS).toMatch(/break-after: page/);
    expect(SHEET_CSS).toMatch(/body > \*:not\(\.inv-print-root\) \{ display: none !important; \}/);
    expect(SHEET_CSS).toMatch(/\.inv-measure-host \{ position: fixed;/); // a fixed host never adds sideways scroll in a right-to-left page
    expect(SHEET_PAGE_WIDTH_PX / SHEET_PAGE_HEIGHT_PX).toBeCloseTo(210 / 297, 2);
  });
});
