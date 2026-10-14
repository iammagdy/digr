import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import * as path from "path";
import * as fs from "fs";
import { normalizeDataset, escapeFormula, type NormalizedDataset } from "../../lib/server/normalizationPipeline";

let cachedRegularBuffer: Buffer | null = null;
let cachedBoldBuffer: Buffer | null = null;

function getRegularFontBuffer(): Buffer {
  if (!cachedRegularBuffer) {
    const cwdPath = path.resolve(process.cwd(), "src", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
    const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
    if (fs.existsSync(cwdPath)) {
      cachedRegularBuffer = fs.readFileSync(cwdPath);
    } else if (fs.existsSync(diskPath)) {
      cachedRegularBuffer = fs.readFileSync(diskPath);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fontRegularBase64 } = require("./embeddedFonts");
      cachedRegularBuffer = Buffer.from(fontRegularBase64, "base64");
    }
  }
  return cachedRegularBuffer;
}

function getBoldFontBuffer(): Buffer {
  if (!cachedBoldBuffer) {
    const cwdPath = path.resolve(process.cwd(), "src", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");
    const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");
    if (fs.existsSync(cwdPath)) {
      cachedBoldBuffer = fs.readFileSync(cwdPath);
    } else if (fs.existsSync(diskPath)) {
      cachedBoldBuffer = fs.readFileSync(diskPath);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fontBoldBase64 } = require("./embeddedFonts");
      cachedBoldBuffer = Buffer.from(fontBoldBase64, "base64");
    }
  }
  return cachedBoldBuffer;
}

/**
 * BiDi-aware line builder for PDFKit:
 * Reorders Arabic words for visual RTL rendering while preserving LTR values (English text, URLs, numbers).
 * Swaps paired punctuation (parentheses, brackets) so they wrap Arabic tokens correctly.
 */
export function formatArabicRtl(text: string): string {
  if (!text) return "";

  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) return text;

  // Protect ASCII parenthesized tokens like (@username) or (UTC) or (123)
  const asciiParenTokens: string[] = [];
  let protectedText = text.replace(/\([a-zA-Z0-9_@.\s-]+\)/g, (match) => {
    asciiParenTokens.push(match);
    return `\u0000ASCII_PAREN_${asciiParenTokens.length - 1}\u0000`;
  });

  // Swap remaining Arabic paired punctuation
  protectedText = protectedText
    .replace(/\(/g, "\u0000OPEN\u0000")
    .replace(/\)/g, "(")
    .replace(/\u0000OPEN\u0000/g, ")")
    .replace(/\[/g, "\u0000B_OPEN\u0000")
    .replace(/\]/g, "[")
    .replace(/\u0000B_OPEN\u0000/g, "]");

  // Restore ASCII parenthesized tokens
  protectedText = protectedText.replace(/\u0000ASCII_PAREN_(\d+)\u0000/g, (_, idx) => {
    return asciiParenTokens[parseInt(idx, 10)];
  });

  // If it's a label + value like: "الحساب المستهدف : MeGz (@iam_megz)"
  const colonMatch = protectedText.match(/^(.*?)\s*:\s*(.*)$/);
  if (colonMatch) {
    const label = colonMatch[1];
    const val = colonMatch[2];
    const valHasArabic = /[\u0600-\u06FF]/.test(val);
    if (!valHasArabic) {
      const revLabel = label.split(" ").reverse().join(" ");
      return `${val} : ${revLabel}`;
    }
  }

  return protectedText.split(" ").reverse().join(" ");
}

// Styling Constants (Academic Navy / Slate / Gold Palette)
const COLOR_NAVY_HEADER = "FF1B365D";
const COLOR_NAVY_LIGHT = "FFEBF2FA";
const COLOR_NAVY_MID = "FF24436E";
const COLOR_GOLD_ACCENT = "FFC59B27";
const COLOR_BORDER = "FFD1D5DB";
const COLOR_ZEBRA_FILL = "FFF8FAFC";
const COLOR_WHITE = "FFFFFFFF";

const borderThin = {
  top: { style: "thin" as const, color: { argb: COLOR_BORDER } },
  left: { style: "thin" as const, color: { argb: COLOR_BORDER } },
  bottom: { style: "thin" as const, color: { argb: COLOR_BORDER } },
  right: { style: "thin" as const, color: { argb: COLOR_BORDER } },
};

/**
 * Generate a research-grade Excel (.xlsx) workbook with 5 sheets:
 * 1. لوحة المؤشرات العامة (Executive KPI Dashboard)
 * 2. البيانات (Full Clean Dataset with RTL & Frozen Header)
 * 3. تحليل التفاعل (Engagement & Distribution Analysis)
 * 4. جودة البيانات (Data Quality, Deduplication & Completeness Audit)
 * 5. دليل الحقول (Dynamic Data Codebook)
 */
export async function generateExcelReport(payload: any): Promise<Buffer> {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = norm.metadata.title;

  const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const rowsCount = norm.rows.length;

  // ================= Sheet 1: لوحة المؤشرات العامة =================
  const wsDash = wb.addWorksheet("لوحة المؤشرات العامة", { views: [{ rightToLeft: true }] });

  // Title Block
  wsDash.mergeCells("A1:H1");
  const titleCell = wsDash.getCell("A1");
  titleCell.value = norm.metadata.title;
  titleCell.font = { name: "Calibri", size: 15, bold: true, color: { argb: COLOR_WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  wsDash.getRow(1).height = 40;

  // Subtitle
  wsDash.mergeCells("A2:H2");
  const subCell = wsDash.getCell("A2");
  subCell.value = `تقرير استخراج وتوثيق البيانات الأكاديمية • ${norm.metadata.platform} • تاريخ الاستخراج: ${dateStr}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF2D3748" } };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_LIGHT } };
  subCell.alignment = { horizontal: "center", vertical: "middle" };
  wsDash.getRow(2).height = 24;

  wsDash.addRow([]); // Blank row 3

  // 4 KPI Summary Cards (Rows 4 & 5)
  wsDash.getRow(4).height = 20;
  wsDash.getRow(5).height = 32;

  const kpiLayout = [
    { colsLabel: "A4:B4", colsVal: "A5:B5", label: "إجمالي السجلات المستخرجة", val: `${rowsCount.toLocaleString("en-US")} سجل` },
    { colsLabel: "C4:D4", colsVal: "C5:D5", label: "المشاهدات / التفاعلات المرصودة", val: (norm.kpis.totalViews || norm.kpis.totalLikes || norm.kpis.totalComments || 0).toLocaleString("en-US") },
    { colsLabel: "E4:F4", colsVal: "E5:F5", label: "نسبة اكتمال البيانات", val: `${norm.kpis.dataCompletenessPct}%` },
    { colsLabel: "G4:H4", colsVal: "G5:H5", label: "المنصة المستهدفة", val: norm.metadata.platform },
  ];

  kpiLayout.forEach((card) => {
    wsDash.mergeCells(card.colsLabel);
    wsDash.mergeCells(card.colsVal);

    const lbl = wsDash.getCell(card.colsLabel.split(":")[0]);
    lbl.value = card.label;
    lbl.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
    lbl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
    lbl.alignment = { horizontal: "center", vertical: "middle" };

    const val = wsDash.getCell(card.colsVal.split(":")[0]);
    val.value = card.val;
    val.font = { name: "Calibri", size: 13, bold: true, color: { argb: COLOR_NAVY_HEADER } };
    val.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    val.alignment = { horizontal: "center", vertical: "middle" };
    val.border = borderThin;
  });

  wsDash.addRow([]); // Blank row 6

  // Methodology Statement Banner (Row 7 & 8)
  wsDash.mergeCells("A7:H8");
  const methCell = wsDash.getCell("A7");
  methCell.value = `ملاحظة منهجية وبيان النزاهة العلمية:\n${norm.metadata.methodology}`;
  methCell.font = { name: "Calibri", size: 9.5, color: { argb: "FF78350F" } };
  methCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
  methCell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  methCell.border = borderThin;
  wsDash.getRow(7).height = 24;
  wsDash.getRow(8).height = 24;

  wsDash.columns = [
    { width: 16 }, { width: 18 }, { width: 22 }, { width: 22 },
    { width: 20 }, { width: 20 }, { width: 24 }, { width: 24 },
  ];

  // ================= Sheet 2: البيانات =================
  const wsData = wb.addWorksheet("البيانات", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });

  // Create Header Map from Codebook for Arabic column headers
  const codebookMap = new Map<string, string>();
  norm.codebook.forEach((c) => codebookMap.set(c.field, c.titleAr));

  const headers = norm.columns.map((c) => codebookMap.get(c) || c);
  const dataHeaderRow = wsData.addRow(headers);
  dataHeaderRow.font = { name: "Calibri", size: 11, bold: true, color: { argb: COLOR_WHITE } };
  dataHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  dataHeaderRow.alignment = { horizontal: "center", vertical: "middle" };
  dataHeaderRow.height = 28;

  // Populate Rows with Zebra Striping and Formula Escaping
  norm.rows.forEach((r, idx) => {
    const rowValues = norm.columns.map((col) => {
      const val = r[col];
      if (val === null || val === undefined) return "";
      if (typeof val === "boolean") return val ? "نعم" : "لا";
      if (typeof val === "number") return val;
      return escapeFormula(val);
    });

    const addedRow = wsData.addRow(rowValues);
    addedRow.font = { name: "Calibri", size: 10 };
    addedRow.height = 22;
    addedRow.alignment = { vertical: "middle" };

    const rowFillColor = idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE;
    addedRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowFillColor } };

    // Format numbers
    addedRow.eachCell((cell, colNumber) => {
      cell.border = borderThin;
      if (typeof cell.value === "number") {
        cell.numFmt = Number.isInteger(cell.value) ? "#,##0" : "#,##0.00";
      }
    });
  });

  // Auto-fit column widths
  wsData.columns = norm.columns.map((col) => {
    const isText = ["text", "comment_text", "bio"].includes(col);
    const isUrl = ["url", "profile_url", "bio_link"].includes(col);
    return { width: isText ? 45 : isUrl ? 32 : 18 };
  });

  // ================= Sheet 3: تحليل التفاعل =================
  const wsEngage = wb.addWorksheet("تحليل التفاعل", { views: [{ rightToLeft: true }] });
  const engTitle = wsEngage.addRow(["تحليل التفاعل والمؤشرات الكمية العامة (Engagement Analysis)"]);
  engTitle.font = { name: "Calibri", size: 13, bold: true, color: { argb: COLOR_NAVY_HEADER } };
  wsEngage.addRow([]);

  const engHeaders = ["المؤشر الرقمي (Metric)", "القيمة الإجمالية (Total)", "المتوسط لكل سجل (Avg / Record)", "ملاحظات إحصائية (Notes)"];
  const engHeaderRow = wsEngage.addRow(engHeaders);
  engHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  engHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
  engHeaderRow.height = 25;
  engHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  const avg = (val: number) => (rowsCount > 0 ? (val / rowsCount).toFixed(1) : "0");
  const metricsData = [
    ["إجمالي المشاهدات (Views)", norm.kpis.totalViews, avg(norm.kpis.totalViews), "مجموع المشاهدات المسجلة للعينات المستخرجة"],
    ["إجمالي الإعجابات (Likes)", norm.kpis.totalLikes, avg(norm.kpis.totalLikes), "تفاعل الإعجاب الصريح بالمنشورات أو التعليقات"],
    ["إعادة النشر والمشاركات (Shares / Retweets)", norm.kpis.totalShares, avg(norm.kpis.totalShares), "مدى الانتشار وتناقل المحتوى"],
    ["التعليقات والردود (Comments / Replies)", norm.kpis.totalComments, avg(norm.kpis.totalComments), "كثافة النقاش والتفاعل النصي المباشر"],
  ];

  metricsData.forEach((m, idx) => {
    const row = wsEngage.addRow(m);
    row.font = { name: "Calibri", size: 10 };
    row.height = 22;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((c) => (c.border = borderThin));
    if (typeof m[1] === "number") row.getCell(2).numFmt = "#,##0";
  });

  wsEngage.columns = [{ width: 35 }, { width: 22 }, { width: 25 }, { width: 45 }];

  // ================= Sheet 4: جودة البيانات =================
  const wsQuality = wb.addWorksheet("جودة البيانات", { views: [{ rightToLeft: true }] });
  const qTitle = wsQuality.addRow(["تقرير جودة وتدقيق البيانات (Data Quality & Verification Audit)"]);
  qTitle.font = { name: "Calibri", size: 13, bold: true, color: { argb: COLOR_NAVY_HEADER } };
  wsQuality.addRow([]);

  const qHeaders = ["معيار التدقيق (Audit Criteria)", "النتيجة المرصودة (Observed Result)", "التقييم المنهجي (Methodological Note)"];
  const qHeaderRow = wsQuality.addRow(qHeaders);
  qHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  qHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
  qHeaderRow.height = 25;
  qHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  const timeRangeDesc = norm.kpis.earliestDate && norm.kpis.latestDate
    ? `من ${norm.kpis.earliestDate} إلى ${norm.kpis.latestDate}`
    : `بتاريخ ${dateStr}`;

  const rawCollectedCount = norm.kpis.totalRecords + (norm.kpis.duplicatesRemoved || 0);
  const targetRequestedDisplay =
    (norm.metadata as any).targetRequested != null
      ? `${(norm.metadata as any).targetRequested} سجل`
      : "عدد السجلات المطلوبة غير متاح";
  const qualityData = [
    ["إجمالي السجلات المستلمة (Raw Collected)", `${rawCollectedCount.toLocaleString("en-US")} سجل`, "إجمالي السجلات الواردة من مزود البيانات قبل الفلترة"],
    ["السجلات الفريدة المسلمة (Unique Delivered)", `${rowsCount.toLocaleString("en-US")} سجل`, "حجم العينة الفعلي المستخلص والموثق في ملف البيانات"],
    ["السجلات المكررة المستبعدة (Duplicates Removed)", `${norm.kpis.duplicatesRemoved} سجل`, "تم التحقق من تفرد السجلات بالمعرف الرقمي وبصمة المحتوى واستبعاد التكرارات"],
    ["السجلات المطلوبة (Target Requested)", targetRequestedDisplay, "الحد المستهدف للعينات المطلوبة في خطة البحث"],
    ["نسبة اكتمال الحقول (Completeness)", `${norm.kpis.dataCompletenessPct}%`, "نسبة الحقول المحتوية على قيم فعلية غير مفقودة"],
    ["نسبة التغطية المنهجية (Coverage)", "نسبة التغطية غير متاحة (مجتمع البحث غير محصور)", "نظراً لأن مجتمع البحث العام غير محصور فإن العينة غير احتمالية ولا تمثل حصراً شاملاً"],
    ["النطاق الزمني للرصد", timeRangeDesc, "الفترة الزمنية الفعلية لتواريخ النشر المستخرجة"],
    ["النزاهة المنهجية (Integrity)", "استخراج مباشر من الواجهات العامة المتاحة", "نُقلت البيانات كما هي معلنة دون أي ترجيح أو توليد اصطناعي"],
    ["ضوابط الخصوصية (Privacy)", "بيانات عامة علنية", "استخراج مقتصر على الواجهات والصفحات المتاحة علناً دون تجاوز"],
  ];

  qualityData.forEach((q, idx) => {
    const row = wsQuality.addRow(q);
    row.font = { name: "Calibri", size: 10 };
    row.height = 22;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((c) => (c.border = borderThin));
  });

  wsQuality.columns = [{ width: 35 }, { width: 25 }, { width: 50 }];

  // ================= Sheet 5: دليل الحقول =================
  const wsCode = wb.addWorksheet("دليل الحقول", { views: [{ rightToLeft: true }] });
  const codeTitle = wsCode.addRow(["دليل حقول ومصطلحات البيانات (Dynamic Data Codebook)"]);
  codeTitle.font = { name: "Calibri", size: 13, bold: true, color: { argb: COLOR_NAVY_HEADER } };
  wsCode.addRow([]);

  const codeHeaders = ["اسم الحقل (Field)", "المسمى باللغة العربية (Label)", "الوصف باللغة العربية (Description)", "نوع البيانات (Data Type)"];
  const codeHeaderRow = wsCode.addRow(codeHeaders);
  codeHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  codeHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  codeHeaderRow.height = 25;
  codeHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  norm.codebook.forEach((c, idx) => {
    const row = wsCode.addRow([c.field, c.titleAr, c.descriptionAr, c.dataType]);
    row.font = { name: "Calibri", size: 10 };
    row.height = 20;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((cell) => (cell.border = borderThin));
  });

  wsCode.columns = [{ width: 20 }, { width: 25 }, { width: 55 }, { width: 22 }];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Generate a white-label CSV file with UTF-8 BOM and formula injection protection
 */
export function generateCsvReport(payload: any): Buffer {
  const norm: NormalizedDataset = normalizeDataset(payload);

  const escapeCsv = (val: any) => {
    const s = String(val ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""');
    return `"${s}"`;
  };

  // Header row using Arabic column titles from codebook
  const codebookMap = new Map<string, string>();
  norm.codebook.forEach((c) => codebookMap.set(c.field, c.titleAr));
  const headers = norm.columns.map((c) => codebookMap.get(c) || c);
  const headerLine = headers.map(escapeCsv).join(",");

  const rowLines = norm.rows.map((row: any) => {
    return norm.columns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return '""';
        if (typeof val === "boolean") return escapeCsv(val ? "نعم" : "لا");
        if (typeof val === "number") return String(val);
        return escapeCsv(escapeFormula(val));
      })
      .join(",");
  });

  // UTF-8 BOM (\uFEFF) ensures Excel and statistical software open Arabic without mojibake
  const csvContent = "\uFEFF" + headerLine + "\n" + rowLines.join("\n") + "\n";
  return Buffer.from(csvContent, "utf-8");
}

/**
 * Generate a white-label Arabic PDF research report with embedded IBM Plex Sans Arabic font
 */
export function generatePdfReport(payload: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const norm: NormalizedDataset = normalizeDataset(payload);

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 35, right: 35 },
      info: {
        Title: norm.metadata.title,
        Author: "Diger",
        Subject: "Data Report",
        Creator: "Diger Data Platform",
      },
    });

    doc.registerFont("ArabicRegular", getRegularFontBuffer());
    doc.registerFont("ArabicBold", getBoldFontBuffer());

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const contentWidth = 525;
    const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const rowsCount = norm.rows.length;

    // 1. Header Banner (Navy)
    doc.rect(35, 28, contentWidth, 54).fill("#1B365D");

    doc.font("ArabicBold").fontSize(14).fillColor("#FFFFFF");
    doc.text(formatArabicRtl(norm.metadata.title), 50, 36, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3.5,
    });

    doc.font("ArabicRegular").fontSize(8.5).fillColor("#CBD5E1");
    const subTitle = `تقرير استخراج وتوثيق البيانات الأكاديمية • ${norm.metadata.platform} • تاريخ الاستخراج: ${dateStr}`;
    doc.text(formatArabicRtl(subTitle), 50, 58, {
      width: contentWidth - 30,
      align: "right",
      wordSpacing: 3,
    });

    let currentY = 92;

    // 2. Summary KPI Cards (4 columns)
    const boxGap = 8;
    const boxWidth = (contentWidth - boxGap * 3) / 4;
    const boxHeight = 52;

    const cards = [
      { label: "إجمالي السجلات", val: `${rowsCount.toLocaleString("en-US")}` },
      { label: "التفاعل المرصود", val: (norm.kpis.totalViews || norm.kpis.totalLikes || norm.kpis.totalComments || 0).toLocaleString("en-US") },
      { label: "نسبة الاكتمال", val: `${norm.kpis.dataCompletenessPct}%` },
      { label: "المنصة", val: norm.metadata.platform.slice(0, 15) },
    ];

    cards.forEach((card, idx) => {
      const bx = 35 + idx * (boxWidth + boxGap);
      doc.rect(bx, currentY, boxWidth, boxHeight).fillAndStroke("#F8FAFC", "#CBD5E1");

      doc.font("ArabicRegular").fontSize(8).fillColor("#64748B");
      doc.text(formatArabicRtl(card.label), bx, currentY + 8, {
        width: boxWidth,
        align: "center",
        wordSpacing: 2,
      });

      doc.font("ArabicBold").fontSize(11).fillColor("#1B365D");
      doc.text(formatArabicRtl(card.val), bx, currentY + 26, {
        width: boxWidth,
        align: "center",
      });
    });

    currentY += 62;

    // 3. Tabular Sample Overview
    doc.font("ArabicBold").fontSize(10.5).fillColor("#1B365D");
    doc.text(formatArabicRtl("عينة من السجلات المستخرجة :"), 35, currentY, {
      width: contentWidth,
      align: "right",
      wordSpacing: 3,
    });
    currentY += 16;

    const sampleRows = norm.rows.slice(0, 5);
    const rowHeight = 36;

    sampleRows.forEach((r, idx) => {
      const ry = currentY + idx * rowHeight;
      const bg = idx % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
      doc.rect(35, ry, contentWidth, rowHeight).fillAndStroke(bg, "#E2E8F0");

      const labelText = r.text || r.comment_text || r.display_name || r.bio || r.author_name || `سجل #${idx + 1}`;
      const metaText = [
        r.username ? r.username : null,
        r.likes_count ? `إعجابات: ${r.likes_count}` : null,
        r.retweets_count ? `إعادة نشر: ${r.retweets_count}` : null,
        r.views_count ? `مشاهدات: ${r.views_count}` : null,
        r.published_at ? String(r.published_at).slice(0, 10) : null,
      ]
        .filter(Boolean)
        .join(" • ");

      doc.font("ArabicBold").fontSize(8.5).fillColor("#1E293B");
      doc.text(formatArabicRtl(String(labelText).slice(0, 90)), 45, ry + 6, {
        width: contentWidth - 20,
        align: "right",
        wordSpacing: 2,
      });

      if (metaText) {
        doc.font("ArabicRegular").fontSize(7.5).fillColor("#64748B");
        doc.text(formatArabicRtl(metaText), 45, ry + 20, {
          width: contentWidth - 20,
          align: "right",
          wordSpacing: 2,
        });
      }
    });

    currentY += sampleRows.length * rowHeight + 14;

    // 4. Academic Methodology Box
    doc.rect(35, currentY, contentWidth, 54).fillAndStroke("#FEF3C7", "#FDE68A");
    doc.font("ArabicBold").fontSize(8.5).fillColor("#92400E");
    doc.text(formatArabicRtl("توثيق المنهجية وإخلاء المسؤولية العلمية :"), 45, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 3,
    });

    doc.font("ArabicRegular").fontSize(7.5).fillColor("#78350F");
    const methSummary = norm.metadata.methodology.slice(0, 240);
    doc.text(formatArabicRtl(methSummary), 45, currentY + 20, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2.5,
    });

    // 5. Footer (Single Page Safe)
    doc.font("ArabicRegular").fontSize(7.5).fillColor("#94A3B8");
    doc.text(formatArabicRtl("تم استخراج وتوثيق هذا التقرير عبر منصة Diger للبيانات العامة • جميع الحقوق محفوظة"), 35, 792, {
      width: contentWidth,
      align: "center",
      wordSpacing: 3,
    });

    doc.end();
  });
}

/**
 * Builds white-label methodology facts document (.txt).
 */
export function generateMethodologyText(payload: any): string {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const rowsCount = norm.rows.length;
  const jobId = norm.metadata.jobId || "N/A";

  return [
    "============================================================",
    "             منصة Diger لاستخراج البيانات العامة             ",
    "               وثيقة المنهجية الأكاديمية والنزاهة              ",
    "============================================================",
    "",
    `معرّف الطلب (Job ID): ${jobId}`,
    `تاريخ الجمع: ${dateStr}`,
    `المصدر / المنصة: ${norm.metadata.platform}`,
    `إجمالي السجلات المستخرجة: ${rowsCount}`,
    "",
    "------------------------------------------------------------",
    "الملاحظات المنهجية ومعايير الجمع:",
    "------------------------------------------------------------",
    norm.metadata.methodology,
    "",
    "إخلاء المسؤولية العلمية والإحصائية:",
    "• هذه البيانات عامة ومتاحة علناً على شبكة الإنترنت بتاريخ الجمع.",
    "• تمثل لقطة مقطعية (Cross-sectional Snapshot) لحظية دقيقة للبيانات المرصودة.",
    "• لا تمثل بالضرورة عينة عشوائية تمثيلية لأغراض التعميم الإحصائي.",
    "• تقتصر النتائج على ما هو متاح علناً للمستخدمين دون أي تجاوز لسياسات الخصوصية.",
    "",
    "تم الإنشاء آلياً عبر منصة Diger • جميع الحقوق محفوظة.",
    "============================================================",
  ].join("\n");
}
