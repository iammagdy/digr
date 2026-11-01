import { formatAr } from "../arabicDigits";
import { AGENT_REPLIES_PER_COMMENT_DEFAULT } from "./constants";
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

export function repliesLinesAr(plan: { stages: Stages; replies_status?: PricedPlan["replies_status"] }): string[] {
  const replies = plan.stages.filter((s) => s.replies_of !== undefined);
  if (replies.length > 0) {
    const planned = replies.reduce((n, s) => n + s.planned_rows, 0);
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

/** True for a plan that has a replies stage. */
export const hasReplies = (plan: { stages: Stages }): boolean => plan.stages.some((s) => s.replies_of !== undefined);

void formatAr;
