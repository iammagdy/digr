/**
 * STAGE 2 x STAGE 4 COMPATIBILITY: THE ONE RULE THAT SAYS A ROW OF `missions` IS AN ADD-ON ROW, for the Stage 2 readers (the `ask_edit` action, the card loader, the live-sheet route).
 *
 * A paid review, review fix or edit of a delivered file (Money PR 7e, docs/MONEY-PR-7A.md section 17) is a row of the `missions` table whose `plan` JSON carries the key `addon`. It is NOT a research mission: it is never planned, edited as a plan, shown an Ask card or a live sheet.
 * This is the SAME structural rule as `src/lib/agentMission/addonMarker.ts` of that PR (a plan that has the `addon` key, or a selected `addon` column that is not empty), written here without importing it because this branch does not contain that file.
 * After both branches are merged, this file may be replaced by an import of `addonMarker.ts` (`hasAddonMarker`, `ADDON_MARKER_COLUMN`); the two rules are pinned equal by a test of the merged tree. It imports nothing and reads nothing.
 */
/** A JSON-path select (the form the repository already uses): the object under `plan.addon`, or null. Selected so a reader never has to read the whole plan. */
export const ADDON_MARKER_SELECT = "addon:plan->addon";

export function isAddonRow(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const { plan, addon } = row as { plan?: unknown; addon?: unknown };
  if (plan && typeof plan === "object" && !Array.isArray(plan) && Object.prototype.hasOwnProperty.call(plan, "addon")) return true;
  return addon !== null && addon !== undefined;
}
