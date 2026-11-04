import { childCountOf } from "../childCount";
import { itemNounOf, knownItemNoun } from "../itemNoun";
import { formatAr } from "../../arabicDigits";
import { looksLikeDateColumn, parseDateOnly } from "../dateCells";
import { MARKS_KEY, MARK_COLUMNS_AR, markCellAr, markVerdict, type RowMarks } from "../rawMarks";
import { APPROX_DATES_KEY, DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR, DATE_PRECISION_TITLE_AR, approxColumnsOf, isRelativeAge } from "../relativeDates";
import { readsAllReplies } from "../repliesCard";
import { textKeyOf } from "../contract";
import { isEnabled } from "../filters";
import type { PricedPlan, PricedStage } from "../plan";
import { TOPIC_RELATION_TITLE_AR } from "./topicChoice";
import { namedAuthorVerdict } from "./pool";

/**
 * THE DELIVERY CONTRACT (round 14). Four rules every delivered file must keep, written on the SHAPE «parents -> children», never on a request, and checked by code on the real built file:
 *   R1 ONE NUMBER: the promised total is the same on the plan card, the file's summary line, the chat's result line, the notice and the orders page; the delivered X equals the data rows in the file.
 *   R2 EVERY GAP STATED: a parent whose counter (or whose number asked) exceeds the children delivered for it has its own line in «حدود هذا التسليم» with both numbers; a stage that delivered less than it promised has a stage line; «لا قيود سُجّلت» only when no gap exists.
 *   R3 APPROXIMATE DATES MARKED: a date computed from a relative text (or from a card whose date is relative) says «تقريبي» in «دقة التاريخ» on its row, and the limits say how many; no foreign relative text is left in a date cell.
 *   R4 MARKS FILLED: for every condition the request set (named source, period, language, country, topic) the parent sheet has its mark column and no row is blank or «غير محدد».
 * IT IS NOT A FILTER: it never removes a row, never changes a value, never blocks or delays a delivery. It returns violations; for R2, R3 and R4 each carries the COMPLETION that only completes the description (a missing limits line, a precision cell, a mark cell filled from data already in the row);
 * for R1 it only reports. Pure: no I/O.
 */
export type ContractRule = "R1" | "R2" | "R3" | "R4";
export type Completion =
  | { kind: "limit_line"; text: string }
  | { kind: "precision"; stageKey: string; rowId: string; dateKey: string }
  | { kind: "mark"; stageKey: string; rowId: string; header: string; value: string };

export interface ContractViolation { rule: ContractRule; sheet: string | null; rowId: string | null; expected: string; found: string; fix?: Completion }

export interface ContractSheet {
  stageKey: string;
  title: string;
  headers: string[];
  /** One entry per data row of the sheet, in order: the row's id, its parent's id and the text of each cell by header. */
  rows: Array<{ id: string; parentId: string | null; cells: Record<string, string> }>;
}

/** The numbers each surface states (null: the surface does not exist for this check). Each is computed by the production function of that surface. */
export interface ContractNumbers {
  card: number | null;
  file: number | null;
  chat: number | null;
  notice: number | null;
  orders: number | null;
  /** The delivered number the file's summary line states, and the data rows the file holds. */
  fileDelivered: number | null;
  deliveredRows: number;
}

export interface ContractInput {
  /** The plan as the file was built from it (judged at the end of the run). */
  plan: PricedPlan;
  rowsByStage: Record<string, Array<Record<string, unknown>>>;
  sheets: ContractSheet[];
  /** The lines of «حدود هذا التسليم». */
  limitLines: string[];
  /** The alternative routes that ANSWERED for a parent of a stage, from the item store's log (stage key -> parent id -> how many): the only evidence R2 reads for «the main route and N alternative routes were tried». */
  routes?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  numbers: ContractNumbers;
  now: number;
}

export const NO_LIMITS_AR = "لا قيود سُجّلت على هذا التسليم";
export const MARK_UNAVAILABLE_AR = "غير متاح من المصدر";
const UNKNOWN_MARK_AR = "غير محدد";
const fmt = (n: number): string => formatAr(Math.max(0, Math.floor(n)));
const rowId = (r: Record<string, unknown>): string => String(r.id ?? "");

/** The header that carries the precision of a date column in a sheet, or null. */
export function precisionHeaderOf(headers: ReadonlyArray<string>, dateHeader: string): string | null {
  return headers.find((h) => h === DATE_PRECISION_TITLE_AR || h === `${DATE_PRECISION_TITLE_AR} (${dateHeader})`) ?? null;
}

/** The words a limits line uses for the numbers of one parent (the same sentence the engine's own lines use). */
export function gapLineAr(input: { parentNoun: string; n: number; counterLabel: string; counter: number; delivered: number; what: string }): string {
  return `ال${input.parentNoun} رقم ${fmt(input.n)}: ${input.what}، ${input.counterLabel} ${fmt(input.counter)}، وسُلّم ${fmt(input.delivered)}؛ والفرق لم يعطِه المصدر`;
}

/** The comments a parent should have given: its counter (never above the number asked per parent), else the number asked; null for an OPEN stage (no counter before reading: the expectation is only «gave none» and «reached the limit»). One rule, read by R2 and by the limits lines. */
export function expectedCommentsOf(stage: Pick<PricedStage, "children_cap_per_parent" | "per_parent_rows">, parent: Record<string, unknown>): number | null {
  const counter = childCountOf(parent);
  const asked = Number(stage.per_parent_rows);
  const open = (stage.children_cap_per_parent ?? null) !== null && counter === null;
  return open ? null : counter !== null ? (Number.isFinite(asked) && asked > 0 ? Math.min(counter, asked) : counter) : Number.isFinite(asked) && asked > 0 ? asked : null;
}

/** «مسارًا بديلًا واحدًا», «مسارين بديلين», «٣ مسارات بديلة»: the alternative routes tried (white label: never a provider or an endpoint). */
export function alternativeRoutesAr(n: number): string {
  const k = Math.max(1, Math.floor(n));
  return k === 1 ? "مسارًا بديلًا واحدًا" : k === 2 ? "مسارين بديلين" : `${fmt(k)} مسارات بديلة`;
}

/** ROUND 16: the line of a parent whose comments fell short AFTER an alternative route was tried: the expected count, the unique comments delivered, the gap, and that the main route and N alternative routes were tried. From persisted execution evidence only (the routes the item store recorded). */
export function alternativesGapLineAr(input: { parentNoun: string; n: number; expected: number; delivered: number; alternatives: number }): string {
  return `ال${input.parentNoun} رقم ${fmt(input.n)}: ${alternativesGapBodyAr(input)}.`;
}

/** The sentence of that line without its head and its final full stop (ROUND 19: the one line of a parent may carry the replies' part after it). */
export function alternativesGapBodyAr(input: { expected: number; delivered: number; alternatives: number }): string {
  return `المتوقع ${fmt(input.expected)} تعليقًا، وسُلّم ${fmt(input.delivered)} تعليقًا فريدًا، والفرق ${fmt(Math.max(0, input.expected - input.delivered))}؛ جرّبنا المسار الرئيسي و${alternativeRoutesAr(input.alternatives)} للمنصة نفسها، ولم يعطِ أيٌّ منها الباقي`;
}

export function checkDeliveryContract(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = [];
  out.push(...r1(input));
  out.push(...r2(input));
  out.push(...r3(input));
  out.push(...r4(input));
  return out;
}

// ------------------------------------------------------------------------------------------------ R1
function r1(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = [];
  const n = input.numbers;
  const stated: Array<[string, number | null]> = [["الخطة قبل الاعتماد", n.card], ["الملف", n.file], ["المحادثة", n.chat], ["الإشعار", n.notice], ["صفحة الطلبات", n.orders]];
  const present = stated.filter((x): x is [string, number] => x[1] !== null);
  const reference = present[0];
  if (reference) for (const [where, value] of present.slice(1)) if (value !== reference[1]) out.push({ rule: "R1", sheet: null, rowId: null, expected: `${fmt(reference[1])} (${reference[0]})`, found: `${fmt(value)} (${where})` });
  // ROUND 19: A PROMISE NEVER STANDS ABOVE THE COUNTERS. A comments stage with a number for each parent promises at most the sum of min(that number, the parent's own counter) over its parents: more than that is a number nothing can deliver (live Facebook: 20 promised, counters 9 and 6)
  for (const stage of input.plan.stages) {
    if (!stage.deliver || stage.parent_key === null || stage.replies_of !== undefined || itemNounOf(stage.title_ar).singular !== "تعليق") continue;
    const per = Number(stage.per_parent_rows);
    if (!(Number.isFinite(per) && per > 0) || (stage.children_cap_per_parent ?? null) !== null) continue;
    const parents = input.rowsByStage[stage.parent_key] ?? [];
    const counters = parents.map((p) => childCountOf(p));
    if (parents.length === 0 || counters.some((c) => c === null)) continue;
    // the stage planned for a number FOR EACH parent (rows = that number x the parents): at most the sum of min(number, counter); a stage sized by an edited total is held to the sum of the counters
    const perForm = stage.planned_rows === per * parents.length;
    const possible = counters.reduce<number>((s, c) => s + (perForm ? Math.min(per, c ?? 0) : (c ?? 0)), 0);
    if (stage.planned_rows > possible) out.push({ rule: "R1", sheet: stage.title_ar, rowId: null, expected: `${fmt(possible)} تعليقًا على الأكثر (مجموع الأصغر من العدد المطلوب لكل عنصر وعدّاد العنصر)`, found: `${fmt(stage.planned_rows)} في الخطة` });
  }
  if (n.fileDelivered !== null && n.fileDelivered !== n.deliveredRows) out.push({ rule: "R1", sheet: null, rowId: null, expected: `${fmt(n.deliveredRows)} صفًا في الملف`, found: `${fmt(n.fileDelivered)} في سطر التسليم` });
  return out;
}

// ------------------------------------------------------------------------------------------------ R2
const stageOf = (plan: PricedPlan, key: string): PricedStage | undefined => plan.stages.find((s) => s.key === key);

function r2(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = [];
  const { plan, rowsByStage, limitLines } = input;
  const missing = (text: string): boolean => !limitLines.some((l) => l.includes(text));
  let anyGap = false;
  const has = (l: string, ...parts: string[]): boolean => parts.every((p) => l.includes(p));
  // ROUND 19: a count of one or two is written in WORDS by the count formatter («تعليق واحد», «تعليقان»), never with a digit: a line that says it so says the number (live YouTube: R2 found no «١» and added a second line to every video that delivered one)
  const saysNumber = (l: string, n: number): boolean => l.includes(fmt(n)) || (n === 1 && /واحد/.test(l)) || (n === 2 && /(?:ين|ان)(?![ء-ي])/.test(l) && /(?:تعليق|رد|منشور|فيديو|تغريد)\S*(?:ين|ان)(?![ء-ي])/.test(l));
  for (const stage of plan.stages) {
    if (!stage.deliver || stage.parent_key === null || stage.replies_of !== undefined) continue;
    if (itemNounOf(stage.title_ar).singular !== "تعليق") continue;
    const parentStage = stageOf(plan, stage.parent_key);
    if (!parentStage || !parentStage.deliver) continue;
    const replyStage = plan.stages.find((x) => x.replies_of === stage.key && x.deliver);
    const parentNoun = (knownItemNoun(itemNounOf(parentStage.title_ar).singular) ?? itemNounOf(parentStage.title_ar)).singular || "عنصر";
    const parents = rowsByStage[parentStage.key] ?? [];
    const comments = rowsByStage[stage.key] ?? [];
    const replies = replyStage ? rowsByStage[replyStage.key] ?? [] : [];
    const repliesOf = new Map<string, number>();
    for (const r of replies) repliesOf.set(String(r.parent_id ?? ""), (repliesOf.get(String(r.parent_id ?? "")) ?? 0) + 1);
    const repliesCap = replyStage && readsAllReplies(plan, replyStage) ? Number.POSITIVE_INFINITY : Math.max(1, replyStage?.per_parent_rows ?? 50);
    parents.forEach((p, i) => {
      const mine = comments.filter((c) => String(c.parent_id ?? "") === rowId(p));
      const counter = childCountOf(p);
      const cap = stage.children_cap_per_parent ?? null;
      // the comments the parent should have given: its counter (never above the number asked per parent), else the number asked; an OPEN stage (no counter before reading) has no expectation but «gave none» and «reached the limit»
      const open = cap !== null && counter === null;
      const expected = expectedCommentsOf(stage, p);
      const head = `ال${parentNoun} رقم ${fmt(i + 1)}`;
      // ROUND 19: ONE line per parent in «حدود هذا التسليم» (live Facebook: two different lines for each post): the asked number or the counter, what was delivered, the gap and the routes tried, said once
      const own = limitLines.filter((l) => l.startsWith(`${head}:`));
      if (own.length > 1) out.push({ rule: "R2", sheet: stage.title_ar, rowId: rowId(p), expected: `سطر واحد لـ«${head}» في حدود هذا التسليم`, found: `${fmt(own.length)} أسطر` });
      if (expected !== null && mine.length < expected) {
        anyGap = true;
        // ROUND 16: a shortfall that happened AFTER alternative routes were tried must say so: the expected count, the unique delivered, the gap, the main route and the N alternative routes tried (persisted execution evidence only)
        const tried = input.routes?.[stage.key]?.[rowId(p)] ?? 0;
        if (tried > 0) {
          if (!limitLines.some((l) => has(l, head, "المسار الرئيسي", alternativeRoutesAr(tried)) && saysNumber(l, expected) && saysNumber(l, mine.length))) out.push({ rule: "R2", sheet: stage.title_ar, rowId: rowId(p), expected: `سطر لـ«${head}» يذكر المتوقع ${fmt(expected)} والفريد المسلّم ${fmt(mine.length)} وأن المسار الرئيسي و${alternativeRoutesAr(tried)} جُرّبت`, found: "لا سطر",
            fix: { kind: "limit_line", text: alternativesGapLineAr({ parentNoun, n: i + 1, expected, delivered: mine.length, alternatives: tried }) } });
        } else if (!limitLines.some((l) => has(l, head) && saysNumber(l, expected) && saysNumber(l, mine.length))) {
          out.push({ rule: "R2", sheet: stage.title_ar, rowId: rowId(p), expected: `سطر لـ«${head}» يذكر ${fmt(expected)} و${fmt(mine.length)}`, found: "لا سطر",
            fix: { kind: "limit_line", text: gapLineAr({ parentNoun, n: i + 1, counterLabel: "المتوقع", counter: expected, delivered: mine.length, what: "التعليقات" }) } });
        }
      } else if (open && mine.length === 0) {
        anyGap = true;
        if (!limitLines.some((l) => has(l, head, "لم يُسلَّم"))) out.push({ rule: "R2", sheet: stage.title_ar, rowId: rowId(p), expected: `سطر لـ«${head}» يقول إنه لم يُسلَّم منه تعليق`, found: "لا سطر", fix: { kind: "limit_line", text: `${head}: لم يُسلَّم منه أي تعليق، لم يعطِ المصدر تعليقات لهذا${parentNoun}` } });
      } else if (open && cap !== null && mine.length >= cap && !limitLines.some((l) => has(l, head, fmt(cap)))) {
        anyGap = true;
        out.push({ rule: "R2", sheet: stage.title_ar, rowId: rowId(p), expected: `سطر لـ«${head}» يذكر الحد ${fmt(cap)}`, found: "لا سطر", fix: { kind: "limit_line", text: `${head}: بلغت قراءة تعليقاته الحد الأقصى المحسوب لكل ${parentNoun} وهو ${fmt(cap)}، وقد يكون في المصدر المزيد` } });
      }
      if (replyStage) {
        const counters = mine.reduce((n, c) => n + Math.min(repliesCap, Math.max(0, childCountOf(c) ?? 0)), 0);
        const got = mine.reduce((n, c) => n + (repliesOf.get(rowId(c)) ?? 0), 0);
        if (got < counters) {
          anyGap = true;
          if (!limitLines.some((l) => has(l, head) && saysNumber(l, counters) && saysNumber(l, got))) {
            out.push({ rule: "R2", sheet: replyStage.title_ar, rowId: rowId(p), expected: `سطر لـ«${head}» يذكر عدّادات الردود ${fmt(counters)} وما سُلّم ${fmt(got)}`, found: "لا سطر",
              fix: { kind: "limit_line", text: `${head}: ردود التعليقات المسلّمة بحسب عدّاداتها ${fmt(counters)} وسُلّم منها ${fmt(got)}؛ والفرق لم يعطِه المصدر` } });
          }
        }
      }
    });
  }
  // a stage that delivered less than it promised has its own line (a replies stage is an estimate bought on top: fewer than estimated is not a shortfall, its gap is the parent's line above)
  for (const stage of plan.stages) {
    if (!stage.deliver || stage.replies_of !== undefined) continue;
    const got = (rowsByStage[stage.key] ?? []).length;
    if (got >= stage.planned_rows) continue;
    anyGap = true;
    const text = `سُلّم ${fmt(got)} من ${fmt(stage.planned_rows)}`;
    if (missing(text)) out.push({ rule: "R2", sheet: stage.title_ar, rowId: null, expected: `سطر يقول «${text}» لمرحلة «${stage.title_ar}»`, found: "لا سطر", fix: { kind: "limit_line", text: `«${stage.title_ar}»: ${text}؛ والفرق لم يعطِه المصدر.` } });
  }
  if (!anyGap) return out;
  if (limitLines.length === 0 || limitLines.every((l) => l.includes(NO_LIMITS_AR))) out.push({ rule: "R2", sheet: null, rowId: null, expected: "سطر لكل نقص", found: NO_LIMITS_AR });
  return out;
}

// ------------------------------------------------------------------------------------------------ R3
const RELATIVE_FOREIGN = /(?:\bago\b|前|天|小时|周|月前|年前)/i;
function r3(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = [];
  const { plan, rowsByStage, sheets, limitLines } = input;
  for (const stage of plan.stages) {
    if (!stage.deliver) continue;
    // the sheet a stage's rows are in: its own, or its comments' sheet when its replies are threaded under their comments
    const sheet = sheets.find((s) => s.stageKey === stage.key) ?? (stage.replies_of !== undefined ? sheets.find((s) => s.stageKey === stage.replies_of) : undefined);
    if (!sheet) continue;
    const rows = rowsByStage[stage.key] ?? [];
    const cellsOf = new Map(sheet.rows.map((r) => [r.id, r] as const));
    let approxRows = 0;
    for (const src of rows) {
      const sr = cellsOf.get(rowId(src));
      if (!sr) continue;
      let approxHere = false;
      for (const dateCol of (stage.columns ?? []).filter((c) => looksLikeDateColumn(c.title_ar, c.key))) {
        const header = sheet.headers.find((h) => h === dateCol.title_ar);
        if (!header) continue;
        const precision = precisionHeaderOf(sheet.headers, header);
        const cell = sr.cells[header] ?? "";
        if (cell && (RELATIVE_FOREIGN.test(cell) || isRelativeAge(cell))) out.push({ rule: "R3", sheet: sheet.title, rowId: sr.id, expected: "تاريخ أو خلية فارغة، لا نص نسبي", found: cell.slice(0, 40) });
        const marked = approxColumnsOf(src).includes(dateCol.key);
        // a date with no time of day in a stage whose card dates its items relatively is a computed day: it must be marked (a real moment has a time)
        const dayOnly = cell !== "" && /^\d{4}-\d{2}-\d{2}$/.test(cell.trim()) && parseDateOnly(cell.trim()) !== null && stage.relative_dates === true;
        if (!marked && !dayOnly) continue;
        approxHere = true;
        if (!precision) { out.push({ rule: "R3", sheet: sheet.title, rowId: sr.id, expected: `عمود «${DATE_PRECISION_TITLE_AR}» = «${DATE_PRECISION_APPROX_AR}»`, found: "لا عمود", fix: { kind: "precision", stageKey: stage.key, rowId: sr.id, dateKey: dateCol.key } }); continue; }
        if (cell !== "" && (sr.cells[precision] ?? "") !== DATE_PRECISION_APPROX_AR) out.push({ rule: "R3", sheet: sheet.title, rowId: sr.id, expected: DATE_PRECISION_APPROX_AR, found: sr.cells[precision] ?? "", fix: { kind: "precision", stageKey: stage.key, rowId: sr.id, dateKey: dateCol.key } });
      }
      if (approxHere) approxRows += 1;
    }
    if (approxRows > 0) {
      const text = `${fmt(approxRows)} من ${fmt(rows.length)} تاريخًا تقريبيًا`;
      if (!limitLines.some((l) => l.includes(text))) out.push({ rule: "R3", sheet: sheet.title, rowId: null, expected: `سطر يقول «${text}»`, found: "لا سطر", fix: { kind: "limit_line", text: `${text}، حُسب من وقت الجلب لأن المصدر يذكر وقت النشر نسبيًا فقط (مثل «قبل ٣ أيام»)، وهو مُعلَّم بكلمة «تقريبي» في عمود «${DATE_PRECISION_TITLE_AR}».` } });
    }
  }
  void DATE_PRECISION_EXACT_AR;
  void APPROX_DATES_KEY;
  return out;
}

// ------------------------------------------------------------------------------------------------ R4
type Condition = "named" | "period" | "language" | "country" | "topic";
const MARK_HEADER: Record<Condition, string> = { named: MARK_COLUMNS_AR.named, period: MARK_COLUMNS_AR.inPeriod, language: MARK_COLUMNS_AR.lang, topic: TOPIC_RELATION_TITLE_AR, country: "الدولة" };
const MARK_OF: Partial<Record<Condition, keyof RowMarks>> = { named: "named", period: "inPeriod", language: "lang" };

function r4(input: ContractInput): ContractViolation[] {
  const out: ContractViolation[] = [];
  const { plan, rowsByStage, sheets } = input;
  const conditions = plan.compiled?.conditions;
  if (!conditions) return out;
  const parent = plan.stages.find((s) => s.deliver && s.parent_key === null);
  const sheet = parent ? sheets.find((s) => s.stageKey === parent.key) : undefined;
  if (!parent || !sheet) return out;
  const rows = new Map((rowsByStage[parent.key] ?? []).map((r) => [rowId(r), r] as const));
  const textKey = textKeyOf(parent, []);
  for (const cond of Object.keys(MARK_HEADER) as Condition[]) {
    if (!conditions[cond]) continue;
    const header = MARK_HEADER[cond];
    if (!sheet.headers.includes(header)) { out.push({ rule: "R4", sheet: sheet.title, rowId: null, expected: `عمود «${header}» في ورقة «${sheet.title}»`, found: "لا عمود" }); continue; }
    for (const sr of sheet.rows) {
      const cell = (sr.cells[header] ?? "").trim();
      if (cell !== "" && cell !== UNKNOWN_MARK_AR) {
        // ROUND 17: «غير متاح من المصدر» in the named-source column is true ONLY when the row carries no author. A row that carries one (an account's handle, a page's name or link) is judged against the named source: the cell must say «مطابق» or «غير مطابق» (every platform)
        if (cond !== "named" || cell !== MARK_UNAVAILABLE_AR) continue;
        const own = rows.get(sr.id);
        const verdict = own ? namedAuthorVerdict(own, plan.compiled?.platform as never, plan.compiled?.source_text) : null;
        if (verdict === null) continue;
        out.push({ rule: "R4", sheet: sheet.title, rowId: sr.id, expected: `«${header}» = «${verdict ? "مطابق" : "غير مطابق"}» لأن الصف يحمل صاحبه`, found: cell, fix: { kind: "mark", stageKey: parent.key, rowId: sr.id, header, value: verdict ? "مطابق" : "غير مطابق" } });
        continue;
      }
      const src = rows.get(sr.id);
      // filled from data already in the row and the plan's own filters; when the source gives nothing to decide it, the cell says so in words (never blank, never «غير محدد»)
      let value = MARK_UNAVAILABLE_AR;
      const key = MARK_OF[cond];
      if (src && key) {
        const filters = (parent.filters ?? []).filter(isEnabled);
        const verdict = markVerdict(filters, src, { textKey, now: input.now })[key];
        if (verdict !== null && verdict !== undefined) value = markCellAr(key, { [key]: verdict } as Partial<RowMarks>);
        else if (src[MARKS_KEY] !== undefined) value = MARK_UNAVAILABLE_AR;
      }
      out.push({ rule: "R4", sheet: sheet.title, rowId: sr.id, expected: `قيمة في «${header}» لأن الطلب حدّد هذا الشرط`, found: cell === "" ? "فارغ" : cell, fix: { kind: "mark", stageKey: parent.key, rowId: sr.id, header, value } });
    }
  }
  return out;
}

/** «تم تسليم ٤٦٤ من ٥٣٧ عنصرًا.» → { x: 464, y: 537 } (Arabic-Indic digits and the thousands mark are read), or null when the line says something else. */
export function parseDeliveredLine(line: string | null | undefined): { x: number; y: number } | null {
  const t = String(line ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬,]/g, "");
  const m = /تم تسليم\s+(\d+)\s+من\s+(\d+)/.exec(t);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** The sentence of one violation the admin reads (rule, sheet, row, what was expected). Admin only: it may name a row id. */
export function violationTextAr(v: ContractViolation): string {
  return `${v.rule}${v.sheet ? ` · ${v.sheet}` : ""}${v.rowId ? ` · ${v.rowId}` : ""}: المتوقع «${v.expected}» والموجود «${v.found}»`;
}
