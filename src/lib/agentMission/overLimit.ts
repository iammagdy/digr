import { AGENT_JOB_POINTS_CAP, AGENT_REPLIES_PER_COMMENT_MAX } from "./constants";
import { childCountOf } from "./childCount";
import { countAr, itemNounOf, knownItemNoun } from "./itemNoun";
import { customerPlanView, stagePriceInputs, type PricedPlan, type PricedStage } from "./plan";
import { priceMissionByCode } from "./price";
import { OPEN_REPLIES_FLOOR } from "./foundation/openReplies";
import { holdLimitOf, type HoldLimit } from "./holdLimit";
import { pointsAr } from "../pointsFormat";
import { formatAr } from "../arabicDigits";

/**
 * A PLAN THAT CANNOT BE APPROVED IS NEVER SHOWN WITH AN APPROVE BUTTON (live round 11, Facebook msn_9d196025e7929324983a: after the customer chose «fill from other pages» the card said «السعر حتى ٩٬١٢٥» and «حجز مؤقت ٢٦٬٦٥٣», above the job cap of
 * 25,000 points; the button could only fail after the click). The hold is the plan's maximum charge plus the 15% buffer (price.ts, not touched); the cap is `AGENT_JOB_POINTS_CAP` (jobPointsCap.ts, not touched). This module only READS both: it names the limit,
 * breaks the price down row by row, and builds a SMALLER VERSION by code (the most comments per post whose hold fits), priced again by the same pricing function; nothing here decides a price, a charge, a reserve or a release. Staged jobs above the cap belong to the
 * money PR. Facebook, Instagram and YouTube compiled plans only (TikTok and X keep their behaviour; a plan of the old path is never touched). Pure.
 */
export const LIMITED_PLATFORMS: ReadonlyArray<string> = ["facebook", "instagram", "youtube"];
const isLimited = (plan: Pick<PricedPlan, "compiled">): boolean => plan.compiled?.by === "compiler" && LIMITED_PLATFORMS.includes(plan.compiled.platform);

export { holdLimitOf, type HoldLimit };

interface Roles { parent: PricedStage; comments: PricedStage; replies: PricedStage | null }
function rolesOf(plan: PricedPlan): Roles | null {
  const parent = plan.stages.find((s) => s.deliver && s.parent_key === null);
  const comments = parent ? plan.stages.find((s) => s.deliver && s.parent_key === parent.key && s.replies_of === undefined) : undefined;
  if (!parent || !comments) return null;
  return { parent, comments, replies: plan.stages.find((s) => s.deliver && s.replies_of === comments.key) ?? null };
}

export interface PriceBreakdown {
  posts: { rows: number; points: number }; comments: { rows: number; points: number };
  /** The replies the comments read at planning say they have (their own counters). */
  repliesCounted: { rows: number; points: number };
  /** The replies of the comments not read yet: an estimate that sizes the hold only. */
  repliesOpen: { rows: number; points: number };
  /** The counted rows (posts, comments, counted replies): the card's «السعر حتى». */
  counted: { rows: number; points: number };
  /** Everything at full delivery: the maximum charge. */
  max: { rows: number; points: number };
  reservePoints: number;
  /** The replies' share of the provider cost of the whole plan (0 to 1). */
  repliesShareOfProviderCost: number;
}

/** THE PRICE ROW BY ROW: each line is the cumulative ceiling at the plan's unit price, so the lines add up exactly to the card's «السعر حتى» and to the maximum charge. Null for a plan with no comments stage. */
export function priceBreakdownOf(plan: PricedPlan): PriceBreakdown | null {
  const roles = rolesOf(plan);
  if (!roles) return null;
  const unit = plan.price.unitPricePoints;
  const promise = roles.replies ? plan.compiled?.promises[roles.replies.key] : undefined;
  const repliesRows = roles.replies?.planned_rows ?? 0;
  const counted = Math.min(repliesRows, promise && promise.type === "open" && typeof promise.counted === "number" ? promise.counted : 0);
  const rows = { posts: roles.parent.planned_rows, comments: roles.comments.planned_rows, counted, open: Math.max(0, repliesRows - counted) };
  const cum = (n: number): number => Math.ceil(n * unit - 1e-9);
  const a = rows.posts, b = a + rows.comments, c = b + rows.counted, d = c + rows.open;
  const replyUsd = roles.replies ? roles.replies.planned_rows * roles.replies.measured_cost_per_row_usd : 0;
  return {
    posts: { rows: rows.posts, points: cum(a) }, comments: { rows: rows.comments, points: cum(b) - cum(a) },
    repliesCounted: { rows: rows.counted, points: cum(c) - cum(b) }, repliesOpen: { rows: rows.open, points: Math.min(plan.price.maxChargePoints, cum(d)) - cum(c) },
    counted: { rows: c, points: cum(c) }, max: { rows: d, points: Math.min(plan.price.maxChargePoints, cum(d)) },
    reservePoints: plan.price.reservePoints,
    repliesShareOfProviderCost: (plan.price.providerCostUsd ?? 0) > 0 ? replyUsd / (plan.price.providerCostUsd ?? 1) : 0,
  };
}

/** What the hold is made of, said in the customer's words (Arabic digits): posts, comments, replies counted, replies not counted yet. */
export function breakdownLineAr(plan: PricedPlan): string | null {
  const roles = rolesOf(plan);
  const b = priceBreakdownOf(plan);
  if (!roles || !b) return null;
  const parent = itemNounOf(roles.parent.title_ar);
  const comment = knownItemNoun("تعليق")!;
  const reply = knownItemNoun("رد")!;
  const parts = [countAr(b.posts.rows, parent), countAr(b.comments.rows, comment), ...(b.repliesCounted.rows > 0 ? [`${countAr(b.repliesCounted.rows, reply)} بحسب عدّادات التعليقات التي قرأناها`] : []), ...(b.repliesOpen.rows > 0 ? [`وحتى ${countAr(b.repliesOpen.rows, reply)} لتعليقات لم نقرأ عدّادها بعد`] : [])];
  return `الحجز المؤقت يشمل: ${parts.slice(0, parts.length > 2 && b.repliesOpen.rows > 0 ? -1 : parts.length).join("، ")}${b.repliesOpen.rows > 0 && parts.length > 2 ? `، ${parts[parts.length - 1]}` : ""}.`;
}

export interface SmallerVersion { per_post: number; plan: PricedPlan }

const grouped = (n: number): string => pointsAr(Math.round(n));

/** The plan with at most `perPost` comments read from each chosen post, by code: the rows follow the posts' counters (the sum of min(counter, N)), the replies are sized by the same ratio the plan already had, the sentences say the new numbers, and the plan is PRICED AGAIN by the pricing function. */
function withCommentsPerPost(plan: PricedPlan, perPost: number): PricedPlan | null {
  const roles = rolesOf(plan);
  if (!roles || !plan.compiled) return null;
  const copy: PricedPlan = structuredClone(plan);
  const r = rolesOf(copy)!;
  const n = Math.max(1, Math.floor(perPost));
  const counters = (r.parent.pinned_rows ?? []).map((row) => childCountOf(row));
  const known = counters.length > 0 && counters.every((c): c is number => c !== null);
  const parents = Math.max(1, r.parent.planned_rows);
  const rows = known ? (counters as number[]).reduce((s, c) => s + Math.min(n, c), 0) : n * parents;
  r.comments.planned_rows = rows;
  r.comments.expected_rows = rows;
  r.comments.per_parent_rows = n;
  if (r.comments.children_cap_per_parent !== undefined) r.comments.children_cap_per_parent = n;
  delete r.comments.all_children;
  const promises = copy.compiled!.promises;
  promises.comments = known ? { type: "counter", n: rows, counter: (counters as number[]).reduce((s, c) => s + c, 0) } : { type: "open", n: rows };
  if (r.replies) {
    const old = plan.compiled!.promises[r.replies.key];
    const oldCounted = old && old.type === "open" && typeof old.counted === "number" ? old.counted : 0;
    const oldComments = old && old.type === "open" && typeof old.counted_comments === "number" ? old.counted_comments : 0;
    const ratio = oldComments > 0 ? oldCounted / oldComments : 0;
    const estimate = Math.max(1, Math.min(rows * AGENT_REPLIES_PER_COMMENT_MAX, Math.ceil(rows * Math.max(ratio, OPEN_REPLIES_FLOOR))));
    const seenComments = Math.min(oldComments, rows);
    const seenReplies = oldComments > 0 ? Math.min(estimate, Math.round(oldCounted * (seenComments / oldComments))) : 0;
    r.replies.planned_rows = estimate;
    r.replies.expected_rows = estimate;
    promises[r.replies.key] = { type: "open", n: estimate, counted: seenReplies, counted_comments: seenComments };
  }
  // the sentences say the new numbers (nothing of the full plan's counts stays on the card)
  const word = copy.compiled!.platform === "youtube" ? "فيديو" : "منشور";
  const per = formatAr(n);
  const lines = (copy.notes_ar ?? []).filter((x) => !x.startsWith("التعليقات:") && !x.startsWith("الردود:") && !x.startsWith("هذه نسخة أصغر"));
  const notes = [
    `هذه نسخة أصغر من الخطة الكاملة: حتى ${per} تعليق من كل ${word}، لتناسب الحد المسموح للحجز.`,
    ...lines,
    `التعليقات: حتى ${per} تعليق من كل ${word} مختار، أي ${formatAr(rows)} تعليق على الأكثر مما يعرضه المصدر.`,
    ...(r.replies ? [`الردود: كل ما يعرضه المصدر من ردود على هذه التعليقات، دون حد لعدد الردود على التعليق الواحد؛ والحد الأقصى المحسوب في الحجز ${formatAr(r.replies.planned_rows)} ردّ، ولا ندفع إلا مقابل ما سُلّم.`] : []),
  ];
  copy.notes_ar = notes;
  copy.summary_ar = copy.summary_ar.replace(/[،,]\s*مع كل تعليق[^.]*\./, `، بحد أقصى ${per} تعليق من كل ${word}${r.replies ? " مع ردودها" : ""}.`);
  if (copy.summary_ar === plan.summary_ar) copy.summary_ar = `${copy.summary_ar.replace(/[.\s]+$/u, "")}، بحد أقصى ${per} تعليق من كل ${word}.`;
  copy.price = priceMissionByCode(stagePriceInputs(copy.stages, copy.contact_steps), { settings: copy.price.settings });
  return copy;
}

/**
 * THE SMALLER VERSION BY CODE: the most comments per chosen post whose hold fits `limitPoints` (the job cap, or the customer's balance when lower), priced again by the pricing function. Null when even one comment per post does not fit, or the plan has no comments
 * stage. `options.perPost` builds exactly that number (used to prove that the next one up does not fit).
 */
export function smallerVersionOf(plan: PricedPlan, limitPoints: number, options: { perPost?: number } = {}): SmallerVersion | null {
  if (!isLimited(plan)) return null;
  const roles = rolesOf(plan);
  if (!roles) return null;
  if (options.perPost !== undefined) { const p = withCommentsPerPost(plan, options.perPost); return p ? { per_post: Math.max(1, Math.floor(options.perPost)), plan: p } : null; }
  const counters = (roles.parent.pinned_rows ?? []).map((row) => childCountOf(row)).filter((c): c is number => c !== null);
  const most = Math.max(1, counters.length > 0 ? Math.max(...counters) : Math.floor(roles.comments.per_parent_rows ?? 100));
  const fits = (n: number): PricedPlan | null => { const p = withCommentsPerPost(plan, n); return p && p.price.reservePoints <= limitPoints ? p : null; };
  if (!fits(1)) return null;
  let lo = 1, hi = most;
  let best = fits(1)!;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const p = fits(mid);
    if (p) { lo = mid; best = p; } else hi = mid - 1;
  }
  return { per_post: lo, plan: best };
}

/** The public plan the card draws from: the customer's view of the plan, and, for a Facebook, Instagram or YouTube compiled plan, its `limit` (the hold against the cap, the hold's rows, and the smaller version by code). Other plans are exactly `customerPlanView`. */
export function publicPlanOf(plan: PricedPlan, options: { now?: number } = {}): ReturnType<typeof customerPlanView> & { limit?: Record<string, unknown> } {
  const view = customerPlanView(plan, options);
  if (!isLimited(plan)) return view;
  const over = holdLimitOf(plan.price.reservePoints, null);
  const smaller = over ? smallerVersionOf(plan, AGENT_JOB_POINTS_CAP) : null;
  return {
    ...view,
    limit: {
      over: over !== null, reserve_points: plan.price.reservePoints, cap_points: AGENT_JOB_POINTS_CAP,
      ...(over ? { rows_ar: breakdownLineAr(plan), sentence_ar: `هذه الخطة أكبر من الحد المسموح لحجز واحد (${grouped(AGENT_JOB_POINTS_CAP)})؛ الحجز المؤقت المطلوب لها ${grouped(plan.price.reservePoints)}، فلا يمكن اعتمادها كما هي.` } : {}),
      smaller: smaller ? { per_post: smaller.per_post, reserve_points: smaller.plan.price.reservePoints, max_charge_points: smaller.plan.price.maxChargePoints, rows: smaller.plan.price.deliveredRows } : null,
    },
  };
}
