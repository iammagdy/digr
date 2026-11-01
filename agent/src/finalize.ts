import ExcelJS from "exceljs";
import type { StopReason } from "./items/itemStore";
import { formatAr } from "../../src/lib/arabicDigits";
import { countAr, GENERIC_ITEM_NOUN, knownItemNoun, type ItemNoun } from "../../src/lib/agentMission/itemNoun";

/**
 * READING A FILE BACK. The count that settles a mission and is shown to the customer is the number of items in the file the customer downloads, counted from the file itself (the xlsx: every sheet after the summary, minus its
 * header row), never from a number kept somewhere else. Null when the bytes are not a workbook.
 */
export async function countWorkbookItems(bytes: Buffer | Uint8Array): Promise<number | null> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    let n = 0;
    wb.worksheets.slice(1).forEach((sheet) => { n += Math.max(0, sheet.actualRowCount - 1); });
    return n;
  } catch {
    return null;
  }
}

/** The items of each sheet after the summary, in sheet order (the delivered stages that have items, in plan order), counted from the workbook itself. Null when the bytes are not a workbook. */
export async function countWorkbookSheets(bytes: Buffer | Uint8Array): Promise<number[] | null> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    return wb.worksheets.slice(1).map((sheet) => Math.max(0, sheet.actualRowCount - 1));
  } catch {
    return null;
  }
}

/** The same count from the CSV (the deepest delivered stage): header row excluded. A second, independent reading of what the customer receives. */
export function countCsvItems(csv: string): number {
  const rows = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0);
  return Math.max(0, rows.length - 1);
}

/**
 * WHY FEWER ITEMS THAN REQUESTED WERE DELIVERED, in plain Arabic and with no number, from the stop reason the engine RECORDED (never a guess, and never «this is all that matched» when found items were not checked). A reason that
 * cannot be named says only what is true: the sources gave no more matching items.
 */
export function shortfallClauseAr(reason: StopReason | null, review: { pending: number; stop: "budget" | "failed" | null; /** Items the language of the plan left out (the language rule): when the sources ran dry, this is the reason to say. Never set for a stage of child items: they are delivered raw. */ languageLeftOut?: number; /** The sentence for a child stage whose parents gave fewer children than the number asked for each (see childShortfallClauseAr). */ childShare?: string | null }): string {
  if (review.pending > 0 && review.stop === "failed") return "لأن المراجعة الآلية تعذّر الوصول إليها لبعض ما وُجد، فلم يُسلَّم ما لم يُراجَع";
  // ONLY A RECORDED STOP SAYS THE LIMIT WAS REACHED (audit G13): waiting items with no recorded stop say what is true and nothing about why
  if (review.pending > 0 && review.stop === "budget") return "لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة قبل فحص كل ما وُجد، فلم يُسلَّم ما لم يُراجَع";
  if (review.pending > 0) return "لأن المراجعة الآلية لم تكتمل لبعض ما وُجد، فلم يُسلَّم ما لم يُراجَع";
  if (review.childShare && (reason === null || reason === "source_exhausted" || reason === "no_new_items" || reason === "target_reached")) return review.childShare;
  if ((review.languageLeftOut ?? 0) > 0 && (reason === null || reason === "source_exhausted" || reason === "no_new_items" || reason === "target_reached")) return "لأن المصادر لم تعطِ ما يكفي من المحتوى باللغة المحددة في خطتك";
  switch (reason) {
    case "source_exhausted": return "لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب";
    case "no_new_items": return "لأن المصدر صار يكرر نفس النتائج ولم تظهر نتائج جديدة مطابقة لطلبك";
    case "budget": return "لأن ميزانية القراءة من المصادر المخصصة لهذه المهمة اكتملت";
    case "daily_cap": return "لأن الحد اليومي للقراءة من المصادر اكتمل";
    case "time_limit": return "لأن الوقت المخصص لهذه المهمة انتهى";
    case "review_limit": return "لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة قبل فحص كل ما وُجد، فلم يُسلَّم ما لم يُراجَع";
    case "failed": case "refused": return "لأن القراءة من المصدر تعذّرت قبل اكتمال العدد";
    case "page_limit": return "لأن القراءة بلغت الحد الأقصى لعدد الصفحات المسموح لهذه المهمة";
    case "no_parents": return "لأن المرحلة السابقة لم تعطِ عناصر يُبنى عليها هذا الجزء";
    case "model_stopped": return "لأن القراءة توقفت قبل اكتمال العدد المطلوب";
    case "target_reached": case null: default: return "لأن هذا كل ما وُجد مطابقًا لطلبك ضمن حدود المصادر والميزانية";
  }
}

/**
 * THE REASON A CHILD STAGE FELL SHORT WHILE EVERY PARENT WAS READ: some parents have fewer children than the number asked for each («بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو»). No language, topic or text rule is ever the reason: the children are delivered as
 * the source gives them. No number in it.
 */
export function childShortfallClauseAr(parentSingular: string, parentPlural: string, childPlural: string): string {
  const withArticle = (w: string): string => (w.startsWith("ال") ? w : `ال${w}`);
  return `لأن بعض ${withArticle(parentPlural)} عليها ${childPlural} أقل من العدد المطلوب لكل ${parentSingular}`;
}

export function shortfallFromStopAr(reason: StopReason | null, review: { pending: number; stop: "budget" | "failed" | null; languageLeftOut?: number; childShare?: string | null }): string {
  return `لم يكتمل العدد المطلوب ${shortfallClauseAr(reason, review)}، ولم يُخصم إلا مقابل ما سُلّم.`;
}

/** What the item store recorded about the delivered stages of a mission that delivered nothing. */
export interface ZeroDeliveryFacts {
  /** Items the source gave (new ones, duplicates left out), summed over the delivered stages. */
  found: number;
  /** Items left out, by the reason the run recorded, summed over the delivered stages. */
  excludedByReason: Record<string, number>;
  /** Items still waiting for a review that never came. */
  pending: number;
  reviewStop: "budget" | "failed" | null;
  /** Why the first delivered stage stopped (a budget, a daily limit, a refusal, a failure say so instead of «the source gave nothing»). */
  stop?: StopReason | null;
}

/** One clause per reason a found item is left out, each finishing «منه ما ...». The relevance reasons are one idea. */
const ZERO_REASON_CLAUSES: ReadonlyArray<{ keys: ReadonlyArray<string>; clause: string }> = [
  { keys: ["filter_account"], clause: "جاء من حسابات أو مصادر غير التي سمّيتها" },
  { keys: ["filter_period"], clause: "وقع خارج الفترة التي حددتها" },
  { keys: ["filter_language"], clause: "كان بلغة غير التي حددتها في خطتك" },
  { keys: ["filter_place"], clause: "كان من مكان غير الذي حددته" },
  { keys: ["filter_reply"], clause: "كان ردودًا على منشورات أخرى" },
  { keys: ["filter_repost"], clause: "كان إعادة نشر لمحتوى غيره" },
  { keys: ["filter_government"], clause: "كان لجهات حكومية أو عسكرية" },
  { keys: ["filter_media"], clause: "لا يثبت أنه فيديو أو صورة كما طلبت" },
  { keys: ["no_text", "no_term", "mention_only", "other_person", "name_extended", "other_meaning", "uncertain", "review_no", "review_failed"], clause: "لا يطابق موضوع طلبك" },
  { keys: ["not_a_person"], clause: "كان عناوين عامة للشركات لا لأشخاص" },
  { keys: ["no_verified_contact"], clause: "لا اسم شخص فيه ولا بيانات تواصل موثّقة" },
];
const ZERO_ADVICE_AR = "يمكنك تعديل الطلب، كاللغة أو الحساب أو الموضوع، ثم إعادة المحاولة.";

/**
 * WHY NOTHING WAS DELIVERED, in plain Arabic and with no number, from what the run RECORDED (live, B3: twelve posts read, all left out by the account and language rules, and the customer read only «لم يُسلَّم أي شيء»; a reason existed only when the model wrote
 * a closing note). The biggest reasons first, at most three. Never a guess: an item that was never read says «the source gave nothing»; items still waiting for a review that ran out say that.
 */
export function zeroDeliveryReasonAr(f: ZeroDeliveryFacts): string {
  const nothing = "لم يُسلَّم أي شيء، ولم يُخصم منك شيء";
  if (f.pending > 0) return `لم يُسلَّم أي شيء ${shortfallClauseAr(f.stop ?? null, { pending: f.pending, stop: f.reviewStop })}، ولم يُخصم منك شيء.`;
  if (f.found <= 0) {
    if (f.stop && f.stop !== "source_exhausted" && f.stop !== "no_new_items" && f.stop !== "target_reached" && f.stop !== "no_parents") return `لم يُسلَّم أي شيء ${shortfallClauseAr(f.stop, { pending: 0, stop: null })}، ولم يُخصم منك شيء.`;
    return `لم يعطِ المصدر أي نتائج لهذا الطلب، فلم يُسلَّم أي شيء ولم يُخصم منك شيء. ${ZERO_ADVICE_AR}`;
  }
  const groups = ZERO_REASON_CLAUSES
    .map((g, order) => ({ clause: g.clause, n: g.keys.reduce((s, k) => s + (f.excludedByReason[k] ?? 0), 0), order }))
    .filter((g) => g.n > 0)
    .sort((a, b) => b.n - a.n || a.order - b.order)
    .slice(0, 3);
  if (groups.length === 0) return `قرأنا ما أعطاه المصدر، لكن لم يبقَ منه ما يطابق طلبك. ${nothing}. ${ZERO_ADVICE_AR}`;
  const clauses = groups.map((g, i) => `${i === 0 ? "منه" : "ومنه"} ما ${g.clause}`).join("، ");
  return `قرأنا ما أعطاه المصدر، لكن لم يبقَ منه ما يطابق طلبك: ${clauses}. ${nothing}. ${ZERO_ADVICE_AR}`;
}

/** What each reason for leaving an item out says to the customer (the delivered file's methodology and the closing sentence read the same words). */
export const REASON_TEXT_AR: Record<string, string> = {
  no_text: "لا نص فيه", no_term: "لا يذكر الموضوع في نصه", mention_only: "إشارة عابرة أو رد فارغ", other_person: "عن شخص آخر يحمل الاسم نفسه", name_extended: "الاسم فيه امتداد يدل على شخص آخر", other_meaning: "عن معنى آخر للاسم نفسه",
  uncertain: "لم يتأكد أنه عن المقصود", not_reviewed: "لم يُراجَع لأن المراجعة الآلية بلغت حدها", review_no: "رُفض عند المراجعة الآلية", review_failed: "تعذّرت مراجعته",
  filter_reply: "رد على غيره", filter_repost: "إعادة نشر", filter_language: "بلغة غير التي حددتها", filter_period: "خارج الفترة المحددة", filter_account: "من مصدر لم تسمّه", filter_place: "من مكان غير الذي حددته", filter_government: "جهة حكومية أو عسكرية", filter_media: "لا يثبت أنه فيديو أو صورة",
  unknown_parent: "لا ينتمي لعنصر مقروء", no_verified_contact: "لا اسم شخص فيه ولا بيانات تواصل موثّقة", not_a_person: "لا يخص شخصًا بعينه (بريد عام أو اسم جهة أو بلا اسم؛ يظهر البريد في عمود إيميلات الشركة)", target_reached: "زاد عن العدد المعتمد",
  not_at_company: "لا يعمل حاليًا في هذه الشركة (شركته الحالية غير الشركة المطلوبة)",
};
export const reasonTextAr = (reason: string): string => REASON_TEXT_AR[reason] ?? "سبب آخر";

/** The reasons that are OUR row rules (the shape of a row), not the customer's own criteria: when they left out what the source gave, «the source gave no more» is not the truth. */
const OUR_ROW_RULE_REASONS: ReadonlyArray<string> = ["no_verified_contact", "not_a_person", "unknown_parent"];

export interface StageTruthFacts {
  /** Items the source gave for the stage (repeats included). */
  found: number;
  /** Repeats among them. */
  duplicates: number;
  /** Items delivered from the stage. */
  delivered: number;
  excludedByReason: Record<string, number>;
  /** THIS stage's items a review never reached (never another stage's). */
  pending: number;
  reviewStop: "budget" | "failed" | null;
  stop: StopReason | null;
  /** The stage's items are people (the noun is «شخص» whatever the stage's title calls them). */
  people?: boolean;
  noun?: ItemNoun;
}

/**
 * WHAT THE STAGE THAT FELL SHORT REALLY FOUND AND LEFT OUT, from the counts the run recorded, in plain Arabic: «وُجد ٣١ شخصًا، ولم يُسلَّم ٣١: ٣١ لا اسم شخص فيه ولا بيانات تواصل موثّقة». Live re-test 2026-10-31 (A1, A2): the delivered file said
 * «سُلّم ٠ من ١٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب» although the source had given 31 and 41 people and OUR row rule had left them all out.
 *
 * Returns null (the caller keeps the older, true sentence by the recorded stop reason) when the source gave nothing, or when none of the items the source gave was left out by one of OUR row rules (everything it gave was delivered, or only what
 * does not match the request was left out: then «the source gave no more matching results» is true).
 */
export function stageTruthBodyAr(t: StageTruthFacts): string | null {
  const found = Math.max(0, Math.floor(Number(t.found) || 0));
  const duplicates = Math.max(0, Math.floor(Number(t.duplicates) || 0));
  const distinct = Math.max(0, found - duplicates);
  if (distinct <= 0) return null;
  const byReason = Object.entries(t.excludedByReason).filter(([k, n]) => k !== "target_reached" && Number(n) > 0).map(([k, n]) => [k, Math.floor(Number(n))] as const);
  if (!byReason.some(([k]) => OUR_ROW_RULE_REASONS.includes(k))) return null;
  const noun = t.people ? knownItemNoun("شخص") ?? GENERIC_ITEM_NOUN : t.noun ?? GENERIC_ITEM_NOUN;
  const parts = [`وُجد ${countAr(distinct, noun)}${duplicates > 0 ? ` (بعد إزالة ${formatAr(duplicates)} مكررًا)` : ""}`];
  const leftN = byReason.reduce((n, [, c]) => n + c, 0);
  if (leftN > 0) parts.push(`ولم يُسلَّم ${formatAr(leftN)}: ${[...byReason].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${formatAr(c)} ${reasonTextAr(k)}`).join("؛ ")}`);
  const pending = Math.max(0, Math.floor(Number(t.pending) || 0));
  if (pending > 0) parts.push(`وبقي ${formatAr(pending)} دون مراجعة${t.reviewStop === "failed" ? " لأن المراجعة الآلية تعذّر الوصول إليها" : t.reviewStop === "budget" ? " لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة" : ""}`);
  return parts.join("، ");
}
