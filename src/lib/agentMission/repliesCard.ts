import { formatAr, toArabicDigits } from "../arabicDigits";
import { AGENT_REPLIES_PER_COMMENT_DEFAULT, AGENT_MAX_DELIVERED_ROWS } from "./constants";
import { childCountOf } from "./childCount";
import { countAr, knownItemNoun } from "./itemNoun";
import type { PricedPlan } from "./plan";

/**
 * THE COUNT AND THE CARD OF THE REPLIES (the replies PR). The customer's number («١٠ تعليقات») counts the TOP-LEVEL comments only; the replies of those comments are delivered in addition, priced by code, and the card says so in plain Arabic. Pure: the plan in, Arabic and counts out.
 *   - `repliesLinesAr` is the card's sentence (built from the plan, so it follows every edit);
 *   - `topLevelFactsOf` splits a delivery into what the customer asked for (the videos and their comments) and the replies that came in addition: only the first decides whether a delivery is complete.
 */
type Stages = Pick<PricedPlan, "stages">["stages"];

const REPLY = knownItemNoun("رد")!;
const BASIC = "التعليقات الأساسية";
/** S9: what the plan says instead of a number when the replies are open. */
export const ALL_REPLIES_AR = "كل الردود على التعليقات المختارة";
/** Rule 1 (consolidation): all the comments of parents whose source gives no comment counter: no number is promised. */
export const ALL_COMMENTS_AR = "كل التعليقات على العناصر المختارة";
export const OPEN_COMMENTS_NOTE_AR = "لا يعرض المصدر عدّاد التعليقات لكل عنصر، فلا نعدك برقم قبل القراءة؛ نقرأ كل التعليقات التي يعطيها المصدر، ولن يتجاوز ما تدفعه الحد الأقصى المعروض في الخطة.";

export function repliesLinesAr(plan: { stages: Stages; replies_status?: PricedPlan["replies_status"]; compiled?: PricedPlan["compiled"] }): string[] {
  const replies = plan.stages.filter((s) => s.replies_of !== undefined);
  if (replies.length > 0) {
    const planned = replies.reduce((n, s) => n + s.planned_rows, 0);
    // THE REPLIES TO TOP-LEVEL ITEMS (live D5: the replies to the chosen tweets): the customer's number is the items', the replies come in addition, by the platform's counter of each item
    const topParent = replies.length === 1 ? plan.stages.find((x) => x.key === replies[0].replies_of && x.parent_key === null) : undefined;
    if (topParent && plan.compiled?.by === "compiler") {
      const counted = plan.compiled.promises[replies[0].key];
      const known = counted?.type === "open" && typeof counted.counted === "number" ? counted.counted : planned;
      return [`العدد الذي طلبته يخص ${topParent.title_ar} وحدها؛ ونضيف إليها كل الردود على ${topParent.title_ar} المختارة: ${countAr(known, REPLY)} بحسب عدّاد المنصة، وقد يعطي المصدر أقل. لا نقرأ ردود عنصر عدّاد ردوده صفر، ولا تدفع إلا مقابل ما سُلّم فعلًا. تقدر توقف الردود من «عدّل الخطة» لتخفيض السعر.`];
    }
    // a compiled plan: the replies the comments read at planning already count by their own counters; the rest is a separate «حتى» part, priced apart on the card (live finding C)
    const counted = plan.compiled?.by === "compiler" ? replies.map((s) => plan.compiled!.promises[s.key]).find((p) => p?.type === "open" && typeof p.counted === "number") : undefined;
    if (counted && replies.some((s) => s.replies_open)) {
      const open = Math.max(0, planned - (counted.counted as number));
      return [`العدد الذي طلبته يخص ${BASIC} وحدها؛ ونضيف إليها ${ALL_REPLIES_AR}، دون حد لعدد الردود على التعليق الواحد: ${countAr(counted.counted as number, REPLY)} بحسب عدّادات ${toArabicDigits(counted.counted_comments ?? 0)} تعليقًا قرأناها${open > 0 ? `، وحتى ${countAr(open, REPLY)} لتعليقات لم نقرأ عدّادها بعد، ويظهر ذلك في سطر منفصل من السعر` : ""}. لا ندفع لقراءة ردود تعليق عدّاد ردوده صفر، ولا تدفع إلا مقابل ما سُلّم فعلًا. تقدر توقف الردود من «عدّل الخطة» لتخفيض السعر.`];
    }
    // S9: replies with no promised number: all the replies of the chosen comments; the estimate prices them as a maximum
    if (replies.some((s) => s.replies_open)) return [`العدد الذي طلبته يخص ${BASIC} وحدها؛ ونضيف إليها ${ALL_REPLIES_AR} دون أن نعدك برقم قبل القراءة، ويُحسب لها في السعر حدّ أقصى بتقدير نحو ${countAr(planned, REPLY)}، ولا تدفع إلا مقابل ما سُلّم فعلًا. لا ندفع لقراءة ردود تعليق عدّاد ردوده صفر. تقدر توقف الردود من «عدّل الخطة» لتخفيض السعر.`];
    return [`العدد الذي طلبته يخص ${BASIC} وحدها؛ ونضيف إليها ردودها بتقدير نحو ${countAr(planned, REPLY)} (حتى ${countAr(Math.max(...replies.map((s) => s.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_DEFAULT)), REPLY)} على كل تعليق له ردود)، ويدخل ذلك في السعر، ولا ندفع لقراءة ردود تعليق عدّاد ردوده صفر. تقدر توقف الردود من «عدّل الخطة» لتخفيض السعر.`];
  }
  switch (plan.replies_status) {
    case "off": return [`أوقفت الردود بتعديلك، فستصلك ${BASIC} وحدها، ويرجع السعر إلى سعرها وحدها.`];
    case "no_source": return [`لا يتوفر لهذه المنصة مصدر نقرأ منه ردود التعليقات، فستصلك ${BASIC} وحدها.`];
    case "no_counter": return [`المصدر لا يعطي عدد الردود على كل تعليق، ولا نشتري ردودًا قبل أن نعرف أي تعليق له ردود، فستصلك ${BASIC} وحدها.`];
    case "none_found": return [`لم نجد ردودًا على التعليقات التي فحصناها، فستصلك ${BASIC} وحدها.`];
    case "no_room": return [`حجم المهمة لا يتسع لقراءة الردود مع التعليقات، فستصلك ${BASIC} وحدها.`];
    default: return [];
  }
}

export interface TopLevelFacts {
  /** The replies the plan estimated, and the replies delivered. */
  repliesPlanned: number;
  repliesDelivered: number;
  /** What the customer asked for (the delivered stages that are not replies): planned and delivered. */
  topLevelPlanned: number;
  topLevelDelivered: number;
}

/** `rowsByStage`: the rows delivered of each stage (by the file). */
export function topLevelFactsOf(plan: { stages: Stages }, rowsByStage: Record<string, number>): TopLevelFacts {
  const out: TopLevelFacts = { repliesPlanned: 0, repliesDelivered: 0, topLevelPlanned: 0, topLevelDelivered: 0 };
  for (const s of plan.stages) {
    if (!s.deliver) continue;
    const rows = Math.max(0, rowsByStage[s.key] ?? 0);
    if (s.replies_of !== undefined) { out.repliesPlanned += s.planned_rows; out.repliesDelivered += rows; } else { out.topLevelPlanned += s.planned_rows; out.topLevelDelivered += rows; }
  }
  return out;
}

/**
 * THE REPLIES JUDGED AGAINST WHAT WAS DELIVERED (S9). A replies stage that is open (`replies_open`) promised no number: after the delivery its promise is the reply counters of the comments that were DELIVERED (each up to the replies read per comment; never fewer than the replies
 * that came, since a comment whose counter said 0 may still have had some), so the notice, the card and the file summary all say the same numbers. The price is not touched (the money is settled on the rows delivered). A plan with no open replies is returned as it is. Pure.
 */
/** A replies stage of a COMPILED plan that reads every reply of each chosen comment (no number per comment was asked): the cap per comment only sized the hold. Never true for a plan the model built. */
export function readsAllReplies(plan: { compiled?: PricedPlan["compiled"] }, stage: Stages[number]): boolean {
  return plan.compiled?.by === "compiler" && stage.replies_of !== undefined && stage.replies_uncapped === true;
}

export function withRepliesJudged<P extends { stages: Stages; compiled?: PricedPlan["compiled"] }>(plan: P, rowsByStage: Record<string, ReadonlyArray<Record<string, unknown>>>, endedAtSource: (key: string) => boolean = () => true): P {
  if (!plan.stages.some((s) => s.replies_open || s.children_open)) return plan;
  return {
    ...plan,
    stages: plan.stages.map((s) => {
      // rule 1 (consolidation): comments of parents with no counter promised no number; when the source ended, the promise is what it gave (a stop for budget or time keeps the estimate, so the shortfall stays visible)
      if (s.children_open && s.replies_of === undefined) {
        const { children_open: _c, ...kept } = s;
        void _c;
        if (!endedAtSource(s.key)) return kept;
        const delivered = (rowsByStage[s.key] ?? []).length;
        return { ...kept, planned_rows: delivered, expected_rows: delivered };
      }
      if (!s.replies_open || s.replies_of === undefined) return s;
      // a compiled plan reads EVERY reply of a comment when no number per comment was asked: the promise is the counters as they are (the cap of 50 sized the hold only)
      const cap = readsAllReplies(plan, s) ? Number.POSITIVE_INFINITY : Math.max(1, s.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_DEFAULT);
      const counters = (rowsByStage[s.replies_of] ?? []).reduce((n, row) => n + Math.min(cap, Math.max(0, childCountOf(row) ?? 0)), 0);
      // ONE PROMISED NUMBER BEFORE AND AFTER APPROVAL (round 14; live Facebook: the card said «٥٣٧», the file, the chat and the orders page «٤٦٤ من ٦٢٠»; found again, by the delivery contract, in the replay of every compiled plan): the promise of a COMPILED plan's replies is the number the card showed at approval:
      // the replies the planning's own counters counted (`compiled.promises.<key>.counted`), and nothing for replies that promised no number. The replies the delivered comments' counters add, and the ones beyond, are told in the limits lines (counter against delivered), never as a new promise.
      // A plan the model built keeps the judged promise it always had.
      const counted = plan.compiled?.by === "compiler" ? plan.compiled.promises?.[s.key]?.counted : undefined;
      const rows = plan.compiled?.by === "compiler" ? Math.max(0, Math.floor(typeof counted === "number" ? counted : 0)) : Math.max(counters, (rowsByStage[s.key] ?? []).length);
      const { replies_open: _open, ...rest } = s;
      void _open;
      return { ...rest, planned_rows: rows, expected_rows: rows };
    }),
  };
}

/** True for a plan that has a replies stage. */
export const hasReplies = (plan: { stages: Stages }): boolean => plan.stages.some((s) => s.replies_of !== undefined);

void formatAr;

/**
 * THE PROMISE FOR COMMENTS AND REPLIES TOGETHER (S5): a video's counter counts both, so the plan fixes ONE total (`promise_total`) and carries an estimated split on the two stages. While the mission runs, each of the two stages may be read up to the total (the source gives no more than the
 * counter in all), so a split that was estimated wrongly never costs a comment or a reply; the delivery is then told against the total: the replies that were delivered, and the comments that complete the total. Pure.
 */
export function withPromiseCaps<P extends { stages: Stages; compiled?: PricedPlan["compiled"] }>(plan: P): P {
  if (!plan.stages.some((s) => s.promise_total !== undefined || s.children_open || readsAllReplies(plan, s))) return plan;
  return {
    ...plan,
    stages: plan.stages.map((s) => {
      // every reply of every chosen comment is read (live finding C): while the run reads, the stage is bounded by the job's own limit of delivered rows, never by the estimate that sized the hold (the charge never goes above the reserve)
      if (readsAllReplies(plan, s)) {
        const others = plan.stages.filter((x) => x.key !== s.key && x.deliver).reduce((n, x) => n + x.planned_rows, 0);
        return { ...s, planned_rows: Math.max(s.planned_rows, AGENT_MAX_DELIVERED_ROWS - others) };
      }
      if (s.promise_total !== undefined) return { ...s, planned_rows: Math.max(s.planned_rows, s.promise_total) };
      // rule 1: all the comments of parents with no counter are read to the source's end, up to what the job may deliver (the price's maximum protects the customer: the charge never goes above the reserve)
      if (s.children_open) {
        const parents = Math.max(1, plan.stages.find((x) => x.key === s.parent_key)?.planned_rows ?? 1);
        return { ...s, planned_rows: Math.max(s.planned_rows, Math.min(AGENT_MAX_DELIVERED_ROWS, parents * Math.max(1, s.per_parent_rows ?? 1))) };
      }
      return s;
    }),
  };
}

/** The plan as the delivery is told: the replies planned are the replies delivered, the comments planned are the total less them (so «delivered of planned» compares like with like and never above the counters). */
export function reportedPlan<P extends { stages: Stages }>(plan: P, rowsByStage: Record<string, number>): P {
  if (!plan.stages.some((s) => s.promise_total !== undefined)) return plan;
  const total = Math.max(...plan.stages.map((s) => s.promise_total ?? 0));
  const replies = plan.stages.filter((s) => s.replies_of !== undefined && s.promise_total !== undefined).reduce((n, s) => n + Math.max(0, rowsByStage[s.key] ?? 0), 0);
  return { ...plan, stages: plan.stages.map((s) => (s.promise_total === undefined ? s : s.replies_of !== undefined ? { ...s, planned_rows: Math.max(0, rowsByStage[s.key] ?? 0) } : { ...s, planned_rows: Math.max(0, total - replies) })) };
}
