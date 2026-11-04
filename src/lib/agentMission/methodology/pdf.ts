import PDFDocument from "pdfkit";
import { formatArabicRtl, getBoldFontBuffer, getRegularFontBuffer } from "../../../functions/shared/fileGenerators";
import type { DocBlock, MethodologyDocument } from "./document";

/**
 * THE PDF OF THE DATA-COLLECTION METHODOLOGY (round 21): Arabic, shaped and right to left, Arabic-Indic digits, with the embedded IBM Plex Sans Arabic font the site's other PDFs use. It is written HERE (not with `generatePdfReport`, which belongs to the old job pipeline and reads a
 * `data.json` a mission never has) and it IMPORTS only the font readers and the right-to-left word order of src/functions/shared/fileGenerators.ts, which are not edited. The drawing follows the shipped Facebook report PDF: a line is put in visual order word by word (`formatArabicRtl`),
 * and a run of Arabic-Indic digits is drawn reversed so that it keeps its reading order on the page. Nothing is drawn that is not in the document model (documentLines), and the page has no number, no date and no count of its own.
 */
const PAGE = { width: 595.28, height: 841.89, margin: 42 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const X0 = PAGE.margin;
const X1 = PAGE.width - PAGE.margin;
const BOTTOM = PAGE.height - PAGE.margin;
const NAVY = "#1B365D";
const NAVY_LIGHT = "#EBF2FA";
const GOLD = "#C59B27";
const INK = "#1F2937";
const GREY = "#64748B";
const WORD_SPACING = 2;
const SPACING = { wordSpacing: WORD_SPACING } as const;

/** A number as one unit: its digit runs joined by a separator that keeps it one number («٢٠٢٦-٠٩-١٤», «١٣:٠٠», «١٬٢٠٠», «٣٫٥»), with a trailing percent sign. */
const NUMBER_CORE = /[٠-٩]+(?:[٬٫:/.\-][٠-٩]+)*٪?/gu;
const NUMERIC_ONLY = /^[٠-٩٬٫٪ .:-]+$/u;
/** A line in the order it is drawn: words from the right, each number reversed once AS A WHOLE (the font engine reverses a right-to-left run, so a number written reversed reads in its own order on the page). A line that is only a number is reversed by formatArabicRtl itself. */
export const visualLine = (line: string): string => {
  if (NUMERIC_ONLY.test(line)) return formatArabicRtl(line);
  const tokens = line.split(" ").map((token) => token.replace(NUMBER_CORE, (run) => [...run].reverse().join("")));
  const shown = formatArabicRtl(tokens.join(" "));
  // the font engine does not mirror quotation marks (formatArabicRtl swaps only brackets): in a right-to-left line the opening mark sits on the right and shows as the closing shape, so «text» keeps its look
  return /[\u0600-\u06FF]/.test(line) ? shown.replace(/[«»]/g, (q) => (q === "«" ? "»" : "«")) : shown;
};

const drawnWidth = (doc: PDFKit.PDFDocument, shown: string): number => doc.widthOfString(shown) + (shown.split(" ").length - 1) * WORD_SPACING;

/** One line drawn inside [x0, x1], right-aligned or centred, by its real width. */
function put(doc: PDFKit.PDFDocument, line: string, x0: number, x1: number, y: number, align: "right" | "center"): void {
  const shown = visualLine(line);
  const width = drawnWidth(doc, shown);
  const x = align === "right" ? x1 - width : x0 + (x1 - x0 - width) / 2;
  doc.text(shown, Math.max(x0, x), y, { lineBreak: false, ...SPACING });
}

/** A word wider than the line is cut into pieces that fit (a long link must not run off the page). */
function pieces(doc: PDFKit.PDFDocument, word: string, width: number): string[] {
  if (drawnWidth(doc, visualLine(word)) <= width) return [word];
  const out: string[] = [];
  let current = "";
  for (const ch of [...word]) {
    if (current && drawnWidth(doc, visualLine(current + ch)) > width) { out.push(current); current = ch; } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function wrap(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).flatMap((w) => pieces(doc, w, width));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && drawnWidth(doc, visualLine(candidate)) > width) { lines.push(current); current = word; } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

class Cursor {
  y = PAGE.margin;
  constructor(readonly doc: PDFKit.PDFDocument) {}
  /** Starts a new page when `height` does not fit in what is left of this one. */
  ensure(height: number): void {
    if (this.y + height > BOTTOM) { this.doc.addPage(); this.y = PAGE.margin; }
  }
}

function paragraph(c: Cursor, text: string, opts: { size: number; bold?: boolean; color?: string; x1?: number; gap?: number }): void {
  const { doc } = c;
  doc.font(opts.bold ? "ArabicBold" : "ArabicRegular").fontSize(opts.size).fillColor(opts.color ?? INK);
  const x1 = opts.x1 ?? X1;
  const lineHeight = opts.size * 1.75;
  for (const line of wrap(doc, text, x1 - X0)) {
    c.ensure(lineHeight);
    put(doc, line, X0, x1, c.y, "right");
    c.y += lineHeight;
  }
  c.y += opts.gap ?? 3;
}

function bullet(c: Cursor, text: string): void {
  const { doc } = c;
  const size = 10.5;
  doc.font("ArabicRegular").fontSize(size).fillColor(INK);
  const x1 = X1 - 14;
  const lineHeight = size * 1.75;
  const lines = wrap(doc, text, x1 - X0);
  c.ensure(lineHeight);
  doc.circle(X1 - 4, c.y + lineHeight / 2 - 1, 1.8).fill(GOLD);
  doc.fillColor(INK);
  for (const line of lines) {
    c.ensure(lineHeight);
    put(doc, line, X0, x1, c.y, "right");
    c.y += lineHeight;
  }
  c.y += 2;
}

function table(c: Cursor, head: string[], rows: string[][]): void {
  const { doc } = c;
  const size = 9.5;
  const cols = head.length;
  // the first column (the stage) takes more room; the others share the rest
  const first = cols > 2 ? CONTENT_WIDTH * 0.3 : CONTENT_WIDTH / cols;
  const widths = head.map((_, i) => (i === 0 ? first : (CONTENT_WIDTH - first) / (cols - 1)));
  // columns run from the right edge (the first column is the rightmost)
  const xRight = (i: number): number => X1 - widths.slice(0, i).reduce((n, w) => n + w, 0);
  const cellLines = (text: string, i: number): string[] => wrap(doc, text, widths[i] - 10);
  const draw = (cells: string[], opts: { bold: boolean; fill: string | null; color: string }): void => {
    doc.font(opts.bold ? "ArabicBold" : "ArabicRegular").fontSize(size);
    const wrapped = cells.map((t, i) => cellLines(t, i));
    const lineHeight = size * 1.7;
    const height = Math.max(1, ...wrapped.map((w) => w.length)) * lineHeight + 8;
    c.ensure(height);
    wrapped.forEach((lines, i) => {
      const x1 = xRight(i);
      const x0 = x1 - widths[i];
      if (opts.fill) doc.rect(x0, c.y, widths[i], height).fill(opts.fill);
      doc.rect(x0, c.y, widths[i], height).lineWidth(0.5).stroke("#D1D5DB");
      doc.font(opts.bold ? "ArabicBold" : "ArabicRegular").fontSize(size).fillColor(opts.color);
      lines.forEach((line, k) => put(doc, line, x0 + 5, x1 - 5, c.y + 4 + k * lineHeight, i === 0 ? "right" : "center"));
    });
    c.y += height;
  };
  draw(head, { bold: true, fill: NAVY, color: "#FFFFFF" });
  rows.forEach((r, k) => draw(head.map((_, i) => r[i] ?? ""), { bold: false, fill: k % 2 ? NAVY_LIGHT : null, color: INK }));
  c.y += 8;
}

function block(c: Cursor, b: DocBlock): void {
  if (b.kind === "label") paragraph(c, b.text, { size: 10.5, bold: true, color: NAVY, gap: 1 });
  else if (b.kind === "paragraph") paragraph(c, b.text, { size: 10.5 });
  else if (b.kind === "bullet") bullet(c, b.text);
  else table(c, b.head, b.rows);
}

/** The document as a PDF (the bytes). `compress: false` is for tests, which read the text back out of the file. */
export function renderMethodologyPdf(document: MethodologyDocument, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const regular = getRegularFontBuffer();
    const bold = getBoldFontBuffer();
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE.margin,
      compress: options.compress !== false,
      font: regular as unknown as string,
      info: { Title: document.title, Author: "Diger", Subject: "منهجية جمع البيانات", Creator: "Diger" },
    });
    doc.registerFont("ArabicRegular", regular);
    doc.registerFont("ArabicBold", bold);
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      // the title band
      doc.rect(0, 0, PAGE.width, 92).fill(NAVY);
      doc.font("ArabicBold").fontSize(20).fillColor("#FFFFFF");
      put(doc, document.title, X0, X1, 24, "center");
      doc.font("ArabicRegular").fontSize(11).fillColor("#CBD5E1");
      const subtitleLines = wrap(doc, document.subtitle, CONTENT_WIDTH).slice(0, 2);
      subtitleLines.forEach((line, i) => put(doc, line, X0, X1, 54 + i * 18, "center"));
      doc.rect(0, 92, PAGE.width, 3).fill(GOLD);
      const c = new Cursor(doc);
      c.y = 116;
      for (const section of document.sections) {
        c.ensure(60);
        paragraph(c, section.heading, { size: 14, bold: true, color: NAVY, gap: 0 });
        doc.moveTo(X0, c.y).lineTo(X1, c.y).lineWidth(1).stroke(GOLD);
        c.y += 8;
        for (const b of section.blocks) block(c, b);
        c.y += 8;
      }
      void GREY;
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
