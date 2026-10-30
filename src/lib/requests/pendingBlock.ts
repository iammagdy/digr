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
