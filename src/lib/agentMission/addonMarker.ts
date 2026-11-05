/**
 * MONEY PR 7e, PHASE 2B-2 TASK 4 (docs/MONEY-PR-7A.md section 17): THE ONE RULE THAT SAYS A ROW OF `missions` IS AN ADD-ON ROW, for every ordinary reader of that table.
 *
 * A paid review, a review fix or an edit of a delivered file is a row of the `missions` table whose `plan` JSON carries the key `addon` (a waiting review request is `plan_ready`, like a research plan that waits for approval). It is NOT a research mission:
 * it is never planned, listed with the research requests, counted against the research limits, replaced by a new chat request, edited as a plan, or approved and cancelled by the research paths. Its own code (reviewRequest.ts, addonSettlement.ts, the worker) is the only code that handles it.
 *
 * The rule is the worker's own (`agent/src/stage4/runAddon.ts` `isAddonMission`: a plan that has the `addon` key) and it is deliberately STRUCTURAL, not validated: a row that carries the key but is malformed is still not an ordinary mission (it must never fall through
 * into the research paths, whose plan code would crash or, worse, claim it). The validated reader `readAddonPlan` lives with the money side; this file imports NOTHING, so any reader may use it without reaching the money side.
 *
 * A reader that does not select the `plan` column asks for `ADDON_MARKER_COLUMN` (a JSON-path select, the form the repository already uses for `plan_public->stages`): it comes back as the object under `addon`, or null.
 */
export const ADDON_MARKER_COLUMN = "addon:plan->addon";

type MarkerCarrier = { plan?: unknown; addon?: unknown } | null | undefined;

/** True when the row's `plan` has the `addon` key, or the selected `addon` column is not empty. Anything that is not an object is not an add-on row. */
export function hasAddonMarker(row: MarkerCarrier | unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const { plan, addon } = row as { plan?: unknown; addon?: unknown };
  if (plan && typeof plan === "object" && !Array.isArray(plan) && Object.prototype.hasOwnProperty.call(plan, "addon")) return true;
  return addon !== null && addon !== undefined;
}

/** The rows that are ordinary research missions. */
export const withoutAddonRows = <T>(rows: ReadonlyArray<T>): T[] => rows.filter((r) => !hasAddonMarker(r));

/** The row as the admin or the customer may be sent it: the selected marker column is internal and is removed. */
export function withoutMarkerColumn<T extends Record<string, unknown>>(row: T): Omit<T, "addon"> {
  const { addon: _addon, ...rest } = row;
  return rest;
}
