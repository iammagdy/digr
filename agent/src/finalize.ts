import ExcelJS from "exceljs";
import type { StopReason } from "./items/itemStore";

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
export function shortfallClauseAr(reason: StopReason | null, review: { pending: number; stop: "budget" | "failed" | null }): string {
  if (review.pending > 0 && review.stop === "failed") return "لأن المراجعة الآلية تعذّر الوصول إليها لبعض ما وُجد، فلم يُسلَّم ما لم يُراجَع";
  if (review.pending > 0) return "لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة قبل فحص كل ما وُجد، فلم يُسلَّم ما لم يُراجَع";
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

export function shortfallFromStopAr(reason: StopReason | null, review: { pending: number; stop: "budget" | "failed" | null }): string {
  return `لم يكتمل العدد المطلوب ${shortfallClauseAr(reason, review)}، ولم يُخصم إلا مقابل ما سُلّم.`;
}
