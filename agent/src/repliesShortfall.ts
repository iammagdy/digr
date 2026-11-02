import { shortfallClauseAr } from "./finalize";
import type { StopReason } from "./items/itemStore";

/**
 * THE TRUE REASON FOR FEWER REPLIES THAN PROMISED (S2 item 5; docs/S1-LIVE-FINDINGS.md, L0.5). The replies are estimated from a sample of the comments, so a delivery can hold fewer than the plan said while every comment was read; the text used to name only the top-level
 * stage, so a gap that was all replies was told as «fewer comments». This sentence is built from what the run RECORDED for the replies stage (its own stop), in plain Arabic and with no number (the money line carries the counts). Empty when the replies were delivered as planned.
 * The status of a delivery is unchanged: it is complete or partial by its top-level rows.
 */
export function repliesShortfallAr(o: { planned: number; delivered: number; stop: StopReason | null; review: { pending: number; stop: "budget" | "failed" | null }; /** Add the money phrase (when this sentence stands alone). */ withMoney?: boolean }): string {
  if (!(o.planned > o.delivered)) return "";
  // a stop that ended the reading before the comments' replies were all read is told as it is (the budget, a failure, the time); a source that simply had no more says what is true: the plan's number was an estimate
  const ended = o.stop === null || o.stop === "source_exhausted" || o.stop === "no_new_items" || o.stop === "target_reached";
  const clause = ended
    ? "لأن الخطة قدّرت الردود من عيّنة من التعليقات، والمصدر لم يعطِ على التعليقات المقروءة أكثر مما سُلّم"
    : shortfallClauseAr(o.stop, { pending: 0, stop: null }).replace(/^لأن /, "لأن ");
  return `الردود التي سُلّمت أقل مما قدّرناه في الخطة ${clause}${o.withMoney ? "، ولم يُخصم إلا مقابل ما سُلّم" : ""}.`;
}
