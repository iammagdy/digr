import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import * as path from "path";
import * as fs from "fs";
import { normalizeDataset, escapeFormula, type NormalizedDataset } from "../../lib/server/normalizationPipeline";
import { fontRegularBase64, fontBoldBase64 } from "./embeddedFonts";
import { extractCityFromAddress } from "../../lib/server/addressParser";
import { detectCountryFromText } from "../../lib/server/tregAdapter";
import { toArabicDigits } from "../../lib/arabicDigits";

let cachedRegularBuffer: Buffer | null = null;
let cachedBoldBuffer: Buffer | null = null;

function getRegularFontBuffer(): Buffer {
  if (!cachedRegularBuffer) {
    try {
      const cwdPath = path.resolve(process.cwd(), "src", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
      const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Regular.ttf");
      if (fs.existsSync(cwdPath)) {
        cachedRegularBuffer = fs.readFileSync(cwdPath);
      } else if (fs.existsSync(diskPath)) {
        cachedRegularBuffer = fs.readFileSync(diskPath);
      }
    } catch {
      // Fall through to embedded base64
    }
    if (!cachedRegularBuffer) {
      cachedRegularBuffer = Buffer.from(fontRegularBase64, "base64");
    }
  }
  return cachedRegularBuffer;
}

function getBoldFontBuffer(): Buffer {
  if (!cachedBoldBuffer) {
    try {
      const cwdPath = path.resolve(process.cwd(), "src", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");
      const diskPath = path.join(__dirname, "..", "..", "assets", "fonts", "IBMPlexSansArabic-Bold.ttf");
      if (fs.existsSync(cwdPath)) {
        cachedBoldBuffer = fs.readFileSync(cwdPath);
      } else if (fs.existsSync(diskPath)) {
        cachedBoldBuffer = fs.readFileSync(diskPath);
      }
    } catch {
      // Fall through to embedded base64
    }
    if (!cachedBoldBuffer) {
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
export async function generateExcelReport(
  payload: any,
  options?: { deduplicationAudit?: any[] }
): Promise<Buffer> {
  const norm: NormalizedDataset = normalizeDataset(payload);
  if (norm.metadata.entityType === "companies") {
    return generateCompanyExcelReport(payload, options?.deduplicationAudit, (payload as any)?.uncertainRows);
  }
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
 * Generates an executive, professional multi-sheet company research workbook:
 * 1. الملخص التنفيذي ومؤشرات السوق (Executive Summary & KPIs)
 * 2. دليل الشركات المعتمد (Company Directory with Sector Groupings)
 * 3. بيانات الشركات للتصفية (Flat Filterable Table with Autofilters)
 * 4. سجل تدقيق الاستبعاد والمطابقة (Negative-List & Deduplication Audit Log)
 * 5. جودة البيانات ومحددات الحصر (Data Quality & Limitations)
 * 6. دليل الحقول (Dynamic Data Codebook)
 */
export async function generateCompanyExcelReport(
  payload: any,
  _deduplicationAudit: any[] = [],
  _uncertainRows: any[] = []
): Promise<Buffer> {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = norm.metadata.title;

  const detectedTitleCountry = detectCountryFromText(norm.metadata.title || (norm.metadata as any).description || "");
  const targetCountry = (norm.metadata as any).country ||
    detectedTitleCountry?.arabicLabel ||
    (norm.metadata.platform && !["web", "companies", "b2b", "digr", "digr data platform"].includes(norm.metadata.platform.toLowerCase())
      ? norm.metadata.platform
      : "مصر");

  // ================= Sheet 1: الملخص التنفيذي ومؤشرات السوق =================
  const wsExec = wb.addWorksheet("الملخص التنفيذي ومؤشرات السوق", {
    views: [{ showGridLines: true, rightToLeft: true }],
  });

  // Title Banner
  wsExec.mergeCells("A1:H2");
  const titleCell = wsExec.getCell("A1");
  titleCell.value = norm.metadata.title;
  titleCell.font = { name: "Calibri", size: 14, bold: true, color: { argb: COLOR_WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };

  // Subtitle
  wsExec.mergeCells("A3:H3");
  const subCell = wsExec.getCell("A3");
  subCell.value = `تقرير استخراج وتوثيق الشركات • النطاق: ${targetCountry} • تاريخ الاستخراج: ${norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10)}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF334155" } };
  subCell.alignment = { horizontal: "center", vertical: "middle" };

  // KPI summary cards
  const kpis = [
    { colsLabel: "A4:B4", colsVal: "A5:B5", label: "إجمالي المسلم المعتمد", val: norm.rows.length },
    { colsLabel: "C4:D4", colsVal: "C5:D5", label: "السجلات المطلوبة", val: norm.metadata.targetRequested || norm.rows.length },
    { colsLabel: "E4:F4", colsVal: "E5:F5", label: "نسبة اكتمال البيانات", val: `${norm.kpis.dataCompletenessPct}%` },
    { colsLabel: "G4:H4", colsVal: "G5:H5", label: "النطاق الجغرافي", val: targetCountry },
  ];

  kpis.forEach((card) => {
    wsExec.mergeCells(card.colsLabel);
    wsExec.mergeCells(card.colsVal);
    const lbl = wsExec.getCell(card.colsLabel.split(":")[0]);
    lbl.value = card.label;
    lbl.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
    lbl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
    lbl.alignment = { horizontal: "center", vertical: "middle" };

    const val = wsExec.getCell(card.colsVal.split(":")[0]);
    val.value = card.val;
    val.font = { name: "Calibri", size: 13, bold: true, color: { argb: COLOR_NAVY_HEADER } };
    val.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    val.alignment = { horizontal: "center", vertical: "middle" };
    val.border = borderThin;
  });

  wsExec.addRow([]); // Blank row 6
  wsExec.mergeCells("A7:H8");
  const methCell = wsExec.getCell("A7");
  methCell.value = `ملاحظة منهجية وبيان النزاهة العلمية:\n${norm.metadata.methodology}`;
  methCell.font = { name: "Calibri", size: 9.5, italic: true, color: { argb: "FF475569" } };
  methCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  methCell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  methCell.border = borderThin;

  // ================= Sheet 2: دليل الشركات المعتمد =================
  const wsDir = wb.addWorksheet("دليل الشركات المعتمد", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  const dirHeaders = [
    "م",
    "اسم الشركة / المؤسسة",
    "النشاط / التخصص الرئيسي",
    "الموقع الإلكتروني الرسمي",
    "رابط لينكد إن",
    "المدينة / المحافظة",
    "الهاتف التجاري",
    "حالة التحقق",
  ];
  const dirHeaderRow = wsDir.addRow(dirHeaders);
  dirHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  dirHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  dirHeaderRow.height = 26;
  dirHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  norm.rows.forEach((r, idx) => {
    const city = r.city || extractCityFromAddress(r.location || r.address || r.city, targetCountry);
    const website = r.website || r.website_url || r.domain || "غير متاح";
    const linkedin = r.linkedin_url || r.linkedin || r.url || "غير متاح";
    const rawPhone = r.phone || (typeof r.phone_number === "string" ? r.phone_number : "") || r.business_phone || "غير متاح";
    const phoneVal = typeof rawPhone === "string" ? rawPhone.replace(/^'/, "") : rawPhone;

    const row = wsDir.addRow([
      idx + 1,
      r.company_name || r.name || r.title || `شركة #${idx + 1}`,
      r.activity || r.sector || r.industry || r.category || "عام / غير مدرج",
      website,
      linkedin,
      city,
      phoneVal,
      "معتمدة مستقلة",
    ]);
    row.font = { name: "Calibri", size: 10 };
    row.height = 22;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((cell, colNumber) => {
      cell.border = borderThin;
      if (colNumber === 7) {
        cell.numFmt = "@";
      }
    });
  });

  wsDir.autoFilter = { from: { row: 1, column: 1 }, to: { row: norm.rows.length + 1, column: dirHeaders.length } };
  wsDir.columns = [
    { width: 8 },
    { width: 35 },
    { width: 30 },
    { width: 30 },
    { width: 32 },
    { width: 20 },
    { width: 22 },
    { width: 18 },
  ];

  // ================= Sheet 3: بيانات الشركات للتصفية =================
  const wsFlat = wb.addWorksheet("بيانات الشركات للتصفية", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  const flatHeaders = ["كود السجل", "اسم الشركة", "النطاق الرسمي", "رابط لينكد إن", "النشاط", "المدينة / المحافظة", "الهاتف الرسمي", "حالة الملاءمة"];
  const flatHeaderRow = wsFlat.addRow(flatHeaders);
  flatHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  flatHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  flatHeaderRow.height = 25;
  flatHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  norm.rows.forEach((r, idx) => {
    const city = r.city || extractCityFromAddress(r.location || r.address || r.city, targetCountry);
    const rawFlatPhone = r.phone || (typeof r.phone_number === "string" ? r.phone_number : "") || r.business_phone || "N/A";
    const flatPhoneVal = typeof rawFlatPhone === "string" ? rawFlatPhone.replace(/^'/, "") : rawFlatPhone;
    const row = wsFlat.addRow([
      r.id || `comp_${idx + 1}`,
      r.company_name || r.name || r.title || `شركة #${idx + 1}`,
      r.website || r.website_url || r.domain || "N/A",
      r.linkedin_url || r.linkedin || r.url || "N/A",
      r.activity || r.sector || r.industry || r.category || "عام",
      city,
      flatPhoneVal,
      r._relevance_status || "مطابق معتمد",
    ]);
    row.font = { name: "Calibri", size: 9.5 };
    row.height = 20;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((cell, colNumber) => {
      cell.border = borderThin;
      if (colNumber === 7) cell.numFmt = "@";
    });
  });
  wsFlat.autoFilter = { from: { row: 1, column: 1 }, to: { row: norm.rows.length + 1, column: flatHeaders.length } };
  wsFlat.columns = [{ width: 14 }, { width: 35 }, { width: 28 }, { width: 28 }, { width: 26 }, { width: 18 }, { width: 20 }, { width: 18 }];

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

    const regularFontBuf = getRegularFontBuffer();
    const boldFontBuf = getBoldFontBuffer();

    const doc = new PDFDocument({
      font: regularFontBuf as any,
      size: "A4",
      margins: { top: 25, bottom: 25, left: 30, right: 30 },
      info: {
        Title: norm.metadata.title,
        Author: "Diger",
        Subject: "Data Report",
        Creator: "Diger Data Platform",
      },
    });

    doc.registerFont("ArabicRegular", regularFontBuf);
    doc.registerFont("ArabicBold", boldFontBuf);

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const contentWidth = 535;
    const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const rowsCount = norm.rows.length;
    const isCompany = norm.metadata.entityType === "companies";

    const detectedTitleCountryPdf = detectCountryFromText(norm.metadata.title || (norm.metadata as any).description || "");
    const targetCountry = (norm.metadata as any).country ||
      detectedTitleCountryPdf?.arabicLabel ||
      (norm.metadata.platform && !["web", "companies", "b2b", "digr", "digr data platform"].includes(norm.metadata.platform.toLowerCase())
        ? norm.metadata.platform
        : "مصر");

    // 1. Header Banner (Academic Navy)
    doc.rect(30, 24, contentWidth, 52).fill("#1B365D");

    doc.font("ArabicBold").fontSize(13.5).fillColor("#FFFFFF");
    doc.text(formatArabicRtl(norm.metadata.title), 40, 32, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 3,
    });

    doc.font("ArabicRegular").fontSize(8).fillColor("#CBD5E1");
    const subTitle = isCompany
      ? `وثيقة المنهجية الأكاديمية وحصر البيانات • ${targetCountry} • تاريخ الاستخراج: ${dateStr}`
      : `تقرير استخراج وتوثيق البيانات الأكاديمية • ${norm.metadata.platform} • تاريخ الاستخراج: ${dateStr}`;
    doc.text(formatArabicRtl(subTitle), 40, 52, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2.5,
    });

    let currentY = 84;

    // 2. Summary KPI Cards (4 columns)
    const boxGap = 7;
    const boxWidth = (contentWidth - boxGap * 3) / 4;
    const boxHeight = 44;

    const cards = isCompany
      ? [
          { label: "إجمالي المسلم المعتمد", val: `${rowsCount}` },
          { label: "السجلات المطلوبة", val: `${norm.metadata.targetRequested || rowsCount}` },
          { label: "نسبة اكتمال البيانات", val: `${norm.kpis.dataCompletenessPct}%` },
          { label: "النطاق الجغرافي", val: targetCountry.slice(0, 18) },
        ]
      : [
          { label: "إجمالي السجلات", val: `${rowsCount}` },
          { label: "التفاعل المرصود", val: `${(norm.kpis.totalViews || norm.kpis.totalLikes || norm.kpis.totalComments || 0).toLocaleString("en-US")}` },
          { label: "نسبة الاكتمال", val: `${norm.kpis.dataCompletenessPct}%` },
          { label: "المنصة المستهدفة", val: norm.metadata.platform.slice(0, 18) },
        ];

    cards.forEach((card, idx) => {
      const bx = 30 + idx * (boxWidth + boxGap);
      doc.rect(bx, currentY, boxWidth, boxHeight).fillAndStroke("#F8FAFC", "#CBD5E1");

      doc.font("ArabicRegular").fontSize(7.5).fillColor("#64748B");
      doc.text(formatArabicRtl(card.label), bx, currentY + 6, {
        width: boxWidth,
        align: "center",
        wordSpacing: 1.5,
      });

      doc.font("ArabicBold").fontSize(10.5).fillColor("#1B365D");
      doc.text(formatArabicRtl(card.val), bx, currentY + 22, {
        width: boxWidth,
        align: "center",
      });
    });

    currentY += 52;

    // 3. جدول المطابقة والحصر الإحصائي (Reconciliation Counters Table)
    doc.rect(30, currentY, contentWidth, 22).fill("#24436E");
    doc.font("ArabicBold").fontSize(8.5).fillColor("#FFFFFF");
    doc.text(formatArabicRtl("جدول المطابقة والحصر الإحصائي (Reconciliation & Quality Audit) :"), 40, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2,
    });
    currentY += 22;

    const rawCollected = (norm.metadata as any).rawCollected || (rowsCount + (norm.kpis.duplicatesRemoved || 0));
    const targetRequested = norm.metadata.targetRequested != null ? `${norm.metadata.targetRequested}` : "غير محدد مسبقاً";
    const dups = norm.kpis.duplicatesRemoved || 0;

    const counterRows = [
      { label: "السجلات المستهدفة في الخطة (Target Requested)", val: targetRequested },
      { label: "السجلات المستلمة أولياً من المصادر (Raw Collected)", val: `${rawCollected}` },
      { label: "السجلات المطابقة المعتمدة بعد المراجعة (Validated Matched)", val: `${rowsCount}` },
      { label: "السجلات المستبعدة للتكرار أو عدم المطابقة (Excluded)", val: `${dups}` },
      { label: "نسبة اكتمال حقول السجلات (Field Completeness)", val: `${norm.kpis.dataCompletenessPct}%` },
      { label: "معدل التحقق المنهجي (Methodological Verification)", val: "فحص تطابق وتدقيق آلي متعدد المراحل" },
    ];

    counterRows.forEach((item, idx) => {
      const ry = currentY + idx * 17;
      const bg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(30, ry, contentWidth, 17).fillAndStroke(bg, "#E2E8F0");

      doc.font("ArabicRegular").fontSize(7.5).fillColor("#334155");
      doc.text(formatArabicRtl(item.label), 200, ry + 4, {
        width: contentWidth - 180,
        align: "right",
        wordSpacing: 1.5,
      });

      doc.font("ArabicBold").fontSize(7.5).fillColor("#1B365D");
      doc.text(formatArabicRtl(item.val), 35, ry + 4, {
        width: 160,
        align: "left",
      });
    });

    currentY += counterRows.length * 17 + 8;

    // 4. Tabular Sample Overview (3 sample records)
    doc.font("ArabicBold").fontSize(9.5).fillColor("#1B365D");
    doc.text(formatArabicRtl(isCompany ? "عينة من الشركات المعتمدة المسلمة :" : "عينة من السجلات المستخرجة :"), 30, currentY, {
      width: contentWidth,
      align: "right",
      wordSpacing: 2,
    });
    currentY += 14;

    const sampleRows = norm.rows.slice(0, 3);
    const rowHeight = 32;

    sampleRows.forEach((r, idx) => {
      const ry = currentY + idx * rowHeight;
      const bg = idx % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
      doc.rect(30, ry, contentWidth, rowHeight).fillAndStroke(bg, "#CBD5E1");

      const labelText = r.company_name || r.name || r.text || r.comment_text || r.display_name || r.author_name || `سجل #${idx + 1}`;
      const metaParts = [
        r.website || r.domain ? `موقع: ${r.website || r.domain}` : null,
        r.activity || r.sector ? `نشاط: ${r.activity || r.sector}` : null,
        r.city || r.governorate ? `مدينة: ${r.city || r.governorate}` : null,
        r.phone ? `هاتف: ${r.phone}` : null,
        r.username ? r.username : null,
        r.likes_count ? `إعجابات: ${r.likes_count}` : null,
        r.views_count ? `مشاهدات: ${r.views_count}` : null,
      ].filter(Boolean);

      doc.font("ArabicBold").fontSize(8).fillColor("#0F172A");
      doc.text(formatArabicRtl(String(labelText).slice(0, 85)), 40, ry + 5, {
        width: contentWidth - 20,
        align: "right",
        wordSpacing: 1.5,
      });

      if (metaParts.length > 0) {
        doc.font("ArabicRegular").fontSize(7).fillColor("#64748B");
        doc.text(formatArabicRtl(metaParts.join(" • ")), 40, ry + 18, {
          width: contentWidth - 20,
          align: "right",
          wordSpacing: 1.5,
        });
      }
    });

    currentY += sampleRows.length * rowHeight + 10;

    // 5. Methodological Limitations & Integrity Box
    doc.rect(30, currentY, contentWidth, 75).fillAndStroke("#FEF3C7", "#FDE68A");
    doc.font("ArabicBold").fontSize(8).fillColor("#92400E");
    doc.text(formatArabicRtl("محددات البحث وإخلاء المسؤولية العلمية والإحصائية :"), 40, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2,
    });

    const limitationsText = [
      "• مصادر البيانات: تم استخراج البيانات مباشرة من المصادر المتاحة علناً دون أي التفاف على سياسات الخصوصية.",
      "• طبيعة العينة: تمثل البيانات لقطة مقطعية (Cross-sectional Snapshot) لحظية دقيقة في تاريخ الجمع؛ ونظراً لأن مجتمع البحث العام غير محصور فإن العينة غير احتمالية.",
      "• النزاهة العلمية: تم تطبيق تدقيق الملاءمة واستبعاد التكرار والتحقق من النطاقات المعلنة بأمانة منهجية تامة.",
      "• حدود المسؤولية: لا نضمن الحصر الشامل لكافة الكيانات بالسوق أو حداثة أرقام الاتصال لتغيرها الدوري في مصادرها المعلنة.",
    ].join("\n");

    doc.font("ArabicRegular").fontSize(6.8).fillColor("#78350F");
    doc.text(formatArabicRtl(limitationsText), 40, currentY + 18, {
      width: contentWidth - 20,
      align: "right",
      lineGap: 2.2,
      wordSpacing: 1.2,
    });

    // 6. Footer (Single Page Safe)
    doc.font("ArabicRegular").fontSize(7).fillColor("#94A3B8");
    doc.text(formatArabicRtl("تم استخراج وتوثيق هذا التقرير عبر منصة Diger للأبحاث والبيانات • جميع الحقوق محفوظة"), 30, 800, {
      width: contentWidth,
      align: "center",
      wordSpacing: 2,
    });

    doc.end();
  });
}

/**
 * Builds white-label methodology facts document (.txt).
 */
export function generateMethodologyText(
  payload: any,
  options?: {
    rawCollected?: number;
    uniqueDelivered?: number;
    duplicatesRemoved?: number;
    deduplicationCount?: number;
  }
): string {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const rowsCount = options?.uniqueDelivered ?? norm.rows.length;
  const jobId = norm.metadata.jobId || "N/A";

  const dedupCount = options?.duplicatesRemoved ?? options?.deduplicationCount ?? norm.kpis.duplicatesRemoved ?? 0;
  const rawCollected = options?.rawCollected ?? (norm.kpis.totalRecords + (norm.kpis.duplicatesRemoved || 0));

  return [
    "============================================================",
    "             منصة Diger لاستخراج البيانات العامة             ",
    "               وثيقة المنهجية الأكاديمية والنزاهة              ",
    "============================================================",
    "",
    `معرّف الطلب (Job ID): ${jobId}`,
    `تاريخ الجمع: ${dateStr}`,
    `المصدر / المنصة: ${norm.metadata.platform}`,
    `نوع الكيان المستخرج: ${norm.metadata.entityType}`,
    `إجمالي السجلات المستخرجة: ${rowsCount}`,
    `إجمالي السجلات المستلمة (Raw Collected): ${rawCollected}`,
    `إجمالي السجلات الخام المستخرجة: ${rawCollected}`,
    `السجلات الفريدة المسلمة (Unique Delivered): ${rowsCount}`,
    `السجلات الفريدة المعتمدة: ${rowsCount}`,
    `السجلات المستبعدة للتكرار (Duplicates Removed): ${dedupCount}`,
    `السجلات المستبعدة والمكررة: ${dedupCount}`,
    `نسبة اكتمال الحقول (Completeness): ${norm.kpis.dataCompletenessPct}%`,
    "نسبة التغطية المنهجية (Coverage): نسبة التغطية غير متاحة (مجتمع البحث غير محصور)",
    "النزاهة المنهجية (Integrity): استخراج مباشر من المصادر المتاحة",
    "",
    "------------------------------------------------------------",
    "الملاحظات المنهجية ومعايير الجمع والنزاهة:",
    "------------------------------------------------------------",
    norm.metadata.methodology,
    "",
    "إخلاء المسؤولية العلمية والإحصائية:",
    "• تم استخراج هذه البيانات حصرياً من مصادر متاحة علناً على شبكة الإنترنت بتاريخ الجمع.",
    "• تمثل لقطة مقطعية (Cross-sectional Snapshot) لحظية دقيقة للبيانات المرصودة.",
    "• نظراً لأن مجتمع البحث العام غير محصور، فإن العينة غير احتمالية ولا تمثل حصراً شاملاً.",
    "• تقتصر النتائج على ما هو متاح علناً للمستخدمين دون أي تجاوز لسياسات الخصوصية، ولا تتضمن جمع بيانات اتصال شخصية.",
    "",
    "تم الإنشاء آلياً عبر منصة Diger • جميع الحقوق محفوظة.",
    "============================================================",
  ].join("\n");
}
