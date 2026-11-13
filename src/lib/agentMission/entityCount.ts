import { formatAr } from "../arabicDigits";
import { countAr, GENERIC_ITEM_NOUN, itemNounOf, type ItemNoun } from "./itemNoun";

/**
 * ROUND 58: THE COMPANY COUNT OF A PLAN IS THE COUNT OF ITS COMPANIES (the 13 Nov cosmetics plan: 20 companies from the maps, and the published contacts of about 12 of them = 32 priced items; the customer read «٣٢» as 32 companies).
 *
 * A plan whose delivered steps are ONE top step (the things the customer asked for: companies, places…) and steps that hang on it (the contacts of each company, its people) is told by the number of its top items, and the steps under
 * it are details of those items with their own expected coverage. The priced total (every delivered item of every step, the approved pricing contract) is unchanged and is called «عنصر», never the top noun. Pure; display only: no
 * price, hold or charge is read or changed here.
 */
export interface EntityStageRef { key: string; titleAr: string; parentKey: string | null; deliver: boolean; rows: number; open?: boolean }
export interface EntityBreakdown { root: { key: string; titleAr: string; rows: number; noun: ItemNoun }; details: Array<{ key: string; titleAr: string; rows: number }>; totalItems: number }

const HUMAN_NOUNS = new Set(["شخص", "موظف"]);
const ofThem = (noun: ItemNoun): string => (HUMAN_NOUNS.has(noun.singular) ? "منهم" : "منها");
/** «الشركات»، «الأماكن»: the plural with the article. */
export const definitePluralAr = (noun: ItemNoun): string => (noun.plural.startsWith("ال") ? noun.plural : `ال${noun.plural}`);

/** The top step and its details, or null when the plan is not one counted thing with details (one step, two independent steps, open replies, or a top noun the table does not know). */
export function entityBreakdownOf(stages: ReadonlyArray<EntityStageRef>): EntityBreakdown | null {
  const delivered = stages.filter((s) => s.deliver);
  if (delivered.length < 2 || delivered.some((s) => s.open)) return null;
  const roots = delivered.filter((s) => s.parentKey === null);
  if (roots.length !== 1) return null;
  const root = roots[0];
  const noun = itemNounOf(root.titleAr);
  if (noun.key === GENERIC_ITEM_NOUN.key) return null;
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const descends = (s: EntityStageRef): boolean => {
    let cur: EntityStageRef | undefined = s;
    for (let hops = 0; cur && hops < 8; hops += 1) {
      if (cur.parentKey === root.key) return true;
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
    return false;
  };
  const details = delivered.filter((s) => s !== root);
  if (!details.every(descends)) return null;
  return { root: { key: root.key, titleAr: root.titleAr, rows: root.rows, noun }, details: details.map((d) => ({ key: d.key, titleAr: d.titleAr, rows: d.rows })), totalItems: delivered.reduce((n, s) => n + s.rows, 0) };
}

/** The stages of a PUBLIC plan (the card's `plan_public`) as references. */
export function entityStagesOfPublic(planPublic: unknown): EntityStageRef[] {
  const p = planPublic && typeof planPublic === "object" ? (planPublic as Record<string, any>) : null;
  const list: any[] = Array.isArray(p?.stages) ? p!.stages : [];
  return list.map((s) => ({
    key: String(s?.key ?? ""),
    titleAr: String(s?.title_ar ?? "").replace(/\s+/g, " ").trim(),
    parentKey: typeof s?.parent_key === "string" && s.parent_key !== "" ? s.parent_key : null,
    deliver: s?.deliver !== false,
    rows: Math.max(0, Math.floor(Number(s?.expected_rows) || 0)),
    open: s?.replies_open === true || s?.children_open === true || typeof s?.replies_counted === "number",
  }));
}

/** The stages of an INTERNAL priced plan as references (the worker's file and the plan editor). */
export function entityStagesOfPriced(stages: ReadonlyArray<{ key: string; title_ar: string; parent_key?: string | null; deliver: boolean; planned_rows: number; replies_of?: unknown; replies_open?: boolean; children_open?: boolean }>): EntityStageRef[] {
  return stages.map((st) => ({ key: st.key, titleAr: st.title_ar, parentKey: st.parent_key ?? null, deliver: st.deliver, rows: st.planned_rows, open: st.replies_of !== undefined || st.replies_open === true || st.children_open === true }));
}

/** The plan's headline after an edit: «تجمع لك ٣٢ شركة، ومعها تفاصيلها كما في الخطة، بحسب خطتك المعدّلة.» for companies with their details; null for any other plan (the caller keeps its sentence). */
export function editedHeadlineAr(stages: ReadonlyArray<EntityStageRef>): string | null {
  const b = entityBreakdownOf(stages);
  return b ? `تجمع لك ${countAr(b.root.rows, b.root.noun)}، ومعها تفاصيلها كما في الخطة، بحسب خطتك المعدّلة.` : null;
}

/** «٢٠ شركة، ومعها «بيانات التواصل …» لحوالي ١٢ منها»: what the customer receives, counted by its top items. */
export function receiveLineAr(b: EntityBreakdown): string {
  const parts = b.details.map((d) => (d.rows <= b.root.rows ? `«${d.titleAr}» لحوالي ${formatAr(d.rows)} ${ofThem(b.root.noun)}` : `${formatAr(d.rows)} من «${d.titleAr}»`));
  return `${countAr(b.root.rows, b.root.noun)}، ومعها ${parts.join("، و")}`;
}

/** The priced total said with what it is: «والمجموع ٣٢ عنصرًا محسوبًا في السعر، وعدد الشركات فيها ٢٠ فقط، لا ٣٢». */
export function pricedTotalAr(b: EntityBreakdown): string {
  return `والمجموع ${countAr(b.totalItems, GENERIC_ITEM_NOUN)} محسوبًا في السعر، وعدد ${definitePluralAr(b.root.noun)} فيها ${formatAr(b.root.rows)} فقط، لا ${formatAr(b.totalItems)}`;
}

/**
 * A plan that targets FEWER than the customer asked for (the planner gave a reason the card shows): the two numbers, side by side, before the approval. Nothing is substituted silently: approving means accepting that number, and the
 * customer can change it. Null when the plan targets what was asked.
 */
export function targetLineAr(planPublic: unknown): string | null {
  const p = planPublic && typeof planPublic === "object" ? (planPublic as Record<string, any>) : null;
  const q = p?.quantity && typeof p.quantity === "object" ? p.quantity : null;
  const requested = Math.floor(Number(q?.requested) || 0);
  const target = Math.floor(Number(q?.target) || 0);
  if (!q || requested <= 0 || target <= 0 || target >= requested) return null;
  const stage = (Array.isArray(p?.stages) ? p!.stages : []).find((s: any) => s?.key === q.stage_key);
  const noun = itemNounOf(String(stage?.title_ar ?? ""));
  return `طلبتَ ${countAr(requested, noun)}، وهذه الخطة تستهدف ${formatAr(target)} فقط، والسبب في ملاحظات الخطة. اعتمادها يعني قبول هذا العدد؛ ولو أردت عددًا آخر فاكتبه في المحادثة أو غيّره من تعديل الخطة.`;
}

/** The delivery said by its top items: «منها ١٩ شركة، و١١ من «بيانات التواصل …»» (the file's first sheet). Null when the plan is not one counted thing with details. */
export function deliveredBreakdownAr(stages: ReadonlyArray<EntityStageRef>, deliveredByKey: Record<string, number>): string | null {
  const b = entityBreakdownOf(stages);
  if (!b) return null;
  const rootN = Math.max(0, deliveredByKey[b.root.key] ?? 0);
  const parts = b.details.map((d) => `${formatAr(Math.max(0, deliveredByKey[d.key] ?? 0))} من «${d.titleAr}»`);
  return `منها ${countAr(rootN, b.root.noun)}، و${parts.join("، و")}.`;
}
