import ExcelJS from "exceljs";
import { escapeFormula } from "../../lib/server/normalizationPipeline";
import { axisNameAr, GENERAL_AXIS_ID, HEALTH_AXES } from "../../lib/facebookReport/axes";
import { buildReportModel, sheetNameFor, type ReportPayload } from "../../lib/facebookReport/aggregate";
import { dayAr } from "../../lib/facebookReport/text";
import { toArabicDigits } from "../../lib/arabicDigits";
import { regionNameAr } from "../../lib/regionNames";
import { POST_COMMENTS_DELIVERED_TITLE_AR } from "../../lib/facebookKeywordService";
import type { ReportPost } from "../../lib/facebookReport/types";

/**
 * The report workbook: DATA ONLY, built from the delivered posts and comments (never from typed numbers). Arabic headers, right-to-left sheets, frozen header rows,
 * filters on the data tables, real numeric cells for numbers (counts, shares are numbers formatted as percentages), real date cells for dates, text only for text,
 * working hyperlinks. No internal id, no provider name and no methodology text appear in it: the methodology is the separate PDF.
 *
 * Number display: cells use the standard `#,##0` / `0.0%` formats. An Arabic-Indic display format (`[$-2000000]`-style) was tried only in LibreOffice here; it was NOT
 * verified in Excel and Google Sheets, so it is not used (see docs/FACEBOOK_REPORT.md, «Arabic-Indic digits in the workbook»).
 */
const NAVY = "FF1B365D";
const NAVY_LIGHT = "FFEBF2FA";
const GREEN = "FF00695C";
const WHITE = "FFFFFFFF";
const BORDER = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
const THIN = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const MAX_WIDTH = 60;

const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\ufeff]", "g");
const text = (value: unknown): string => String(escapeFormula(String(value ?? "").replace(CONTROL_RE, "")));

const CONTENT_TYPE_AR: Record<ReportPost["contentType"], string> = { text: "منشور نصي أو صورة", video: "فيديو أو ريلز" };
const REACTION_COLUMNS: Array<[keyof NonNullable<import("../../lib/facebookReport/types").ReportComment["breakdown"]>, string]> = [["like", "إعجاب"], ["love", "حب"], ["care", "اهتمام"], ["haha", "ضحك"], ["wow", "دهشة"], ["sad", "حزن"], ["angry", "غضب"]];

type Row = Array<string | number | Date | { text: string; hyperlink: string } | null>;

function header(sheet: ExcelJS.Worksheet, row: number, titles: string[], fill = NAVY): void {
  const r = sheet.getRow(row);
  titles.forEach((title, i) => {
    const cell = r.getCell(i + 1);
    cell.value = title;
    cell.font = { bold: true, color: { argb: WHITE }, name: "IBM Plex Sans Arabic", size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true, readingOrder: "rtl" };
    cell.border = THIN;
  });
  r.height = 26;
}

function widths(sheet: ExcelJS.Worksheet, titles: string[], rows: Row[], fixed: Record<number, number> = {}): void {
  titles.forEach((title, i) => {
    const longest = Math.max(title.length, ...rows.slice(0, 400).map((row) => {
      const value = row[i];
      const shown = value === null || value === undefined ? "" : value instanceof Date ? "0000-00-00 00:00" : typeof value === "object" ? String((value as any).text) : String(value);
      return Math.min(shown.split("\n")[0].length, MAX_WIDTH);
    }));
    sheet.getColumn(i + 1).width = fixed[i] ?? Math.min(MAX_WIDTH, Math.max(8, longest + 3));
  });
}

function addTable(sheet: ExcelJS.Worksheet, startRow: number, titles: string[], rows: Row[], options: { numeric?: number[]; percent?: number[]; dates?: number[]; wrap?: number[]; fixedWidths?: Record<number, number>; filter?: boolean; fill?: string } = {}): number {
  header(sheet, startRow, titles, options.fill);
  rows.forEach((values, index) => {
    const r = sheet.getRow(startRow + 1 + index);
    values.forEach((value, i) => {
      const cell = r.getCell(i + 1);
      cell.value = value as ExcelJS.CellValue;
      cell.border = THIN;
      cell.alignment = { vertical: "top", horizontal: options.numeric?.includes(i) || options.percent?.includes(i) ? "center" : "right", readingOrder: "rtl", wrapText: options.wrap?.includes(i) ?? false };
      if (options.numeric?.includes(i)) cell.numFmt = "#,##0";
      if (options.percent?.includes(i)) cell.numFmt = "0.0%";
      if (options.dates?.includes(i)) cell.numFmt = "yyyy-mm-dd hh:mm";
      if (typeof value === "object" && value !== null && !(value instanceof Date) && "hyperlink" in value) cell.font = { color: { argb: "FF0563C1" }, underline: true };
    });
    if (index % 2 === 1) values.forEach((_, i) => { r.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } }; });
  });
  widths(sheet, titles, rows, options.fixedWidths);
  if (options.filter && rows.length > 0) sheet.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + rows.length, column: titles.length } };
  return startRow + rows.length;
}

function newSheet(workbook: ExcelJS.Workbook, name: string, freezeRow: number, tab: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true, state: freezeRow > 0 ? "frozen" : "normal", xSplit: 0, ySplit: freezeRow, showGridLines: false }], properties: { tabColor: { argb: tab } } });
  return sheet;
}

const dateCell = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const linkCell = (url: string): { text: string; hyperlink: string } | null => (/^https?:\/\//i.test(url) ? { text: url, hyperlink: url } : null);

export const SUMMARY_SHEET_AR = "الموجز الإحصائي";
export const POSTS_SHEET_AR = "المنشورات";
export const COMMENTS_SHEET_AR = "التعليقات";

export const POSTS_HEADERS_AR = ["م", "المحور", "نوع المحتوى", "الناشر", "تاريخ النشر", "نص المنشور", POST_COMMENTS_DELIVERED_TITLE_AR, "عدد التفاعلات", "عدد المشاركات", "رابط المنشور"];
export const COMMENTS_HEADERS_AR_BASE = ["م", "رقم المنشور", "المحور", "مقتطف من المنشور", "اسم المعلّق", "تاريخ التعليق", "نص التعليق", "عدد التفاعلات", "عدد الردود"];

export interface ReportCommentRow { postKey: string; author: string; text: string; publishedAtMs: number | null; reactions: number; replies: number; breakdown?: Record<string, number> }

/** Comment rows of the saved data (the worker's delivered rows) in the shape the sheet reads. */
export function commentRowsOf(rows: Array<Record<string, any>>): ReportCommentRow[] {
  return rows.map((row) => ({
    postKey: String(row.post_key ?? ""),
    author: String(row.author ?? ""),
    text: String(row.text ?? ""),
    publishedAtMs: row.published_at ? Date.parse(String(row.published_at)) || null : null,
    reactions: Number(row.reactions) || 0,
    replies: Number(row.replies) || 0,
    ...(row.reaction_breakdown && typeof row.reaction_breakdown === "object" ? { breakdown: row.reaction_breakdown as Record<string, number> } : {}),
  }));
}

export async function generateFacebookReportExcel(payload: ReportPayload, commentRows: Array<Record<string, any>>): Promise<Buffer> {
  const model = buildReportModel(payload);
  const comments = commentRowsOf(commentRows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Diger";
  workbook.created = new Date();
  const country = regionNameAr(payload.request.region) ?? "";
  const taken = new Set<string>([SUMMARY_SHEET_AR, POSTS_SHEET_AR, COMMENTS_SHEET_AR].map((name) => name.toLowerCase()));

  /* ------------------------------------------------------------------------------------------------ summary */
  const summary = newSheet(workbook, SUMMARY_SHEET_AR, 0, NAVY);
  summary.mergeCells("A1:H1");
  const title = summary.getCell("A1");
  title.value = text(`تقرير رصد وتحليل منشورات فيسبوك: ${payload.request.topic}${country ? ` في ${country}` : ""}`);
  title.font = { bold: true, size: 16, color: { argb: WHITE }, name: "IBM Plex Sans Arabic" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  title.alignment = { horizontal: "center", vertical: "middle", readingOrder: "rtl" };
  summary.getRow(1).height = 34;
  const lines = [
    `الفترة المطلوبة: من ${dayAr(payload.request.from)} إلى ${dayAr(payload.request.to)}`,
    "المنصة: فيسبوك (المنشورات العامة)",
    model.covered.from ? `الفترة التي غطّتها المنشورات فعلًا: من ${dayAr(model.covered.from)} إلى ${dayAr(model.covered.to)} (${toArabicDigits(model.covered.days)} يومًا)` : "الفترة التي غطّتها المنشورات فعلًا: غير متاحة (لا منشورات)",
  ];
  lines.forEach((line, i) => {
    summary.mergeCells(`A${2 + i}:H${2 + i}`);
    const cell = summary.getCell(`A${2 + i}`);
    cell.value = text(line);
    cell.alignment = { horizontal: "right", vertical: "middle", readingOrder: "rtl" };
    cell.font = { size: 12, name: "IBM Plex Sans Arabic", bold: i === 2 };
  });

  // KPI cards: a label cell above a numeric value cell, two columns each
  const cards: Array<[string, number]> = [["عدد المنشورات", model.kpis.posts], ["عدد التعليقات", model.kpis.comments], ["إجمالي التفاعلات", model.kpis.reactions], ["إجمالي المشاركات", model.kpis.shares]];
  cards.forEach(([label, value], i) => {
    const col = 1 + i * 2;
    summary.mergeCells(6, col, 6, col + 1);
    summary.mergeCells(7, col, 7, col + 1);
    const labelCell = summary.getCell(6, col);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: WHITE }, name: "IBM Plex Sans Arabic" };
    labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i === 1 ? GREEN : NAVY } };
    labelCell.alignment = { horizontal: "center", vertical: "middle", readingOrder: "rtl" };
    const valueCell = summary.getCell(7, col);
    valueCell.value = value;
    valueCell.numFmt = "#,##0";
    valueCell.font = { bold: true, size: 20, name: "IBM Plex Sans Arabic", color: { argb: NAVY } };
    valueCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY_LIGHT } };
    valueCell.alignment = { horizontal: "center", vertical: "middle" };
  });
  summary.getRow(7).height = 36;

  let row = 9;
  summary.getCell(row, 1).value = "جدول ١: توزيع المنشورات على المحاور";
  summary.getCell(row, 1).font = { bold: true, size: 13, name: "IBM Plex Sans Arabic" };
  row = addTable(summary, row + 1, ["الترتيب", "المحور", "عدد المنشورات", "عدد التعليقات", "إجمالي التفاعلات", "نسبة المنشورات"], model.axes.map((axis) => [axis.rank, axis.nameAr, axis.posts, axis.comments, axis.reactions, axis.share]), { numeric: [0, 2, 3, 4], percent: [5] }) + 2;
  summary.getCell(row, 1).value = "جدول ٢: أبرز ١٠ منشورات تفاعلًا";
  summary.getCell(row, 1).font = { bold: true, size: 13, name: "IBM Plex Sans Arabic" };
  row = addTable(summary, row + 1, ["الترتيب", "المحور", "الناشر", "مقتطف من المنشور", "عدد التفاعلات", "رابط المنشور"], model.top.map(({ rank, post, interactions }) => [rank, axisNameAr(post.axis || GENERAL_AXIS_ID, HEALTH_AXES), text(post.publisher), text(post.text.replace(/\s+/g, " ").slice(0, 140)), interactions, linkCell(post.url)]), { numeric: [0, 4], wrap: [3] }) + 2;
  summary.getCell(row, 1).value = "جدول ٣: تركّز الناشرين";
  summary.getCell(row, 1).font = { bold: true, size: 13, name: "IBM Plex Sans Arabic" };
  row = addTable(summary, row + 1, ["الترتيب", "الناشر", "عدد المنشورات", "نسبة المنشورات"], model.concentration.map((entry, i) => [i + 1, text(entry.name), entry.posts, entry.share]), { numeric: [0, 2], percent: [3] }) + 2;
  summary.getCell(row, 1).value = text(`الفترة الفعلية التي غطّتها المنشورات: ${model.covered.from ? `من ${dayAr(model.covered.from)} إلى ${dayAr(model.covered.to)}` : "غير متاحة"}`);
  summary.getCell(row, 1).font = { bold: true, name: "IBM Plex Sans Arabic" };
  summary.getColumn(1).width = 12; summary.getColumn(2).width = 44; summary.getColumn(3).width = 24; summary.getColumn(4).width = 52; summary.getColumn(5).width = 16; summary.getColumn(6).width = 40; summary.getColumn(7).width = 12; summary.getColumn(8).width = 12;

  /* ------------------------------------------------------------------------------------------------- posts */
  const postRow = (post: ReportPost, n: number): Row => [n, axisNameAr(post.axis || GENERAL_AXIS_ID, HEALTH_AXES), CONTENT_TYPE_AR[post.contentType], text(post.publisher), dateCell(post.publishedAtMs), text(post.text), post.commentsDelivered ?? 0, post.reactions, post.shares, linkCell(post.url)];
  const posts = newSheet(workbook, POSTS_SHEET_AR, 1, "FF37474F");
  addTable(posts, 1, POSTS_HEADERS_AR, model.posts.map((post) => postRow(post, model.numberOf.get(post.key) ?? 0)), { numeric: [0, 6, 7, 8], dates: [4], wrap: [5], filter: true, fixedWidths: { 5: 70 } });

  /* ----------------------------------------------------------------------------------------------- comments */
  const hasBreakdown = comments.some((comment) => comment.breakdown && Object.keys(comment.breakdown).length > 0);
  const breakdownColumns = hasBreakdown ? REACTION_COLUMNS.filter(([key]) => comments.some((comment) => typeof comment.breakdown?.[key] === "number")) : [];
  const commentHeaders = [...COMMENTS_HEADERS_AR_BASE, ...breakdownColumns.map(([, label]) => label), "رابط المنشور"];
  const postByKey = new Map(model.posts.map((post) => [post.key, post] as const));
  const commentsSheet = newSheet(workbook, COMMENTS_SHEET_AR, 1, GREEN);
  const orderedComments = comments
    .map((comment, index) => ({ comment, index, number: model.numberOf.get(comment.postKey) ?? 0 }))
    .sort((a, b) => a.number - b.number || a.index - b.index);
  const commentTableRows: Row[] = orderedComments.map(({ comment, number }, i) => {
    const post = postByKey.get(comment.postKey);
    return [
      i + 1,
      number || null,
      post ? axisNameAr(post.axis || GENERAL_AXIS_ID, HEALTH_AXES) : "",
      post ? text(post.text.replace(/\s+/g, " ").slice(0, 100)) : "",
      text(comment.author),
      dateCell(comment.publishedAtMs),
      text(comment.text),
      comment.reactions,
      comment.replies,
      ...breakdownColumns.map(([key]) => (typeof comment.breakdown?.[key] === "number" ? (comment.breakdown![key] as number) : null)),
      post ? linkCell(post.url) : null,
    ];
  });
  const numericComment = [0, 1, 7, 8, ...breakdownColumns.map((_, i) => 9 + i)];
  addTable(commentsSheet, 1, commentHeaders, commentTableRows, { numeric: numericComment, dates: [5], wrap: [3, 6], filter: true, fixedWidths: { 6: 70, 3: 40 }, fill: GREEN });

  /* ------------------------------------------------------------------------------------------ one per axis */
  for (const axis of model.axes) {
    const name = sheetNameFor(axis.nameAr, taken);
    const sheet = newSheet(workbook, name, 1, "FF607D8B");
    const axisPosts = model.posts.filter((post) => (post.axis || GENERAL_AXIS_ID) === axis.axisId);
    addTable(sheet, 1, POSTS_HEADERS_AR, axisPosts.map((post) => postRow(post, model.numberOf.get(post.key) ?? 0)), { numeric: [0, 6, 7, 8], dates: [4], wrap: [5], filter: true, fixedWidths: { 5: 70 } });
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

