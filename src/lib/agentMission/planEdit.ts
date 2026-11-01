import { toArabicDigits } from "../arabicDigits";
import { AGENT_MAX_DELIVERED_ROWS, AGENT_PEOPLE_PAGES_MAX, AGENT_REPLIES_PER_COMMENT_DEFAULT, AGENT_REPLIES_PER_COMMENT_MAX } from "./constants";
import { textKeyOf } from "./contract";
import { FILTER_KINDS, filterVerdict, isEnabled, kindsPromisedBy, type FilterKind } from "./filters";
import { countAr, itemNounOf, itemNounOfPlan, type ItemNoun } from "./itemNoun";
import { lockedColumnKeys, stagePriceInputs, targetStageKey, type PlanColumn, type PricedPlan, type PricedStage } from "./plan";
import { priceMissionByCode } from "./price";
import { classifyRows } from "./relevance";
import { countedQuantities } from "./quantity";
import { repliesEstimateFor } from "./replies";

/**
 * THE CUSTOMER EDITS THE PLAN ITSELF (the card's «عدّل الخطة»), without cancelling and retyping: the number of items, the period, the language, each exclusion the card shows (replies, reposts, accounts, places) on or off, and the main
 * columns. The edit is applied to the STORED plan by code, checked again against what the mapping really gives (a locked column cannot be switched off, a filter the mapping cannot enforce is not offered), and PRICED AGAIN BY CODE
 * with the same function that priced it (the model never decides a price); the result is shown again for approval. Pure: no I/O (the caller stores it).
 */
export interface PlanEdits {
  /** The number of items the customer wants: the target of the stage their quantity counts. */
  count?: number;
  stages?: Array<{
    key: string;
    /** For a stage that hangs on another (the people of each company): how many items per item of the parent. */
    per_parent?: number;
    /** For a people stage read in depth: how many pages of the source are read for each parent (lower = cheaper). */
    pages?: number;
    /** For the COMMENTS stage: whether the replies of its comments are delivered too (off: the replies stage leaves the plan and the price falls to the comments' own; on: it comes back). */
    replies?: boolean;
    /** For the COMMENTS stage while its replies are on: the most replies read for each comment (1 to 50; the default is 10); the replies planned and the price follow it by code. */
    replies_per_comment?: number;
    /** The keys of the columns that stay in the file (the others are hidden; hidden ones may be switched back on). */
    columns?: string[];
    filters?: Array<{ kind: FilterKind; enabled?: boolean; lang?: "ar" | "en"; days?: number }>;
  }>;
}

export type PlanEditResult = { ok: true; plan: PricedPlan } | { ok: false; errorAr: string };
const fail = (errorAr: string): PlanEditResult => ({ ok: false, errorAr });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface EditContext {
  /** The mapped items of the page a stage's yield was measured on (null: unavailable, the measured yield stays). */
  yieldRows?: (stage: PricedStage) => Array<Record<string, unknown>> | null;
  now?: number;
}

/** A count written in a sentence of the plan, moved to the new count (Arabic-Indic or Western digits, standing alone). */
function replaceCount(text: string, from: number, to: number): string {
  if (from === to) return text;
  const ar = toArabicDigits(from);
  return text.replace(new RegExp(`(?<![0-9٠-٩])(?:${ar}|${from})(?![0-9٠-٩])`, "g"), toArabicDigits(to));
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A COUNT OF THIS NOUN IN A TEXT, MOVED TO THE NEW COUNT IN THE RIGHT FORM («أعلى ١٠ تعليقات» -> «أعلى تعليقين» -> «أعلى ٣ تعليقات»). Golden run round 2, G4: the customer edited the comments per video from 10 to 2 and the stage's title, which is the sheet's name and its line on the card,
 * kept saying ten. Only a number standing in front of THIS noun's own forms (or the noun's spelled count) is moved, so a number of another thing in the same sentence («٥ فيديوهات») is never touched.
 */
export function restateNounCount(text: string, from: number, to: number, noun: ItemNoun): string {
  if (from === to || !text) return text;
  const alternatives = [
    `(?<![0-9٠-٩])(?:${escapeRe(toArabicDigits(from))}|${from})\\s+(?:${[noun.plural, noun.tamyiz, noun.singular].map(escapeRe).join("|")})(?![\\p{L}])`,
    ...[countAr(from, noun), countAr(from, noun, { subject: true })].filter((x, i, a) => a.indexOf(x) === i).map((x) => `(?<![\\p{L}])${escapeRe(x)}(?![\\p{L}])`),
  ];
  return text.replace(new RegExp(alternatives.join("|"), "gu"), countAr(to, noun));
}

/** The count per item of the parent moved in every sentence of the plan that states it with the stage's noun: the stage's title, the headline, each explanation, the assumptions. */
function restatePerParent(plan: PricedPlan, stage: PricedStage, from: number, to: number): void {
  const noun = itemNounOf(stage.title_ar);
  if (noun.key === itemNounOf("").key) return;
  stage.title_ar = restateNounCount(stage.title_ar, from, to, noun);
  plan.summary_ar = restateNounCount(plan.summary_ar, from, to, noun);
  for (const s of plan.stages) if (s.how_ar) s.how_ar = restateNounCount(s.how_ar, from, to, noun);
  if (plan.assumptions_ar) plan.assumptions_ar = plan.assumptions_ar.map((a) => restateNounCount(a, from, to, noun));
}

/** The sentences of the plan that carry a count, kept consistent with the new target; a sentence whose count cannot be moved is replaced by a sentence built here (never left saying the old number). */
function restateCounts(plan: PricedPlan, from: number, to: number): void {
  const targets = new Set<number>(plan.stages.flatMap((s) => [s.planned_rows, ...(s.per_parent_rows ? [s.per_parent_rows] : [])]));
  const titles = plan.stages.map((s) => s.title_ar);
  const stale = (text: string): boolean => countedQuantities(text, titles).some((q) => !targets.has(q.value));
  plan.summary_ar = replaceCount(plan.summary_ar, from, to);
  if (stale(plan.summary_ar)) plan.summary_ar = `تجمع لك ${countAr(to, itemNounOfPlan(plan))} بحسب خطتك المعدّلة.`;
  for (const s of plan.stages) if (s.how_ar) { s.how_ar = replaceCount(s.how_ar, from, to); if (stale(s.how_ar)) delete s.how_ar; }
  if (plan.assumptions_ar) plan.assumptions_ar = plan.assumptions_ar.map((a) => replaceCount(a, from, to)).filter((a) => !stale(a));
}

export function applyPlanEdits(planIn: PricedPlan, editsIn: unknown, ctx: EditContext = {}): PlanEditResult {
  if (!isRecord(editsIn)) return fail("تعذّر قراءة تعديلك. حاول مرة أخرى.");
  const plan = JSON.parse(JSON.stringify(planIn)) as PricedPlan;
  const now = ctx.now ?? Date.now();

  // 1. THE NUMBER OF ITEMS: the target of the stage the customer's quantity counts; what hangs on it follows in proportion, and a parent that cannot give that many grows
  if (editsIn.count !== undefined && editsIn.count !== null) {
    const count = Number(editsIn.count);
    if (!Number.isInteger(count) || count < 1 || count > AGENT_MAX_DELIVERED_ROWS) return fail(`العدد لازم يكون رقمًا صحيحًا من ${toArabicDigits(1)} إلى ${toArabicDigits(AGENT_MAX_DELIVERED_ROWS)}.`);
    const key = targetStageKey(plan);
    const target = plan.stages.find((s) => s.key === key);
    if (!target) return fail("لا توجد مرحلة يُعدَّل عددها.");
    const before = target.planned_rows;
    const rowsBefore = new Map(plan.stages.map((x) => [x.key, x.planned_rows] as const));
    const setRows = (s: PricedStage, rows: number) => { s.planned_rows = rows; s.expected_rows = rows; };
    setRows(target, count);
    // up: a parent must be able to give that many (parent rows x items per parent)
    let child = target;
    for (let guard = 0; child.parent_key !== null && guard < 8; guard += 1) {
      const parent = plan.stages.find((s) => s.key === child.parent_key);
      if (!parent) break;
      const per = Math.max(1, child.per_parent_rows ?? 1);
      if (parent.planned_rows * per < child.planned_rows) setRows(parent, Math.ceil(child.planned_rows / per));
      child = parent;
    }
    // down: what hangs on a stage whose rows changed follows in proportion (never above what its parent gives)
    const changed = new Map<string, number>([[target.key, target.planned_rows / Math.max(1, before)]]);
    for (const s of plan.stages) {
      if (s.parent_key === null || s.key === target.key) continue;
      const ratio = changed.get(s.parent_key);
      if (ratio === undefined) continue;
      const parent = plan.stages.find((p) => p.key === s.parent_key)!;
      const rows = Math.max(1, Math.min(parent.planned_rows * Math.max(1, s.per_parent_rows ?? 1), Math.round(s.planned_rows * ratio)));
      changed.set(s.key, rows / Math.max(1, s.planned_rows));
      setRows(s, rows);
    }
    plan.quantity = { requested: count, stage_key: target.key, target: count, source: "edit" };
    restateCounts(plan, before, count);
    // a title that carries the stage's own count follows it (it is the sheet's name and the stage's line on the card)
    for (const x of plan.stages) { const was = rowsBefore.get(x.key); if (was !== undefined && was !== x.planned_rows) x.title_ar = restateNounCount(x.title_ar, was, x.planned_rows, itemNounOf(x.title_ar)); }
  }

  // 2. THE COLUMNS AND THE FILTERS of each stage named in the edit (a filter whose value the customer changed makes the model's sentence about it stale: it is replaced by the code's own)
  const changedKinds = new Set<FilterKind>();
  let perEdited = false;
  const repliesPer = new Map<string, number>();
  const stageEdits = Array.isArray(editsIn.stages) ? editsIn.stages : [];
  for (const e of stageEdits) {
    if (!isRecord(e)) return fail("تعذّر قراءة تعديلك. حاول مرة أخرى.");
    const stage = plan.stages.find((s) => s.key === String(e.key ?? ""));
    if (!stage) return fail("هذه المرحلة غير موجودة في الخطة.");
    // the replies stage is the comments' own: its number per comment, its columns and its filters are code's (replies.ts); the customer's choice is the switch on the comments stage
    if (stage.replies_of !== undefined && (e.per_parent !== undefined || e.pages !== undefined || e.columns !== undefined || e.filters !== undefined || e.replies_per_comment !== undefined)) return fail("الردود يحدّد برنامجنا عددها وأعمدتها؛ يمكنك إيقافها أو تشغيلها من خيار الردود في التعليقات.");
    if (e.replies !== undefined) {
      if (typeof e.replies !== "boolean") return fail("تعذّر قراءة تعديلك. حاول مرة أخرى.");
      const at = plan.stages.findIndex((x) => x.replies_of === stage.key);
      if (e.replies === false && at >= 0) {
        plan.replies_off = plan.stages[at];
        plan.stages.splice(at, 1);
        plan.replies_status = "off";
      } else if (e.replies === true && at < 0) {
        if (plan.replies_off?.replies_of !== stage.key) return fail("لا ردود متاحة في هذه الخطة.");
        const back = plan.stages.findIndex((x) => x.key === stage.key);
        plan.stages.splice(back + 1, 0, plan.replies_off);
        delete plan.replies_off;
        delete plan.replies_status;
      } else if (e.replies === false && at < 0 && plan.replies_off?.replies_of !== stage.key) return fail("لا ردود متاحة في هذه الخطة.");
    }
    if (e.replies_per_comment !== undefined) {
      // THE REPLIES READ FOR EACH COMMENT: a whole number from 1 to the cap, only while the stage's replies are in the plan; the replies planned and the price follow it below, by the same rule that built them
      const n = Number(e.replies_per_comment);
      if (!plan.stages.some((x) => x.replies_of === stage.key)) return fail("لا ردود متاحة في هذه الخطة.");
      if (!Number.isInteger(n) || n < 1 || n > AGENT_REPLIES_PER_COMMENT_MAX) return fail(`عدد الردود لكل تعليق لازم يكون رقمًا صحيحًا من ${toArabicDigits(1)} إلى ${toArabicDigits(AGENT_REPLIES_PER_COMMENT_MAX)}.`);
      repliesPer.set(stage.key, n);
    }
    if (e.per_parent !== undefined) {
      // THE COUNT PER ITEM OF THE PARENT («صناع القرار» of each company): a whole number from 1; the stage's rows follow (parent rows x count) and the plan is priced again below
      const per = Number(e.per_parent);
      const parent = stage.parent_key === null ? undefined : plan.stages.find((s) => s.key === stage.parent_key);
      if (!parent) return fail("هذا العدد خاص بالمراحل التابعة لمرحلة أخرى.");
      if (!Number.isInteger(per) || per < 1 || per > 100) return fail(`العدد لكل ${itemNounOf(parent.title_ar).singular} لازم يكون رقمًا صحيحًا من ${toArabicDigits(1)} إلى ${toArabicDigits(100)}.`);
      const perBefore = stage.per_parent_rows ?? per;
      stage.per_parent_rows = per;
      restatePerParent(plan, stage, perBefore, per);
      stage.planned_rows = parent.planned_rows * per;
      stage.expected_rows = stage.planned_rows;
      // the line that said the count was code's default is the customer's own now; a sentence that still carries the old count is dropped
      plan.assumptions_ar = [...(plan.assumptions_ar ?? []).filter((a) => !a.startsWith("لم تحدد عدد") && !a.startsWith("اعتمدنا")), `اعتمدنا ${toArabicDigits(per)} لكل ${itemNounOf(parent.title_ar).singular} حسب تعديلك.`];
      perEdited = true;
    }
    if (e.pages !== undefined) {
      // THE DEPTH of a people stage (pages of the source for each company): a whole number from 1 to the maximum; the plan is priced again below by the same function
      const pages = Number(e.pages);
      if (!(Number(stage.pages_per_parent) >= 1) || !stage.role_preference) return fail("هذا الخيار خاص بمرحلة صناع القرار في كل شركة.");
      if (!Number.isInteger(pages) || pages < 1 || pages > AGENT_PEOPLE_PAGES_MAX) return fail(`عدد صفحات البحث لازم يكون رقمًا صحيحًا من ${toArabicDigits(1)} إلى ${toArabicDigits(AGENT_PEOPLE_PAGES_MAX)}.`);
      stage.pages_per_parent = pages;
    }
    if (Array.isArray(e.columns)) {
      const all: PlanColumn[] = [...stage.columns, ...(stage.hidden_columns ?? [])];
      const on = new Set(e.columns.map((k) => String(k)));
      for (const k of on) if (!all.some((c) => c.key === k)) return fail("عمود غير موجود في هذه المرحلة.");
      // a field a check reads that is not a column of the file at all (a hidden reply flag) is not the customer's to switch
      for (const k of lockedColumnKeys(stage)) if (all.some((c) => c.key === k) && !on.has(k)) return fail("لا يمكن حذف هذا العمود؛ تعتمد عليه فحوص الخطة.");
      if (on.size < 1) return fail("اترك عمودًا واحدًا على الأقل في الملف.");
      stage.columns = all.filter((c) => on.has(c.key));
      const hidden = all.filter((c) => !on.has(c.key));
      if (hidden.length > 0) stage.hidden_columns = hidden; else delete stage.hidden_columns;
    }
    if (Array.isArray(e.filters)) {
      for (const fe of e.filters) {
        if (!isRecord(fe) || !FILTER_KINDS.includes(fe.kind as FilterKind)) return fail("خيار غير معروف.");
        const f = (stage.filters ?? []).find((x) => x.kind === fe.kind);
        if (!f) return fail("هذا الخيار غير متاح لهذه الخطة.");
        if (fe.enabled !== undefined) { if (fe.enabled === false) f.enabled = false; else delete f.enabled; }
        if (fe.lang !== undefined) {
          if (f.kind !== "language" || (fe.lang !== "ar" && fe.lang !== "en")) return fail("اللغة المتاحة هي العربية أو الإنجليزية.");
          if (f.lang !== fe.lang) changedKinds.add("language");
          f.lang = fe.lang;
        }
        if (fe.days !== undefined) {
          const days = Number(fe.days);
          if (f.kind !== "period" || !Number.isInteger(days) || days < 1 || days > 3650) return fail("الفترة لازم تكون عدد أيام صحيحًا من ١ إلى ٣٦٥٠.");
          if (f.days !== days || f.from || f.to) changedKinds.add("period");
          f.days = days; delete f.from; delete f.to;
        }
      }
    }
  }

  if (perEdited) restateCounts(plan, 0, 0);
  // a sentence of the plan that promises what a filter the customer just switched OFF used to enforce is not left on the card: the headline becomes a sentence built here, the stage's explanation is dropped
  const offKinds = new Set(plan.stages.flatMap((s) => (s.filters ?? []).filter((f) => !isEnabled(f)).map((f) => f.kind)));
  const stalePromise = (text: string): boolean => kindsPromisedBy(text).some((k) => offKinds.has(k) || changedKinds.has(k));
  if (plan.assumptions_ar) plan.assumptions_ar = plan.assumptions_ar.filter((a) => !kindsPromisedBy(a).some((k) => changedKinds.has(k)));
  if (stalePromise(plan.summary_ar)) plan.summary_ar = `تجمع لك ${countAr(plan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0), itemNounOfPlan(plan))} بحسب خطتك المعدّلة.`;
  for (const s of plan.stages) if (s.how_ar && stalePromise(s.how_ar)) delete s.how_ar;

  // 3. THE YIELD again where the measured page is available: a filter switched on changes how many items of a page match, and the price rests on the cost per MATCHING item
  for (const s of plan.stages) {
    if (!s.relevance) continue;
    const mapped = ctx.yieldRows?.(s) ?? null;
    if (!mapped || mapped.length === 0) continue;
    const enabled = (s.filters ?? []).filter(isEnabled);
    const textKey = textKeyOf(s, Object.keys(mapped[0] ?? {}));
    const passing = mapped.filter((r) => filterVerdict(enabled, r, { textKey, now }) === null);
    const { counts } = classifyRows(s.relevance, passing);
    s.sample_examined = mapped.length;
    s.sample_matching = counts.match;
    s.yield_share = Math.min(1, Math.max(0.02, (counts.match + 0.5 * counts.review) / mapped.length));
    s.review_share = counts.review / mapped.length;
  }

  // 3b. THE REPLIES FOLLOW THEIR COMMENTS: the replies planned are the expected replies per comment over the comments now planned (replies.ts), whatever changed the comments' number
  for (const r of plan.stages.filter((x) => x.replies_of !== undefined)) {
    const comments = plan.stages.find((x) => x.key === r.replies_of);
    if (!comments) continue;
    const elsewhere = plan.stages.filter((x) => x.deliver && x.key !== r.key).reduce((n, x) => n + x.planned_rows, 0);
    const per = repliesPer.get(comments.key) ?? r.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_DEFAULT;
    const est = repliesEstimateFor(r, comments.planned_rows, per, elsewhere);
    r.per_parent_rows = per;
    r.planned_rows = est.rows;
    r.replies_per_comment_expected = est.perCommentExpected;
    r.measured_cost_per_row_usd = est.costPerRowUsd;
    r.expected_rows = r.planned_rows;
    r.title_ar = `ردود ${comments.title_ar}`;
  }

  // a replies stage switched off keeps its title in step with its comments' (it comes back under that title)
  if (plan.replies_off) { const c = plan.stages.find((x) => x.key === plan.replies_off!.replies_of); if (c) plan.replies_off = { ...plan.replies_off, title_ar: `ردود ${c.title_ar}` }; }

  // 4. PRICED AGAIN BY CODE (the same function that priced the plan; the model has no hand in it)
  const delivered = plan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0);
  if (delivered > AGENT_MAX_DELIVERED_ROWS) return fail("العدد أكبر من الحد المسموح لمهمة واحدة.");
  const price = priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: plan.price.settings });
  if (price.overCap) return fail("هذا العدد يتجاوز الحد المسموح لحجز واحد. قلّله ثم أعد المحاولة.");
  plan.price = price;
  return { ok: true, plan };
}
