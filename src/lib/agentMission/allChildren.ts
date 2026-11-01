import { toArabicDigits } from "../arabicDigits";
import { childCountOf } from "./childCount";
import { isPeopleStage } from "./people";
import { priceMissionByCode } from "./price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "./plan";

/**
 * «ALL COMMENTS MEANS ALL» (docs/REDESIGN.md section 4, S1 item 1.10, [PRICE-INPUT]). When the customer asks for every comment, the plan does not give each video the same share: each parent is read to its source's end, and the estimate that prices the plan is the
 * sum of the parents' OWN comment counters (a parent whose counter is 0 is never read, and costs nothing). Only the estimate that prices the plan is computed here (planned rows, through the one pricing function); the charge formula in price.ts is not touched, and
 * what is charged is still what is delivered. Above the job cap the plan keeps today's behaviour and says so; Stage 4 adds staging. Pure apart from the counters the caller reads.
 */
const ALL_WORDS = /(?:^|\s|و)(?:كل|جميع|كافة)\s+(?:ال)?تعليقات/;
export const wantsAllChildren = (request: unknown): boolean => ALL_WORDS.test(String(request ?? ""));

export interface AllChildrenEstimate { total: number; perParent: number; /** Parents that will be read. */ read: number; /** Parents whose own counter is 0: never read. */ skipped: number; /** Parents that gave no counter: estimated at the fallback share. */ unknown: number }

/** The estimate from the counters of the parents that will be read, in order. A parent with no counter is estimated at `fallbackShare`. */
export function allChildrenEstimate(counters: ReadonlyArray<number | null>, fallbackShare: number): AllChildrenEstimate {
  let total = 0; let read = 0; let skipped = 0; let unknown = 0; let largest = 0;
  for (const c of counters) {
    if (c === null) { unknown += 1; read += 1; total += fallbackShare; largest = Math.max(largest, fallbackShare); continue; }
    if (c <= 0) { skipped += 1; continue; }
    read += 1; total += Math.floor(c); largest = Math.max(largest, Math.floor(c));
  }
  return { total, perParent: Math.max(1, largest), read, skipped, unknown };
}

export interface AllChildrenDeps {
  request: string;
  /** The comment counters of the parent stage's rows, in the order the parents are read (the measured page mapped by the stage's proven mapping); null for a row with no counter. */
  parentCountersOf: (parent: PricedStage) => Promise<Array<number | null> | null>;
}

const NOTE_CAP_AR = "طلب كل التعليقات أكبر من الحد الأقصى للمهمة الواحدة، فسنسلّم عددًا محدودًا منها ضمن هذا الحد.";
const noteAr = (parentTitle: string, parents: number, total: number): string => `ستحصل على كل التعليقات على ${toArabicDigits(parents)} من ${parentTitle}، وهي نحو ${toArabicDigits(total)} تعليقًا بحسب عدّاد كل واحد منها، ويدخل هذا العدد في السعر.`;

export const counterOfRow = (row: Record<string, unknown>): number | null => childCountOf(row);

/**
 * The plan with its comments stage set to read all the comments: planned rows = the sum of the parents' counters, per-parent figure = the largest counter, `all_children` set (the engine then reads each parent to its own counter), the plan priced again by the one
 * pricing function, and one line on the card that says «كل التعليقات» with the estimate. Returns the plan as given when the request does not ask for all of them, when no counters are known, or when the estimate would exceed the job cap (a line says so).
 */
export async function withAllChildren(plan: PricedPlan, deps: AllChildrenDeps): Promise<PricedPlan> {
  if (!wantsAllChildren(deps.request)) return plan;
  let out = plan;
  for (const stage of plan.stages) {
    if (stage.parent_key === null || !stage.deliver || stage.replies_of !== undefined || isPeopleStage(stage) || stage.engine === undefined) continue;
    const parent = out.stages.find((s) => s.key === stage.parent_key);
    if (!parent) continue;
    const counters = await deps.parentCountersOf(parent);
    if (!counters || counters.every((c) => c === null)) continue;
    const est = allChildrenEstimate(counters.slice(0, Math.max(1, parent.planned_rows)), Math.max(1, Number(stage.per_parent_rows) || 1));
    if (est.total < 1) continue;
    const stages = out.stages.map((s) => (s.key === stage.key ? { ...s, planned_rows: est.total, expected_rows: est.total, per_parent_rows: est.perParent, all_children: true } : s));
    const price = priceMissionByCode(stagePriceInputs(stages, out.contact_steps), { settings: out.price.settings });
    if (price.overCap) { if (!(out.notes_ar ?? []).includes(NOTE_CAP_AR)) out = { ...out, notes_ar: [...(out.notes_ar ?? []), NOTE_CAP_AR] }; continue; }
    const note = noteAr(parent.title_ar, est.read, est.total);
    out = { ...out, stages, price, notes_ar: [...(out.notes_ar ?? []).filter((n) => n !== note), note] };
  }
  return out;
}
