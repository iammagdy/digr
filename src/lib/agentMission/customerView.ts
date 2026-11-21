import { CSV_LABEL_AR, CSV_METHODOLOGY_LABEL_AR } from "./csvLabels";
import { queueLineV2 } from "./stage3/queueView";
import { checkCustomerText, customerSafeText, NEUTRAL_CUSTOMER_TEXT_AR } from "./text";
import { isExpiredMission } from "../requests/expiry";
import { deliveredChargedLineAr } from "../jobs/requestStatus";
import { SOURCE_LABEL_FALLBACK_AR, foreignLatinIn, latinWordsOf, withoutUnwrittenLabels, writtenLatinWords } from "./shownWords";
import { formatAr, normalizeDigits, toArabicDigits } from "../arabicDigits";
import type { ProgressSample } from "../jobEta";
import { FILES_STEP_TITLE_AR, PLANNING_STEP_TITLES, type PanelStep } from "../missionView";
import { pointsAr, unitPriceLabelAr } from "../pointsFormat";
import providerMetadata from "../../../data/capabilities/provider-metadata.json";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR, AGENT_SLOW_AFTER_MS, AGENT_STALL_AFTER_MS } from "./constants";
import { isInternalEvent } from "./eventText";
import { countAr, deliveredOfAr, GENERIC_ITEM_NOUN, itemNounOf, itemNounOfPlan, knownItemNoun } from "./itemNoun";
import { entityBreakdownOf, entityStagesOfPublic, pricedTotalAr, receiveLineAr, targetLineAr } from "./entityCount";
import { moneyLineAr } from "./moneyText";
import { isFreeRerunEvents } from "./freeRerunMark";
import { fixFileWordingAr } from "./fileWording";
import { remainingLineAr, stageMetricLines, trackMission } from "./tracker";
import { deliveryDenominatorOf, type PlanEditorView } from "./plan";
import { ALL_COMMENTS_AR, ALL_REPLIES_AR } from "./repliesCard";
import { minutesAr } from "./expectedTime";
import { filterLineAr, isEnabled, type StageFilter } from "./filters";
import { formatSampleCell } from "../customerDates";
import { sampleCellText, storedSampleCell } from "./sampleLinks";
import { dedupeNearIdentical } from "../dedupeLines";

/**
 * WHAT THE CUSTOMER SEES OF A MISSION: one pure function from the columns the customer may read (the mission row without its internal columns, its events, the worker's state and the queue)
 * to a view that the chat card and the live panel «خطة المهمة» draw. Arabic only, Arabic-Indic digits; no endpoint, no provider, no internal id, no dollar amount, no English label.
 * Counts come from the events' `counts` JSON (never from their text). Nothing here holds money logic: the price figures are the ones the code computed and stored with the plan.
 */
export type CustomerPhase = "waiting" | "planning" | "question" | "plan" | "running" | "done" | "partial" | "unserved" | "failed" | "cancelled";

export interface MissionRowForCustomer {
  id: string;
  status: string;
  question_ar: string | null;
  plan_public: any | null;
  reserved_points: number | null;
  unit_price_points: number | null;
  delivered_units: number | null;
  charged_points: number | null;
  summary_ar: string | null;
  files: Array<{ name: string; kind: string }> | null;
  created_at: string;
  error?: string | null;
  charged_units?: number | null;
}
export interface EventForCustomer { id: number; kind: string; message_ar: string; counts: Record<string, number> | null; created_at: string }
export interface QueueInfo {
  /** Missions waiting for the worker that were created before this one. */
  ahead: number;
  /** Missions the worker is running right now. */
  running: number;
  /** The worker's heartbeat is fresh. */
  workerAlive: boolean;
  /** Of `ahead`, the ones that are THIS customer's own requests (round 14: a request waits behind the customer's own running job). Absent: not known, counted as other customers'. */
  aheadOwn?: number;
  /** Of `running`, the ones that are this customer's own. */
  runningOwn?: number;
}
export interface CustomerStageView { n: number; titleAr: string; rows: number; rowsAr: string; deliver: boolean; noteAr: string | null; yieldShare?: number; /** The number (1-based) of the stage this one hangs on (comments of posts), else null. */ parentN: number | null }

export interface CustomerMissionView {
  id: string;
  phase: CustomerPhase;
  /** ONE sentence: what will be delivered. */
  summaryAr: string | null;
  /** Honest sentences next to the summary (for example why a contact the customer asked for is not in the plan). */
  notesAr: string[];
  /** What the agent assumed where the request left a choice open («المقصود: محمد صلاح لاعب كرة القدم.»): the customer reads it on the card and may edit the request before approving. */
  assumptionsAr: string[];
  /** THE REQUEST LINE (card redesign): the platform, the topic and the period of what was asked, from the plan's understanding; empty when the plan has none (the card then draws no request line). */
  requestPartsAr: string[];
  /** The steps the customer asked for that the plan leaves out, each with the reason (shown BEFORE approval; the customer approves the rest or edits the request). */
  unservedAr: string[];
  /** The ready answers of the agent's one question (the customer taps one). */
  questionOptionsAr: string[];
  stages: CustomerStageView[];
  totalRows: number;
  totalRowsAr: string;
  /** What the delivered file holds, with the noun («١٥ خبرًا»): the file button says it, never the planned total (live, 16 Nov 2026: a partial of 15 news read «إكسل ٢٠ خبرًا · ٦ أعمدة»). Null before the end. */
  fileRowsAr?: string | null;
  /** 2 to 3 sample rows with readable columns only. */
  samples: { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] } | null;
  /** What the file will contain, built from the plan's REAL columns (never from the agent's own words): «يضم الملف: التاريخ والوقت، نص التغريدة، …». */
  fileContentsAr: string | null;
  /** price, hold and expected time on ONE line. */
  priceLineAr: string | null;
  /** The same facts as short labelled cells for the compact card («السعر حتى ٢٤٣ نقطة»، «حجز مؤقت ٢٧٩ نقطة»، «الوقت المتوقع نحو ٤ دقائق»), and the one sentence under them. */
  priceFacts: Array<{ labelAr: string; valueAr: string }>;
  priceNoteAr: string | null;
  /** ROUND 57: what the price counts (each step's items, when the plan delivers more than one kind) and the hold as the price plus its margin, in the plan's own numbers. Empty: nothing to add. */
  priceExplainAr: string[];
  /** ROUND 58: what the count is, said with its noun: a plan of companies with their contacts is told as its companies (never the priced total as «شركة»), and a target below the customer's own number says both numbers. Empty: nothing to add. */
  countLinesAr: string[];
  /** ROUND 58: the «هتستلم» cell of a plan of companies with their details («٢٠ شركة»); null: the cell shows `totalRowsAr` as before. */
  headlineCountAr: string | null;
  questionAr: string | null;
  /** Why the request waits (round 14: never a time), or null. */
  queueLineAr: string | null;
  queuePosition: number | null;
  /** The live panel «خطة المهمة». */
  steps: PanelStep[];
  currentLineAr: string;
  delayAr: string | null;
  remainingAr: string | null;
  /** Said once after approval, while the work runs. */
  closePageAr: string | null;
  /** After the end: what was delivered, what was charged, what was released. */
  resultLinesAr: string[];
  resultSummaryAr: string | null;
  files: Array<{ name: string; kind: string; labelAr: string }>;
  /** What the customer asked for in all, and the target the plan was approved at: equal unless the plan proposed fewer, with the reason on the card. A delivery below the request is never «complete». */
  requestedRows: number;
  /** The honest end sentence (what happened and what it cost, in one place): for an ending only; null while the mission is open. */
  endLineAr: string | null;
  /** The plan editor of the card (the target, the columns, the filters), only while the plan waits for approval. */
  edit: PlanEditorView | null;
  /** The start of the work (the first event), for the elapsed clock. */
  startedAt: number | null;
  live: boolean;
  /** The period the plan applies, in words («آخر ٩٠ يومًا»), from its own enabled period filter; null when the plan has none. */
  periodAr: string | null;
  /** The expected time in words («نحو دقيقتين»), from the plan's own `expected_minutes` (the one function the calculator uses too); null when the plan has none. */
  expectedAr: string | null;
  /** After approval: what has reached the file so far, out of the whole, with the noun of the request («١٢ من ٥٠ تغريدة»); null before approval. */
  progressLineAr: string | null;
  /** ROUND 26 (item 2): the time (ms) of the last event the customer may read, or null: the card shows how long since anything changed. */
  lastEventAt: number | null;
  /** ROUND 26 (item 6): THE ONE SENTENCE of the running card, which follows the state and carries the one counter: «نجمع التغريدات (٣ من ١٠)» while collecting, «جمعنا التغريدات، ونجهّز ملفك الآن» at the count; null before approval. */
  collectLineAr: string | null;
  /** The items saved so far and the total, for a progress bar. */
  savedSoFar: number;
  expired?: boolean;
  expiredNoteAr?: string | null;
  partialReasonAr?: string | null;
  partialRefundAr?: string | null;
  /**
   * THE LIMIT OF THE HOLD (live round 11): for a Facebook, Instagram or YouTube compiled plan, the hold against the job cap, what it is made of, and the smaller version by code. `over`: the plan is above the cap and has NO approve button. Null for every other plan.
   * `reservePoints` is the hold the customer would be asked to cover (the card compares it with the customer's balance).
   */
  limit?: { over: boolean; reservePoints: number; capPoints: number; sentenceAr: string | null; rowsAr: string | null; smaller: { perPost: number; reservePoints: number; maxChargePoints: number; rows: number } | null } | null;
}

function limitViewOf(plan: any): NonNullable<CustomerMissionView["limit"]> | null {
  const l = plan?.limit;
  if (!l || typeof l !== "object") return null;
  const reserve = Math.round(Number(l.reserve_points));
  if (!Number.isFinite(reserve) || reserve <= 0) return null;
  const sm = l.smaller && typeof l.smaller === "object" && Number(l.smaller.per_post) >= 1 ? { perPost: Math.floor(Number(l.smaller.per_post)), reservePoints: Math.round(Number(l.smaller.reserve_points)), maxChargePoints: Math.round(Number(l.smaller.max_charge_points)), rows: Math.round(Number(l.smaller.rows)) } : null;
  return { over: l.over === true, reservePoints: reserve, capPoints: Math.round(Number(l.cap_points)) || 0, sentenceAr: typeof l.sentence_ar === "string" ? l.sentence_ar : null, rowsAr: typeof l.rows_ar === "string" ? l.rows_ar : null, smaller: sm };
}

const PHASE_OF_STATUS: Record<string, CustomerPhase> = { queued: "waiting", planning: "planning", needs_input: "question", plan_ready: "plan", approved: "running", executing: "running", completed: "done", unserved: "unserved", failed: "failed", cancelled: "cancelled" };
export const isLivePhase = (p: CustomerPhase) => p === "waiting" || p === "planning" || p === "running";

export { minutesAr };

const REPLY_NOUN = knownItemNoun("رد")!;
/** The replies stage of a compiled plan in plain words: what the counters of the comments read already say, and the «حتى» part for the comments not read yet. */
export const repliesSplitAr = (counted: number, open: number): string => {
  const known = counted > 0 ? `${countAr(counted, REPLY_NOUN)} بحسب عدّادات التعليقات التي قرأناها` : "لم نعدّ ردودًا بعد";
  return open > 0 ? `${known}، وحتى ${countAr(open, REPLY_NOUN)} لتعليقات لم نقرأ عدّادها بعد` : known;
};
/** The fact line of the replies not counted yet: their rows and the price they add at most. */
export const openRepliesFactAr = (rows: number, points: number): string => `${countAr(rows, REPLY_NOUN)} · ${pointsAr(Math.round(points))}`;

/** Stages in plain words with the expected rows of each; the delivered ones add up to the total shown. */
export function stagesView(plan: any): { stages: CustomerStageView[]; total: number } {
  const stages: CustomerStageView[] = [];
  let total = 0;
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  list.forEach((s, i) => {
    const rows = Math.max(0, Math.floor(Number(s?.expected_rows) || 0));
    const deliver = s?.deliver !== false;
    // S9: replies with no promised number (all the replies of the chosen comments) are not in the total: the estimate is only the maximum the price was made from
    const openReplies = s?.replies_open === true;
    const open = openReplies || s?.children_open === true;
    // a compiled plan's replies: those the comments read at planning COUNT (their own counters) and join the total; the rest is a separate «حتى» part (live finding C)
    const split = openReplies && typeof s?.replies_counted === "number" ? { counted: Math.max(0, Math.floor(s.replies_counted)), open: Math.max(0, Math.floor(Number(s.replies_open_rows) || 0)) } : null;
    if (deliver && !open) total += rows;
    if (deliver && split) total += split.counted;
    const parentIndex = typeof s?.parent_key === "string" ? list.findIndex((x) => x?.key === s.parent_key) : -1;
    // a stage that only FEEDS the next one is a ceiling, never a promise: «حتى ١٠ فيديوهات» (how many of them end up with results in the file is counted from the item store at the end)
    // ROUND 58: a step that hangs on a step of the same noun («بيانات تواصل الشركات» under «شركات …») holds details of those items, never more of them: its rows are «عنصر» («١٢ عنصرًا», not «١٢ شركة»)
    const ownNoun = itemNounOf(String(s?.title_ar ?? ""));
    const parentStage = typeof s?.parent_key === "string" ? list.find((x) => x?.key === s.parent_key) : null;
    const rowsAr = countAr(rows, parentStage && ownNoun.key !== GENERIC_ITEM_NOUN.key && itemNounOf(String(parentStage?.title_ar ?? "")).key === ownNoun.key ? GENERIC_ITEM_NOUN : ownNoun);
    stages.push({ n: i + 1, parentN: parentIndex >= 0 ? parentIndex + 1 : null, titleAr: customerSafeText(s?.title_ar, "مرحلة"), rows: open ? 0 : rows, rowsAr: split ? repliesSplitAr(split.counted, split.open) : open ? (openReplies ? ALL_REPLIES_AR : ALL_COMMENTS_AR) : deliver ? rowsAr : `حتى ${rowsAr}`, deliver, noteAr: deliver ? null : "تُستخدم في المرحلة التالية ولا تُحتسب في ملفك", ...(typeof s?.yield_share === "number" ? { yieldShare: s.yield_share } : {}) });
  });
  return { stages, total };
}

/** ROUND 58: the card's «هتستلم» cell for a plan of companies with their details: the companies («٢٠ شركة»; the details and the priced total are said in `countLinesAr` and `priceExplainAr`). Null for any other plan (the cell keeps the total). */
function headlineCountArOf(plan: any): string | null {
  const entity = entityBreakdownOf(entityStagesOfPublic(plan));
  return entity ? countAr(entity.root.rows, entity.root.noun) : null;
}

export function samplesView(plan: any): CustomerMissionView["samples"] {
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  // the deepest delivered stage is what the customer gets: show its rows (else the first stage that has any)
  const delivered = list.filter((s) => s?.deliver !== false && Array.isArray(s?.sample_rows) && s.sample_rows.length > 0);
  const stage = delivered[delivered.length - 1] ?? list.find((s) => Array.isArray(s?.sample_rows) && s.sample_rows.length > 0);
  if (!stage) return null;
  const columns: Array<{ key: string; titleAr: string }> = (Array.isArray(stage.columns) ? stage.columns : []).map((c: any) => ({ key: String(c.key), titleAr: String(c.title_ar ?? c.titleAr ?? "") })).filter((c: { titleAr: string }) => c.titleAr).slice(0, 6);
  if (columns.length === 0) return null;
  // NOV 7 2026: a link is shown whole; a link stored cut by an older card (no `links_whole` mark) is said to be cut, never shown as if it worked (sampleLinks.ts)
  const linksWhole = stage.links_whole === true;
  const rows = (stage.sample_rows as Array<Record<string, unknown>>).slice(0, 3).map((r) => columns.map((c) => formatSampleCell(storedSampleCell(sampleCellText(String(r?.[c.key] ?? ""), 600), linksWhole))));
  return { stageTitleAr: customerSafeText(stage.title_ar, "مرحلة"), columns, rows };
}

/** What the file holds, from the columns of the deepest delivered stage (the sheet the customer opens): one line, in the order of the sheet. Null when the plan has no readable column. */
export function fileContentsAr(plan: any): string | null {
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  const delivered = list.filter((s) => s?.deliver !== false);
  const stage = delivered[delivered.length - 1];
  const titles: string[] = (Array.isArray(stage?.columns) ? stage.columns : []).map((c: any) => String(c.title_ar ?? c.titleAr ?? "").trim()).filter(Boolean);
  return titles.length > 0 ? `يضم الملف: ${titles.join("، ")}.` : null;
}

/** The one honest sentence of the plan card about what is charged: the price shown is the price of the FULL delivery; fewer items cost in proportion; nothing delivered costs nothing. */
export const PRICE_PROMISE_AR = "السعر المعروض هو سعر التسليم الكامل؛ لو سُلّم أقل يُخصم بنسبة ما سُلّم فقط، ولو لم يُسلَّم شيء لا يُخصم شيء.";

/** The label of the line that holds the replies not counted yet (rows and price). */
export const OPEN_REPLIES_LABEL_AR = "ردود لم تُعدّ بعد (حتى)";
/** A compiled plan's price split (plan.ts repliesSplitOf, stored in the public plan): what the counted items cost at most, and what the replies not counted yet add at most. Null: the price is one figure for everything, as it always was. */
function countedSplitOf(price: any): { countedMax: number; openRows: number; openMax: number } | null {
  const openRows = Number(price?.open_rows);
  const countedMax = Number(price?.counted_max_points);
  const openMax = Number(price?.open_max_points);
  return Number.isFinite(openRows) && openRows > 0 && Number.isFinite(countedMax) && Number.isFinite(openMax) ? { countedMax, openRows, openMax } : null;
}

/** price, hold and expected time on one clear line. */
export function priceLineAr(plan: any): string | null {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return null;
  const maxCharge = Math.round(Number(price.max_charge_points));
  const reserve = Math.round(Number(price.reserve_points));
  const minutes = Math.round(Number(plan?.expected_minutes) || 0);
  const split = countedSplitOf(price);
  const parts = [
    split ? `السعر حتى ${pointsAr(split.countedMax)} لما عددناه (سعر التسليم الكامل له) ويُخصم بنسبة ما يُسلَّم فعلًا` : `السعر حتى ${pointsAr(maxCharge)} (سعر التسليم الكامل) ويُخصم بنسبة ما يُسلَّم فعلًا`,
    ...(split ? [`${OPEN_REPLIES_LABEL_AR}: ${openRepliesFactAr(split.openRows, split.openMax)}`] : []),
    `حجز مؤقت ${pointsAr(reserve)} يُحرَّر ما لا يُستخدم منه`,
  ];
  if (minutes > 0) parts.push(`الوقت المتوقع ${minutesAr(minutes)}`);
  return parts.join(" · ");
}

/** The price, the hold and the expected time as short cells, and one sentence about what is charged (full delivery = the price shown, fewer = in proportion, nothing = nothing). Empty when the plan has no price. */
export function priceFactsOf(plan: any): { facts: Array<{ labelAr: string; valueAr: string }>; noteAr: string | null } {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return { facts: [], noteAr: null };
  const minutes = Math.round(Number(plan?.expected_minutes) || 0);
  const split = countedSplitOf(price);
  const listed = price.listed_rate;
  const reviewedRates = (providerMetadata.treg as { missionListedServices?: Record<string, { nounAr: string }> }).missionListedServices;
  const showListed = Number.isFinite(listed?.unit_points) && listed.unit_points > 0
    && Object.values(reviewedRates ?? {}).some(({ nounAr }) => nounAr === listed.noun_ar);
  const facts = [
    ...(showListed ? [{ labelAr: "سعر الوحدة قبل الحد الأدنى", valueAr: unitPriceLabelAr(listed.unit_points, listed.noun_ar) }] : []),
    { labelAr: "السعر حتى", valueAr: pointsAr(Math.round(split ? split.countedMax : Number(price.max_charge_points))) },
    ...(split ? [{ labelAr: OPEN_REPLIES_LABEL_AR, valueAr: openRepliesFactAr(split.openRows, split.openMax) }] : []),
    { labelAr: "حجز مؤقت", valueAr: pointsAr(Math.round(Number(price.reserve_points))) },
    ...(minutes > 0 ? [{ labelAr: "الوقت المتوقع", valueAr: minutesAr(minutes) }] : []),
  ];
  return { facts, noteAr: PRICE_PROMISE_AR };
}

/**
 * ROUND 57 (13 Nov): «٣٢ عنصرًا» read as 32 companies when the plan was 20 companies and 12 contact rows of companies, and the hold (374) next to the price (325) was never explained. Two sentences, from the plan's own numbers:
 * what the price counts, step by step (only when more than one step is delivered), and the hold as the price plus the safety margin (only when it is above the price). The pricing itself is unchanged.
 */
export function priceExplainOf(plan: any): string[] {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return [];
  const out: string[] = [];
  const stages = (Array.isArray(plan?.stages) ? plan.stages : []).filter((s: any) => s && s.deliver !== false && Number(s.expected_rows) > 0);
  if (stages.length >= 2) {
    const parts = stages.map((s: any) => `${formatAr(Math.round(Number(s.expected_rows)))} من «${String(s.title_ar ?? "").replace(/\s+/g, " ").trim()}»`);
    const total = stages.reduce((n: number, s: any) => n + Math.round(Number(s.expected_rows)), 0);
    // ROUND 58: the priced total of companies with their contacts is never read as that many companies
    const entity = entityBreakdownOf(entityStagesOfPublic(plan));
    out.push(`السعر محسوب على كل عنصر يُسلَّم من كل خطوة: ${parts.join(" و")}، ${entity ? pricedTotalAr(entity) : `والمجموع ${formatAr(total)}`}.`);
  }
  const estimate = Math.round(Number(price.max_charge_points));
  const reserve = Math.round(Number(price.reserve_points));
  if (!countedSplitOf(price) && Number.isFinite(reserve) && reserve > estimate) {
    out.push(price.execution_funding_applied === true
      ? `الحجز المؤقت ${pointsAr(reserve)} لتغطية جمع العدد المخطط. أقصى سعر للتسليم الكامل ${pointsAr(estimate)}، ويُحرَّر ما لا يُستخدم من الحجز.`
      : `الحجز المؤقت ${pointsAr(reserve)} = أقصى السعر ${pointsAr(estimate)} + هامش أمان ${pointsAr(reserve - estimate)}؛ وهو ليس خصمًا، ولا يُخصم أكثر من أقصى السعر، ويُحرَّر ما لا يُستخدم منه بعد التسليم.`);
  }
  return out;
}

/** The period of the plan in words, from its own enabled period filter (the one the card's promise rests on); null when no stage filters by period. */
/** ROUND 58: the card's lines about the COUNT (see `countLinesAr`). */
export function countLinesOf(plan: any): string[] {
  if (!plan) return [];
  const entity = entityBreakdownOf(entityStagesOfPublic(plan));
  const target = targetLineAr(plan);
  return [
    ...(target ? [target] : []),
    ...(entity ? [`ستستلم ${receiveLineAr(entity)}؛ وهذا عدد مستهدف وليس مضمونًا، وما لا يُنشر في المصدر يبقى فارغًا.`] : []),
  ];
}

export function periodOfPlan(plan: any): string | null {
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  for (const s of list) {
    for (const f of (Array.isArray(s?.filters) ? s.filters : []) as StageFilter[]) {
      if (f?.kind === "period" && isEnabled(f)) return filterLineAr({ ...f, enabled: true }).replace(/[.\s]+$/u, "");
    }
  }
  return null;
}

/** The queue line, only when the mission really waits behind another or the worker is busy or away; the position counts the missions ahead + 1. */
export function queueLine(status: string, queue: QueueInfo | null): { lineAr: string | null; position: number | null } {
  if (!queue || (status !== "queued" && status !== "approved")) return { lineAr: null, position: null };
  const position = queue.ahead + 1;
  if (!queue.workerAlive) return { lineAr: "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وستبدأ تلقائيًا عند عودة الخدمة للعمل.", position };
  if (queue.ahead === 0 && queue.running === 0) return { lineAr: null, position: 1 };
  // WHY IT WAITS, never a time (round 14): behind the customer's own running request (it may last over an hour), behind other customers' requests (counted), or both
  const ownRunning = Math.max(0, Math.floor(queue.runningOwn ?? 0));
  const others = Math.max(0, queue.ahead - Math.max(0, Math.floor(queue.aheadOwn ?? 0))) + Math.max(0, queue.running - ownRunning);
  const own = ownRunning + Math.max(0, Math.floor(queue.aheadOwn ?? 0));
  if (own > 0 && others === 0) return { lineAr: "طلبك ينتظر لأن لديك طلبًا جاريًا؛ سيبدأ تلقائيًا بعد انتهائه.", position };
  if (own > 0) return { lineAr: `طلبك ينتظر لأن لديك طلبًا جاريًا، وقبله ${toArabicDigits(others)} من طلبات العملاء الآخرين؛ سيبدأ تلقائيًا بعد انتهاء ما قبله.`, position };
  return { lineAr: `طلبك ينتظر دوره؛ قبله ${toArabicDigits(others)} من الطلبات الجارية أو المنتظرة، وسيبدأ تلقائيًا عند دوره.`, position };
}

/** The honest lines of a step that is slow. Planning holds NOTHING, and says so; a running mission says it charges only what it delivers. Never an ETA. */
export const SLOW_PLANNING_AR = "ما زلنا نجهّز خطتك، والأمر يأخذ وقتًا أطول قليلًا. لم يُحجز أي رصيد منك.";
export const STALLED_PLANNING_AR = "الخطوة الحالية تستغرق وقتًا أطول من المعتاد وما زلنا نعمل عليها. لم يُحجز أي رصيد منك حتى الآن.";
export const SLOW_RUNNING_AR = "الأمر يأخذ وقتًا أطول قليلًا وما زلنا نعمل. ولن يُخصم منك إلا ما يُسلَّم فعلًا.";
export const STALLED_RUNNING_AR = "الأمر يأخذ وقتًا أطول من المعتاد، وما زلنا نعمل عليه. ولن يُخصم منك إلا ما يُسلَّم فعلًا.";

/** Progress INSIDE the planning step «بنجرب عينة صغيرة للتأكد من الجودة»: the samples read so far, and out of how many when the agent has said how many stages it plans. */
function sampleProgress(events: EventForCustomer[], callsMade: number): { done: number; of: number | null } {
  let samples = 0;
  let stages = 0;
  for (const e of events) {
    if (typeof e.counts?.samples === "number") samples = Math.max(samples, Math.floor(e.counts.samples));
    if (typeof e.counts?.stages === "number" && e.counts.stages > 0) stages = Math.floor(e.counts.stages);
  }
  const done = Math.max(samples, callsMade);
  return { done, of: stages > 0 ? stages : null };
}

const stageIndexOf = (e: EventForCustomer): number => Math.max(0, Math.floor(Number(e.counts?.stage) || 0));

/**
 * ROUND 26 (item 3): a plan is a plan only when it has stages. A question keeps its options in the same column ({question_options}), which is NOT a plan: counting it as one checked
 * the planning steps after the first one while «فهمنا طلبك» was still open (live msn_ef86659ab11d50f4dfee after the customer's answer).
 */
export const hasPlanStages = (plan: any): boolean => Array.isArray(plan?.stages) && plan.stages.length > 0;

/**
 * ROUND 26 (item 3): a step is CHECKED only when it is done and every step before it is done. The first step that is not done is the current one: working while the mission works,
 * waiting before that. A stopped step stays stopped. Later steps that were done are shown as waiting until the steps before them are checked.
 */
export function inOrder(steps: PanelStep[], working: boolean): PanelStep[] {
  let openSeen = false;
  return steps.map((s) => {
    if (!openSeen) {
      if (s.state === "done") return s;
      openSeen = true;
      if (s.state === "stopped") return s;
      return { ...s, state: working ? "running" : "waiting" } as PanelStep;
    }
    if (s.state === "done" || s.state === "running") return { ...s, state: "waiting" } as PanelStep;
    return s;
  });
}

/** Steps of the live panel. Before the plan: the four planning steps; after approval: the plan's stages and the files. */
function stepsOf(input: { phase: CustomerPhase; status: string; stages: CustomerStageView[]; events: EventForCustomer[]; callsMade: number; hasPlan: boolean; delivered: number | null; filesReady: boolean; now: number }): { steps: PanelStep[]; samples: ProgressSample[]; savedTotal: number; plannedTotal: number; track: ReturnType<typeof trackMission> } {
  const { phase, status, stages, events, callsMade, hasPlan } = input;
  const executing = status === "approved" || status === "executing" || status === "completed" || (status === "failed" && hasPlan && events.some((e) => stageIndexOf(e) > 0));
  const finishedRun = status === "completed";
  // the live numbers of every stage, from the mission's own events: they only grow (one rule for every mission type)
  // the end of a finished mission: the items of each stage IN THE FILE (the result event's own counts, written by code from the delivered file); an older mission that has none says its delivered count for its one delivered stage
  const resultCounts = [...events].reverse().find((e) => e.kind === "result" && e.counts)?.counts ?? null;
  const deliveredStages = stages.filter((s) => s.deliver);
  const finalSaved = finishedRun ? stages.map((s) => (typeof resultCounts?.[`stage_${s.n}_rows`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_rows`]) : deliveredStages.length === 1 && s.deliver && typeof input.delivered === "number" ? input.delivered : undefined)) : undefined;
  const track = trackMission({ stages: stages.map((s) => ({ n: s.n, titleAr: s.titleAr, expectedRows: s.rows, deliver: s.deliver, yieldShare: s.yieldShare })), events, finished: finishedRun, finalSaved, now: input.now });
  const savedPerStage = new Map<number, number>(track.stages.map((s) => [s.n, s.saved]));
  const samples: ProgressSample[] = [];
  const savedTotalNow = track.stages.reduce((n, s) => n + s.saved, 0);
  const plannedTotal = stages.reduce((n, s) => n + s.rows, 0);
  if (!executing) {
    const planned = hasPlan;
    const planning = phase === "planning" || phase === "waiting";
    const steps: PanelStep[] = PLANNING_STEP_TITLES.map((titleAr, i) => ({ id: `plan-${i + 1}`, titleAr, state: "waiting" as PanelStep["state"] }));
    steps[0].state = phase === "waiting" ? "waiting" : "done";
    if (phase === "planning" && !events.some((e) => e.kind === "progress") && callsMade === 0) steps[0].state = "running";
    steps[1].state = planned || callsMade > 0 ? "done" : phase === "planning" && steps[0].state === "done" ? "running" : "waiting";
    steps[2].state = planned ? "done" : callsMade > 0 ? "running" : "waiting";
    steps[3].state = planned ? "done" : planning && callsMade > 0 ? "waiting" : "waiting";
    // clear progress inside the current step: «عينة ١ من ٢» when the number of stages is known, else how many samples were tried
    const progress = sampleProgress(events, callsMade);
    if (!planned && progress.done > 0 && steps[2].state === "running") {
      if (progress.of !== null) { const n = Math.min(progress.done, progress.of); steps[2].countAr = `عينة ${formatAr(n)} من ${formatAr(progress.of)}`; steps[2].ratio = Math.min(1, n / progress.of); }
      // ROUND 26 (item 6): no «جرّبنا N عينات» line in the steps panel (a count there was the second counter); the samples stay in the data
    }
    if (phase === "question") { for (const s of steps) if (s.state === "waiting" || s.state === "running") s.state = "waiting"; }
    if (phase === "unserved" || phase === "failed" || phase === "cancelled") {
      // P0 (15 Nov 2026): a request that ENDED WITHOUT A PLAN never shows «لقينا المصادر» or the sample as done: a source that can serve the request was identified, but nothing usable was found (msn_84d0f3738c87d5ed3aee showed it done after two empty reads)
      if (!planned) for (const s of steps.slice(1)) if (s.state === "done") s.state = "stopped";
      for (const s of steps) if (s.state === "running" || s.state === "waiting") s.state = "stopped";
    }
    return { steps: inOrder(steps, phase === "planning"), samples, savedTotal: savedTotalNow, plannedTotal, track };
  }
  const finished = status === "completed";
  const firstOpen = stages.findIndex((s) => (savedPerStage.get(s.n) ?? 0) < s.rows);
  const steps: PanelStep[] = stages.map((s, i) => {
    const t = track.stages[i];
    const saved = Math.min(t.saved, s.rows);
    const done = finished || (saved >= s.rows && s.rows > 0) || (firstOpen !== -1 && i < firstOpen && saved > 0);
    const running = !done && !finished && (status === "executing" || status === "approved") && i === (firstOpen === -1 ? 0 : firstOpen);
    const step: PanelStep = { id: `stage-${s.n}`, titleAr: s.titleAr, state: done ? "done" : running && status === "executing" ? "running" : "waiting" };
    if (saved > 0 || running || t.found > 0) {
      // what is in the file, with the noun of the stage; the bar follows the whole work of the stage (reading, checking, saving), so it moves while items are found and checked
      step.countAr = deliveredOfAr(saved, s.rows, t.noun);
      step.savedN = saved;
      step.plannedN = s.rows;
      step.ratio = done ? 1 : t.ratio;
      const lines = done && finished ? [] : stageMetricLines(t);
      if (lines.length > 0) step.metricsAr = lines;
      if (t.excluded > 0) step.excludedAr = `استُبعد ${formatAr(t.excluded)} لأنه لا يخص طلبك`;
    }
    if (!s.deliver) step.detailAr = "تُستخدم في المرحلة التالية";
    // THE TRUTH ABOUT A PARENT STAGE, from the item store: how many parents were read and, at the end, how many of them have items in the file (never «١٠ من ١٠» when only some parents gave results)
    if (stages.some((c) => c.parentN === s.n) && (saved > 0 || t.found > 0)) {
      const read = typeof resultCounts?.[`stage_${s.n}_read`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_read`]) : saved;
      const used = typeof resultCounts?.[`stage_${s.n}_used`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_used`]) : null;
      step.countAr = parentCountAr({ read, max: s.rows, used, noun: t.noun, finished });
    }
    return step;
  });
  const failedStop = status === "failed";
  if (failedStop) for (const s of steps) if (s.state === "running" || s.state === "waiting") { s.state = "stopped"; }
  steps.push({ id: "files", titleAr: FILES_STEP_TITLE_AR, state: input.filesReady ? "done" : finished ? "done" : failedStop ? "stopped" : "waiting" });
  return { steps: inOrder(steps, status === "executing" || status === "approved"), samples, savedTotal: savedTotalNow, plannedTotal, track };
}

/** What a parent stage says about itself: while it works, how many were read of the most it may read; at the end, how many were read and how many of them have items in the file. */
export function parentCountAr(input: { read: number; max: number; used: number | null; noun: Parameters<typeof countAr>[1]; finished: boolean }): string {
  if (!input.finished || input.used === null) return `قُرئ ${countAr(input.read, input.noun)}، والحد الأقصى ${formatAr(input.max)}`;
  return `قُرئ ${countAr(input.read, input.noun)}، ومنها ${formatAr(input.used)} لها نتائج في ملفك`;
}

/**
 * THE FILES A CUSTOMER IS OFFERED (round 32): the Excel, and, for a mission that has its Excel, the CSV of its data and the CSV of its methodology. The CSV is built from the customer's own Excel when it is asked for (customerCsvFile): one stage is a CSV, more
 * than one is an archive with a CSV per stage and the methodology. The stored CSV copy of the worker (the deepest stage only) is never what a customer is offered.
 */
const FILE_LABEL_AR: Record<string, string> = { xlsx: "تنزيل ملف إكسل" };

/**
 * «تقدر تقفل الصفحة» is said ONLY when closing the page is really safe: the mission is approved (its work is in the worker's hands on the server, not in this browser) AND the worker is alive right now (a fresh heartbeat).
 * The e-mail is promised only when one will really be sent (a real address, the customer's «done» e-mails on). With no proof (no queue reading, a dead worker) the line is not shown and the panel's honest delay line speaks.
 */
export function customerFilesOf(files: ReadonlyArray<{ name: string; kind: string }>): Array<{ name: string; kind: string; labelAr: string }> {
  const excel = files.filter((f) => FILE_LABEL_AR[f.kind]).map((f) => ({ name: f.name, kind: f.kind, labelAr: FILE_LABEL_AR[f.kind] }));
  if (excel.length > 0) return [...excel, { name: "result.csv", kind: "csv", labelAr: CSV_LABEL_AR }, { name: "methodology.csv", kind: "methodology", labelAr: CSV_METHODOLOGY_LABEL_AR }];
  return files.some((f) => f.kind === "csv") ? [{ name: "result.xlsx", kind: "xlsx", labelAr: FILE_LABEL_AR.xlsx }] : [];
}

/**
 * ROUND 26 (item 6): the one sentence of the running card. «نجمع التغريدات (٣ من ١٠)» while the items collect; «جمعنا التغريدات، ونجهّز ملفك الآن» once the planned count is in the file.
 * Only for an approved or executing mission with a planned count; null for every other state (no «بدأنا جمع» after the collection ended, and no time in this line).
 */
export function collectLineOf(status: string, saved: number, planned: number, noun: { plural: string }): string | null {
  if ((status !== "approved" && status !== "executing") || planned <= 0) return null;
  const what = `ال${noun.plural}`;
  if (saved >= planned) return `جمعنا ${what}، ونجهّز ملفك الآن`;
  return `نجمع ${what} (${formatAr(Math.max(0, saved))} من ${formatAr(planned)})`;
}

export function closePageLine(status: string, queue: QueueInfo | null | undefined, emailWillBeSent: boolean | undefined): string | null {
  if (status !== "approved" && status !== "executing") return null;
  if (!queue || !queue.workerAlive) return null;
  return emailWillBeSent === false ? AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR : AGENT_CLOSE_PAGE_LINE_AR;
}

/**
 * «المطلوب»: what the customer asked for in all. The planned rows of the delivered stages, plus what a lower target (proposed with a reason) left out of the request.
 * One definition, read by the customer's card (customerMissionView) and the admin overview (adminOverview.ts).
 */
export function requestedRowsOf(planPublic: unknown): number {
  const plan: any = planPublic && typeof planPublic === "object" ? planPublic : null;
  const planned = stagesView(plan).stages.filter((s) => s.deliver).reduce((n, s) => n + s.rows, 0);
  const quantity = plan?.quantity && typeof plan.quantity === "object" ? plan.quantity : null;
  return planned + (quantity ? Math.max(0, Math.floor(Number(quantity.requested) || 0) - Math.floor(Number(quantity.target) || 0)) : 0);
}

export function customerMissionView(input: { mission: MissionRowForCustomer; /** The customer's own request: a Latin word they wrote is theirs to see (DT-20261118-09 S1); absent: no Latin word is allowed in a line the model wrote. */ requestText?: string; events: EventForCustomer[]; queue?: QueueInfo | null; callsMade?: number; now?: number; /** Will the completion e-mail really be sent (real address, e-mails on)? Unknown: it is promised (the old default). */ emailWillBeSent?: boolean; /** STAGE 3 S5: the new queue line, with the stored approval time (null: not measured). Absent: today's line. */ stage3Queue?: { approvedAtMs: number | null } }): CustomerMissionView {
  const { mission } = input;
  const now = input.now ?? Date.now();
  // the run's measured memory is for the admin: the customer never sees it
  const events = input.events.filter((e) => !isInternalEvent(e)).sort((a, b) => a.id - b.id);
  const basePhase = PHASE_OF_STATUS[mission.status] ?? "waiting";
  const plan = mission.plan_public && typeof mission.plan_public === "object" ? mission.plan_public : null;
  const { stages, total } = stagesView(plan);
  const planned = stages.filter((s) => s.deliver).reduce((n, s) => n + s.rows, 0);
  // the request: the target the plan was approved at, plus what a lower target (proposed with a reason) left out of it
  const requestedRows = requestedRowsOf(plan);
  const delivered = mission.delivered_units;
  const phase: CustomerPhase = basePhase === "done" && delivered !== null && requestedRows > 0 && delivered < requestedRows ? "partial" : basePhase;
  // STAGE 3 S5: with `stage3Queue` (DIGER_STAGE3_QUEUE on, passed by the loader) the queue line is the new one; without it, exactly today's
  const q = input.stage3Queue ? queueLineV2(mission.status, input.queue ?? null, input.stage3Queue.approvedAtMs, now) : queueLine(mission.status, input.queue ?? null);
  const filesReady = Array.isArray(mission.files) && mission.files.length > 0;
  const { steps, track } = stepsOf({ phase, status: mission.status, stages, events, callsMade: input.callsMade ?? 0, hasPlan: hasPlanStages(plan), delivered, filesReady, now });

  // the items of the DELIVERED stages that have reached the file so far (the one number the progress line and the bar show)
  const savedSoFar = track.stages.reduce((n, t, i) => n + (stages[i]?.deliver ? Math.min(t.saved, stages[i].rows) : 0), 0);
  const lastEvent = events[events.length - 1];
  const lastAt = lastEvent ? Date.parse(lastEvent.created_at) : NaN;
  const progressLine = [...events].reverse().find((e) => e.kind === "progress" || e.kind === "system")?.message_ar ?? null;
  const running = steps.find((s) => s.state === "running");
  let delayAr: string | null = null;
  // how long since anything moved: the last event, or the creation of the mission when there is none yet
  const quietSince = Number.isFinite(lastAt) ? lastAt : Date.parse(mission.created_at);
  if ((mission.status === "executing" || mission.status === "planning") && Number.isFinite(quietSince)) {
    const quietMs = now - quietSince;
    const planningNow = mission.status === "planning";
    if (quietMs > AGENT_STALL_AFTER_MS) delayAr = planningNow ? STALLED_PLANNING_AR : STALLED_RUNNING_AR;
    else if (quietMs > AGENT_SLOW_AFTER_MS) delayAr = planningNow ? SLOW_PLANNING_AR : SLOW_RUNNING_AR;
  }
  if (input.queue && !input.queue.workerAlive && (mission.status === "queued" || mission.status === "approved" || mission.status === "executing" || mission.status === "planning")) delayAr = "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وتكمل أول ما تعود للعمل.";

  // the time left: by code, from the measured speed, smoothed, and only when the estimates agree (never a number that jumps)
  const remainingAr: string | null = mission.status === "executing" ? remainingLineAr(track.remainingSeconds, track.ratio) : null;
  // ROUND 26 (item 6): the panel's current line names the step only; the one counter is the top box's sentence
  const currentLineAr = q.lineAr ?? (running ? running.titleAr : progressLine ?? steps.find((s) => s.state === "waiting")?.titleAr ?? "");

  // THE RESULT, in the words of the wallet: what was delivered of what was requested (with the noun of the request), then the hold, the charge and the released hold, each with the same number the wallet shows
  const resultLinesAr: string[] = [];
  const fileRowsAr = delivered !== null && delivered > 0 && (phase === "done" || phase === "partial") ? countAr(delivered, itemNounOfPlan(plan)) : null;
  if (delivered !== null && (phase === "done" || phase === "partial" || phase === "failed" || phase === "unserved")) {
    const noun = itemNounOfPlan(plan);
    // a delivery short of the CARD is told against the card's total (what the customer approved); one that fills a card with a lowered target, against the request
    if (requestedRows > 0 && delivered > 0) {
      if (typeof mission.charged_units === "number" && Number.isFinite(mission.charged_units) && delivered > mission.charged_units) {
        resultLinesAr.push(deliveredChargedLineAr({ delivered, charged: mission.charged_units }));
      } else {
        resultLinesAr.push(`تم تسليم ${deliveredOfAr(delivered, deliveryDenominatorOf(delivered, planned, requestedRows), noun)}.`);
      }
    } else if (requestedRows > 0) {
      resultLinesAr.push("لم يُسلَّم أي شيء.");
    }
    if (mission.charged_points !== null && Number(mission.reserved_points ?? 0) > 0) resultLinesAr.push(`${moneyLineAr({ reservedPoints: Number(mission.reserved_points), chargedPoints: Number(mission.charged_points), delivered, noun, ...(isFreeRerunEvents(input.events) ? { free: true } : {}) })}.`);
  }

  const rawSummary = mission.summary_ar ? fixFileWordingAr(mission.summary_ar, plan?.stages) : null;
  const summaryCheck = rawSummary ? checkCustomerText(rawSummary, { maxChars: 600 }) : null;
  const summaryMatchesCardNumbers = (text: string): boolean => {
    const nums = (normalizeDigits(text).replace(/(?<=\d)[,٬](?=\d)/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (nums.length === 0) return true;
    const allowed = new Set<number>();
    const realDelivered = delivered !== null && Number.isFinite(delivered) ? Math.round(delivered) : null;
    if (realDelivered !== null) allowed.add(realDelivered);
    if (typeof mission.charged_units === "number" && Number.isFinite(mission.charged_units)) allowed.add(Math.round(mission.charged_units));
    const realCharged = mission.charged_points !== null && Number.isFinite(Number(mission.charged_points)) ? Math.round(Number(mission.charged_points)) : null;
    if (realCharged !== null) allowed.add(realCharged);
    const realReserved = mission.reserved_points !== null && Number(mission.reserved_points) > 0 && Number.isFinite(Number(mission.reserved_points)) ? Math.round(Number(mission.reserved_points)) : null;
    if (realReserved !== null) allowed.add(realReserved);
    if (realReserved !== null && realCharged !== null && realReserved > realCharged) allowed.add(realReserved - realCharged);
    const denom = requestedRows > 0 && delivered !== null && delivered > 0 ? deliveryDenominatorOf(delivered, planned, requestedRows) : requestedRows > 0 ? requestedRows : null;
    if (denom !== null && Number.isFinite(denom) && (phase !== "partial" || (realDelivered !== null && nums.includes(realDelivered)))) {
      allowed.add(Math.round(denom));
    }
    return nums.every((n) => Number.isFinite(n) && allowed.has(n));
  };
  const storedSummary = rawSummary && summaryCheck
    ? (/[0-9٠-٩]/.test(rawSummary)
        ? (summaryCheck.issues.length === 0 && summaryMatchesCardNumbers(rawSummary) ? summaryCheck.text : null)
        : (summaryCheck.issues.some((i) => !i.includes("no Latin words")) ? null : rawSummary))
    : null;

  const expired = phase === "cancelled" && isExpiredMission(mission);

  let partialReasonAr: string | null = null;
  let partialRefundAr: string | null = null;
  if (phase === "partial") {
    let reasonText = storedSummary;
    if (!reasonText) {
      const lastResult = [...input.events].reverse().find((e) => e.kind === "result" && e.message_ar);
      if (lastResult?.message_ar) {
        const c = checkCustomerText(lastResult.message_ar);
        if (c.issues.length === 0) reasonText = c.text;
      }
    }
    if (reasonText) {
      partialReasonAr = reasonText.startsWith("اكتمل الجمع بعدد أقل من المطلوب")
        ? reasonText
        : `اكتمل الجمع بعدد أقل من المطلوب: ${reasonText.replace(/[.。\s]+$/u, "")}.`;
    }
    const hasKnownHoldAndCharge =
      typeof mission.reserved_points === "number" && Number.isFinite(mission.reserved_points) &&
      typeof mission.charged_points === "number" && Number.isFinite(mission.charged_points);
    const refundPoints = hasKnownHoldAndCharge
      ? Math.round(Number(mission.reserved_points)) - Math.round(Number(mission.charged_points))
      : null;
    partialRefundAr =
      hasKnownHoldAndCharge && Number(mission.reserved_points) > 0 && refundPoints !== null && refundPoints > 0
        ? `رجع لمحفظتك ${pointsAr(refundPoints)}.`
        : null;
  }

  const endLineAr = endLineOf(phase, resultLinesAr, storedSummary, expired);
  const view: CustomerMissionView = {
    id: mission.id, phase, summaryAr: plan?.summary_ar ? String(plan.summary_ar) : null, notesAr: Array.isArray(plan?.notes_ar) ? dedupeNearIdentical(plan.notes_ar.map(String)) : [], requestPartsAr: Array.isArray(plan?.request_parts_ar) ? plan.request_parts_ar.map(String).filter(Boolean).slice(0, 5) : [], assumptionsAr: Array.isArray(plan?.assumptions_ar) ? dedupeNearIdentical(plan.assumptions_ar.map(String)) : [], unservedAr: Array.isArray(plan?.unserved_ar) ? dedupeNearIdentical(plan.unserved_ar.map(String)) : [],
    questionOptionsAr: phase === "question" && Array.isArray((mission.plan_public as any)?.question_options) ? (mission.plan_public as any).question_options.map(String).slice(0, 6) : [], stages, totalRows: total, totalRowsAr: countAr(total, itemNounOfPlan(plan)), headlineCountAr: headlineCountArOf(plan), countLinesAr: countLinesOf(plan),
    samples: plan ? samplesView(plan) : null, fileContentsAr: plan ? fileContentsAr(plan) : null, priceLineAr: plan ? priceLineAr(plan) : null, priceFacts: plan ? priceFactsOf(plan).facts : [], priceNoteAr: plan ? priceFactsOf(plan).noteAr : null, priceExplainAr: plan ? priceExplainOf(plan) : [], questionAr: phase === "question" ? mission.question_ar : null,
    queueLineAr: q.lineAr, queuePosition: q.position, steps, currentLineAr, delayAr, remainingAr,
    closePageAr: closePageLine(mission.status, input.queue, input.emailWillBeSent),
    resultLinesAr, fileRowsAr, resultSummaryAr: phase === "done" || phase === "partial" || phase === "unserved" || phase === "failed" ? storedSummary : null,
    // a mission whose delivery holds only a CSV (older) is offered ONE Excel: the download builds it from that CSV
    files: filesReady ? customerFilesOf(mission.files!) : [],
    requestedRows, endLineAr, edit: phase === "plan" && plan?.edit && typeof plan.edit === "object" ? (plan.edit as PlanEditorView) : null,
    startedAt: (events.length ? Date.parse(events[0].created_at) : Date.parse(mission.created_at)) || null,
    live: isLivePhase(phase),
    periodAr: periodOfPlan(plan),
    expectedAr: Number(plan?.expected_minutes) > 0 ? minutesAr(Math.round(Number(plan.expected_minutes))) : null,
    progressLineAr: mission.status === "approved" || mission.status === "executing" ? deliveredOfAr(Math.min(savedSoFar, planned), planned, itemNounOfPlan(plan)) : null,
    collectLineAr: collectLineOf(mission.status, Math.min(savedSoFar, planned), planned, itemNounOfPlan(plan)),
    lastEventAt: Number.isFinite(lastAt) ? lastAt : null,
    savedSoFar,
    ...(expired ? { expired: true, expiredNoteAr: EXPIRED_PLAN_NOTE_AR } : {}),
    partialReasonAr: partialReasonAr ?? null,
    partialRefundAr: partialRefundAr ?? null,
  };
  // the limit is a key of the view ONLY when the plan carries one (a Facebook, Instagram or YouTube compiled plan): every other view is byte for byte what it was
  const limit = phase === "plan" ? limitViewOf(plan) : null;
  if (limit) view.limit = limit;
  return guardViewText(view, input.requestText ?? "");
}

/**
 * Every customer text of a view, passed through the render-time guard: whatever a stored field holds (an older mission's title or summary, an event the model wrote, a release reason), the customer never reads an English or an internal
 * phrase, in any state of the mission. Data cells (the samples) and file names are the customer's data, not messages, and are left as they are.
 */
/** The headline when the model's own summary may not be shown (a Latin word the customer did not write): never an empty headline. */
/** The header of a column whose own title may not be shown: a neutral Arabic label numbered by its place (never the column's internal key; FIX2). */
export const columnLabelAr = (index: number): string => `عمود ${toArabicDigits(index + 1)}`;
/** What a filter of the plan editor says when its own wording may not be shown (a Latin word the customer did not write; FIX2). */
const FILTER_FALLBACK_AR = "تصفية محددة في طلبك.";
export const NEUTRAL_HEADLINE_AR = "نجهّز لك البيانات التي طلبتها كما وصفتها.";

export function guardViewText(v: CustomerMissionView, requestText = ""): CustomerMissionView {
  // ONE CHOKE POINT (DT-20261118-09 FIX1, QA FAIL on #578: a field routed around the S1/S2 rules leaked): every string of the view goes through `m`, and the view is rebuilt below field by field, so a field that is
  // not routed is a field the test «every string of the view is clean» finds (tests/dt09-fix1-card.test.ts). A text with no Latin word and no source label of the code's own table is exactly what customerSafeText returns.
  // 1. an internal phrase becomes its Arabic meaning (customerSafeText); 2. a source label of the code's own table the customer did not write becomes «المصدر»; 3. a Latin word the customer did not write removes the line
  // (a word the customer wrote is theirs to see). The data cells of the samples and the file names are the customer's data, not messages, and are left as they are.
  const written = writtenLatinWords([requestText]);
  const m = (s: string): string => {
    const t0 = String(s ?? "").trim();
    if (!t0) return "";
    const t = withoutUnwrittenLabels(t0, [requestText]);
    if (latinWordsOf(t).length === 0) return customerSafeText(t);
    if (foreignLatinIn(t, written).length > 0) return /[؀-ۿ]/.test(t) ? "" : customerSafeText(t, "");
    return /[A-Za-z0-9]+_[A-Za-z0-9_]+/.test(t) ? customerSafeText(t) : toArabicDigits(t);
  };
  const nm = (s: string | null | undefined): string | null => (s === null || s === undefined ? null : m(s) || null);
  const colTitle = (s: string | null | undefined, i: number): string => {
    const out = m(String(s ?? ""));
    return !out || out === NEUTRAL_CUSTOMER_TEXT_AR ? columnLabelAr(i) : out;
  };
  const list = (a: ReadonlyArray<string> | undefined): string[] => (a ?? []).map(m).filter((x) => x !== "" && x !== NEUTRAL_CUSTOMER_TEXT_AR);
  // an answer the customer taps that is only the neutral source word says nothing
  const answers = (a: ReadonlyArray<string> | undefined): string[] => list(a).filter((x) => x !== SOURCE_LABEL_FALLBACK_AR);
  return {
    ...v,
    summaryAr: v.summaryAr !== null && v.summaryAr.trim() !== "" ? m(v.summaryAr) || NEUTRAL_HEADLINE_AR : nm(v.summaryAr), notesAr: list(v.notesAr), requestPartsAr: list(v.requestPartsAr), assumptionsAr: list(v.assumptionsAr), unservedAr: list(v.unservedAr), questionOptionsAr: answers(v.questionOptionsAr),
    stages: v.stages.map((s) => ({ ...s, titleAr: m(s.titleAr) || "مرحلة", noteAr: nm(s.noteAr) })),
    samples: v.samples ? { ...v.samples, stageTitleAr: m(v.samples.stageTitleAr) || "مرحلة", columns: v.samples.columns.map((c, i) => ({ ...c, titleAr: colTitle(c.titleAr, i) })) } : null,
    fileContentsAr: nm(v.fileContentsAr), priceLineAr: nm(v.priceLineAr), priceFacts: (v.priceFacts ?? []).map((f) => ({ labelAr: m(f.labelAr), valueAr: m(f.valueAr) })), priceNoteAr: nm(v.priceNoteAr), priceExplainAr: list(v.priceExplainAr), countLinesAr: list(v.countLinesAr), headlineCountAr: nm(v.headlineCountAr ?? null),
    totalRowsAr: m(v.totalRowsAr), ...(v.fileRowsAr !== undefined ? { fileRowsAr: nm(v.fileRowsAr) } : {}), periodAr: nm(v.periodAr), expectedAr: nm(v.expectedAr), progressLineAr: nm(v.progressLineAr), collectLineAr: nm(v.collectLineAr),
    questionAr: nm(v.questionAr), queueLineAr: nm(v.queueLineAr),
    steps: v.steps.map((s) => ({ ...s, titleAr: m(s.titleAr) || "خطوة", ...(typeof s.countAr === "string" ? { countAr: m(s.countAr) } : {}) })),
    currentLineAr: m(v.currentLineAr), delayAr: nm(v.delayAr), remainingAr: nm(v.remainingAr), closePageAr: nm(v.closePageAr),
    resultLinesAr: list(v.resultLinesAr), resultSummaryAr: nm(v.resultSummaryAr), endLineAr: nm(v.endLineAr),
    ...(v.expired ? { expired: true, expiredNoteAr: nm(v.expiredNoteAr) } : {}),
    partialReasonAr: v.partialReasonAr ? nm(v.partialReasonAr) : null,
    partialRefundAr: v.partialRefundAr ? nm(v.partialRefundAr) : null,
    ...(v.limit ? { limit: { ...v.limit, sentenceAr: nm(v.limit.sentenceAr), rowsAr: nm(v.limit.rowsAr) } } : {}),
    // the plan editor: titles, labels and the filter lines all go through m (a filter line is built from what the customer gave, so a word they wrote stays; any other Latin word or source label does not)
    edit: v.edit ? { ...v.edit, stages: v.edit.stages.map((s) => ({
      ...s, title_ar: m(s.title_ar) || "مرحلة", ...(s.per_parent_label_ar !== undefined ? { per_parent_label_ar: m(s.per_parent_label_ar) } : {}), ...(s.pages_label_ar !== undefined ? { pages_label_ar: m(s.pages_label_ar) } : {}),
      ...(s.replies ? { replies: { ...s.replies, label_ar: m(s.replies.label_ar) } } : {}),
      columns: s.columns.map((c, i) => ({ ...c, title_ar: colTitle(c.title_ar, i) })),
      filters: s.filters.map((f) => ({ ...f, label_ar: m(f.label_ar) || FILTER_FALLBACK_AR, line_ar: m(f.line_ar) || FILTER_FALLBACK_AR })),
    })) } : null,
  };
}

export const EXPIRED_PLAN_END_AR = "انتهت مهلة اعتماد الخطة (٧٢ ساعة) دون تأكيد، ولم يُخصم أي رصيد من محفظتك.";
export const EXPIRED_PLAN_NOTE_AR = "يمكنك إعادة تجهيز الخطة وتحديث الأسعار بنقرة واحدة.";

/** THE HONEST END SENTENCE of a mission that ended, said once on the card (and read aloud as a status): what happened, in the customer's words; null while the mission is open. */
function endLineOf(phase: CustomerPhase, resultLinesAr: string[], summary: string | null, expired = false): string | null {
  switch (phase) {
    case "done": return resultLinesAr[0] ?? "اكتملت مهمتك.";
    case "partial": return resultLinesAr[0] ?? "تم تسليم مهمتك بعدد أقل من المطلوب.";
    case "unserved": return summary ?? "لم نتمكن من تجهيز طلبك، ولم يُخصم منك شيء.";
    case "failed": return summary ?? "تعذّر استكمال مهمتك ولم يُخصم منك شيء.";
    case "cancelled": return expired ? EXPIRED_PLAN_END_AR : "أُلغيت هذه المهمة ولم يُخصم شيء.";
    default: return null;
  }
}
