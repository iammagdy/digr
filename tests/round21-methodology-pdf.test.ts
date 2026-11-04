import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readWorkbookMethodology, type WorkbookMethodology } from "../src/lib/agentMission/methodology/readWorkbook";
import { METHODOLOGY_DOC_TITLE_AR, buildMethodologyDocument, documentLines, type MethodologyDocument } from "../src/lib/agentMission/methodology/document";
import { renderMethodologyPdf } from "../src/lib/agentMission/methodology/pdf";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { missionFileTitleAr } from "../src/lib/agentMission/fileNames";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";
import { replayMission, type MissionReplay } from "./helpers/missionReplay";
import { MISSIONS } from "./helpers/round14Missions";
import { pdfDrawnText, pdfGlyphVariants } from "./helpers/pdfText";

/**
 * ROUND 21, item 3: THE DATA-COLLECTION METHODOLOGY AS A PDF, tested on the STORED LIVE MISSIONS. Each mission is replayed end to end (as the delivery contract's replay does), the workbook the customer would receive is built, the methodology is written from THAT FILE, rendered as a PDF,
 * and the PDF's own text is read back out of its bytes. The test fails if any number in the PDF is not a number of the delivered file, if the PDF is not the document (nothing missing, nothing added), if it says a provider, an endpoint, a price in dollars or a model's vendor,
 * or if its Arabic is not right to left and shaped.
 */
const NUMBER = /[٠-٩]+(?:[٬٫:/.\-][٠-٩]+)*/gu;
const numbersOf = (text: string): string[] => text.match(NUMBER) ?? [];
const FORBIDDEN = /TREG|tikhub|scrapecreators|anyapi|apify|anthropic|claude|openai|haiku|sonnet|endpoint|USD|\$|دولار/i;
const LETTERS_AND_DIGITS = /[ء-ي٠-٩ً-ْ]/g;

/** Every number the delivered file states, read independently of the code under test: the first sheet's text, the sheets' names and headers, and the counts the file's rows give (a sheet's delivered rows, the marks of its date-precision column). */
async function numbersOfFile(xlsx: Buffer): Promise<Set<string>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const out = new Set<string>();
  const add = (t: unknown) => { if (typeof t === "string") for (const n of numbersOf(t)) out.add(n); };
  const text = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && Array.isArray((v as { richText?: unknown }).richText) ? (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join("") : v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? (v as { text: string }).text : "");
  const first = wb.worksheets[0];
  first.eachRow((row) => row.eachCell((cell) => add(text(cell.value))));
  for (const ws of wb.worksheets.slice(1)) {
    add(ws.name);
    let rows = 0;
    const precisionCol: number[] = [];
    ws.getRow(1).eachCell((cell, col) => { const t = text(cell.value); add(t); if (/^دقة التاريخ/.test(t)) precisionCol.push(col); });
    let approx = 0;
    let exact = 0;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      rows += 1;
      for (const col of precisionCol) { const v = text(row.getCell(col).value); if (v === "تقريبي") approx += 1; else if (v === "دقيق") exact += 1; }
    });
    out.add(toArabicDigits(rows));
    if (precisionCol.length > 0) { out.add(toArabicDigits(approx)); out.add(toArabicDigits(exact)); }
  }
  return out;
}

describe.each(MISSIONS)("the methodology PDF of $label", ({ input }) => {
  let r: MissionReplay;
  let methodology: WorkbookMethodology | null;
  let doc: MethodologyDocument;
  let pdf: Buffer;
  let drawn: string[];
  let fileNumbers: Set<string>;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(input.readAt));
    r = await replayMission(input);
    vi.useRealTimers();
    const xlsx = r.built.xlsx;
    methodology = await readWorkbookMethodology(xlsx);
    const delivered = Object.values(r.rowsByStage).reduce((n, rows) => n + rows.length, 0);
    const subtitle = missionFileTitleAr({ plan: r.plan, requestText: input.request, delivered, date: new Date(input.readAt) });
    doc = buildMethodologyDocument({ methodology: methodology!, subtitleAr: subtitle });
    pdf = await renderMethodologyPdf(doc, { compress: false });
    drawn = pdfDrawnText(pdf);
    fileNumbers = await numbersOfFile(xlsx);
  }, 300_000);
  afterAll(() => { vi.useRealTimers(); });

  it("the delivered file carries the «المنهجية» section and the reader finds its lines, its counts table and its sheets", () => {
    expect(methodology).not.toBeNull();
    const labels = methodology!.items.map((i) => i.label);
    for (const l of ["طلبك (بكلماتك)", "المنصات والمصادر المستخدمة", "ما بُحث عنه", "حدود هذا التسليم", "صيغة الاستشهاد المقترحة"]) expect(labels, l).toContain(l);
    expect(methodology!.table.head).toEqual(["المرحلة", "قُرئ", "استُبعد", "سُلّم", "ملاحظة"]);
    expect(methodology!.table.rows.length).toBeGreaterThan(0);
    expect(methodology!.sheets.length).toBeGreaterThan(0);
  });

  it("it is a PDF with the document's title, subtitle and every section, and more than the cover", () => {
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
    expect(doc.title).toBe(METHODOLOGY_DOC_TITLE_AR);
    expect(doc.sections.map((s) => s.heading)).toEqual(expect.arrayContaining(["عن هذا المستند", "الطلب كما فُهم", "ما بُحث عنه والفترة الزمنية", "الأعداد المسلّمة", "حدود هذا التسليم", "ملف النتائج وعلاماته"]));
  });

  it("EVERY NUMBER IN THE PDF IS A NUMBER OF THE DELIVERED FILE (read back from the PDF's own bytes, in their reading order), and every number of the file's methodology section is in the PDF", () => {
    const inPdf = numbersOf(drawn.join("\n"));
    expect(inPdf.length).toBeGreaterThan(0);
    const foreign = inPdf.filter((n) => !fileNumbers.has(n));
    expect(foreign, `numbers in the PDF that the delivered file does not state: ${foreign.join(" ")}`).toEqual([]);
    const section = new Set<string>();
    for (const i of methodology!.items) for (const v of i.values) for (const n of numbersOf(v)) section.add(n);
    for (const row of [methodology!.table.head, ...methodology!.table.rows]) for (const c of row) for (const n of numbersOf(c)) section.add(n);
    const pdfSet = new Set(inPdf);
    const missing = [...section].filter((n) => !pdfSet.has(n));
    expect(missing, `numbers of the file's methodology missing from the PDF: ${missing.join(" ")}`).toEqual([]);
  });

  it("the PDF is exactly the document: the letters and digits drawn are the document's (nothing missing, nothing added, nothing lost at a page break)", () => {
    const count = (text: string): Map<string, number> => { const m = new Map<string, number>(); for (const ch of text.match(LETTERS_AND_DIGITS) ?? []) m.set(ch, (m.get(ch) ?? 0) + 1); return m; };
    const want = count(documentLines(doc).join(" "));
    const got = count(drawn.join(" "));
    const diff = [...new Set([...want.keys(), ...got.keys()])].filter((k) => want.get(k) !== got.get(k)).map((k) => `${k}: document ${want.get(k) ?? 0}, drawn ${got.get(k) ?? 0}`);
    expect(diff).toEqual([]);
  });

  it("the Arabic is RIGHT TO LEFT (the title is drawn from the right edge: its letters come out in visual order) and SHAPED (a letter has its initial, medial and final forms: several glyphs of the font for one character)", () => {
    const title = [...METHODOLOGY_DOC_TITLE_AR].reverse().join("");
    expect(drawn.some((l) => l.includes(title)), "the title in visual order").toBe(true);
    expect(drawn.some((l) => l.includes(METHODOLOGY_DOC_TITLE_AR)), "never the logical order").toBe(false);
    const variants = pdfGlyphVariants(pdf);
    for (const letter of ["ب", "ي", "ع"]) expect(variants.get(letter) ?? 0, `forms of ${letter}`).toBeGreaterThanOrEqual(3);
  });

  it("Arabic-Indic digits only (no Western digit anywhere in the PDF except inside a link the customer's own request names), and no emoji", () => {
    const all = drawn.join("\n");
    // a link keeps its own characters (it would not open otherwise); every other word of the PDF has no Western digit
    const withoutLinks = all.split(/\s+/).filter((w) => !/[A-Za-z]|:\/\//.test(w)).join(" ");
    expect(withoutLinks).not.toMatch(/[0-9]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("white-label: no provider, endpoint, price in dollars or model vendor in anything the document says", () => {
    for (const line of documentLines(doc)) {
      expect(line, line).not.toMatch(FORBIDDEN);
      expect(line, line).not.toMatch(PROVIDER_NAME_PATTERN);
    }
  });

  it("the fixed sentences and headings pass the customer-text check (no «صف» or «سجل», no mixed scripts)", () => {
    const fixed = [doc.title, ...doc.sections.map((s) => s.heading), ...doc.sections.flatMap((s) => s.blocks.filter((b) => b.kind === "label" || (b.kind === "paragraph" && (s.heading === "عن هذا المستند"))).map((b) => ("text" in b ? b.text : "")))];
    for (const t of fixed) expect(checkCustomerText(t, { maxChars: 600 }).issues, t).toEqual([]);
    // and the sheet lines (which the code writes around the file's own names)
    const layout = doc.sections.find((s) => s.heading === "ملف النتائج وعلاماته")!;
    for (const b of layout.blocks) if (b.kind === "bullet") expect(b.text, b.text).not.toMatch(/سجل|سجلات|صفوف|صف /);
  });

  it("no number of its own: no date, no page number, no count the file does not state (the sentences written by the code carry no digit)", () => {
    const about = doc.sections.find((s) => s.heading === "عن هذا المستند")!;
    for (const b of about.blocks) expect("text" in b ? b.text : "").not.toMatch(/[٠-٩0-9]/);
    for (const s of doc.sections) expect(s.heading).not.toMatch(/[٠-٩0-9]/);
  });
});
