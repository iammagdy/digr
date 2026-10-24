import PDFDocument from "pdfkit";
import { formatArabicRtl, getBoldFontBuffer, getRegularFontBuffer } from "./fileGenerators";
import { buildReportModel, type ReportModel, type ReportPayload } from "../../lib/facebookReport/aggregate";
import { conclusionsAr, limitsAr, scopeLinesAr } from "../../lib/facebookReport/conclusions";
import { dayAr, formatAr, percentAr } from "../../lib/facebookReport/text";
import { toArabicDigits } from "../../lib/arabicDigits";
import { regionNameAr } from "../../lib/regionNames";

/**
 * The methodology PDF of the Facebook topic report: SEPARATE from the Excel (which holds data only), Arabic, right-to-left, Arabic-Indic digits, built with the same
 * embedded font the other PDFs use (`getRegularFontBuffer` / `getBoldFontBuffer`: the file on disk, else the embedded copy; a missing font broke PDFs before).
 * Contents: the period asked and the period actually covered, the number of Pages used (never a source's name), the counts, the axes table, the publisher
 * concentration, the honest limits and the analytical conclusions, every sentence of which is a template filled from computed numbers (see conclusions.ts).
 * No emoji, no vendor name, no internal id.
 */
const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const NAVY = "#1B365D";
const NAVY_MID = "#24436E";
const GOLD = "#C59B27";

/** A run of Arabic-Indic digits (with the grouping and decimal marks and the percent sign) is drawn reversed, as `formatArabicRtl` does for a whole numeric string: it keeps its reading order on the page, also when a bracket or a comma is stuck to it. */
const NUMBER_RUN = /[٠-٩٬٫٪]+/gu;
const NUMERIC_ONLY = /^[٠-٩٬٫٪ .:-]+$/u;
const visual = (line: string): string => {
  // a line that is only a number is reversed by formatArabicRtl itself; a number inside words is reversed here, once
  if (NUMERIC_ONLY.test(line)) return formatArabicRtl(line);
  const tokens = line.split(" ").map((token) => token.replace(NUMBER_RUN, (run) => [...run].reverse().join("")));
  return formatArabicRtl(tokens.join(" "));
};
const WORD_SPACING = 2;
const SPACING = { wordSpacing: WORD_SPACING } as const;

/** The width a drawn line really takes: its glyphs plus the extra space between words (PDFKit leaves the extra space out when it aligns a line). */
function drawnWidth(doc: PDFKit.PDFDocument, shown: string): number {
  return doc.widthOfString(shown) + (shown.split(" ").length - 1) * WORD_SPACING;
}

/** Draws one line inside [x0, x1]: right-aligned, centred, or left-aligned, positioned by its real width. */
function put(doc: PDFKit.PDFDocument, line: string, x0: number, x1: number, y: number, align: "right" | "center" | "left"): void {
  const shown = visual(line);
  const width = drawnWidth(doc, shown);
  const x = align === "right" ? x1 - width : align === "center" ? x0 + (x1 - x0 - width) / 2 : x0;
  doc.text(shown, Math.max(x0, x), y, { lineBreak: false, ...SPACING });
}

function wrapLine(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && drawnWidth(doc, visual(candidate)) > width) { lines.push(current); current = word; } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

class Page {
  y = PAGE.margin;
  constructor(readonly doc: PDFKit.PDFDocument) {}
  private ensure(height: number): void {
    if (this.y + height > PAGE.height - PAGE.margin - 18) { this.doc.addPage(); this.y = PAGE.margin; }
  }
  banner(title: string, sub: string): void {
    const d = this.doc;
    d.rect(PAGE.margin, this.y, CONTENT_WIDTH, 64).fill(NAVY);
    d.font("ArabicBold").fontSize(15).fillColor("#FFFFFF");
    put(d, title, PAGE.margin + 16, PAGE.margin + CONTENT_WIDTH - 16, this.y + 12, "right");
    d.font("ArabicRegular").fontSize(9).fillColor("#CBD5E1");
    put(d, sub, PAGE.margin + 16, PAGE.margin + CONTENT_WIDTH - 16, this.y + 40, "right");
    this.y += 78;
  }
  heading(text: string): void {
    this.ensure(34);
    const d = this.doc;
    d.rect(PAGE.margin, this.y, CONTENT_WIDTH, 24).fill(NAVY_MID);
    d.rect(PAGE.margin + CONTENT_WIDTH - 4, this.y, 4, 24).fill(GOLD);
    d.font("ArabicBold").fontSize(11).fillColor("#FFFFFF");
    put(d, text, PAGE.margin + 10, PAGE.margin + CONTENT_WIDTH - 14, this.y + 6, "right");
    this.y += 32;
  }
  paragraph(text: string, options: { bullet?: boolean; size?: number; color?: string; bold?: boolean } = {}): void {
    const d = this.doc;
    const size = options.size ?? 9.5;
    d.font(options.bold ? "ArabicBold" : "ArabicRegular").fontSize(size).fillColor(options.color ?? "#1F2937");
    const indent = options.bullet ? 14 : 0;
    const lines = wrapLine(d, text, CONTENT_WIDTH - indent - 8);
    const lineHeight = size * 1.75;
    this.ensure(lines.length * lineHeight + 4);
    lines.forEach((line, i) => {
      put(d, line, PAGE.margin, PAGE.margin + CONTENT_WIDTH - indent, this.y + i * lineHeight, "right");
      if (options.bullet && i === 0) { d.fillColor(GOLD).text("•", PAGE.margin + CONTENT_WIDTH - 8, this.y, { width: 8, lineBreak: false }); d.fillColor(options.color ?? "#1F2937"); }
    });
    this.y += lines.length * lineHeight + 4;
  }
  /** A table whose first column is at the RIGHT edge. `widths` are fractions of the content width. */
  table(headers: string[], rows: string[][], widths: number[], align: Array<"right" | "center"> = []): void {
    const d = this.doc;
    const rowHeight = 21;
    const xs: number[] = [];
    let cursor = PAGE.margin + CONTENT_WIDTH;
    for (const fraction of widths) { const w = fraction * CONTENT_WIDTH; cursor -= w; xs.push(cursor); }
    const drawRow = (cells: string[], y: number, head: boolean, shade: boolean): void => {
      d.rect(PAGE.margin, y, CONTENT_WIDTH, rowHeight).fillAndStroke(head ? NAVY : shade ? "#F8FAFC" : "#FFFFFF", "#E2E8F0");
      d.font(head ? "ArabicBold" : "ArabicRegular").fontSize(head ? 8.5 : 8.5).fillColor(head ? "#FFFFFF" : "#1F2937");
      cells.forEach((cell, i) => {
        const w = widths[i] * CONTENT_WIDTH;
        let shown = cell;
        while (shown.length > 1 && drawnWidth(d, visual(shown)) > w - 10) shown = shown.slice(0, -1);
        if (shown !== cell) shown = `${shown.trimEnd()}…`;
        put(d, shown, xs[i] + 4, xs[i] + w - 4, y + 6, head ? "center" : align[i] ?? "right");
      });
    };
    this.ensure(rowHeight * 2 + 4);
    drawRow(headers, this.y, true, false);
    this.y += rowHeight;
    rows.forEach((cells, i) => {
      if (this.y + rowHeight > PAGE.height - PAGE.margin - 18) { this.doc.addPage(); this.y = PAGE.margin; drawRow(headers, this.y, true, false); this.y += rowHeight; }
      drawRow(cells, this.y, false, i % 2 === 1);
      this.y += rowHeight;
    });
    this.y += 10;
  }
}

export function generateFacebookReportPdf(payload: ReportPayload, model: ReportModel = buildReportModel(payload)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const regular = getRegularFontBuffer();
    const bold = getBoldFontBuffer();
    const doc = new PDFDocument({
      font: regular as any,
      size: "A4",
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      bufferPages: true,
      info: { Title: "منهجية تقرير منشورات فيسبوك", Author: "Diger", Subject: "منهجية وتحليل", Creator: "Diger" },
    });
    doc.registerFont("ArabicRegular", regular);
    doc.registerFont("ArabicBold", bold);
    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const page = new Page(doc);
    const country = regionNameAr(payload.request.region);
    page.banner(`منهجية وتحليل: ${payload.request.topic}${country ? ` في ${country}` : ""}`, "تقرير منشورات فيسبوك العامة وتعليقاتها • ملف المنهجية منفصل عن ملف البيانات");

    page.heading("نطاق التقرير والفترة");
    for (const line of scopeLinesAr(payload, model)) page.paragraph(line, { bullet: true });

    page.heading("الأعداد الرئيسية");
    page.table(["المؤشر", "القيمة"], [
      ["عدد المنشورات المسلَّمة", formatAr(model.kpis.posts)],
      ["عدد التعليقات المسلَّمة", formatAr(model.kpis.comments)],
      ["إجمالي التفاعلات على المنشورات", formatAr(model.kpis.reactions)],
      ["إجمالي المشاركات", formatAr(model.kpis.shares)],
      ["منشورات استُبعدت لوقوعها خارج الفترة", formatAr(payload.collection.postsOutsideWindow)],
      ["منشورات استُبعدت لعدم وجود تاريخ يمكن التحقق منه", formatAr(payload.collection.postsUndated)],
    ], [0.7, 0.3], ["right", "center"]);

    page.heading("توزيع المنشورات على المحاور");
    page.table(["الترتيب", "المحور", "المنشورات", "التعليقات", "نسبة المنشورات"], model.axes.map((axis) => [toArabicDigits(axis.rank), axis.nameAr, formatAr(axis.posts), formatAr(axis.comments), percentAr(axis.share)]), [0.1, 0.46, 0.14, 0.14, 0.16], ["center", "right", "center", "center", "center"]);

    page.heading("تركّز الناشرين");
    const shown = model.concentration.slice(0, 12);
    const rest = model.concentration.slice(12);
    page.table(["الترتيب", "الناشر", "المنشورات", "النسبة"], [
      ...shown.map((entry, i) => [toArabicDigits(i + 1), entry.name, formatAr(entry.posts), percentAr(entry.share)]),
      ...(rest.length > 0 ? [["", `ناشرون آخرون (${formatAr(rest.length)})`, formatAr(rest.reduce((sum, entry) => sum + entry.posts, 0)), percentAr(rest.reduce((sum, entry) => sum + entry.share, 0))]] : []),
    ], [0.1, 0.55, 0.17, 0.18], ["center", "right", "center", "center"]);

    page.heading("الاستنتاجات التحليلية (مولَّدة من الأرقام المحسوبة)");
    for (const sentence of conclusionsAr(payload, model)) page.paragraph(sentence, { bullet: true });

    page.heading("حدود هذا التقرير");
    for (const sentence of limitsAr(payload, model)) page.paragraph(sentence, { bullet: true });

    page.paragraph(`أُعدّ هذا الملف آليًا من بيانات الطلب بتاريخ ${dayAr(new Date().toISOString().slice(0, 10))}.`, { size: 8, color: "#64748B" });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
      put(doc, `ديجر • صفحة ${toArabicDigits(i + 1)} من ${toArabicDigits(range.count)}`, PAGE.margin, PAGE.margin + CONTENT_WIDTH, PAGE.height - 28, "center");
    }
    doc.end();
  });
}
