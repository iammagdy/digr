import PDFDocument from "pdfkit";
import { workbookCompanyColumns } from "../../lib/companyColumns";
import { formatPhoneDisplay, phoneMayBeIncomplete, PHONE_MAY_BE_INCOMPLETE_AR } from "../../lib/phoneDisplay";
import ExcelJS from "exceljs";
import { POSTS_SHEET_NAME_AR, POST_COMMENTS_DELIVERED_TITLE_AR, POST_DETAIL_KEYS, POST_NUMBER_KEY, POST_NUMBER_TITLE_AR, POST_COLUMN_TITLES_AR } from "../../lib/facebookKeywordService";
import { PassThrough } from "node:stream";
import * as path from "path";
import * as fs from "fs";
import { normalizeDataset, escapeFormula, type NormalizedDataset } from "../../lib/server/normalizationPipeline";
import { fontRegularBase64, fontBoldBase64 } from "./embeddedFonts";
import { localizeAddressAr, localizeCityFromAddress, localizeCityName } from "../../lib/server/addressParser";
import { detectCountryFromText } from "../../lib/server/tregAdapter";
import { toArabicDigits } from "../../lib/arabicDigits";
import { arabicVerificationStatus, markedInvalid } from "../../lib/contactVerification";
import { PEOPLE_COLUMNS } from "../../lib/peopleColumns";
import { peopleDeliveryRow } from "../../lib/server/peopleDelivery";
import { contactValueDelivered } from "./decisionMakerPricing";
import { industryLabelForCell } from "../../lib/industryLabels";
import { cleanCompanyRecord } from "../../lib/companyRowHygiene";
import { isoCountryCodeFromName } from "../../lib/planParameters";
import { normalizeSocialRow } from "../../lib/server/socialRows";
import { resolveCompanyLinks } from "../../lib/companyUrls";
import { scaleValue } from "../../lib/scaleConfig";
import { FILE_SPEC_LIMITS, applySpecToRows, groupRows, sheetNames, specColumns, type FileSpec } from "../../lib/fileSpec";

let cachedRegularBuffer: Buffer | null = null;
let cachedBoldBuffer: Buffer | null = null;

export function getRegularFontBuffer(): Buffer {
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

export function getBoldFontBuffer(): Buffer {
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

/** The record id a customer sees is a plain number («١» in the sheet), never the internal «rec_1» key. */
function plainRecordId(value: unknown, index: number): number | string {
  const text = String(value ?? "").trim().replace(/^rec_/i, "");
  return /^\d+$/.test(text) ? Number(text) : text || index + 1;
}

/** A city cell never holds a country: «مصر» in the city column is the country, so the cell stays empty. */
function cityNotCountry(city: string): string {
  if (city === "غير متاح") return city;
  // Country detection also recognises big cities as their country («دبي» is the Emirates), so only a value that IS the country's name is blanked.
  const country = detectCountryFromText(city);
  const name = city.trim().toLowerCase();
  return country && (name === country.arabicLabel.toLowerCase() || name === country.canonicalEnglish.toLowerCase()) ? "غير متاح" : city;
}

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
  const detected = detectCountryFromText(value);
  if (detected?.arabicLabel) return detected.arabicLabel;
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

/** First line of the review sheet: said plainly, in Arabic, before any table. */
export const REVIEW_SHEET_NOTICE_AR = "هذه السجلات لم تُحتسب عليك ولم تُخصم نقاطها، ولم تدخل ضمن الملف المُسلَّم لأننا لم نتأكد من مطابقتها لطلبك. راجعها بنفسك إن أردت.";
/** First line of the «غير مراجَع» sheet: rows the job's review budget did not reach. Said plainly, in Arabic, before any table. */
export const UNREVIEWED_SHEET_NOTICE_AR = "هذه السجلات لم تُراجَع آلياً لأن التحقق بلغ الحد المسموح لهذا الطلب، فلم نتأكد من مطابقتها لموضوعك. لم تُحتسب عليك ولم تُخصم نقاطها، ولم تدخل ضمن الملف المُسلَّم. راجعها بنفسك إن أردت.";
export const UNREVIEWED_SHEET_NAME_AR = "غير مراجَع";

/** Which of the two apart-sheets of social rows is written: rows under review, or rows the review budget did not reach. */
interface ReviewSheetKind { name: string; notice: string; reasonLabel: string }
const REVIEW_SHEET: ReviewSheetKind = { name: "سجلات تحتاج مراجعة", notice: REVIEW_SHEET_NOTICE_AR, reasonLabel: "سبب المراجعة" };
const UNREVIEWED_SHEET: ReviewSheetKind = { name: UNREVIEWED_SHEET_NAME_AR, notice: UNREVIEWED_SHEET_NOTICE_AR, reasonLabel: "سبب عدم المراجعة" };

/**
 * Generate a data-only Excel workbook. Methodology is delivered separately as PDF.
 */
/**
 * A review sheet for rows the gate could not decide (social posts, comments, videos, people). Said plainly first: they
 * were not charged and are not in the delivered data. Columns: identifier, what the row says, link, why it is here.
 */
function addGenericReviewSheet(wb: ExcelJS.Workbook, uncertain: any[], pick: { text: (row: any) => string; link: (row: any) => string; idLabel?: string }, sheet: ReviewSheetKind = REVIEW_SHEET) {
  if (!Array.isArray(uncertain) || uncertain.length === 0) return;
  const review = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 2, rightToLeft: true }] });
  const headers = ["معرّف السجل", "ما ورد في السجل", "الرابط", sheet.reasonLabel];
  review.mergeCells(1, 1, 1, headers.length);
  const notice = review.getCell(1, 1);
  notice.value = sheet.notice;
  notice.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF7A2E0E" } };
  notice.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };
  notice.alignment = { horizontal: "right", vertical: "middle", wrapText: true, readingOrder: "rtl" as any };
  review.getRow(1).height = 48;
  const head = review.addRow(headers);
  head.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  [22, 60, 36, 56].forEach((width, i) => { review.getColumn(i + 1).width = width; });
  uncertain.forEach((row, i) => {
    const link = pick.link(row);
    const out = review.addRow([
      plainRecordId(row?.id ?? row?.source_id, i),
      escapeFormula(String(pick.text(row) || "غير متاح")),
      /^https?:\/\//i.test(link) ? workbookHyperlink(link) : "غير متاح",
      escapeFormula(String(row?._relevance_reason || "غير متاح")),
    ]);
    out.alignment = { vertical: "middle", wrapText: true };
    out.eachCell((cell) => { cell.border = borderThin; if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true }; });
  });
  review.autoFilter = { from: { row: 2, column: 1 }, to: { row: uncertain.length + 2, column: headers.length } };
}

export async function generateExcelReport(
  payload: any,
  options?: { deduplicationAudit?: any[] }
): Promise<Buffer> {
  const norm: NormalizedDataset = normalizeDataset(payload);
  if (norm.metadata.entityType === "people") {
    return generatePeopleDataWorkbook(norm, (payload as any)?.uncertainRows);
  }
  if (norm.metadata.entityType === "companies") {
    return generateCompanyDataWorkbook(norm, (payload as any)?.uncertainRows);
  }
  if (norm.metadata.socialKind) {
    return generateSocialDataWorkbook(norm, (payload as any)?.uncertainRows, (payload as any)?.unreviewedRows);
  }
  return generateStructuredDataWorkbook(payload, norm);
}

/** The cells of one social record, in column order (the same in the in-memory workbook and in the streamed one). */
function socialRowValues(norm: NormalizedDataset, record: Record<string, any>, index: number, columns: readonly string[] = norm.columns): ExcelJS.CellValue[] {
  return columns.map((key) => {
    const value = record[key];
    if (value === null || value === undefined) return "";
    if (key === "id") return plainRecordId(value, index);
    if (typeof value === "boolean") return value ? "نعم" : "لا";
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim()) && /(?:^url$|_url$)/i.test(key)) return workbookHyperlink(value);
    return escapeFormula(value);
  });
}

const socialSheetName = (norm: NormalizedDataset) =>
  norm.metadata.socialKind === "comments" ? "التعليقات" : norm.metadata.socialKind === "videos" ? "الفيديوهات والمنشورات" : "المنشورات";

const socialColumnWidths = (norm: NormalizedDataset, columns: readonly string[] = norm.columns) =>
  columns.map((key) => ({
    width: /comment_text|video_caption|video_title/.test(key) ? 48 : /url/.test(key) ? 32 : /hashtags|author_name|channel_name/.test(key) ? 24 : 16,
  }));

/** The columns of the comments sheet: for the Facebook keyword service the post's own columns are not repeated in every comment row (the posts sheet holds them once). */
const socialSheetColumns = (norm: NormalizedDataset): string[] =>
  norm.metadata.postUnit ? norm.columns.filter((key) => !(POST_DETAIL_KEYS as readonly string[]).includes(key)) : norm.columns;

/** Rows of the comments that the review sheets list: the platform's own comment id never stands in for a record number. */
const reviewRowsOf = (norm: NormalizedDataset, list: any[]): any[] =>
  (Array.isArray(list) ? list : []).map((raw) => {
    const row: Record<string, any> = { ...(norm.metadata.socialKind ? normalizeSocialRow(norm.metadata.socialKind as any, raw) : raw), _relevance_reason: raw?._relevance_reason };
    if (norm.metadata.postUnit) delete row.source_id;
    return row;
  });

/** The posts sheet of the Facebook keyword service: one row per post (number, text, link, date) and the comments delivered under it. */
function postsSheetTable(norm: NormalizedDataset): { headers: string[]; widths: number[]; rows: ExcelJS.CellValue[][] } {
  const byPost = new Map<number, { text: string; url: string; date: string; delivered: number }>();
  for (const record of norm.rows) {
    const number = Number(record[POST_NUMBER_KEY]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const entry = byPost.get(number) ?? { text: "", url: "", date: "", delivered: 0 };
    entry.text ||= String(record.video_title ?? "");
    entry.url ||= String(record.video_url ?? "");
    entry.date ||= String(record.video_published_at ?? "");
    entry.delivered += 1;
    byPost.set(number, entry);
  }
  const headers = [POST_NUMBER_TITLE_AR, "نص المنشور", POST_COLUMN_TITLES_AR.video_url.titleAr, POST_COLUMN_TITLES_AR.video_published_at.titleAr, POST_COMMENTS_DELIVERED_TITLE_AR];
  const rows = [...byPost.entries()].sort((a, b) => a[0] - b[0]).map(([number, post]) => [
    number,
    escapeFormula(post.text),
    /^https?:\/\//i.test(post.url) ? workbookHyperlink(post.url) : "",
    escapeFormula(post.date),
    post.delivered,
  ] as ExcelJS.CellValue[]);
  return { headers, widths: [14, 60, 32, 18, 18], rows };
}

/**
 * A large result of comments or posts, written row by row to a stream instead of built in memory: memory stays flat whatever the number
 * of rows (the in-memory workbook needs about 18 MB per 1,000 rows), and the rows are split over several sheets of at most
 * `rowsPerSheet` rows, the first row of each sheet being the header. The columns, cell values, styles and the review sheet are the same
 * as in the in-memory workbook; only a result above `scaleValue("streamXlsxAboveRows")` rows takes this path.
 */
async function generateSocialDataWorkbookStreaming(norm: NormalizedDataset, uncertainRows: any[] = [], unreviewedRows: any[] = []): Promise<Buffer> {
  const out = new PassThrough();
  const pieces: Buffer[] = [];
  out.on("data", (piece: Buffer) => pieces.push(piece));
  const finished = new Promise<void>((resolve, reject) => { out.on("end", () => resolve()); out.on("error", reject); });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = "Diger";
  const labels = new Map(norm.codebook.map((entry) => [entry.field, entry.titleAr]));
  const columns = socialSheetColumns(norm);
  const headers = columns.map((key) => labels.get(key) || key);
  const perSheet = scaleValue("rowsPerSheet");
  const sheetCount = Math.max(1, Math.ceil(norm.rows.length / perSheet));
  for (let part = 0; part < sheetCount; part += 1) {
    const sheet = wb.addWorksheet(sheetCount === 1 ? socialSheetName(norm) : `${socialSheetName(norm)} ${toArabicDigits(part + 1)}`, {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
    });
    sheet.columns = socialColumnWidths(norm, columns);
    const header = sheet.addRow(headers);
    header.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    header.height = 30;
    header.commit();
    const from = part * perSheet;
    const to = Math.min(norm.rows.length, from + perSheet);
    for (let index = from; index < to; index += 1) {
      const row = sheet.addRow(socialRowValues(norm, norm.rows[index], index, columns));
      row.height = 22;
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => {
        cell.border = borderThin;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
        if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
      });
      row.commit();
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, to - from + 1), column: Math.max(1, headers.length) } };
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    sheet.commit();
  }
  if (norm.metadata.postUnit) {
    const table = postsSheetTable(norm);
    if (table.rows.length > 0) {
      const posts = wb.addWorksheet(POSTS_SHEET_NAME_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
      posts.columns = table.widths.map((width) => ({ width }));
      const head = posts.addRow(table.headers);
      head.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      });
      head.height = 30;
      head.commit();
      table.rows.forEach((values, i) => {
        const row = posts.addRow(values);
        row.alignment = { vertical: "top", wrapText: true };
        row.eachCell((cell) => {
          cell.border = borderThin;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
          if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
        });
        row.commit();
      });
      posts.autoFilter = { from: { row: 1, column: 1 }, to: { row: table.rows.length + 1, column: table.headers.length } };
      posts.commit();
    }
  }
  const addApartSheet = (rowsOf: any[], kind: ReviewSheetKind) => {
    const review = reviewRowsOf(norm, rowsOf);
    if (review.length === 0) return;
    const sheet = wb.addWorksheet(kind.name, { views: [{ state: "frozen", ySplit: 2, rightToLeft: true }] });
    sheet.columns = [22, 60, 36, 56].map((width) => ({ width }));
    const notice = sheet.addRow([kind.notice]);
    sheet.mergeCells(1, 1, 1, 4);
    const noticeCell = notice.getCell(1);
    noticeCell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF7A2E0E" } };
    noticeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };
    noticeCell.alignment = { horizontal: "right", vertical: "middle", wrapText: true, readingOrder: "rtl" as any };
    notice.height = 48;
    notice.commit();
    const head = sheet.addRow(["معرّف السجل", "ما ورد في السجل", "الرابط", kind.reasonLabel]);
    head.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    head.commit();
    review.forEach((row: any, i: number) => {
      const link = String(row.url || row.video_url || "");
      const out2 = sheet.addRow([
        plainRecordId(row?.id ?? row?.source_id, i),
        escapeFormula(String(row.comment_text || row.text || row.video_caption || row.video_title || "غير متاح")),
        /^https?:\/\//i.test(link) ? workbookHyperlink(link) : "غير متاح",
        escapeFormula(String(row?._relevance_reason || "غير متاح")),
      ]);
      out2.alignment = { vertical: "middle", wrapText: true };
      out2.eachCell((cell) => { cell.border = borderThin; if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true }; });
      out2.commit();
    });
    sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: review.length + 2, column: 4 } };
    sheet.commit();
  };
  addApartSheet(uncertainRows, REVIEW_SHEET);
  addApartSheet(unreviewedRows, UNREVIEWED_SHEET);
  await wb.commit();
  await finished;
  return Buffer.concat(pieces);
}

/** One data sheet of comments or videos with the fixed Arabic columns, readable dates and live links. */
async function generateSocialDataWorkbook(norm: NormalizedDataset, uncertainRows: any[] = [], unreviewedRows: any[] = []): Promise<Buffer> {
  if (norm.rows.length > scaleValue("streamXlsxAboveRows")) return generateSocialDataWorkbookStreaming(norm, uncertainRows, unreviewedRows);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = customerFacingTitle(norm.metadata.title);
  const sheetName = norm.metadata.socialKind === "comments"
    ? "التعليقات"
    : norm.metadata.socialKind === "videos"
      ? "الفيديوهات والمنشورات"
      : "المنشورات";
  const sheet = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  const labels = new Map(norm.codebook.map((entry) => [entry.field, entry.titleAr]));
  const columns = socialSheetColumns(norm);
  const headers = columns.map((key) => labels.get(key) || key);
  const header = sheet.addRow(headers);
  header.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  header.height = 30;
  norm.rows.forEach((record, index) => {
    const row = sheet.addRow(socialRowValues(norm, record, index, columns));
    row.height = 22;
    row.alignment = { vertical: "middle", wrapText: true };
    row.eachCell((cell) => {
      cell.border = borderThin;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
      if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
    });
  });
  sheet.columns = socialColumnWidths(norm, columns);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, norm.rows.length + 1), column: Math.max(1, headers.length) } };
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  if (norm.metadata.postUnit) {
    const table = postsSheetTable(norm);
    if (table.rows.length > 0) {
      const posts = wb.addWorksheet(POSTS_SHEET_NAME_AR, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
      const head = posts.addRow(table.headers);
      head.eachCell((cell) => {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      });
      head.height = 30;
      table.rows.forEach((values, i) => {
        const row = posts.addRow(values);
        row.alignment = { vertical: "top", wrapText: true };
        row.eachCell((cell) => {
          cell.border = borderThin;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
          if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
        });
      });
      posts.columns = table.widths.map((width) => ({ width }));
      posts.autoFilter = { from: { row: 1, column: 1 }, to: { row: table.rows.length + 1, column: table.headers.length } };
      posts.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    }
  }
  // Rows the gate could not decide are normalised like delivered rows and listed apart, never charged.
  addGenericReviewSheet(wb, reviewRowsOf(norm, uncertainRows), {
    text: (row) => row.comment_text || row.text || row.video_caption || row.video_title || "",
    link: (row) => row.url || row.video_url || "",
  });
  // Rows the review budget did not reach: a sheet of their own, never charged, never in the delivered data.
  addGenericReviewSheet(wb, reviewRowsOf(norm, unreviewedRows), {
    text: (row) => row.comment_text || row.text || row.video_caption || row.video_title || "",
    link: (row) => row.url || row.video_url || "",
  }, UNREVIEWED_SHEET);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function contactVerificationSummary(rows: Array<Record<string, any>>): string {
  const summarize = (field: "work_email" | "phone", statusField: string, label: string) => {
    const fallbackField = field === "work_email" ? "email" : "phone_number";
    const present = rows.filter((row) => String(row[field] || row[fallbackField] || "").trim());
    if (!present.length) return `${label}: لا توجد قيم واردة`;
    const statuses = present.map((row) => String(row[statusField] || "").trim());
    const verified = statuses.filter((status) => status === "متحقق").length;
    const checked = statuses.filter((status) => ["متحقق", "لم يتم التحقق", "يحتاج مراجعة", "غير صالح"].includes(status)).length;
    if (!checked) return `${label}: لم ترد حالات تحقق (${toArabicDigits(present.length)} قيمة)`;
    const rate = Math.round((verified / checked) * 100);
    return `${label}: ${toArabicDigits(verified)} من ${toArabicDigits(checked)} حالة تحقق مسجلة (${toArabicDigits(rate)}٪)؛ إجمالي القيم ${toArabicDigits(present.length)}`;
  };
  // People and company results both carry contact fields; social results never do.
  const contactRows = rows.filter((row) => row.contact_name || row.full_name || row.job_title || row.work_email || row.workEmail || row.email || row.phone || row.phone_number || row.company_name);
  if (!contactRows.length) return "";
  return [
    summarize("work_email", "work_email_verification_status", "البريد المهني"),
    summarize("phone", "phone_verification_status", "الهاتف المهني"),
  ].join("؛ ");
}

/** Build a data-only workbook with normalized parent/child tables when the
 * source returns nested comments or replies. Methodology and quality prose is
 * delivered in the separate PDF, not repeated as extra Excel tabs. */
async function generateStructuredDataWorkbook(payload: any, norm: NormalizedDataset): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = customerFacingTitle(norm.metadata.title);
  const rawRows: Record<string, any>[] = Array.isArray(payload?.rows) ? payload.rows : norm.rows;
  const nestedKeys = new Set(["comments", "top_comments", "topComments", "commentList", "replies", "replyList", "reply_list"]);
  const arrayValue = (value: unknown): any[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    return [];
  };
  const mainRows: Record<string, any>[] = [];
  const topComments: Record<string, any>[] = [];
  const replies: Record<string, any>[] = [];
  for (const source of rawRows) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const main = Object.fromEntries(Object.entries(source).filter(([key]) => !nestedKeys.has(key)));
    const looksLikeComment = Boolean(source.comment_id || source.commentId || source.comment_text || source.commentText || source.parent_id || source.parentId);
    if (!looksLikeComment) mainRows.push(main);

    const rootEntityId = String(source.video_id || source.videoId || source.post_id || source.postId || source.id || source.source_id || "");
    const nestedComments = ["comments", "top_comments", "topComments", "commentList"].flatMap((key) => arrayValue(source[key]));
    for (const comment of nestedComments) {
      if (!comment || typeof comment !== "object") continue;
      const { replies: nestedReplies, replyList, reply_list, ...commentFields } = comment;
      const commentId = String(commentFields.comment_id || commentFields.commentId || commentFields.id || commentFields.cid || "");
      topComments.push({ source_entity_id: rootEntityId, ...commentFields, comment_id: commentId || undefined });
      for (const reply of [...arrayValue(nestedReplies), ...arrayValue(replyList), ...arrayValue(reply_list)]) {
        if (!reply || typeof reply !== "object") continue;
        replies.push({ parent_id: commentId, source_entity_id: rootEntityId, ...reply });
      }
    }
    if (looksLikeComment) {
      const item = { ...main };
      const parentId = String(item.parent_id || item.parentId || item.parent_comment_id || "");
      if (item.is_reply === true || parentId) replies.push({ ...item, parent_id: parentId });
      else topComments.push({ ...item, comment_id: item.comment_id || item.commentId || item.id });
    }
  }
  const mainDataset = normalizeDataset({ metadata: payload?.metadata || {}, rows: rawRows.length ? mainRows : norm.rows });
  const commentsDataset = normalizeDataset({ metadata: payload?.metadata || {}, rows: topComments });
  const repliesDataset = normalizeDataset({ metadata: payload?.metadata || {}, rows: replies });
  const titleCell = (cell: ExcelJS.Cell) => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  };
  const addTable = (name: string, dataset: NormalizedDataset) => {
    if (!dataset.rows.length) return;
    const sheet = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    const labels = new Map(dataset.codebook.map((entry) => [entry.field, entry.titleAr]));
    const headers = dataset.columns.map((key) => labels.get(key) || key);
    const header = sheet.addRow(headers);
    header.eachCell(titleCell);
    header.height = 30;
    dataset.rows.forEach((record, index) => {
      const row = sheet.addRow(dataset.columns.map((key) => {
        const value = record[key];
        if (value === null || value === undefined) return "";
        if (key === "id") return plainRecordId(value, index);
        if (typeof value === "boolean") return value ? "نعم" : "لا";
        if (typeof value === "string" && /^(?:https?:\/\/)/i.test(value.trim()) && /(?:^url$|_url$|link$|permalink$)/i.test(key)) return workbookHyperlink(value);
        return escapeFormula(value);
      }));
      row.height = 22;
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => {
        cell.border = borderThin;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
        if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
      });
    });
    sheet.columns = dataset.columns.map((key) => ({ width: /text|comment|description|bio/i.test(key) ? 44 : /url|link/i.test(key) ? 32 : 20 }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, dataset.rows.length + 1), column: Math.max(1, headers.length) } };
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  };

  addTable(norm.metadata.entityType === "posts" ? "الكيانات الأساسية" : "البيانات", mainDataset);
  addTable("التعليقات الرئيسية", commentsDataset);
  addTable("الردود", repliesDataset);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The customer workbook of a decision-makers request: one row per PERSON, in the shared people columns (`src/lib/peopleColumns.ts`, the list the
 * results screen reads too). The name, title, company, work email, office phone, their two statuses and the profile link are always written
 * («غير متاح» where the person has no value, or where the source marked the value invalid); the country, city, company website, industry and
 * the company description are written only when at least one person has a value, like the screen. A value the source marked invalid is not
 * delivered, so it is not written (the settlement does not charge it either).
 */
const PEOPLE_ALWAYS_COLUMNS = new Set(["contact_name", "job_title", "company_name", "work_email", "work_email_verification_status", "phone", "phone_verification_status", "linkedin_url"]);

async function generatePeopleDataWorkbook(norm: NormalizedDataset, uncertainRows: any[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = customerFacingTitle(norm.metadata.title);
  const text = (value: unknown) => String(value ?? "").replace(/^'/, "").trim();
  const cell = (record: Record<string, any>, key: string): string => {
    if (key === "work_email") return contactValueDelivered(record, "work_email") ? text(record.work_email) : "";
    if (key === "phone") return contactValueDelivered(record, "phone") ? text(record.phone) : "";
    if (key === "work_email_verification_status") return contactValueDelivered(record, "work_email") ? arabicVerificationStatus(record.work_email_verification_status, true) : "";
    if (key === "phone_verification_status") return contactValueDelivered(record, "phone") ? arabicVerificationStatus(record.phone_verification_status, true) : "";
    return text(record[key]);
  };
  // Rows already in the shared columns (the worker's) pass through unchanged; a row from another path is put in them (country and city in Arabic).
  const rows = norm.rows.map(peopleDeliveryRow);
  const columns = PEOPLE_COLUMNS.filter((column) => PEOPLE_ALWAYS_COLUMNS.has(column.key) || rows.some((record) => cell(record, column.key) !== ""));
  const lastColumn = columns.length + 1;
  const ws = wb.addWorksheet("بيانات المهنيين", {
    views: [{ state: "frozen", ySplit: 4, rightToLeft: true }],
  });
  ws.mergeCells(1, 1, 1, lastColumn);
  ws.getCell("A1").value = customerFacingTitle(norm.metadata.title);
  ws.getCell("A1").font = { name: "Calibri", size: 15, bold: true, color: { argb: COLOR_WHITE } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 36;
  ws.mergeCells(2, 1, 2, lastColumn);
  const companyNote = columns.some((column) => column.key === "description" || column.key === "website") ? " الموقع الإلكتروني والوصف للشركة التي يعمل بها الشخص." : "";
  ws.getCell("A2").value = `بيانات الاتصال المهنية كما أرجعتها المصادر؛ وجود القيمة لا يعني التحقق المستقل من صحتها.${companyNote}`;
  ws.getCell("A2").font = { name: "Calibri", size: 10, color: { argb: "FF475569" } };
  ws.getCell("A2").alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  ws.getRow(2).height = 28;
  ws.addRow(["عدد السجلات", rows.length]);
  const headers = ["م", ...columns.map((column) => column.titleAr)];
  const header = ws.addRow(headers);
  header.height = 30;
  header.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_MID } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borderThin;
  });
  rows.forEach((record, index) => {
    const values = columns.map((column) => {
      const value = cell(record, column.key);
      if (value === "") return "غير متاح";
      return column.key === "phone" ? formatPhoneDisplay(value) : value;
    });
    const row = ws.addRow([index + 1, ...values.map((value, at) => (typeof value === "string" && columns[at].key !== "work_email" ? escapeFormula(value) : value))]);
    row.height = 24;
    row.alignment = { vertical: "middle", wrapText: true };
    row.eachCell((c) => {
      c.border = borderThin;
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
    });
    columns.forEach((column, at) => {
      const link = cell(record, column.key);
      if ((column.key === "linkedin_url" || column.key === "website") && /^https?:\/\//i.test(link)) {
        const target = row.getCell(at + 2);
        target.value = workbookHyperlink(link);
        target.font = { color: { argb: "FF0563C1" }, underline: true };
      }
      if (column.key === "phone") row.getCell(at + 2).numFmt = "@";
    });
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: rows.length + 4, column: headers.length } };
  ws.columns = [{ width: 8 }, ...columns.map((column) => ({ width: column.width }))];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  addGenericReviewSheet(wb, Array.isArray(uncertainRows) ? uncertainRows : [], {
    text: (row) => [
      [row.contact_name || row.full_name || row.name, row.job_title, row.company_name].filter(Boolean).join(" — "),
      row.location || row.address ? `عنوان الشخص: ${row.location || row.address}` : "",
      row.company_address ? `عنوان الشركة: ${row.company_address}` : "",
    ].filter(Boolean).join("؛ "),
    link: (row) => row.linkedin_url || row.profile_url || "",
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}


/** Customer workbook for company research: only the delivered rows, with an
 * optional separate review table for uncertain rows. Methodology belongs in
 * its PDF, never as hidden audit/codebook tabs in the data workbook. */
async function generateCompanyDataWorkbook(
  norm: NormalizedDataset,
  uncertainRows: any[] = [],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = customerFacingTitle(norm.metadata.title);
  const ws = wb.addWorksheet("بيانات الشركات", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  // The delivered rows are cleaned once more here (a name without a page title's tail or markdown, a phone whose international prefix is another
  // country's not delivered as this company's): the same rules whatever source the row came from.
  const requestedCountry = detectCountryFromText(String((norm.metadata as any).reportContext?.scope?.country || (norm.metadata as any).country || ""));
  const requestedIso = requestedCountry ? isoCountryCodeFromName(requestedCountry.canonicalEnglish) : undefined;
  const rows = norm.rows.map((row) => cleanCompanyRecord(row, { countryIso: requestedIso }));
  // The titles, the order and the widths come from the ONE company column list the results screen reads too: the three optional columns
  // (description, headcount, founding year) are written only when a delivered row has them, so a column empty in every row never appears.
  const columns = workbookCompanyColumns(rows);
  const headers = columns.map((column) => column.titleAr);
  const header = ws.addRow(headers);
  header.font = { name: "Calibri", size: 11, bold: true, color: { argb: COLOR_WHITE } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
  header.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  header.height = 30;
  const companyName = (r: any, index: number) => String(r.company_name || r.name || r.title || `شركة ${index + 1}`).trim();
  const cleanCellText = (v: unknown) => String(v ?? "").replace(/^'/, "").trim() || "غير متاح";
  const sectorLabel = (value: unknown) => industryLabelForCell(cleanCellText(value));
  rows.forEach((r, index) => {
    const rawAddress = cleanCellText(r.address || r.full_address || r.location);
    const rawCity = cleanCellText(r.city);
    const city = cityNotCountry(rawCity !== "غير متاح"
      ? localizeCityName(rawCity, String((norm.metadata as any).country || ""))
      : localizeCityFromAddress(rawAddress === "غير متاح" ? "" : rawAddress, String((norm.metadata as any).country || "")));
    const { website, linkedin } = resolveCompanyLinks(r);
    // A value the SOURCE marked invalid is never delivered: the cell says «غير متاح» (the status columns are not in this workbook, so nothing else could warn).
    const phoneText = markedInvalid(r.phone_verification_status, cleanCellText(r.phone || r.phone_number || r.business_phone) !== "غير متاح")
      ? "غير متاح"
      : cleanCellText(r.phone || r.phone_number || r.business_phone);
    const emailText = markedInvalid(r.work_email_verification_status ?? r.email_verification_status, cleanCellText(r.work_email || r.workEmail || r.email) !== "غير متاح")
      ? "غير متاح"
      : cleanCellText(r.work_email || r.workEmail || r.email);
    const cellFor = (key: string): ExcelJS.CellValue => {
      switch (key) {
        case "company_name": return companyName(r, index);
        case "industry": return sectorLabel(r.industry || r.activity || r.sector || r.category);
        case "website": return /^https?:\/\//i.test(String(website)) ? workbookHyperlink(website) : "غير متاح";
        case "linkedin_url": return /^https?:\/\//i.test(String(linkedin)) ? workbookHyperlink(linkedin) : "غير متاح";
        case "city": return city;
        case "address": return localizeAddressAr(rawAddress);
        case "phone": return phoneText === "غير متاح" ? phoneText : formatPhoneDisplay(phoneText);
        case "work_email": return emailText;
        case "description": return cleanCellText(r.description || r.about || r.headline || r.slogan);
        // A count and a year are read the way the screen shows them: Arabic-Indic digits, and a zero headcount is no headcount.
        case "headcount": { const value = cleanCellText(r.headcount ?? r.numberOfEmployees ?? r.employee_count); return value === "غير متاح" || value === "0" ? "غير متاح" : toArabicDigits(value); }
        case "founded_year": { const value = cleanCellText(r.founded_year ?? r.foundedYear ?? r.year_founded); return value === "غير متاح" ? value : toArabicDigits(value); }
        default: return "غير متاح";
      }
    };
    const values: ExcelJS.CellValue[] = columns.map((column) => cellFor(column.key));
    const row = ws.addRow(values);
    row.height = columns.some((column) => column.key === "description") ? 60 : 24;
    row.alignment = { vertical: "middle", wrapText: true };
    row.eachCell((cell, col) => {
      const key = columns[col - 1]?.key;
      cell.border = borderThin;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
      if (key === "phone" || key === "work_email") cell.numFmt = "@";
      // A phone the source probably cut keeps its digits exactly; the remark is a cell note, so the cell value stays a plain number.
      if (key === "phone" && phoneMayBeIncomplete(cell.value)) cell.note = PHONE_MAY_BE_INCOMPLETE_AR;
      if ((key === "website" || key === "linkedin_url") && cell.hyperlink) {
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
      }
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  ws.columns = columns.map((column) => ({ width: column.width }));
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  // Source-provided branches stay linked to their company by its name (the customer workbook carries no record id).
  const parseBranches = (value: unknown): Array<Record<string, any>> => {
    if (Array.isArray(value)) return value as Array<Record<string, any>>;
    if (typeof value !== "string" || !value.trim().startsWith("[")) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const branchRows: ExcelJS.CellValue[][] = [];
  rows.forEach((r, index) => {
    parseBranches(r.branches).forEach((branch) => {
      const branchAddress = cleanCellText(branch.address || branch.full_address);
      const branchCity = cleanCellText(branch.city);
      branchRows.push([
        companyName(r, index),
        cleanCellText(branch.name || branch.title),
        branchCity !== "غير متاح"
          ? localizeCityName(branchCity, String((norm.metadata as any).country || ""))
          : localizeCityFromAddress(branchAddress === "غير متاح" ? "" : branchAddress, String((norm.metadata as any).country || "")),
        branchAddress,
      ]);
    });
  });
  if (branchRows.length) {
    const branchSheet = wb.addWorksheet("فروع الشركات", {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
    });
    const branchHeaders = ["اسم الشركة", "اسم الفرع", "المدينة", "العنوان"];
    const bh = branchSheet.addRow(branchHeaders);
    bh.font = header.font;
    bh.fill = header.fill;
    bh.alignment = header.alignment;
    branchHeaders.forEach((_, i) => { branchSheet.getColumn(i + 1).width = [36, 32, 22, 44][i]; });
    branchRows.forEach((values) => branchSheet.addRow(values));
    branchSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: branchRows.length + 1, column: branchHeaders.length } };
  }

  const uncertain = Array.isArray(uncertainRows) ? uncertainRows : [];
  if (uncertain.length) {
    const review = wb.addWorksheet("سجلات تحتاج مراجعة", {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
    });
    // No record id: the main sheet has none either, and nothing in the workbook points at a review row (the company name is what the customer reads).
    const reviewHeaders = ["اسم الشركة", "مجال النشاط كما ورد", "العنوان كما ورد", "سبب المراجعة"];
    // Plain statement first: these rows are outside the delivered data and outside the bill.
    review.mergeCells(1, 1, 1, reviewHeaders.length);
    const notice = review.getCell(1, 1);
    notice.value = REVIEW_SHEET_NOTICE_AR;
    notice.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF7A2E0E" } };
    notice.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };
    notice.alignment = { horizontal: "right", vertical: "middle", wrapText: true, readingOrder: "rtl" as any };
    review.getRow(1).height = 48;
    const rh = review.addRow(reviewHeaders);
    rh.font = header.font;
    rh.fill = header.fill;
    rh.alignment = header.alignment;
    review.views = [{ state: "frozen", ySplit: 2, rightToLeft: true }];
    reviewHeaders.forEach((_, i) => { review.getColumn(i + 1).width = [36, 32, 38, 56][i]; });
    uncertain.forEach((r, i) => review.addRow([
      companyName(r, i),
      industryLabelForCell(cleanCellText(r.industry || r.activity || r.sector)),
      localizeAddressAr(cleanCellText(r.location || r.city || r.address)),
      cleanCellText(r._relevance_reason),
    ]));
    review.autoFilter = { from: { row: 2, column: 1 }, to: { row: uncertain.length + 2, column: reviewHeaders.length } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Why a shaped file cannot be built; the message is Arabic and safe to show the customer. */
export class FileShapeError extends Error {
  constructor(public readonly messageAr: string) {
    super(messageAr);
    this.name = "FileShapeError";
  }
}

function shapedCell(key: string, value: unknown): ExcelJS.CellValue {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim()) && /(?:^url$|_url$|link$|permalink$)/i.test(key)) return workbookHyperlink(value);
  // Every cell goes through the same formula-injection guard as the standard files: nothing the spec or the data
  // contains can become a formula.
  return escapeFormula(value) as ExcelJS.CellValue;
}

/**
 * Excel built from the saved data and a VALIDATED spec (see lib/fileSpec): chosen columns in order, filters, sorting,
 * and one sheet per value of the grouping column. Data only, like every Diger workbook.
 */
export async function generateShapedExcelReport(payload: any, spec: FileSpec): Promise<Buffer> {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const labels = new Map(norm.codebook.map((entry) => [entry.field, entry.titleAr]));
  const columns = specColumns(norm.columns, spec);
  if (columns.length === 0) throw new FileShapeError("لا توجد أعمدة مطابقة لما طلبته.");
  const rows = applySpecToRows(norm.rows, spec);
  if (rows.length === 0) throw new FileShapeError("لا توجد سجلات تطابق شروط التصفية التي طلبتها.");

  const groups = spec.groupBy ? groupRows(rows, spec.groupBy.column) : [{ value: customerFacingTitle(norm.metadata.title), rows }];
  if (groups.length > FILE_SPEC_LIMITS.maxSheets) {
    throw new FileShapeError(`التقسيم المطلوب ينتج ${toArabicDigits(groups.length)} شيتًا، والحد الأقصى ${toArabicDigits(FILE_SPEC_LIMITS.maxSheets)} شيتًا. اختر عمودًا قيمه أقل.`);
  }
  const names = sheetNames(groups.map((g) => g.value));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = customerFacingTitle(norm.metadata.title);
  groups.forEach((group, groupIndex) => {
    const sheet = wb.addWorksheet(names[groupIndex], { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    const header = sheet.addRow(columns.map((key) => labels.get(key) || key));
    header.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    header.height = 30;
    group.rows.forEach((record, index) => {
      const row = sheet.addRow(columns.map((key) => shapedCell(key, record[key])));
      row.height = 22;
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => {
        cell.border = borderThin;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE } };
        if (cell.hyperlink) cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
      });
    });
    sheet.columns = columns.map((key) => ({ width: /text|caption|title|description/.test(key) ? 48 : /url|link/.test(key) ? 32 : 18 }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, group.rows.length + 1), column: columns.length } };
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The saved data after the spec's filters, sort and column choice, for the CSV and PDF builders. */
export function shapedPayload(payload: any, spec: FileSpec): any {
  const norm: NormalizedDataset = normalizeDataset(payload);
  const columns = specColumns(norm.columns, spec);
  const rows = applySpecToRows(norm.rows, spec).map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])));
  if (rows.length === 0) throw new FileShapeError("لا توجد سجلات تطابق شروط التصفية التي طلبتها.");
  return { ...payload, rows, metadata: { ...(payload?.metadata || {}), rowsCount: rows.length } };
}

/**
 * Generate a white-label CSV file with UTF-8 BOM and formula injection protection
 */
/** Rows turned into text at a time when a CSV file is written. */
const CSV_ROWS_PER_BLOCK = 2000;

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

  const csvLine = (row: any) => {
    const isCompany = Boolean(row.company_name || row.website || row.linkedin_url || row.domain);
    const links = isCompany ? resolveCompanyLinks(row) : null;
    return norm.columns
      .map((col) => {
        let val = row[col];
        if (links) {
          if (col === "website") val = links.website;
          if (col === "linkedin_url" || col === "linkedin") val = links.linkedin || val;
        }
        if (val === null || val === undefined) return '""';
        if (typeof val === "boolean") return escapeCsv(val ? "نعم" : "لا");
        if (typeof val === "number") return String(val);
        return escapeCsv(escapeFormula(val));
      })
      .join(",");
  };

  // Written in blocks of rows (the BOM, the header, then each block), so a very large result never exists as one giant string next to
  // its list of lines and its buffer; the bytes are exactly those of the single-string version.
  // UTF-8 BOM (\uFEFF) ensures Excel and statistical software open Arabic without mojibake
  const blocks: Buffer[] = [Buffer.from("\uFEFF" + headerLine + "\n", "utf-8")];
  for (let start = 0; start < norm.rows.length; start += CSV_ROWS_PER_BLOCK) {
    const text = norm.rows.slice(start, start + CSV_ROWS_PER_BLOCK).map(csvLine).join("\n");
    blocks.push(Buffer.from((start > 0 ? "\n" : "") + text, "utf-8"));
  }
  blocks.push(Buffer.from("\n", "utf-8"));
  return Buffer.concat(blocks);
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
      ...(Number(counts.unreviewedRows) > 0 ? [`غير مراجَع: ${toArabicDigits(counts.unreviewedRows)}`] : []),
    ].join(" • ");
    const reportFacts: Array<{ label: string; value: string }> = [
      { label: "١. النطاق والأهداف", value: scopeParts.join(" • ") || "النطاق غير مسجل" },
      { label: "٢. عبارات البحث", value: searchTerms.join("، ") || "لم تُسجل عبارات بحث منفصلة" },
      { label: "٣. الجمع والترقيم", value: `${collection.methodLabel || "مسار الجمع غير مسجل"} • ${paginationLabel} • ${Number(collection.pagesFetched) > 0 ? `${toArabicDigits(collection.pagesFetched)} دفعات` : "عدد الدفعات غير مسجل"} • ${stopReason}` },
      { label: "٤. التنظيف والأعداد", value: cleaningCounts },
      { label: "٥. الخصوصية والتحقق", value: [contactVerificationSummary(norm.rows), "لا تُقاس تغطية مجتمع البحث من هذه السجلات وحدها."].filter(Boolean).join(" • ") || "لم ترد حالات تحقق مستقلة للحقول؛ ولا تُقاس تغطية مجتمع البحث من هذه السجلات وحدها." },
      { label: "٦. ملفات التسليم", value: "ملف إكسل: البيانات فقط • ملف سي إس في: السجلات • ملف بي دي إف: الملخص والمنهجية" },
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
        doc.font("ArabicBold").fontSize(7.25);
        const valueHeight = doc.heightOfString(valueText, {
          width: 215,
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
      const fieldsText = `${shownFields.join(" • ")}${fields.length > shownFields.length ? ` • و${toArabicDigits(fields.length - shownFields.length)} حقول أخرى` : ""}`;
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
    doc.text(formatArabicRtl("وثيقة منهجية جمع البيانات عبر منصة ديجر • جميع الحقوق محفوظة"), 30, 800, {
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
    Number(contextCounts.unreviewedRows) > 0 ? `غير مراجَع: ${toArabicDigits(contextCounts.unreviewedRows)}` : "",
    dedupCount > 0 ? `تكرارات: ${toArabicDigits(dedupCount)}` : "",
  ].filter(Boolean).join("؛ ") || "لا توجد استبعادات مسجلة في بيانات التشغيل";

  return [
    "============================================================",
    "                    منصة ديجر للبيانات                    ",
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
    `${contactVerificationSummary(norm.rows) || "لم ترد حالات تحقق مستقلة للحقول."} تُعرض السجلات وفق ما أعادته المصادر المتاحة وقواعد الخطة المسجلة؛ ولا تُقاس تغطية مجتمع البحث من هذه السجلات وحدها.`,
    "",
    "٦. ملفات التسليم",
    `ملف إكسل: ${toArabicDigits(rowsCount)} سجل (البيانات فقط) • ملف سي إس في: سجلات البيانات • ملف بي دي إف: ملخص البحث والمنهجية.`,
    "",
    "------------------------------------------------------------",
    "ملاحظات حول البيانات:",
    "------------------------------------------------------------",
    "تعرض هذه الوثيقة الأعداد والحقول الموجودة في ملف التسليم. إزالة التكرار تعتمد على السجلات التي أمكن مطابقتها.",
    "اكتمال الحقول يقيس وجود قيمة في الحقل فقط، ولا يعني التحقق من صحتها.",
    "لم تُقَس نسبة تغطية المجتمع المستهدف، ولا يمكن استنتاج الشمول أو التمثيل الإحصائي من هذه الأعداد وحدها.",
    "",
    "تم الإنشاء آلياً عبر منصة ديجر • جميع الحقوق محفوظة.",
    "============================================================",
  ].join("\n");
}
