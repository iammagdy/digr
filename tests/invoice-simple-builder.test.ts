import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sectorsPhrase } from "../src/components/admin/invoices/InvoiceBuilder";

/** The simple builder (INVOICES SIMPLE 1): what the owner sees on the one screen, checked at the source (the behaviour is covered by the other invoice tests and by the 380 px browser run). */
const builder = readFileSync("src/components/admin/invoices/InvoiceBuilder.tsx", "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

describe("one screen: a short form on top, the real sheet always visible, big clear buttons", () => {
  it("has the labels the owner asked for, in Arabic", () => {
    for (const label of ["اكتب اللي عملته", "رتّبهالي", "خيارات إضافية", "القطاعات", "إضافة قطاع", "معاينة", "حفظ مسودة", "تنزيل صورة", "تنزيل PDF", "بيان بيانات", "العميل", "عدد "]) expect(builder, label).toContain(label);
  });

  it("the sheet preview is part of the page itself (never behind a button), beside the form on a desktop and below it on a phone", () => {
    expect(builder).toContain('data-testid="preview-section"');
    expect(builder).toContain("lg:grid-cols-2"); // two columns from the large breakpoint, one column on a phone
    expect(builder).toContain("useInvoiceExport(shownModel");
    expect(builder).not.toMatch(/showExport|toggle-export/);
  });

  it("the extras (discount, tax, notes, payment text, hide a line, summary only, dates, client details) are behind ONE «خيارات إضافية» toggle", () => {
    const at = builder.indexOf('data-testid="more-options"');
    expect(at).toBeGreaterThan(0);
    for (const id of ["discount-kind", "tax-enabled", "show-qr", "line-hidden", "summary-only-list"]) {
      expect(builder.indexOf(`data-testid="${id}"`), id).toBeGreaterThan(at);
    }
    expect(builder.match(/data-testid="toggle-more"/g)).toHaveLength(1);
    // the quick number boxes and the currency chips are NOT behind it
    expect(builder.indexOf('data-testid="sectors-section"')).toBeLessThan(at);
    expect(builder.indexOf('data-testid="currency-section"')).toBeLessThan(at);
  });

  it("the client is optional and the rate is asked once, only when none is saved", () => {
    expect(builder).toContain("(اختياري)");
    // the rate box is always there while points or EGP are on (it used to vanish after the first digit typed: tests/invoice-live-fixes.test.ts)
    expect(builder).toContain("showRateBox(form)");
    expect(builder).toContain("أول سعر تحفظ به مسودة يصير السعر الافتراضي للوثائق القادمة");
  });

  it("a statement hides every money control and the paid button", () => {
    for (const id of ['data-testid="currency-section"', 'data-testid="totals-section"']) {
      const at = builder.indexOf(id);
      expect(builder.slice(Math.max(0, at - 200), at), id).toMatch(/!statement/);
    }
    expect(builder).toMatch(/status === "sent" && form\.docType === "invoice"/); // only an invoice is ever marked paid
  });

  it("there is no emoji in any invoice screen, and nothing on the client side can reach the model or its key", () => {
    const files = [...walk("src/components/admin/invoices"), ...walk("src/app/admin/invoices")];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
      expect(text, f).not.toMatch(/api\.anthropic\.com|x-api-key|ANTHROPIC|sk-ant|providerKeys/i);
    }
    expect(builder).toContain('"/api/admin/invoices/assist"'); // the helper is reached only through the admin-checked server route
  });
});

describe("the helper's confirmation sentence uses the right Arabic plural", () => {
  it("قطاع واحد / قطاعين / ٣ قطاعات / ١١ قطاعًا", () => {
    expect([1, 2, 3, 10, 11].map(sectorsPhrase)).toEqual(["قطاع واحد", "قطاعين", "٣ قطاعات", "١٠ قطاعات", "١١ قطاعًا"]);
  });
});
