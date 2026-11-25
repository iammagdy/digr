import { describe, expect, it } from "vitest";
import { shortfallClauseAr } from "../agent/src/finalize";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { GAP_CHOICE_LINE_AR } from "../src/lib/agentMission/gapLines";
import { MARK_COLUMNS_AR, MARK_COLUMN_ORDER, markCellAr } from "../src/lib/agentMission/rawMarks";

/** S1: EVERY NEW CUSTOMER-FACING STRING GOES THROUGH checkCustomerText (Arabic only, no source names, no dollar amount, no internal id, no Latin word, no spreadsheet word). The strings of the other items are checked beside their own tests; these are the rest. */
const ok = (text: string) => expect(checkCustomerText(text).issues, text).toEqual([]);
describe("the new customer strings", () => {
  it("the closing sentence of a stage that stopped at the reserve edge", () => {
    ok(`سُلّم أقل من المطلوب ${shortfallClauseAr("need_new_plan", { pending: 0, stop: null })}.`);
  });
  it("the choice line of the gap statement", () => ok(GAP_CHOICE_LINE_AR));
  it("every mark cell the file can hold", () => {
    for (const k of MARK_COLUMN_ORDER) { ok(MARK_COLUMNS_AR[k]); for (const v of [true, false, null, "ar", "other"]) ok(markCellAr(k, { [k]: v } as never)); }
  });
});
