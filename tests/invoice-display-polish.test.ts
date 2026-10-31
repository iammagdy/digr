import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newDocForm, formToPreview, type DocForm } from "../src/lib/invoices/form";
import { exportFileBase, pngFileName } from "../src/lib/invoices/labels";
import { lineCents, pointsToQirsh } from "../src/lib/invoices/money";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import { computeTotals, egpIsDerivedFromPoints, totalsForDoc } from "../src/lib/invoices/totals";
import { fmtFixed, unitAt, unitDecimals } from "../src/lib/invoices/unitColumn";
import type { Currency, DocView, LineInput, Totals } from "../src/lib/invoices/types";

const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
const line = (key: string, name: string, quantity: number, unitCc: number, batchKey: string | null = null, hidden = false): LineInput => ({ key, batchKey, itemTypeId: null, itemTypeName: name, description: "", quantity, unitCc, hidden });
const doc = (over: Partial<DocView>): DocView => ({
  id: "x", docType: "invoice", number: "INV-2026-0002", status: "draft", revision: 1, client: { id: null, company: "ش", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: null,
  show: { usd: false, points: true, egp: true }, rateE4: 565000, creditValueE4: 1000, discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0, notes: "", paymentInstructions: "", instapayAddress: "", showInstapayQr: false,
  paidAt: null, paymentReference: "", convertedFromId: null, duplicatedFromId: null, lockedAt: null, batches: [], lines: [], frozen: null, ...over,
});
/** «٠.٣٢٥» / «١٬٢٠٠» -> an exact rational (numerator, denominator as 10^decimals) */
const parseAr = (t: string): { n: bigint; d: bigint } => {
  const ascii = t.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/٬/g, "");
  const [i, f = ""] = ascii.split(".");
  return { n: BigInt(i + f), d: BigInt(10) ** BigInt(f.length) };
};
let seed = 20261031;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

describe("4a. unit-price columns: quantity x the shown unit matches EVERY printed line (to within half of the total's last digit)", () => {
  const check = (d: DocView): number => {
    const model = buildSheetModel(d, SELLER);
    const t = totalsForDoc(d);
    const derived = egpIsDerivedFromPoints(d);
    let checked = 0;
    const lineRows = model.rows.filter((r) => r.kind === "line");
    const visible = d.lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.hidden);
    expect(lineRows).toHaveLength(visible.length);
    model.currencies.forEach((cur, c) => {
      if (cur === "usd") return;
      lineRows.forEach((r, k) => {
        if (r.kind !== "line") return;
        const { l, i } = visible[k];
        const unit = parseAr(r.unit[c]);
        const totalMinor = (cur === "points" ? t.lines[i].points : t.lines[i].egp) ?? 0;
        // the unit shown, read back from the PRINTED text, times the quantity, against the PRINTED total, in minor units: tolerance = half a cent in the currency + half the total's last digit
        const scale = cur === "points" ? 1 : 100;
        const diffMinor = Math.abs(l.quantity * Number(unit.n) * scale / Number(unit.d) - totalMinor);
        const halfCentMinor = cur === "points" ? d.rateE4! / (200 * d.creditValueE4) : d.rateE4! / 20_000;
        const lastDigit = cur === "points" ? 0.5 : derived ? d.creditValueE4 / 200 : 0.5;
        expect(diffMinor, `${cur} line ${k}: ${l.quantity} x ${r.unit[c]} vs ${r.total[c]}`).toBeLessThanOrEqual(halfCentMinor + lastDigit + 1e-6);
        checked++;
      });
    });
    return checked;
  };

  it("the owner's first invoice: 200 companies at 12 cents, points only and points + EGP, at his rate", () => {
    const lines = [line("a", "شركة", 200, 1200), line("b", "مدير", 601, 3500), line("c", "بريد", 300, 45)];
    expect(check(doc({ lines, show: { usd: false, points: true, egp: false } }))).toBe(3);
    expect(check(doc({ lines, show: { usd: false, points: true, egp: true } }))).toBe(6);
    expect(check(doc({ lines, show: { usd: true, points: true, egp: true } }))).toBe(6);
  });

  it("the unit shows as many decimals as it needs, not a rounded whole point", () => {
    // 12 cents at 56.5 EGP/USD with 1 point = 0.10 EGP is 67.8 points: shown as 67.8, so 200 x 67.8 = 13,560 is the printed total (a whole 68 would print 13,600)
    const d = doc({ lines: [line("a", "شركة", 200, 1200)], show: { usd: false, points: true, egp: false } });
    const row = buildSheetModel(d, SELLER).rows.find((r) => r.kind === "line");
    expect(row?.kind === "line" && row.unit[0]).toBe("٦٧.٨");
    expect(row?.kind === "line" && row.total[0]).toBe("١٣٬٥٦٠");
  });

  it("whole points are kept when they are enough (60 points a unit at 50 EGP/USD)", () => {
    const d = doc({ rateE4: 500000, lines: [line("a", "شركة", 250, 1200)], show: { usd: false, points: true, egp: false } });
    const row = buildSheetModel(d, SELLER).rows.find((r) => r.kind === "line");
    expect(row?.kind === "line" && row.unit[0]).toBe("٦٠");
  });

  it("300 random documents in every currency combination: EVERY printed line matches", () => {
    let total = 0;
    for (let k = 0; k < 300; k++) {
      const n = 1 + rnd(8);
      const lines = Array.from({ length: n }, (_, i) => line(`l${i}`, "x", 1 + rnd(5000), 1 + rnd(20000), null, rnd(7) === 0));
      if (lines.every((l) => l.hidden)) lines[0].hidden = false;
      const show = [{ usd: false, points: true, egp: false }, { usd: false, points: false, egp: true }, { usd: true, points: true, egp: true }, { usd: false, points: true, egp: true }][rnd(4)];
      total += check(doc({ lines, show, rateE4: 300000 + rnd(500000), discountKind: rnd(3) === 0 ? "percent" : "none", discountValue: rnd(2500) }));
    }
    expect(total).toBeGreaterThan(250);
  });

  it("the rounding note stays only for a line that cannot match even at 6 decimals (an absurd quantity with a recurring unit); the ordinary case needs none", () => {
    expect(buildSheetModel(doc({ lines: [line("a", "x", 10001, 50)], show: { usd: true, points: true, egp: false } }), SELLER).roundingNote).toBeNull();
    // point value 0.105 EGP: a unit of 1 hundredth of a cent is 0.0538095... points; 10,000,000 of them print 538,095 and 6 decimals show 538,100: 5 points off, more than half a cent allows
    expect(unitDecimals("points", [{ quantity: 10_000_000, unitCc: 1, totalMinor: 538_095 }], 565000, 1050).ok).toBe(false);
    expect(unitDecimals("points", [{ quantity: 200, unitCc: 1200, totalMinor: 13560 }], 565000, 1000)).toEqual({ decimals: 1, ok: true });
  });

  it("the helpers: decimals are the fewest that satisfy every line; one count per column; at most 6", () => {
    const lines = [{ quantity: 200, unitCc: 1200, totalMinor: 13560 }, { quantity: 3, unitCc: 45, totalMinor: 6 }];
    const { decimals, ok } = unitDecimals("points", lines, 565000, 1000);
    expect(ok).toBe(true);
    expect(decimals).toBeLessThanOrEqual(6);
    expect(fmtFixed(unitAt("points", 1200, 565000, 1000, 1), 1)).toBe("٦٧.٨");
    expect(fmtFixed(BigInt(1234567), 3)).toBe("١٬٢٣٤.٥٦٧");
  });
});

describe("4b. EGP = points x point value, exactly, when both are shown", () => {
  const eq = (t: Totals, credit: number) => {
    for (const m of [...t.lines, t.subtotal, t.discount, t.afterDiscount, t.tax, t.total]) expect(m.egp, JSON.stringify(m)).toBe(pointsToQirsh(m.points as number, credit));
  };
  it("17,097 points is 1,709.70 EGP (it used to print 1,709.68)", () => {
    expect(pointsToQirsh(17097, 1000)).toBe(170970);
    // an owner-like invoice with both shown: every line and every total
    const d = doc({ lines: [line("a", "شركة", 200, 1200), line("b", "مدير", 601, 3500), line("c", "بريد", 287, 45)], discountKind: "percent", discountValue: 1000, taxEnabled: true, taxBp: 1400 });
    const t = totalsForDoc(d);
    eq(t, 1000);
    expect(t.total.egp).toBe((t.total.points as number) * 10);
  });

  it("the sums stay exact: the lines add up to the subtotal and the printed total in EGP, as in points", () => {
    for (let k = 0; k < 200; k++) {
      const lines = Array.from({ length: 1 + rnd(6) }, (_, i) => line(`l${i}`, "x", 1 + rnd(3000), 1 + rnd(15000)));
      const d = doc({ lines, rateE4: 300000 + rnd(500000), discountKind: (["none", "percent", "amount"] as const)[rnd(3)], discountValue: rnd(2000) + 1, taxEnabled: rnd(2) === 0, taxBp: rnd(2500) });
      const t = totalsForDoc(d);
      eq(t, 1000);
      expect(t.lines.reduce((s, m) => s + (m.egp as number), 0)).toBe(t.subtotal.egp);
      expect((t.subtotal.egp as number) - (t.discount.egp as number) + (t.tax.egp as number)).toBe(t.total.egp);
    }
  });

  it("EGP alone (points hidden) and a point value that is not a whole number of qirsh keep the independent rule", () => {
    const lines = [line("a", "شركة", 200, 1200)];
    const egpOnly = totalsForDoc(doc({ lines, show: { usd: false, points: false, egp: true } }));
    expect(egpOnly.total.egp).toBe(Math.round(lineCents(200, 1200) * 565000 / 10000));
    const odd = totalsForDoc(doc({ lines, creditValueE4: 1050 }));
    expect(odd.total.egp).toBe(Math.round(lineCents(200, 1200) * 565000 / 10000));
  });

  it("a SENT document prints its FROZEN numbers: nothing is recomputed", () => {
    const frozen = computeTotals([{ quantity: 200, unitCc: 1200 }], { rateE4: 565000, creditValueE4: 1000, discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "x", taxBp: 0 }); // the old independent rule
    const sent = doc({ status: "sent", lines: [line("a", "شركة", 200, 1200)], frozen });
    expect(totalsForDoc(sent)).toBe(frozen);
    const preview = formToPreview({ ...newDocForm("invoice", "2026-10-31", { rateE4: 565000 }), showPoints: true, showEgp: true, lines: [] }, { id: null, number: "", status: "draft", revision: 1, instapayAddress: "" });
    expect(preview.show).toMatchObject({ points: true, egp: true });
  });
});

describe("4c-4f. labels, defaults, file names", () => {
  const sheet = readFileSync("src/components/admin/invoices/InvoiceSheet.tsx", "utf8");
  const builder = readFileSync("src/components/admin/invoices/InvoiceBuilder.tsx", "utf8");

  it("the summary table is «ملخص القطاعات» (no «المراحل» left in the sheet or the chat)", () => {
    expect(sheet).toContain("ملخص القطاعات</th>");
    for (const f of ["src/components/admin/invoices/InvoiceSheet.tsx", "src/lib/invoices/chat/apply.ts"]) expect(readFileSync(f, "utf8")).not.toContain("ملخص المراحل");
  });

  it("a new document is EGP only, the payment block is OFF (no text, no QR), the saved rate is prefilled", () => {
    const f: DocForm = newDocForm("invoice", "2026-10-31", { rateE4: 565000 });
    expect(f).toMatchObject({ showEgp: true, showPoints: false, showUsd: false, payment: "", showQr: false, rate: "56.5" });
    expect(builder).toContain("newDocForm(initialType");
    const model = buildSheetModel(formToPreview(f, { id: null, number: "", status: "draft", revision: 1, instapayAddress: "iammagdy@instapay" }), SELLER);
    expect(model.paymentInstructions).toBe("");
    expect(model.showQr).toBe(false);
  });

  it("the payment block comes back when the owner turns it on, and goes again when he turns it off", () => {
    expect(builder).toContain('data-testid="payment-on"');
    expect(builder).toMatch(/setPaymentOn = \(on: boolean\) => set\(on \? \{ payment: meta\.defaultPaymentInstructions, showQr: eligibleQr \} : \{ payment: "", showQr: false \}\)/);
  });

  it("file names: «فاتورة INV-2026-0002», «بيان STM-…», «عرض سعر QUO-…», drafts «مسودة فاتورة»; PNG pages", () => {
    expect(exportFileBase({ docType: "invoice", number: "INV-2026-0002" })).toBe("فاتورة INV-2026-0002");
    expect(exportFileBase({ docType: "statement", number: "STM-2026-0001" })).toBe("بيان STM-2026-0001");
    expect(exportFileBase({ docType: "quote", number: "QUO-2026-0003" })).toBe("عرض سعر QUO-2026-0003");
    expect(exportFileBase({ docType: "invoice", number: "" })).toBe("مسودة فاتورة");
    expect(exportFileBase({ docType: "statement", number: "" })).toBe("مسودة بيان");
    expect(exportFileBase({ docType: "quote", number: "" })).toBe("مسودة عرض سعر");
    expect(exportFileBase({ docType: "invoice", number: 'INV/20:26*"1' })).not.toMatch(/[\\/:*?"<>|]/);
    expect(`${exportFileBase({ docType: "invoice", number: "INV-2026-0002" })}.pdf`).toBe("فاتورة INV-2026-0002.pdf");
    expect(pngFileName("بيان STM-2026-0001", 1, 1)).toBe("بيان STM-2026-0001.png");
    expect(pngFileName("فاتورة INV-2026-0002", 2, 3)).toBe("فاتورة INV-2026-0002 - 2.png");
  });

  it("the builder names a draft «مسودة …» even if it already has a number; the print dialog gets the name as the page title and gives it back", () => {
    expect(builder).toMatch(/exportFileBase\(\{ docType: form\.docType, number: status === "draft" \? "" : loaded\?\.doc\.number \?\? "" \}\)/);
    expect(sheet).toContain("document.title = fileBase;");
    expect(sheet).toContain('window.addEventListener("afterprint", restore)');
    expect(sheet).toContain("document.title = before");
  });
});
