import { toArabicDigits } from "../arabicDigits";
import { PENDING_MAX_WAITING } from "./expiry";

/** The block of questions and plans that wait for the customer shows the newest 5; the rest sit behind «عرض الكل (n)». Pure, so the rule is tested without a browser. */
export function pendingBlockView<T extends { createdAt: string | null }>(items: readonly T[], expanded: boolean): { visible: T[]; hiddenCount: number; showAllLabel: string | null } {
  const newestFirst = [...items].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const hiddenCount = Math.max(0, newestFirst.length - PENDING_MAX_WAITING);
  return {
    visible: expanded ? newestFirst : newestFirst.slice(0, PENDING_MAX_WAITING),
    hiddenCount,
    showAllLabel: hiddenCount > 0 && !expanded ? `عرض الكل (${toArabicDigits(newestFirst.length)})` : null,
  };
}

/**
 * THE ONE LINE of the block (round 14): «٤ خطط تنتظر اعتمادك». A plan waits for approval, a question waits for the customer's answer; the line counts what is there with the right plural of each, and says «طلبات تنتظرك» for the mixed case's total.
 * Pure, so the words and the plurals are tested without a browser.
 */
export function pendingSummaryAr(items: ReadonlyArray<{ status: string }>): string {
  const plans = items.filter((m) => m.status === "plan_ready").length;
  const questions = items.length - plans;
  const plansAr = plans === 1 ? "خطة واحدة تنتظر اعتمادك" : plans === 2 ? "خطتان تنتظران اعتمادك" : `${toArabicDigits(plans)} ${plans >= 3 && plans <= 10 ? "خطط" : "خطة"} تنتظر اعتمادك`;
  if (questions === 0) return plansAr;
  if (plans === 0) return questions === 1 ? "طلب واحد ينتظر إجابتك" : questions === 2 ? "طلبان ينتظران إجابتك" : `${toArabicDigits(questions)} ${questions >= 3 && questions <= 10 ? "طلبات" : "طلبًا"} تنتظر إجابتك`;
  return `${toArabicDigits(items.length)} ${items.length >= 3 && items.length <= 10 ? "طلبات" : "طلبًا"} تنتظرك: ${plansAr.replace(" تنتظر اعتمادك", "").replace(" تنتظران اعتمادك", "")} للاعتماد و${questions === 1 ? "طلب" : toArabicDigits(questions) + " " + (questions >= 3 && questions <= 10 ? "طلبات" : "طلبًا")} للإجابة`;
}
