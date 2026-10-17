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

  // PDFKit renders an Arabic-only numeric token from right to left; reverse it so the
  // visual sequence remains the normal Arabic-Indic number order in the generated PDF.
  if (/^[٠-٩٬٫٪ .:-]+$/u.test(text)) return text.split("").reverse().join("");

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

function workbookHyperlink(value: unknown): ExcelJS.CellValue {
  const url = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return url || "غير متاح";
  return { text: url, hyperlink: url, tooltip: url };
}

function customerFacingTitle(title: string): string {
  const cleaned = String(title || "")
    .replace(/\bicypeas(?:[-_. ]companies[-_. ]search)?\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[•·:—-]\s*/g, " — ")
    .replace(/(?:نتائج|بيانات)\s+(?:استخراج|بحث)\s*—?\s*$/u, "نتائج البحث")
    .replace(/^(?:\s*[—–-]\s*)+|(?:\s*[—–-]\s*)+$/g, "")
    .trim();
  return cleaned || "نتائج البحث";
}

function customerFacingPlatform(platform: string): string {
  const normalized = String(platform || "").toLowerCase();
  if (/\b(twitter|tweets|\bx\b)/i.test(normalized)) return "منصة إكس";
  if (normalized.includes("youtube")) return "يوتيوب";
  if (normalized.includes("tiktok")) return "تيك توك";
  if (normalized.includes("facebook")) return "فيسبوك";
  if (normalized.includes("instagram")) return "إنستغرام";
  if (normalized.includes("google") || normalized.includes("serp")) return "جوجل";
  if (normalized.includes("telegram")) return "تيليجرام";
  if (/company|companies|b2b|icypeas/i.test(normalized)) return "بيانات الشركات والأعمال";
  return "مصادر متاحة";
}

function customerFacingEntityType(entityType: string): string {
  const entityLabels: Record<string, string> = {
    companies: "شركات",
    posts: "منشورات",
    comments: "تعليقات",
    profile: "ملف شخصي",
    search: "نتائج بحث",
    tabular: "سجلات",
  };
  return entityLabels[String(entityType || "").toLowerCase()] || "سجلات";
}

function customerFacingCountry(country: unknown): string {
  const value = String(country || "").trim();
  if (!value) return "غير محدد";
  if (/[\u0600-\u06FF]/.test(value)) return value;
  const labels: Record<string, string> = {
    egypt: "مصر",
    germany: "ألمانيا",
    "united arab emirates": "الإمارات العربية المتحدة",
    uae: "الإمارات العربية المتحدة",
    "saudi arabia": "السعودية",
    france: "فرنسا",
    "united kingdom": "المملكة المتحدة",
    uk: "المملكة المتحدة",
    "united states": "الولايات المتحدة",
    usa: "الولايات المتحدة",
  };
  return labels[value.toLowerCase()] || "غير محدد";
}

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
  const reportTitle = customerFacingTitle(norm.metadata.title);
  wb.title = reportTitle;

  const dateStr = norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const rowsCount = norm.rows.length;

  // ================= Sheet 1: لوحة المؤشرات العامة =================
  const wsDash = wb.addWorksheet("لوحة المؤشرات العامة", { views: [{ rightToLeft: true }] });

  // Title Block
  wsDash.mergeCells("A1:H1");
  const titleCell = wsDash.getCell("A1");
  titleCell.value = reportTitle;
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

  wsDash.columns = [
    { width: 16 }, { width: 18 }, { width: 22 }, { width: 22 },
    { width: 20 }, { width: 20 }, { width: 24 }, { width: 24 },
  ];
  wsDash.mergeCells("A8:H8");
  const distributionTitle = wsDash.getCell("A8");
  distributionTitle.value = "التوزيع الإحصائي للسجلات حسب الفئة كما وردت في المصدر";
  distributionTitle.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  distributionTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
  distributionTitle.alignment = { horizontal: "right", vertical: "middle" };
  wsDash.getRow(8).height = 24;
  const categoryGroups = new Map<string, { count: number; views: number; likes: number; comments: number; shares: number }>();
  norm.rows.forEach((record) => {
    const category = String(record.category || record.topic || record.industry || "غير مصنف").trim() || "غير مصنف";
    const group = categoryGroups.get(category) || { count: 0, views: 0, likes: 0, comments: 0, shares: 0 };
    group.count += 1;
    if (typeof record.views_count === "number") group.views += record.views_count;
    if (typeof record.likes_count === "number") group.likes += record.likes_count;
    if (typeof record.replies_count === "number") group.comments += record.replies_count;
    if (typeof record.retweets_count === "number") group.shares += record.retweets_count;
    categoryGroups.set(category, group);
  });
  const distributionHeaders = ["الفئة", "السجلات", "نسبة العينة", "المشاهدات", "الإعجابات", "التعليقات", "المشاركات", "متوسط التفاعلات"];
  distributionHeaders.forEach((label, index) => {
    const cell = wsDash.getCell(9, index + 1);
    cell.value = label;
    cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borderThin;
  });
  wsDash.getRow(9).height = 28;
  const distributionRows = [...categoryGroups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "ar"));
  distributionRows.forEach(([category, metrics], index) => {
    const rowIndex = 10 + index;
    const totalEngagement = metrics.views + metrics.likes + metrics.comments + metrics.shares;
    const values = [category, metrics.count, rowsCount ? metrics.count / rowsCount : 0, metrics.views, metrics.likes, metrics.comments, metrics.shares, rowsCount ? Number((totalEngagement / metrics.count).toFixed(1)) : 0];
    const row = wsDash.getRow(rowIndex);
    row.height = 21;
    values.forEach((value, colIndex) => {
      const cell = row.getCell(colIndex + 1);
      cell.value = value;
      cell.font = { name: "Calibri", size: 9.5, color: { argb: "FF1F2937" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
      cell.alignment = { horizontal: colIndex === 0 ? "right" : "center", vertical: "middle" };
      cell.border = borderThin;
      if (colIndex === 2) cell.numFmt = "0.0%";
      if (colIndex >= 1 && colIndex !== 2) cell.numFmt = "#,##0.0";
    });
  });
  const distributionTotalRow = 10 + distributionRows.length;
  const totalInteraction = norm.kpis.totalViews + norm.kpis.totalLikes + norm.kpis.totalComments + norm.kpis.totalShares;
  const distributionTotals = ["الإجمالي", rowsCount, rowsCount ? 1 : 0, norm.kpis.totalViews, norm.kpis.totalLikes, norm.kpis.totalComments, norm.kpis.totalShares, rowsCount ? Number((totalInteraction / rowsCount).toFixed(1)) : 0];
  const totalsRow = wsDash.getRow(distributionTotalRow);
  totalsRow.height = 23;
  distributionTotals.forEach((value, colIndex) => {
    const cell = totalsRow.getCell(colIndex + 1);
    cell.value = value;
    cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
    cell.alignment = { horizontal: colIndex === 0 ? "right" : "center", vertical: "middle" };
    cell.border = borderThin;
    if (colIndex === 2) cell.numFmt = "0.0%";
    if (colIndex >= 1 && colIndex !== 2) cell.numFmt = "#,##0.0";
  });
  wsDash.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

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
      if (typeof val === "string" && /^(?:https?:\/\/)/i.test(val.trim()) && /(?:^url$|_url$|link$|permalink$)/i.test(col)) {
        return workbookHyperlink(val);
      }
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
      if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
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
  if (norm.columns.length > 0) {
    wsData.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, rowsCount + 1), column: norm.columns.length },
    };
  }
  wsData.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

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
  const qTitle = wsQuality.addRow(["تقرير جودة البيانات (Data Quality Audit)"]);
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

  const reportContext = (norm.metadata as any).reportContext || {};
  const reportedRawCount = Number(reportContext.counts?.rawRows);
  const rawCollectedCount = Number.isFinite(reportedRawCount)
    ? reportedRawCount
    : norm.kpis.totalRecords + (norm.kpis.duplicatesRemoved || 0);
  const targetRequestedDisplay =
    (norm.metadata as any).targetRequested != null
      ? `${(norm.metadata as any).targetRequested} سجل`
      : "عدد السجلات المطلوبة غير متاح";
  const qualityData = [
    ["إجمالي السجلات المستلمة (Raw Collected)", `${rawCollectedCount.toLocaleString("en-US")} سجل`, "عدد السجلات التي أعادها المصدر قبل تطبيق فلاتر الملاءمة"],
    ["السجلات الفريدة المسلمة (Unique Delivered)", `${rowsCount.toLocaleString("en-US")} سجل`, "حجم العينة الفعلي المستخلص والموثق في ملف البيانات"],
    ["السجلات المكررة المستبعدة (Duplicates Removed)", `${norm.kpis.duplicatesRemoved} سجل`, "تم التحقق من تفرد السجلات بالمعرف الرقمي وبصمة المحتوى واستبعاد التكرارات"],
    ["السجلات المطلوبة (Target Requested)", targetRequestedDisplay, "الحد المستهدف للعينات المطلوبة في خطة البحث"],
    ["نسبة اكتمال الحقول (Completeness)", `${norm.kpis.dataCompletenessPct}%`, "نسبة الحقول المحتوية على قيم فعلية غير مفقودة"],
    ["نسبة التغطية المنهجية (Coverage)", "نسبة التغطية غير متاحة (مجتمع البحث غير محصور)", "نظراً لأن مجتمع البحث العام غير محصور فإن العينة غير احتمالية ولا تمثل حصراً شاملاً"],
    ["النطاق الزمني للرصد", timeRangeDesc, "الفترة الزمنية الفعلية لتواريخ النشر المستخرجة"],
    ["معالجة البيانات", "تنظيم وفحص السجلات المستلمة", "الأعداد والحقول تصف نتيجة المصدر بعد تطبيق قواعد الخطة المسجلة"],
    ["حدود التحقق", "لم يُجرَ تحقق مستقل من صحة البيانات", "وجود قيمة في الحقل لا يثبت صحتها أو حداثتها"],
    ...(Number(reportContext.counts?.baselineExclusions) > 0
      ? [["مطابقات قائمة الاستبعاد", `${reportContext.counts.baselineExclusions} سجل`, "عدد السجلات التي طابقت القائمة المرجعية أثناء التنفيذ"]]
      : []),
    ...(Number(reportContext.counts?.relevanceExclusions) > 0
      ? [["سجلات غير ملائمة مستبعدة", `${reportContext.counts.relevanceExclusions} سجل`, "نتيجة فحص الملاءمة المنفذ خلال جمع البيانات"]]
      : []),
    ...(Number(reportContext.counts?.uncertainRows) > 0
      ? [["سجلات تحتاج مراجعة", `${reportContext.counts.uncertainRows} سجل`, "سجلات صنفها فحص الملاءمة كغير محسومة"]]
      : []),
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
 * 2. دليل الشركات المستخرجة (Company Directory with Sector Groupings)
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
  const reportTitle = customerFacingTitle(norm.metadata.title);
  wb.title = reportTitle;

  const detectedTitleCountry = detectCountryFromText(norm.metadata.title || (norm.metadata as any).description || "");
  const targetCountry = customerFacingCountry((norm.metadata as any).country || detectedTitleCountry?.arabicLabel);
  const sourceProvider = String(
    (norm.metadata as any).providerName || (norm.metadata as any).provider || (norm.metadata as any).sourceName || "غير متاح"
  ).trim() || "غير متاح";

  // ================= Sheet 1: الملخص التنفيذي ومؤشرات السوق =================
  const wsExec = wb.addWorksheet("الملخص التنفيذي ومؤشرات السوق", {
    views: [{ showGridLines: true, rightToLeft: true }],
  });

  // Title Banner
  wsExec.mergeCells("A1:H2");
  const titleCell = wsExec.getCell("A1");
  titleCell.value = reportTitle;
  titleCell.font = { name: "Calibri", size: 15, bold: true, color: { argb: COLOR_WHITE } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };

  // Subtitle
  wsExec.mergeCells("A3:H3");
  const subCell = wsExec.getCell("A3");
  subCell.value = `تقرير استخراج وتوثيق الشركات • المزود: ${sourceProvider} • النطاق: ${targetCountry} • تاريخ الاستخراج: ${norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10)}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF334155" } };
  subCell.alignment = { horizontal: "center", vertical: "middle" };

  // KPI summary cards
  const kpis = [
    { colsLabel: "A4:B4", colsVal: "A5:B5", label: "إجمالي السجلات المسلمة", val: norm.rows.length },
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

  // Bring the category and location breakdown onto the first sheet so the
  // workbook opens with an actual summary table, not KPI cards alone.
  const totalCompanies = norm.rows.length;
  const byIndustry = new Map<string, { count: number; emails: number }>();
  const byCity = new Map<string, { count: number; websites: number }>();
  norm.rows.forEach((company) => {
    const industry = String(company.activity || company.sector || company.industry || company.category || "غير متاح").trim() || "غير متاح";
    const cityValue = company.city || extractCityFromAddress(company.location || company.address || company.city, targetCountry);
    const city = String(cityValue || "غير متاح").trim() || "غير متاح";
    const email = String(company.work_email || company.workEmail || company.email || "").trim();
    const website = String(company.website || company.website_url || company.domain || "").trim();
    const industryEntry = byIndustry.get(industry) || { count: 0, emails: 0 };
    industryEntry.count += 1;
    industryEntry.emails += email ? 1 : 0;
    byIndustry.set(industry, industryEntry);
    const cityEntry = byCity.get(city) || { count: 0, websites: 0 };
    cityEntry.count += 1;
    cityEntry.websites += website ? 1 : 0;
    byCity.set(city, cityEntry);
  });
  const industryRows = [...byIndustry.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "ar"));
  const cityRows = [...byCity.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "ar"));

  const addBreakdown = (
    startColumn: number,
    title: string,
    nameHeader: string,
    countHeader: string,
    availabilityHeader: string,
    entries: Array<[string, { count: number; emails?: number; websites?: number }]>,
    availabilityKey: "emails" | "websites",
  ) => {
    const sectionRow = 8;
    const headerRowIndex = 9;
    const endColumn = startColumn + 3;
    wsExec.mergeCells(sectionRow, startColumn, sectionRow, endColumn);
    const section = wsExec.getCell(sectionRow, startColumn);
    section.value = title;
    section.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
    section.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
    section.alignment = { horizontal: "right", vertical: "middle" };
    wsExec.getRow(sectionRow).height = 24;

    const headers = [nameHeader, countHeader, "نسبة من العينة", availabilityHeader];
    headers.forEach((label, index) => {
      const cell = wsExec.getCell(headerRowIndex, startColumn + index);
      cell.value = label;
      cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = borderThin;
    });
    wsExec.getRow(headerRowIndex).height = 30;

    const visibleRows = Math.max(industryRows.length, cityRows.length);
    for (let index = 0; index < visibleRows; index++) {
      const entry = entries[index];
      const values = entry
        ? [entry[0], entry[1].count, totalCompanies ? entry[1].count / totalCompanies : 0, entry[1][availabilityKey] || 0]
        : ["", "", "", ""];
      const rowIndex = headerRowIndex + index + 1;
      const row = wsExec.getRow(rowIndex);
      row.height = 21;
      values.forEach((value, colOffset) => {
        const cell = row.getCell(startColumn + colOffset);
        cell.value = value as any;
        cell.font = { name: "Calibri", size: 9.5, color: { argb: "FF1F2937" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
        cell.alignment = { horizontal: colOffset === 0 ? "right" : "center", vertical: "middle", wrapText: true };
        cell.border = borderThin;
        if (colOffset === 2 && entry) cell.numFmt = "0.0%";
        if ((colOffset === 1 || colOffset === 3) && entry) cell.numFmt = "#,##0";
      });
    }

    const totalRowIndex = headerRowIndex + visibleRows + 1;
    const totalAvailability = entries.reduce((sum, entry) => sum + (entry[1][availabilityKey] || 0), 0);
    const totalRow = wsExec.getRow(totalRowIndex);
    totalRow.height = 23;
    ["الإجمالي", totalCompanies, totalCompanies ? 1 : 0, totalAvailability].forEach((value, colOffset) => {
      const cell = totalRow.getCell(startColumn + colOffset);
      cell.value = value;
      cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
      cell.alignment = { horizontal: colOffset === 0 ? "right" : "center", vertical: "middle" };
      cell.border = borderThin;
      if (colOffset === 2) cell.numFmt = "0.0%";
      if (colOffset === 1 || colOffset === 3) cell.numFmt = "#,##0";
    });
  };

  addBreakdown(1, "التوزيع حسب النشاط", "النشاط", "الشركات", "بريد العمل المتاح", industryRows, "emails");
  addBreakdown(5, "التوزيع حسب الموقع", "المدينة", "الشركات", "المواقع المتاحة", cityRows, "websites");
  wsExec.columns = [{ width: 28 }, { width: 12 }, { width: 14 }, { width: 18 }, { width: 28 }, { width: 12 }, { width: 14 }, { width: 18 }];
  wsExec.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  // ================= Sheet 2: دليل الشركات المستخرجة =================
  const wsDir = wb.addWorksheet("دليل الشركات المستخرجة", {
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
    "بريد العمل (كما ورد من المصدر)",
    "توفر البريد المهني",
    "حالة التوفر في البيانات",
    "معرّف الشركة",
  ];
  const dirHeaderRow = wsDir.addRow(dirHeaders);
  dirHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  dirHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  dirHeaderRow.height = 26;
  dirHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  norm.rows.forEach((r, idx) => {
    const extractedCity = r.city || extractCityFromAddress(r.location || r.address || r.city, targetCountry);
    const city = extractedCity && extractedCity !== "غير محدد" ? extractedCity : "غير متاح";
    const website = r.website || r.website_url || r.domain || "غير متاح";
    const linkedin = r.linkedin_url || r.linkedin || r.url || "غير متاح";
    const rawPhone = r.phone ?? r.phone_number ?? r.business_phone ?? "غير متاح";
    const phoneVal = String(rawPhone).replace(/^'/, "");
    const workEmail = String(r.work_email || r.workEmail || r.email || "").trim();

    const row = wsDir.addRow([
      idx + 1,
      r.company_name || r.name || r.title || `شركة #${idx + 1}`,
      r.activity || r.sector || r.industry || r.category || "غير متاح",
      workbookHyperlink(website),
      workbookHyperlink(linkedin),
      city,
      phoneVal,
      workEmail || "غير متاح",
      workEmail ? "موجود" : "غير موجود",
      "مدرجة في البيانات المستخرجة",
      r.company_id || r.source_id || r.id || `comp_${idx + 1}`,
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
    [4, 5].forEach((column) => {
      const cell = row.getCell(column);
      if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
    });
  });

  wsDir.autoFilter = { from: { row: 1, column: 1 }, to: { row: norm.rows.length + 1, column: dirHeaders.length } };
  wsDir.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  wsDir.columns = [
    { width: 8 },
    { width: 35 },
    { width: 30 },
    { width: 30 },
    { width: 32 },
    { width: 20 },
    { width: 22 },
    { width: 34 },
    { width: 20 },
    { width: 18 },
    { width: 26 },
  ];

  // ================= Sheet 3: بيانات الشركات للتصفية =================
  const wsFlat = wb.addWorksheet("بيانات الشركات للتصفية", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  const flatHeaders = ["كود السجل", "اسم الشركة", "النطاق الرسمي", "رابط لينكد إن", "النشاط", "المدينة / المحافظة", "الهاتف الرسمي", "بريد العمل (كما ورد من المصدر)", "توفر البريد المهني", "حالة الملاءمة"];
  const flatHeaderRow = wsFlat.addRow(flatHeaders);
  flatHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  flatHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
  flatHeaderRow.height = 25;
  flatHeaderRow.alignment = { horizontal: "center", vertical: "middle" };

  norm.rows.forEach((r, idx) => {
    const extractedCity = r.city || extractCityFromAddress(r.location || r.address || r.city, targetCountry);
    const city = extractedCity && extractedCity !== "غير محدد" ? extractedCity : "غير متاح";
    const rawFlatPhone = r.phone ?? r.phone_number ?? r.business_phone ?? "غير متاح";
    const flatPhoneVal = String(rawFlatPhone).replace(/^'/, "");
    const workEmail = String(r.work_email || r.workEmail || r.email || "").trim();
    const row = wsFlat.addRow([
      r.company_id || r.source_id || r.id || `comp_${idx + 1}`,
      r.company_name || r.name || r.title || `شركة #${idx + 1}`,
      workbookHyperlink(r.website || r.website_url || r.domain || "غير متاح"),
      workbookHyperlink(r.linkedin_url || r.linkedin || r.url || "غير متاح"),
      r.activity || r.sector || r.industry || r.category || "غير متاح",
      city,
      flatPhoneVal,
      workEmail || "غير متاح",
      workEmail ? "موجود" : "غير موجود",
      r._relevance_status || "لم تُراجع الملاءمة",
    ]);
    row.font = { name: "Calibri", size: 9.5 };
    row.height = 20;
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: idx % 2 === 1 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    row.eachCell((cell, colNumber) => {
      cell.border = borderThin;
      if (colNumber === 7) cell.numFmt = "@";
    });
    [3, 4].forEach((column) => {
      const cell = row.getCell(column);
      if (cell.hyperlink) cell.font = { name: "Calibri", size: 9.5, color: { argb: "FF0563C1" }, underline: true };
    });
  });
  wsFlat.autoFilter = { from: { row: 1, column: 1 }, to: { row: norm.rows.length + 1, column: flatHeaders.length } };
  wsFlat.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  wsFlat.columns = [{ width: 14 }, { width: 35 }, { width: 28 }, { width: 28 }, { width: 26 }, { width: 18 }, { width: 20 }, { width: 34 }, { width: 20 }, { width: 18 }];

  // ================= Sheet 4: فروع مرتبطة بمعرّف الشركة =================
  // Branch data is included only when it is explicitly present in the source row.
  const wsBranches = wb.addWorksheet("فروع الشركات", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  const branchHeaders = ["معرّف الفرع", "معرّف الشركة", "اسم الشركة", "اسم الفرع", "المدينة", "العنوان", "الهاتف التجاري", "بريد العمل", "رابط المصدر"];
  const branchHeaderRow = wsBranches.addRow(branchHeaders);
  branchHeaderRow.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  branchHeaderRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  branchHeaderRow.height = 26;
  branchHeaderRow.alignment = { horizontal: "center", vertical: "middle" };
  let branchCount = 0;
  norm.rows.forEach((company, companyIndex) => {
    const companyId = String(company.company_id || company.source_id || company.id || `comp_${companyIndex + 1}`);
    const companyName = company.company_name || company.name || company.title || `شركة #${companyIndex + 1}`;
    let branches: any[] = Array.isArray(company.branches) ? company.branches : [];
    if (!branches.length && typeof company.branches === "string") {
      try {
        const parsed = JSON.parse(company.branches);
        if (Array.isArray(parsed)) branches = parsed;
      } catch {
        branches = [];
      }
    }
    branches.forEach((branch: any, branchIndex: number) => {
      const item = typeof branch === "string" ? { address: branch } : branch;
      if (!item || typeof item !== "object") return;
      branchCount += 1;
      wsBranches.addRow([
        String(item.id || item.branch_id || `${companyId}_branch_${branchIndex + 1}`),
        companyId,
        companyName,
        item.name || item.branch_name || "غير متاح",
        item.city || "غير متاح",
        item.address || item.location || "غير متاح",
        String(item.phone ?? item.phone_number ?? "غير متاح"),
        item.work_email || item.email || "غير متاح",
        workbookHyperlink(item.source_url || item.url || "غير متاح"),
      ]);
    });
  });
  if (!branchCount) wsBranches.addRow(["لا توجد بيانات فروع واردة من المصدر"]);
  wsBranches.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, branchCount + 1), column: branchHeaders.length } };
  wsBranches.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  wsBranches.columns = [{ width: 26 }, { width: 24 }, { width: 34 }, { width: 26 }, { width: 20 }, { width: 40 }, { width: 22 }, { width: 34 }, { width: 38 }];

  // ================= Sheet 5: عدادات وتحليل الحقول المتاحة =================
  const wsAnalysis = wb.addWorksheet("تحليل وتوزيع الشركات", { views: [{ rightToLeft: true }] });
  wsAnalysis.addRow(["المؤشر", "العدد", "ملاحظة"]);
  const availableEmailCount = norm.rows.filter((r) => String(r.work_email || r.workEmail || r.email || "").trim()).length;
  const industryCounts = new Map<string, number>();
  const cityCounts = new Map<string, number>();
  norm.rows.forEach((r) => {
    const industry = String(r.activity || r.sector || r.industry || r.category || "غير متاح").trim() || "غير متاح";
    const city = String(r.city || extractCityFromAddress(r.location || r.address || r.city, targetCountry) || "غير متاح").trim() || "غير متاح";
    industryCounts.set(industry, (industryCounts.get(industry) || 0) + 1);
    cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
  });
  [
    ["الشركات الواردة من المصدر", norm.rows.length, "عدد السجلات في ورقة دليل الشركات"],
    ["الفروع الواردة من المصدر", branchCount, branchCount ? "عدد عناصر الفروع المرفقة صراحةً بالسجلات" : "لم ترد بيانات فروع من المصدر"],
    ["سجلات تحتوي بريد عمل", availableEmailCount, "وجود البريد في المصدر لا يعني التحقق من صحته"],
    ["سجلات بلا بريد عمل", norm.rows.length - availableEmailCount, "عداد وجود الحقل فقط"],
  ].forEach((row) => wsAnalysis.addRow(row));
  wsAnalysis.addRow([]);
  wsAnalysis.addRow(["التوزيع حسب النشاط كما ورد", "العدد", ""]);
  [...industryCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([label, count]) => wsAnalysis.addRow([label, count, "حسب قيمة النشاط الواردة من المصدر"]));
  wsAnalysis.addRow([]);
  wsAnalysis.addRow(["التوزيع حسب المدينة كما وردت أو استُخرجت من العنوان", "العدد", ""]);
  [...cityCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([label, count]) => wsAnalysis.addRow([label, count, "لا تُنشأ مدينة عند غياب عنوان واضح"]));
  wsAnalysis.columns = [{ width: 48 }, { width: 16 }, { width: 58 }];
  wsAnalysis.getRow(1).font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
  wsAnalysis.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  wsAnalysis.getRow(1).height = 26;
  wsAnalysis.getRow(1).alignment = { horizontal: "center", vertical: "middle" };

  const doubtfulRows = Array.isArray(_uncertainRows) ? _uncertainRows : [];
  if (doubtfulRows.length) {
    const wsUncertain = wb.addWorksheet("سجلات تحتاج مراجعة", { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    const uncertainHeaders = ["معرّف السجل", "اسم الشركة", "النشاط الوارد", "الموقع الوارد", "حالة الملاءمة", "سبب الإحالة للمراجعة"];
    const header = wsUncertain.addRow(uncertainHeaders);
    header.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: COLOR_WHITE } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
    header.height = 26;
    header.alignment = { horizontal: "center", vertical: "middle" };
    doubtfulRows.forEach((row: any, index: number) => {
      wsUncertain.addRow([
        escapeFormula(String(row.id || `uncertain_${index + 1}`)),
        escapeFormula(String(row.company_name || row.name || row.title || "غير متاح")),
        escapeFormula(String(row.activity || row.sector || row.industry || row.category || "غير متاح")),
        escapeFormula(String(row.location || row.city || row.address || "غير متاح")),
        "تحتاج مراجعة",
        escapeFormula(String(row._relevance_reason || "لم يتأكد التطابق")),
      ]);
    });
    wsUncertain.autoFilter = { from: { row: 1, column: 1 }, to: { row: doubtfulRows.length + 1, column: uncertainHeaders.length } };
    wsUncertain.columns = [{ width: 24 }, { width: 34 }, { width: 30 }, { width: 32 }, { width: 20 }, { width: 52 }];
  }

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
        Title: customerFacingTitle(norm.metadata.title),
        Author: "Diger",
        Subject: "منهجية جمع البيانات",
        Creator: "Diger",
      },
    });

    doc.registerFont("ArabicRegular", regularFontBuf);
    doc.registerFont("ArabicBold", boldFontBuf);

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const contentWidth = 535;
    const dateStr = toArabicDigits(norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    const rowsCount = norm.rows.length;
    const isCompany = norm.metadata.entityType === "companies";

    const detectedTitleCountryPdf = detectCountryFromText(norm.metadata.title || (norm.metadata as any).description || "");
    const targetCountry = customerFacingCountry((norm.metadata as any).country || detectedTitleCountryPdf?.arabicLabel);

    // 1. Header Banner (Academic Navy). Fit long Arabic headings and leave a
    // deliberate inset so the final glyph cannot be clipped at the page edge.
    doc.rect(30, 24, contentWidth, 62).fill("#1B365D");
    const titleText = formatArabicRtl(customerFacingTitle(norm.metadata.title));
    let titleFontSize = 13.5;
    doc.font("ArabicBold").fillColor("#FFFFFF");
    while (titleFontSize > 9) {
      doc.fontSize(titleFontSize);
      if (doc.widthOfString(titleText) <= contentWidth - 36) break;
      titleFontSize -= 0.5;
    }
    doc.fontSize(titleFontSize);
    doc.text(titleText, 48, 31, {
      width: contentWidth - 36,
      height: 24,
      align: "right",
      lineBreak: false,
    });

    const subTitle = `وثيقة منهجية جمع البيانات • ${isCompany ? targetCountry : customerFacingPlatform(norm.metadata.platform)} • تاريخ الجمع: ${dateStr}`;
    const subTitleText = formatArabicRtl(subTitle);
    let subTitleFontSize = 8;
    doc.font("ArabicRegular").fillColor("#CBD5E1");
    while (subTitleFontSize > 6) {
      doc.fontSize(subTitleFontSize);
      if (doc.widthOfString(subTitleText) <= contentWidth - 36) break;
      subTitleFontSize -= 0.25;
    }
    doc.fontSize(subTitleFontSize);
    doc.text(subTitleText, 48, 58, {
      width: contentWidth - 36,
      height: 15,
      align: "right",
      lineBreak: false,
    });

    let currentY = 96;

    // 2. Summary KPI Cards (4 columns)
    const boxGap = 7;
    const boxWidth = (contentWidth - boxGap * 3) / 4;
    const boxHeight = 44;

    const cards = isCompany
      ? [
          { label: "عدد السجلات المعروضة", val: toArabicDigits(rowsCount) },
          { label: "العدد المطلوب", val: toArabicDigits(norm.metadata.targetRequested || rowsCount) },
          { label: "اكتمال الحقول", val: `${toArabicDigits(norm.kpis.dataCompletenessPct)}٪` },
          { label: "النطاق الجغرافي", val: targetCountry },
        ]
      : [
          { label: "عدد السجلات", val: toArabicDigits(rowsCount) },
          { label: "التفاعل المرصود", val: toArabicDigits((norm.kpis.totalViews || norm.kpis.totalLikes || norm.kpis.totalComments || 0).toLocaleString("en-US")) },
          { label: "اكتمال الحقول", val: `${toArabicDigits(norm.kpis.dataCompletenessPct)}٪` },
          { label: "المنصة", val: customerFacingPlatform(norm.metadata.platform) },
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

      const valueText = formatArabicRtl(card.val);
      let valueFontSize = 10.5;
      doc.font("ArabicBold").fillColor("#1B365D");
      while (valueFontSize > 7) {
        doc.fontSize(valueFontSize);
        if (doc.widthOfString(valueText) <= boxWidth - 12) break;
        valueFontSize -= 0.5;
      }
      doc.fontSize(valueFontSize);
      doc.text(valueText, bx + 4, currentY + 22, {
        width: boxWidth - 8,
        height: 15,
        align: "center",
        lineBreak: false,
      });
    });

    currentY += 52;

    // 3. جدول المطابقة والحصر الإحصائي (Reconciliation Counters Table)
    doc.rect(30, currentY, contentWidth, 26).fill("#24436E");
    doc.font("ArabicBold").fontSize(9.5).fillColor("#FFFFFF");
    doc.text(formatArabicRtl("ملخص الأعداد وجودة الحقول:"), 40, currentY + 7, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2,
    });
    currentY += 26;

    const reportContext = (norm.metadata as any).reportContext || {};
    const reportCounts = reportContext.counts || {};
    const contextRawCount = Number(reportCounts.rawRows);
    const rawCollected = Number.isFinite(contextRawCount)
      ? contextRawCount
      : ((norm.metadata as any).rawCollected ?? (rowsCount + (norm.kpis.duplicatesRemoved || 0)));
    const targetRequested = norm.metadata.targetRequested != null ? toArabicDigits(norm.metadata.targetRequested) : "غير محدد";
    const dups = norm.kpis.duplicatesRemoved || 0;

    const counterRows = [
      { label: "العدد المطلوب في الخطة", val: targetRequested },
      { label: "السجلات المستلمة من المصدر", val: toArabicDigits(rawCollected) },
      { label: "السجلات المعروضة بعد إزالة التكرار", val: toArabicDigits(rowsCount) },
      { label: "السجلات المزالة بوصفها مكررة", val: toArabicDigits(dups) },
      { label: "اكتمال الحقول", val: `${toArabicDigits(norm.kpis.dataCompletenessPct)}٪` },
      ...(Number(reportCounts.baselineExclusions) > 0
        ? [{ label: "مطابقات قائمة الاستبعاد", val: toArabicDigits(reportCounts.baselineExclusions) }]
        : []),
      ...(Number(reportCounts.relevanceExclusions) > 0
        ? [{ label: "سجلات مستبعدة لعدم الملاءمة", val: toArabicDigits(reportCounts.relevanceExclusions) }]
        : []),
    ];

    counterRows.forEach((item, idx) => {
      const ry = currentY + idx * 22;
      const bg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      doc.rect(30, ry, contentWidth, 22).fillAndStroke(bg, "#E2E8F0");

      doc.font("ArabicRegular").fontSize(8.5).fillColor("#334155");
      doc.text(formatArabicRtl(item.label), 200, ry + 5, {
        width: contentWidth - 180,
        align: "right",
        height: 13,
        lineBreak: false,
      });

      doc.font("ArabicBold").fontSize(8.5).fillColor("#1B365D");
      doc.text(formatArabicRtl(item.val), 38, ry + 5, {
        width: 160,
        align: "left",
        height: 13,
        lineBreak: false,
      });
    });

    currentY += counterRows.length * 22 + 12;

    // 4. Methodology narrative only. The data and sample records belong in Excel/CSV.
    doc.rect(30, currentY, contentWidth, 26).fill("#24436E");
    doc.font("ArabicBold").fontSize(9.5).fillColor("#FFFFFF");
    doc.text(formatArabicRtl("نطاق البحث والمنهجية:"), 40, currentY + 7, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2,
    });
    currentY += 26;
    const methodologyText = String((norm.metadata as any).methodology || "يعرض هذا التقرير السجلات التي جُمعت ضمن نطاق البحث المحدد في ملف التسليم. حُسب عدد السجلات المعروضة واكتمال الحقول من القيم الموجودة في هذه السجلات؛ ولا تعني نسبة الاكتمال التحقق من صحة المعلومات أو بيانات الاتصال.")
      .replace(/\s+/g, " ")
      .slice(0, 1000);
    doc.font("ArabicRegular").fontSize(9).fillColor("#334155");
    const methodologyHeight = Math.min(150, Math.max(58, doc.heightOfString(formatArabicRtl(methodologyText), {
      width: contentWidth - 32,
      align: "right",
      lineGap: 4,
    })));
    doc.text(formatArabicRtl(methodologyText), 46, currentY + 10, {
      width: contentWidth - 32,
      height: methodologyHeight,
      align: "right",
      lineGap: 4,
    });
    currentY += methodologyHeight + 18;

    // Include run-level provenance only when the worker recorded it. These
    // facts describe the actual search and stopping condition, not guarantees.
    const scope = reportContext.scope || {};
    const collection = reportContext.collection || {};
    const counts = reportContext.counts || {};
    const scopeParts = [scope.country, scope.location, scope.industry]
      .filter((value) => typeof value === "string" && value.trim());
    const searchTerms = Array.isArray(scope.searchTerms)
      ? scope.searchTerms.filter((value: unknown) => typeof value === "string" && value.trim())
      : [];
    if (scope.dateFrom || scope.dateTo) scopeParts.push([scope.dateFrom, scope.dateTo].filter(Boolean).join(" — "));
    const stopReason = collection.stopReason === "target_reached"
      ? "تم بلوغ العدد المطلوب"
      : collection.stopReason === "source_exhausted"
        ? "انتهت الصفحات المتاحة"
        : "غير مسجل";
    const paginationLabel = ({
      cursor: "مؤشر استمرار",
      offset: "إزاحة",
      page: "ترقيم الصفحات",
      none: "طلب واحد",
    } as Record<string, string>)[String(collection.paginationStrategy)] || "غير مسجل";
    const cleaningCounts = [
      `الوارد: ${Number.isFinite(Number(counts.rawRows)) ? toArabicDigits(counts.rawRows) : "غير مسجل"}`,
      `المعروض: ${toArabicDigits(rowsCount)}`,
      `المكرر: ${toArabicDigits(norm.kpis.duplicatesRemoved || 0)}`,
      ...(Number(counts.baselineExclusions) > 0 ? [`قائمة الاستبعاد: ${toArabicDigits(counts.baselineExclusions)}`] : []),
      ...(Number(counts.relevanceExclusions) > 0 ? [`غير ملائم: ${toArabicDigits(counts.relevanceExclusions)}`] : []),
      ...(Number(counts.uncertainRows) > 0 ? [`قيد المراجعة: ${toArabicDigits(counts.uncertainRows)}`] : []),
    ].join(" • ");
    const reportFacts: Array<{ label: string; value: string }> = [
      { label: "١. النطاق والأهداف", value: scopeParts.join(" • ") || "النطاق غير مسجل" },
      { label: "٢. عبارات البحث", value: searchTerms.join("، ") || "لم تُسجل عبارات بحث منفصلة" },
      { label: "٣. الجمع والترقيم", value: `${collection.methodLabel || "مسار الجمع غير مسجل"} • ${paginationLabel} • ${Number(collection.pagesFetched) > 0 ? `${toArabicDigits(collection.pagesFetched)} دفعات` : "عدد الدفعات غير مسجل"} • ${stopReason}` },
      { label: "٤. التنظيف والأعداد", value: cleaningCounts },
      { label: "٥. الخصوصية والتحقق", value: "لم يُجرَ تحقق مستقل من صحة الحقول أو بيانات الاتصال، ولم تُقَس تغطية المجتمع المستهدف." },
      { label: "٦. ملفات التسليم", value: "Excel: البيانات ودليل الحقول • CSV: السجلات • PDF: الملخص والمنهجية" },
    ];

    if (reportFacts.length) {
      doc.rect(30, currentY, contentWidth, 24).fill("#EDF2F7");
      doc.rect(30, currentY, 3, 24).fill("#C59B27");
      doc.font("ArabicBold").fontSize(8.5).fillColor("#1B365D");
      doc.text(formatArabicRtl("منهجية البحث: ستة محاور"), 40, currentY + 6, {
        width: contentWidth - 20,
        align: "right",
      });
      currentY += 24;

      reportFacts.forEach((fact, idx) => {
        const valueText = formatArabicRtl(fact.value);
        const valueHeight = doc.heightOfString(valueText, {
          width: 215,
          font: "ArabicBold",
          size: 7.25,
          lineGap: 1,
        });
        const rowHeight = Math.max(23, Math.min(38, valueHeight + 8));
        doc.rect(30, currentY, contentWidth, rowHeight)
          .fillAndStroke(idx % 2 ? "#F8FAFC" : "#FFFFFF", "#E2E8F0");
        doc.font("ArabicRegular").fontSize(7.5).fillColor("#475569");
        doc.text(formatArabicRtl(fact.label), 265, currentY + 4, {
          width: 285,
          height: rowHeight - 8,
          align: "right",
        });
        doc.font("ArabicBold").fontSize(7.25).fillColor("#1B365D");
        doc.text(valueText, 38, currentY + 4, {
          width: 215,
          height: rowHeight - 8,
          align: "left",
          lineGap: 1,
        });
        currentY += rowHeight;
      });
      currentY += 10;
    }

    const fields = norm.codebook.map((field) => field.titleAr).filter(Boolean);
    if (fields.length) {
      const shownFields = fields.slice(0, 10);
      const fieldsText = `${shownFields.join(" • ")}${fields.length > shownFields.length ? ` • و${toArabicDigits(fields.length - shownFields.length)} حقول أخرى موضحة في ورقة دليل الحقول بملف Excel` : ""}`;
      const fieldsHeight = Math.max(34, Math.min(58, doc.heightOfString(formatArabicRtl(fieldsText), {
        width: contentWidth - 32,
        lineGap: 2,
      })));
      doc.rect(30, currentY, contentWidth, 24).fill("#EDF2F7");
      doc.rect(30, currentY, 3, 24).fill("#C59B27");
      doc.font("ArabicBold").fontSize(8.5).fillColor("#1B365D");
      doc.text(formatArabicRtl("حقول ملف البيانات:"), 40, currentY + 6, {
        width: contentWidth - 20,
        align: "right",
      });
      currentY += 24;
      doc.font("ArabicRegular").fontSize(7.5).fillColor("#334155");
      doc.text(formatArabicRtl(fieldsText), 46, currentY + 5, {
        width: contentWidth - 32,
        height: fieldsHeight,
        align: "right",
        lineGap: 2,
      });
      currentY += fieldsHeight + 10;
    }

    // 5. Methodological Limitations & Integrity Box
    const limitationsText = [
      "• يعرض التقرير السجلات التي أعادتها المصادر المتاحة وقت الجمع، ولا يثبت شمول جميع الجهات في السوق.",
      "• اكتمال الحقول هو قياس لوجود القيم في السجلات، وليس تحققاً من صحتها.",
      "• لم تُقَس نسبة تغطية المجتمع المستهدف، ولم يُجرَ تحقق مستقل من بيانات الاتصال.",
    ].join("\n");
    doc.font("ArabicRegular").fontSize(8).fillColor("#78350F");
    const limitationsHeight = doc.heightOfString(formatArabicRtl(limitationsText), {
      width: contentWidth - 32,
      lineGap: 3,
    });
    const limitationsBoxHeight = limitationsHeight + 34;
    doc.rect(30, currentY, contentWidth, limitationsBoxHeight).fillAndStroke("#FEF3C7", "#FDE68A");
    doc.font("ArabicBold").fontSize(8).fillColor("#92400E");
    doc.text(formatArabicRtl("حدود ما يوضحه هذا التقرير:"), 40, currentY + 6, {
      width: contentWidth - 20,
      align: "right",
      wordSpacing: 2,
    });

    doc.font("ArabicRegular").fontSize(8).fillColor("#78350F");
    doc.text(formatArabicRtl(limitationsText), 46, currentY + 20, {
      width: contentWidth - 32,
      height: limitationsHeight + 4,
      align: "right",
      lineGap: 3,
    });

    // 6. Footer (Single Page Safe)
    doc.font("ArabicRegular").fontSize(7).fillColor("#94A3B8");
    doc.text(formatArabicRtl("وثيقة منهجية جمع البيانات عبر منصة Diger • جميع الحقوق محفوظة"), 30, 800, {
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
  const dateStr = toArabicDigits(norm.metadata.collectedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10));
  const rowsCount = options?.uniqueDelivered ?? norm.rows.length;

  const dedupCount = options?.duplicatesRemoved ?? options?.deduplicationCount ?? norm.kpis.duplicatesRemoved ?? 0;
  const reportContext = (norm.metadata as any).reportContext || {};
  const contextCounts = reportContext.counts || {};
  const rawCollected = options?.rawCollected ?? contextCounts.rawRows ?? (norm.kpis.totalRecords + (norm.kpis.duplicatesRemoved || 0));
  const contextScope = reportContext.scope || {};
  const contextCollection = reportContext.collection || {};
  const paginationStrategyLabel = ({
    cursor: "مؤشر استمرار",
    offset: "إزاحة",
    page: "ترقيم الصفحات",
    none: "طلب واحد",
  } as Record<string, string>)[String(contextCollection.paginationStrategy)] || "غير مسجل";
  const scopeItems = [
    contextScope.country,
    contextScope.location,
    contextScope.industry,
    ...(Array.isArray(contextScope.searchTerms) ? contextScope.searchTerms : []),
  ]
    .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0);
  const dateRange = [contextScope.dateFrom, contextScope.dateTo].filter(
    (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const stopReasonText = contextCollection.stopReason === "target_reached"
    ? "تم بلوغ العدد المستهدف في الخطة"
    : contextCollection.stopReason === "source_exhausted"
      ? "انتهت الصفحات المتاحة من المصدر قبل بلوغ العدد المستهدف"
      : "غير مسجل";
  const searchRangeText = dateRange.length ? dateRange.join(" — ") : "غير محددة";
  const searchScopeText = scopeItems.length ? scopeItems.join("، ") : "غير مسجل";
  const exclusionSummary = [
    Number(contextCounts.baselineExclusions) > 0 ? `قائمة الاستبعاد: ${toArabicDigits(contextCounts.baselineExclusions)}` : "",
    Number(contextCounts.relevanceExclusions) > 0 ? `عدم الملاءمة: ${toArabicDigits(contextCounts.relevanceExclusions)}` : "",
    Number(contextCounts.uncertainRows) > 0 ? `قيد المراجعة: ${toArabicDigits(contextCounts.uncertainRows)}` : "",
    dedupCount > 0 ? `تكرارات: ${toArabicDigits(dedupCount)}` : "",
  ].filter(Boolean).join("؛ ") || "لا توجد استبعادات مسجلة في بيانات التشغيل";

  return [
    "============================================================",
    "                    منصة Diger للبيانات                    ",
    "                   ملخص منهجية جمع البيانات                  ",
    "============================================================",
    "",
    `تاريخ الجمع: ${dateStr}`,
    `المصدر: ${customerFacingPlatform(norm.metadata.platform)}`,
    `نوع السجلات: ${customerFacingEntityType(norm.metadata.entityType)}`,
    "",
    "١. نطاق البحث وأهدافه",
    `النطاق المسجل: ${searchScopeText}`,
    `الفترة المطلوبة: ${searchRangeText}`,
    `العدد المطلوب في الخطة: ${norm.metadata.targetRequested == null ? "غير متاح" : toArabicDigits(norm.metadata.targetRequested)}`,
    "",
    "٢. مصطلحات البحث والتصنيف",
    `عبارات البحث كما سُجلت: ${scopeItems.filter((item) => ![contextScope.country, contextScope.location, contextScope.industry].includes(item)).join("، ") || "غير مسجلة"}`,
    "لم تُضف تصنيفات موضوعية لم يحددها المستخدم أو المصدر.",
    "",
    "٣. تنفيذ الجمع والترقيم",
    `مسار الجمع: ${contextCollection.methodLabel || "غير مسجل"}`,
    `أسلوب التصفح: ${paginationStrategyLabel}`,
    `دفعات الجمع: ${Number(contextCollection.pagesFetched) > 0 ? toArabicDigits(contextCollection.pagesFetched) : "غير مسجلة"}`,
    `سبب التوقف: ${stopReasonText}`,
    "",
    "٤. التنظيف وإزالة التكرار",
    `السجلات المستلمة من المصدر: ${toArabicDigits(rawCollected)}`,
    `السجلات المعروضة بعد التنظيف: ${toArabicDigits(rowsCount)}`,
    `الاستبعادات المسجلة: ${exclusionSummary}`,
    `اكتمال الحقول: ${toArabicDigits(norm.kpis.dataCompletenessPct)}٪ (يقيس وجود القيم فقط).`,
    "",
    "٥. الخصوصية وحدود التحقق",
    "لم يُجرَ تحقق مستقل من صحة البيانات أو بيانات الاتصال، ولم تُقَس تغطية مجتمع البحث. تُعرض السجلات وفق ما أعاده المصدر وقواعد الخطة المسجلة.",
    "",
    "٦. ملفات التسليم",
    `Excel: ${toArabicDigits(rowsCount)} سجل مع دليل الحقول والجودة • CSV: سجلات البيانات • PDF: ملخص البحث والمنهجية.`,
    "",
    "------------------------------------------------------------",
    "ملاحظات حول البيانات:",
    "------------------------------------------------------------",
    "تعرض هذه الوثيقة الأعداد والحقول الموجودة في ملف التسليم. إزالة التكرار تعتمد على السجلات التي أمكن مطابقتها.",
    "اكتمال الحقول يقيس وجود قيمة في الحقل فقط، ولا يعني التحقق من صحتها.",
    "لم تُقَس نسبة تغطية المجتمع المستهدف، ولا يمكن استنتاج الشمول أو التمثيل الإحصائي من هذه الأعداد وحدها.",
    "لم يُجرَ تحقق مستقل من بيانات الاتصال.",
    "",
    "تم الإنشاء آلياً عبر منصة Diger • جميع الحقوق محفوظة.",
    "============================================================",
  ].join("\n");
}
