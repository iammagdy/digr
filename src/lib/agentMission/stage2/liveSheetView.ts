import { formatAr, toArabicDigits } from "../../arabicDigits";
import { OVER_DELIVERED_NOTE_AR } from "./counterWording";
import type { LiveCell, LiveRow } from "./liveSheet";
import type { WorkLogLine } from "./workLog";

/**
 * STAGE 2, THE LIVE SHEET'S DRAWING RULES (the Claude Design handoff «Diger live sheet», 16 Nov 2026). The screen draws the rows the route sent as a spreadsheet (desktop) or as the newest
 * three rows (phone); this file holds what both read: the kind and width of each column, the text of each cell, the counter's words, the status line under the grid. Pure: no React, no clock
 * of its own (the caller passes `nowMs`), so the tests read the same words the customer reads. Nothing here invents a value: every text is the file's cell, a fixed sentence, or a whitelisted
 * work-log line.
 */

export type ColKind = "long" | "short" | "latin" | "date" | "link" | "number" | "id" | "emptycol";

/** Desktop widths in px by kind (the handoff's table). The long text column also takes any width the chat column has left. */
export const COL_WIDTH: Readonly<Record<ColKind, number>> = { long: 300, short: 150, latin: 130, date: 128, link: 72, number: 84, id: 132, emptycol: 72 };
export const ROW_NUMBER_WIDTH = 44;
export const ROW_HEIGHT = 32;
export const HEADER_HEIGHT = 30;
export const VISIBLE_ROWS = 10;
/** The rows asked per window (the route's default) and the most one window may carry. */
export const WINDOW_ROWS = 50;
export const MAX_WINDOW_ROWS = 200;
/** A running sheet with no new row for this long is «quiet» (a calm line, no fake motion). */
export const QUIET_AFTER_MS = 45_000;
/** Rows land one at a time, this far apart; a long queue is shown faster so the screen never falls far behind the work. */
export const REVEAL_GAP_MS = 420;
export const REVEAL_MIN_GAP_MS = 80;
export const REVEAL_QUEUE_BUDGET_MS = 4_000;
/** How long a revealed row keeps its arrival look (fade, highlight, the gold edge). */
export const ARRIVAL_MS = 1_800;
export const EDGE_MS = 1_500;

export const LIVE_GRID_TITLE_AR = "ما جمعناه حتى الآن";
export const LIVE_FINAL_TITLE_AR = "النتائج النهائية";
export const LIVE_PROGRESS_LABEL_AR = "تقدّم الجمع";
export const LIVE_SHEETS_LABEL_AR = "أوراق الملف";
export const LIVE_HIDE_AR = "أخفِ الجدول";
export const LIVE_ROW_NUMBER_LABEL_AR = "الترتيب";
export const LIVE_OPEN_CHIP_AR = "فتح ↗";
export const LIVE_OPEN_LINK_AR = "افتح الرابط ↗";
export const LIVE_EMPTY_VALUE_AR = "فارغة";
export const LIVE_CUT_NOTE_AR = "قُصّ النص هنا لطوله، والملف يحفظه كاملًا.";
export const LIVE_PREV_ROW_AR = "السابق";
export const LIVE_NEXT_ROW_AR = "التالي";
export const LIVE_CLOSE_AR = "إغلاق";
export const LIVE_PHONE_EMPTY_AR = "تظهر النتائج هنا فور حفظها";
export const LIVE_STATUS_WAITING_AR = "بدأنا القراءة من المصدر. تظهر النتائج هنا فور حفظها.";
export const LIVE_STATUS_QUIET_AR = "لا نتائج جديدة منذ دقيقة. ما زلنا نقرأ المصدر، وبعض الصفحات أبطأ من غيرها.";
export const LIVE_STATUS_RECONNECT_AR = "انقطع الاتصال، نعيد المحاولة… النتائج المعروضة باقية كما هي.";
export const LIVE_STATUS_DONE_AR = "الملف جاهز. هذه النتائج هي نفسها التي في ملفك، وبالترتيب نفسه.";
export const LIVE_STATUS_WORKING_AR = "نقرأ المصدر الآن.";
export const LIVE_NOW_AR = "الآن";

/** The kind of a column from its header alone (before any row exists). */
const NAME_KIND: Readonly<Record<string, ColKind>> = {
  النص: "long", "نص التعليق": "long", "نص الرد": "long", الوصف: "long", العنوان: "long",
  الاسم: "short", الموقع: "short", الوسوم: "short", الدولة: "short", المدينة: "short",
  "صاحب الحساب": "short", "صاحب التعليق": "short",
  الحساب: "latin", "اسم المستخدم": "latin",
  "تاريخ النشر": "date", التاريخ: "date", "تاريخ ووقت النشر": "date", "تاريخ ووقت التعليق": "date",
  الرابط: "link",
  الإعجابات: "number", "عدد التعليقات": "number", "عدد الردود": "number", المشاركات: "number", المشاهدات: "number", م: "number",
};
const isAscii = (s: string): boolean => /^[\x00-\x7F]*$/.test(s);

/**
 * The kind of a column: an identifier column by its header; otherwise from the first filled cell of the sample (a number, a date, a link) or the text's length and script; a column with no
 * value in the sample is «empty»; with no sample at all, the header's name decides.
 */
export function colKindOf(header: string, sample: ReadonlyArray<LiveCell | undefined>): ColKind {
  if (/معرّف|معرف/.test(header)) return "id";
  if (sample.length === 0) return NAME_KIND[header] ?? "short";
  const vals = sample.filter((c): c is LiveCell => Boolean(c) && c!.k !== "empty");
  if (vals.length === 0) return "emptycol";
  const k = vals[0].k;
  if (k === "number" || k === "date" || k === "link") return k;
  const avg = vals.reduce((a, c) => a + c.v.length, 0) / vals.length;
  if (avg > 40) return "long";
  if (vals.every((c) => isAscii(c.v))) return "latin";
  return "short";
}

/** Every cell of a row under the file's headers, in order: its readable cells, then «المعرّف» and «معرّف الأصل» (the file's last columns). */
export function displayCellsOf(row: LiveRow, headers: ReadonlyArray<string>): LiveCell[] {
  const out: LiveCell[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    if (i < row.cells.length) out.push(row.cells[i]);
    else if (i === row.cells.length) out.push(row.id ? { k: "text", v: row.id } : { k: "empty", v: "" });
    else if (i === row.cells.length + 1) out.push(row.parentId ? { k: "text", v: row.parentId } : { k: "empty", v: "" });
    else out.push({ k: "empty", v: "" });
  }
  return out;
}

/** The text a cell shows: a date its Cairo text, a whole number in Arabic-Indic digits with «٬» grouping, anything else as the file has it. */
export function cellTextOf(c: LiveCell): string {
  if (c.k === "date") return c.d ?? c.v;
  if (c.k === "number") return /^-?\d+$/.test(c.v.trim()) ? formatAr(Number(c.v.trim())) : toArabicDigits(c.v);
  if (c.k === "empty") return "";
  return c.v;
}

/** «اعرض الجدول (٨٠)»: the fold's label with the count of results shown (the customer texts never say «صف»). */
export const showSheetAr = (n: number): string => (n > 0 ? `اعرض الجدول (${formatAr(n)})` : "اعرض الجدول");

/**
 * THE COUNTER'S WORDS, split in two: the big number (null before the first row: never a lone «٠») and the quiet words after it. Above the promised number the words say so (finding F-1:
 * never «١٠٩ من ٧٠»).
 */
export function counterPartsAr(delivered: number, promised: number | null): { num: string | null; rest: string; label: string } {
  const p = promised !== null && promised > 0 ? promised : null;
  if (delivered <= 0) {
    const rest = p ? `بانتظار أول النتائج · المطلوب ${formatAr(p)}` : "بانتظار أول النتائج";
    return { num: null, rest, label: rest };
  }
  const num = formatAr(delivered);
  if (!p) return { num, rest: "حتى الآن", label: `${num} حتى الآن` };
  if (delivered > p) return { num, rest: `(${OVER_DELIVERED_NOTE_AR(p)})`, label: `${num} (${OVER_DELIVERED_NOTE_AR(p)})` };
  return { num, rest: `من ${formatAr(p)}`, label: `${num} من ${formatAr(p)}` };
}

export type LiveTone = "live" | "quiet" | "retry" | "done" | "waiting";
export interface StatusLine { tone: LiveTone; timeAr: string | null; textAr: string; agoAr: string | null }

/** «آخر إضافة قبل ١٢ ث» (under a minute), «آخر إضافة قبل ٣ د» after. */
export function agoAr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 4) return LIVE_NOW_AR;
  if (s < 60) return `آخر إضافة قبل ${formatAr(s)} ث`;
  return `آخر إضافة قبل ${formatAr(Math.floor(s / 60))} د`;
}

/**
 * THE STATUS LINE under the grid (it replaces the separate «دفتر شغل» box): the reconnecting line while asks fail, the final line once every row of the done snapshot is shown, the waiting line
 * before the first row, the quiet line after 45 s with no new row, else the newest whitelisted work-log line with its Cairo time and how long ago the last row landed.
 */
export function statusLineOf(a: { status: "running" | "done"; failing: boolean; shown: number; pending: number; workLog: ReadonlyArray<WorkLogLine>; lastRowAt: number | null; sinceMs: number; nowMs: number }): StatusLine {
  const latest = [...a.workLog].sort((x, y) => x.at - y.at).pop() ?? null;
  const timeAr = latest?.timeAr ?? null;
  if (a.failing && a.status === "running") return { tone: "retry", timeAr, textAr: LIVE_STATUS_RECONNECT_AR, agoAr: null };
  if (a.status === "done" && a.pending === 0) return { tone: "done", timeAr, textAr: LIVE_STATUS_DONE_AR, agoAr: null };
  if (a.shown === 0) return { tone: "waiting", timeAr, textAr: LIVE_STATUS_WAITING_AR, agoAr: null };
  const quietFor = a.nowMs - (a.lastRowAt ?? a.sinceMs);
  if (a.pending === 0 && quietFor > QUIET_AFTER_MS) return { tone: "quiet", timeAr, textAr: LIVE_STATUS_QUIET_AR, agoAr: null };
  return { tone: "live", timeAr, textAr: latest?.textAr ?? LIVE_STATUS_WORKING_AR, agoAr: a.lastRowAt === null ? null : agoAr(a.nowMs - a.lastRowAt) };
}

/** The wait before the next row is revealed: 420 ms, shorter when many rows wait (the queue is shown within about four seconds). */
export const revealGapMs = (queued: number): number => (queued <= 0 ? REVEAL_GAP_MS : Math.max(REVEAL_MIN_GAP_MS, Math.min(REVEAL_GAP_MS, Math.round(REVEAL_QUEUE_BUDGET_MS / queued))));

/** The short word after a number on the phone («٦ إعجاب», «٤٥ تعليق»); a header with no known word is shown as it is. */
const STAT_WORD: Readonly<Record<string, string>> = { الإعجابات: "إعجاب", "عدد التعليقات": "تعليق", التعليقات: "تعليق", "عدد الردود": "رد", المشاركات: "مشاركة", المشاهدات: "مشاهدة" };
export const statWordOf = (header: string): string => STAT_WORD[header] ?? header;

/** The phone's link button names what it opens when the sheet's name says it («افتح التغريدة ↗»), else «افتح الرابط ↗». */
const OPEN_BY_SHEET: ReadonlyArray<[RegExp, string]> = [[/تغريد/, "افتح التغريدة ↗"], [/تعليق/, "افتح التعليق ↗"], [/رد|ردود/, "افتح الرد ↗"], [/فيديو/, "افتح الفيديو ↗"], [/منشور|بوست/, "افتح المنشور ↗"]];
export const openLinkLabelOf = (sheetNameAr: string): string => OPEN_BY_SHEET.find(([re]) => re.test(sheetNameAr))?.[1] ?? LIVE_OPEN_LINK_AR;

export interface RowParts {
  /** The row's main text (the first long text column, else the first text cell). */
  text: { h: string; c: LiveCell; i: number } | null;
  /** The number columns (the file's own «م» aside), at most three, for the phone's tiles and meta line. */
  stats: Array<{ h: string; word: string; c: LiveCell; i: number }>;
  link: { h: string; c: LiveCell; i: number } | null;
  /** Every other column, in the file's order (empty ones included: the detail says «فارغة»). */
  rest: Array<{ h: string; c: LiveCell; i: number; kind: ColKind }>;
}
/** How the phone and the detail split a row: the text, up to three numbers, the link, and the rest, together exactly the file's columns, none twice. */
export function rowPartsOf(cells: ReadonlyArray<LiveCell>, headers: ReadonlyArray<string>, kinds: ReadonlyArray<ColKind>): RowParts {
  const at = (i: number) => ({ h: headers[i], c: cells[i] ?? { k: "empty" as const, v: "" }, i });
  // a sheet of comments or replies carries its parent's text first («النص») and its own after («نص التعليق»): the row's own text leads
  let textI = headers.findIndex((h, i) => /^نص\s/.test(h) && cells[i]?.k === "text");
  if (textI < 0) textI = kinds.findIndex((k, i) => k === "long" && cells[i]?.k === "text");
  if (textI < 0) textI = cells.findIndex((c, i) => c.k === "text" && kinds[i] !== "id");
  const stats = kinds.map((k, i) => ({ k, i })).filter(({ k, i }) => k === "number" && headers[i] !== "م" && cells[i]?.k === "number").slice(0, 3).map(({ i }) => ({ ...at(i), word: statWordOf(headers[i]) }));
  const linkI = cells.findIndex((c) => c.k === "link");
  const used = new Set<number>([textI, linkI, ...stats.map((s) => s.i)].filter((i) => i >= 0));
  const rest = headers.map((_, i) => i).filter((i) => !used.has(i)).map((i) => ({ ...at(i), kind: kinds[i] }));
  return { text: textI >= 0 ? at(textI) : null, stats, link: linkI >= 0 ? at(linkI) : null, rest };
}
