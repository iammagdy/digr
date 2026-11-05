import { toArabicDigits } from "../../arabicDigits";
import { CAIRO_TZ } from "../cairoTime";
import { counterAr } from "./counterWording";
import { itemNounOf, knownItemNoun, type ItemNoun } from "../itemNoun";
import { nounCountAr as countAr } from "./arabicCount";

/**
 * STAGE 2, «دفتر شغل» (docs/STAGE-2.md, FOUNDATION-PLAN PR 4: «the notebook line from a code whitelist»). What the work is doing, said to the customer while they wait, ONE fixed Arabic
 * sentence per event CODE, written here in code. An event carries only a code, a moment and numbers (and a noun from a fixed list); its sentence never takes words from anywhere else, so a
 * provider's name, an endpoint id, a dollar amount or a model's name can never reach the customer through it. An unknown code, or a code without the number its sentence needs, gives
 * NOTHING. Times are Cairo's; numbers are Arabic-Indic. Pure.
 */
export const WORK_LOG_CODES = [
  "queued", "plan_approved", "stage_started", "page_read", "items_saved", "duplicates_removed", "parent_replaced", "next_tool", "source_ended", "retry_wait", "stage_done", "gap_stated", "file_building", "file_ready",
] as const;
export type WorkLogCode = (typeof WORK_LOG_CODES)[number];

/** The nouns a line may name (a fixed list: the items of the file). */
export const WORK_LOG_NOUNS = ["videos", "tweets", "posts", "comments", "replies", "companies", "people"] as const;
export type WorkLogNoun = (typeof WORK_LOG_NOUNS)[number];
const NOUN_WORD: Record<WorkLogNoun, string> = { videos: "فيديو", tweets: "تغريدة", posts: "منشور", comments: "تعليق", replies: "رد", companies: "شركة", people: "شخص" };

export interface WorkLogEvent {
  code: WorkLogCode;
  /** The moment (ISO text or ms since 1970). */
  at: string | number;
  /** The number of this event (pages read, items added, duplicates removed, the stage's delivered count when it ended). */
  n?: number;
  /** The running total of the stage. */
  total?: number;
  /** The stage's promised number (the N of «X من N»). */
  promised?: number;
  noun?: WorkLogNoun;
}
export interface WorkLogLine { code: WorkLogCode; at: number; timeAr: string; textAr: string }

const hm = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const nounOf = (k: unknown): ItemNoun | null => (typeof k === "string" && (WORK_LOG_NOUNS as ReadonlyArray<string>).includes(k) ? knownItemNoun(NOUN_WORD[k as WorkLogNoun]) : null);
/** «X من N» in Arabic-Indic digits: the noun is named before it in the sentence (S11: «٤٠ من ١٠٠ تعليقًا» and «فيديوهين من فيديوهين» read badly). */
const xOfN = (x: number, n: number): string => counterAr(x, n); // above N it is the counter's over-delivery wording (finding F-1): never «١٠٩ من ٧٠»
const pagesAr = (n: number): string => (n === 1 ? "صفحة واحدة" : n === 2 ? "صفحتين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} صفحات` : `${toArabicDigits(n)} صفحة`);

type Render = (e: WorkLogEvent, noun: ItemNoun | null) => string | null;
/** THE WHITELIST: each code and its one sentence. `null` when the event lacks what the sentence needs. */
const SENTENCE: Readonly<Record<WorkLogCode, Render>> = {
  queued: () => "طلبك في الدور، وسيبدأ تلقائيًا.",
  plan_approved: () => "اعتمدت الخطة، وبدأنا العمل.",
  stage_started: (_e, noun) => (noun ? `بدأنا جمع ${noun.plural}.` : null),
  page_read: (e) => (isCount(e.n) && e.n > 0 ? `قرأنا ${pagesAr(e.n)} من المصدر حتى الآن.` : null),
  items_saved: (e, noun) => (noun && isCount(e.n) && isCount(e.total) ? `أضفنا ${countAr(e.n, noun)}، والمجموع الآن ${isCount(e.promised) && e.promised > 0 ? xOfN(e.total, e.promised) : countAr(e.total, noun)}.` : null),
  duplicates_removed: (e, noun) => (noun && isCount(e.n) && e.n > 0 ? `حذفنا ${countAr(e.n, noun)} مكررة تمامًا، ولم نحذف شيئًا غيرها.` : null),
  parent_replaced: (_e, noun) => (noun ? `لم يظهر تحت أحد ${noun.plural} أي تعليق، فأكملنا بالتالي في الترتيب.` : null),
  next_tool: () => "توقفت إحدى أدوات الجمع مبكرًا، فأكملنا بأداة أخرى.",
  source_ended: (_e, noun) => (noun ? `انتهى ما يعرضه المصدر من ${noun.plural}.` : null),
  retry_wait: () => "المصدر تأخر في الرد، ونعيد المحاولة.",
  stage_done: (e, noun) => (noun && isCount(e.n) ? `انتهينا من جمع ${noun.plural}: ${isCount(e.promised) && e.promised > 0 ? xOfN(e.n, e.promised) : countAr(e.n, noun)}.` : null),
  gap_stated: (e, noun) => (noun && isCount(e.n) && isCount(e.promised) && e.promised > e.n ? `أعطانا المصدر ${xOfN(e.n, e.promised)} فقط، وكتبنا ذلك في الملف.` : null),
  file_building: () => "نجهّز الملف الآن.",
  file_ready: () => "الملف جاهز للتنزيل.",
};

/** One event's line, or null (an unknown code, a missing number, a bad time). */
export function workLogLine(e: WorkLogEvent): WorkLogLine | null {
  if (!e || typeof e.code !== "string" || !Object.prototype.hasOwnProperty.call(SENTENCE, e.code)) return null;
  const at = typeof e.at === "number" ? e.at : Date.parse(String(e.at ?? ""));
  if (!Number.isFinite(at)) return null;
  const textAr = SENTENCE[e.code](e, nounOf(e.noun));
  if (textAr === null) return null;
  return { code: e.code, at, timeAr: toArabicDigits(hm.format(at)), textAr };
}

/** The lines of a list of events, oldest first; events that give nothing are left out. */
export const workLogLines = (events: ReadonlyArray<WorkLogEvent>): WorkLogLine[] => events.map(workLogLine).filter((l): l is WorkLogLine => l !== null).sort((a, b) => a.at - b.at);

/** The noun of a stage, from its title (the file's own noun), as a work-log noun; null when it is none of the list. */
const NOUN_BY_KEY: Record<string, WorkLogNoun> = { فيديو: "videos", تغريده: "tweets", منشور: "posts", بوست: "posts", تعليق: "comments", رد: "replies", شركه: "companies", موظف: "people", شخص: "people" };
export const stageNounOf = (titleAr: string): WorkLogNoun | null => NOUN_BY_KEY[itemNounOf(titleAr).key] ?? null;

/**
 * THE STORED LIVE EVENTS (the worker's `progress` events of today) AS WORK-LOG LINES, by their NUMBERS only: a «saved» event (`counts.stage`, `counts.saved`, `counts.planned`) is
 * `items_saved` (the number added since the stage's previous «saved» event), a «pages» event (`counts.pages`) is `page_read`. The words of an event are never read. Any other event gives nothing.
 */
export function workLogFromEvents(
  plan: { stages: ReadonlyArray<{ key: string; title_ar: string; planned_rows: number }> },
  events: ReadonlyArray<{ kind: string; created_at: string; counts?: Record<string, unknown> | null }>,
): WorkLogLine[] {
  const lastSaved = new Map<number, number>();
  const out: WorkLogEvent[] = [];
  for (const ev of events) {
    const c = ev.counts ?? {};
    if (ev.kind !== "progress") continue;
    if (isCount(c.stage) && isCount(c.saved)) {
      const stage = plan.stages[c.stage - 1];
      const noun = stage ? stageNounOf(stage.title_ar) : null;
      if (!stage || !noun) continue;
      const before = lastSaved.get(c.stage) ?? 0;
      lastSaved.set(c.stage, c.saved);
      if (c.saved <= before) continue;
      out.push({ code: "items_saved", at: ev.created_at, n: c.saved - before, total: c.saved, promised: isCount(c.planned) ? c.planned : stage.planned_rows, noun });
    } else if (isCount(c.pages) && c.pages > 0) out.push({ code: "page_read", at: ev.created_at, n: c.pages });
  }
  return workLogLines(out);
}
