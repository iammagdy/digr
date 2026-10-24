import { toArabicDigits } from "./arabicDigits";
import { DISCOVER_VIDEOS_PER_CHANNEL, SOCIAL_MAX_CALLS_PER_CHUNK, getSocialCapability, socialRowsPerChunk } from "./socialSources";
import { closePageLineAr, type DriverMode } from "./driverMode";
import { isCompanyDirectoryJob } from "./server/directoryCapability";
import { isSmallJob, maxPagesForJob, smallJobPageSize } from "./server/providerCallCaps";

/**
 * How long a mission will take, BEFORE the customer approves it: computed by code from the numbers of the real worker (records per
 * provider call, calls per chunk, the chunk's own time limit, the driver's cadence, retries and the final file assembly), with the
 * measured seconds per chunk of finished jobs when there are enough of them and conservative defaults when there are not.
 *
 * Two values come out: an optimistic and a pessimistic one, with the stage breakdown. The language model never sees or decides any
 * of this: it only phrases a sentence from a duration and a few counts; no price, no points, no money value enters this module (a
 * test reads the source to prove it imports no pricing code). Every duration shown to a customer is approximate and labelled «تقديري».
 */

/** The worker stops a chunk 45 s after it starts (`deadlineMs` in the chunk route); work per chunk fits in this budget. */
export const CHUNK_BUDGET_SECONDS = 40;
/** A family needs at least this many measured chunks before its measured time replaces the default. */
export const MIN_MEASURED_CHUNKS = 5;
/** Without measurements the pessimistic end is widened by this factor: the range must not look surer than the data. */
export const UNMEASURED_WIDENING = 1.5;

export interface Range { optimistic: number; pessimistic: number }

/** Conservative defaults, from the first production jobs (8 to 13 s per small chunk) widened for big volumes. Replaced by measurements. */
export const DEFAULT_TIMINGS = {
  /** One provider call. */
  callSeconds: { optimistic: 1.5, pessimistic: 6 } as Range,
  /** Claim, save the page, complete the chunk, write the events. */
  chunkOverheadSeconds: { optimistic: 2, pessimistic: 6 } as Range,
  /** Time between one chunk ending and the next one starting, by who drives the next chunk. */
  gapSeconds: { tab: { optimistic: 2, pessimistic: 20 }, cron: { optimistic: 2, pessimistic: 65 } } as Record<DriverMode, Range>,
  /** A share of chunks hit a provider slow-down or a 429 and wait before retrying. */
  retryFraction: { optimistic: 0, pessimistic: 0.1 } as Range,
  retrySeconds: { optimistic: 0, pessimistic: 90 } as Range,
  /** Every chunk re-reads the files of all earlier chunks to drop duplicates (the current worker): per earlier file. */
  priorFileReadSeconds: { optimistic: 0.05, pessimistic: 0.25 } as Range,
  /** Building the final files from all chunks. */
  assemblyBaseSeconds: { optimistic: 5, pessimistic: 20 } as Range,
  assemblyPerRecordSeconds: { optimistic: 0.0004, pessimistic: 0.002 } as Range,
};

/** What kind of work a step is, for the measured timings and the per-chunk shape. */
export type TimingFamily = "social_comments" | "social_posts" | "social_videos" | "companies" | "people" | "other";

export interface MeasuredChunkTiming {
  /** Median and 90th percentile of the wall seconds of one chunk (chunk to next chunk), from finished jobs. */
  p50: number;
  p90: number;
  /** How many chunks the figures come from. */
  chunks: number;
}

export type MeasuredTimings = Partial<Record<TimingFamily, MeasuredChunkTiming>>;

export interface DurationStep {
  /** Customer-facing name of the step, for the breakdown («تعليقات»). */
  labelAr: string;
  family: TimingFamily;
  /** Records wanted from this step. */
  records: number;
  /** Real records one provider call returns for the chosen source. */
  recordsPerCall: number;
  /** Provider calls needed per record beyond collection (decision makers: an e-mail call and a phone call per person). */
  callsPerRecord?: number;
  /** Dependent calls before the records can be collected (channel to videos, videos to their comments). */
  extraCalls?: number;
  /** The step starts only after the previous one is complete (companies, then their decision makers). */
  dependsOnPrevious?: boolean;
  /**
   * Directory searches only: the most records the stop rules let the job request (pages allowed x page size). The pessimistic end of the
   * range is computed for this many, because a search whose pages find few matches runs up to its page limit; the optimistic end stays
   * the wanted count.
   */
  pessimisticRecords?: number;
}

export interface DurationInput {
  steps: DurationStep[];
  driver: DriverMode;
  /** Measured seconds per chunk by family; absent or too few chunks = defaults. */
  measured?: MeasuredTimings;
  /** True (the current worker) when each chunk re-reads all earlier chunk files; false once a running identity set replaces it. */
  rereadsPriorChunks?: boolean;
}

export type StageKind = "collect" | "dependent" | "rereads" | "retries" | "assembly";

export interface DurationStage {
  kind: StageKind;
  labelAr: string;
  optimisticSeconds: number;
  pessimisticSeconds: number;
}

export interface MissionDuration {
  optimisticSeconds: number;
  pessimisticSeconds: number;
  stages: DurationStage[];
  /** Provider calls and worker chunks the mission needs (not money). */
  calls: number;
  chunks: number;
  records: number;
  /** measured: every family had enough chunks; default: none; mixed: some. */
  basis: "measured" | "default" | "mixed";
  driver: DriverMode;
  /** More than one step runs in sequence (channels to videos to comments, companies then decision makers). */
  dependentSteps: number;
  exceedsDay: boolean;
}

const clamp0 = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

function pick(range: Range, side: "optimistic" | "pessimistic"): number {
  return range[side];
}

interface StepNumbers {
  calls: number;
  chunks: number;
  recordsPerChunk: number;
}

/** Calls, records per chunk and chunks of a step, for one side of the range (the time budget of a chunk bounds the work in it). */
function stepNumbers(step: DurationStep, side: "optimistic" | "pessimistic"): StepNumbers {
  const wanted = Math.max(0, Math.floor(step.records));
  const records = side === "pessimistic" ? Math.max(wanted, Math.floor(step.pessimisticRecords || 0)) : wanted;
  const perCall = Math.max(1, Math.floor(step.recordsPerCall));
  const callsPerRecord = step.callsPerRecord && step.callsPerRecord > 0 ? step.callsPerRecord : 0;
  const callSeconds = pick(DEFAULT_TIMINGS.callSeconds, side);
  const budgetCalls = Math.max(1, Math.floor(CHUNK_BUDGET_SECONDS / callSeconds));
  let recordsPerChunk: number;
  if (callsPerRecord > 0) {
    // enrichment calls are one after another: as many people as the chunk's time allows
    recordsPerChunk = Math.max(1, Math.floor(budgetCalls / callsPerRecord));
  } else {
    const callsInChunk = Math.min(SOCIAL_MAX_CALLS_PER_CHUNK, budgetCalls);
    recordsPerChunk = Math.max(1, Math.min(socialRowsPerChunk(), callsInChunk * perCall));
  }
  const chunks = records > 0 ? Math.ceil(records / recordsPerChunk) : 0;
  const collectCalls = callsPerRecord > 0 ? Math.ceil(records * callsPerRecord) + Math.ceil(records / perCall) : Math.ceil(records / perCall);
  const calls = collectCalls + Math.max(0, Math.floor(step.extraCalls || 0));
  return { calls, chunks, recordsPerChunk };
}

function useMeasured(measured: MeasuredChunkTiming | undefined): measured is MeasuredChunkTiming {
  return Boolean(measured && measured.chunks >= MIN_MEASURED_CHUNKS && measured.p50 > 0 && measured.p90 >= measured.p50);
}

/** The mission's duration. Pure: the same input gives the same output; nothing is read from anywhere. */
export function estimateMissionDuration(input: DurationInput): MissionDuration {
  const rereads = input.rereadsPriorChunks !== false;
  const sides = ["optimistic", "pessimistic"] as const;
  const totals = { optimistic: 0, pessimistic: 0 };
  const stageMap = new Map<string, DurationStage>();
  const addStage = (kind: StageKind, labelAr: string, side: "optimistic" | "pessimistic", seconds: number) => {
    const key = `${kind}:${labelAr}`;
    const stage = stageMap.get(key) || { kind, labelAr, optimisticSeconds: 0, pessimisticSeconds: 0 };
    if (side === "optimistic") stage.optimisticSeconds += seconds;
    else stage.pessimisticSeconds += seconds;
    stageMap.set(key, stage);
    totals[side] += seconds;
  };

  let calls = 0;
  let chunks = 0;
  let records = 0;
  let measuredFamilies = 0;
  let unmeasuredFamilies = 0;
  const seenFamilies = new Set<TimingFamily>();

  for (const step of input.steps) {
    records += Math.max(0, Math.floor(step.records));
    const measured = input.measured?.[step.family];
    const isMeasured = useMeasured(measured);
    if (!seenFamilies.has(step.family)) {
      seenFamilies.add(step.family);
      if (isMeasured) measuredFamilies++;
      else unmeasuredFamilies++;
    }
    for (const side of sides) {
      const n = stepNumbers(step, side);
      if (side === "optimistic") { calls += n.calls; chunks += n.chunks; }
      const callSeconds = pick(DEFAULT_TIMINGS.callSeconds, side);
      // one chunk, wall to wall: measured when there are enough finished chunks, else calls + overhead + the driver's gap
      const chunkWall = isMeasured
        ? (side === "optimistic" ? measured!.p50 : measured!.p90)
        : Math.min(CHUNK_BUDGET_SECONDS, Math.min(n.recordsPerChunk, side === "pessimistic" ? Math.max(step.records, step.pessimisticRecords || 0) : step.records) / Math.max(1, step.recordsPerCall) * callSeconds * (step.callsPerRecord ? step.callsPerRecord * Math.max(1, step.recordsPerCall) : 1))
          + pick(DEFAULT_TIMINGS.chunkOverheadSeconds, side) + pick(DEFAULT_TIMINGS.gapSeconds[input.driver], side);
      addStage("collect", step.labelAr, side, n.chunks * chunkWall);
      if (step.extraCalls && step.extraCalls > 0) addStage("dependent", step.labelAr, side, step.extraCalls * (callSeconds + (isMeasured ? 0 : pick(DEFAULT_TIMINGS.chunkOverheadSeconds, side) / SOCIAL_MAX_CALLS_PER_CHUNK)));
      const retryExtra = n.chunks * pick(DEFAULT_TIMINGS.retryFraction, side) * pick(DEFAULT_TIMINGS.retrySeconds, side);
      if (retryExtra > 0) addStage("retries", step.labelAr, side, retryExtra);
      if (rereads && n.chunks > 1) addStage("rereads", step.labelAr, side, (n.chunks * (n.chunks - 1) / 2) * pick(DEFAULT_TIMINGS.priorFileReadSeconds, side));
    }
  }
  for (const side of sides) {
    addStage("assembly", "ملفات النتائج", side, pick(DEFAULT_TIMINGS.assemblyBaseSeconds, side) + records * pick(DEFAULT_TIMINGS.assemblyPerRecordSeconds, side));
  }

  const basis: MissionDuration["basis"] = measuredFamilies > 0 && unmeasuredFamilies === 0 ? "measured" : measuredFamilies > 0 ? "mixed" : "default";
  // No (or partial) measurements: the data does not support a tight range, so the pessimistic end is widened.
  let pessimistic = totals.pessimistic;
  let optimistic = totals.optimistic;
  if (basis !== "measured") pessimistic *= basis === "default" ? UNMEASURED_WIDENING : (1 + UNMEASURED_WIDENING) / 2;
  pessimistic = Math.max(pessimistic, optimistic);
  optimistic = clamp0(optimistic);
  const stages = [...stageMap.values()].map((stage) => ({ ...stage, pessimisticSeconds: basis !== "measured" ? stage.pessimisticSeconds * (basis === "default" ? UNMEASURED_WIDENING : (1 + UNMEASURED_WIDENING) / 2) : stage.pessimisticSeconds }));
  return {
    optimisticSeconds: Math.round(optimistic),
    pessimisticSeconds: Math.round(pessimistic),
    stages,
    calls,
    chunks,
    records,
    basis,
    driver: input.driver,
    dependentSteps: input.steps.filter((step) => step.dependsOnPrevious || (step.extraCalls || 0) > 0).length,
    exceedsDay: pessimistic > 24 * 3600,
  };
}

/* ---------------------------------------------------------------- from a plan item */

export interface PlanItemLike {
  capabilitySlug?: string;
  endpointId?: string;
  targetVolumeMax?: number;
  params?: Record<string, any>;
}

const MAX_PER_CALL_DEFAULT = 20;
/** The share of the posts a keyword search lists that are about the keyword (ASSUMED: no job has measured it). */
const PAGED_ADOPTION_SHARE = 0.5;

function firstSourceMaxPerCall(slug: string, mode: "comments" | "discover"): number {
  const def = getSocialCapability(slug);
  if (!def) return MAX_PER_CALL_DEFAULT;
  if (mode === "comments") return def.comments?.[0]?.maxPerCall ?? MAX_PER_CALL_DEFAULT;
  const first = Object.values(def.discover).flat().filter(Boolean)[0];
  return first?.maxPerCall ?? MAX_PER_CALL_DEFAULT;
}

/** The timing family of a capability slug or endpoint id (also used to group the measured finished jobs). */
export function timingFamilyFor(slugOrEndpoint: string | undefined | null): TimingFamily {
  const value = String(slugOrEndpoint || "").toLowerCase();
  const social = getSocialCapability(value);
  if (social) return social.kind === "comments" ? "social_comments" : social.kind === "posts" ? "social_posts" : "social_videos";
  if (/people|decision/.test(value)) return "people";
  if (/compan/.test(value)) return "companies";
  if (/comments?/.test(value)) return "social_comments";
  if (/search\.posts|\.posts?\b|x\.search/.test(value)) return "social_posts";
  if (/videos?|user\.videos|channel/.test(value)) return "social_videos";
  return "other";
}

const FAMILY_LABEL_AR: Record<TimingFamily, string> = {
  social_comments: "التعليقات",
  social_posts: "المنشورات",
  social_videos: "الفيديوهات",
  companies: "الشركات",
  people: "صنّاع القرار",
  other: "البيانات",
};

/** Records per call and dependent calls of one plan item, from its capability and parameters. */
export function durationStepFromPlanItem(item: PlanItemLike, index = 0): DurationStep {
  const slug = String(item.capabilitySlug || item.endpointId || "");
  // A company search is recognised by its plan shape too (see directoryCapability), whatever the source's name says.
  const family = timingFamilyFor(slug) === "other" && isCompanyDirectoryJob(String(item.capabilitySlug || ""), String(item.endpointId || ""), item.params) ? "companies" : timingFamilyFor(slug);
  const records = Math.max(0, Math.floor(Number(item.targetVolumeMax) || 0));
  const params = item.params || {};
  if (family === "people") {
    return { labelAr: FAMILY_LABEL_AR.people, family, records, recordsPerCall: 10, callsPerRecord: 2, dependsOnPrevious: index > 0 };
  }
  if (family === "companies") {
    // The page size and the page limit are the worker's (jobExecutionSpec, providerCallCaps): the worst case is every allowed page requested.
    const pageSize = isSmallJob(records) ? smallJobPageSize(records) : Math.min(50, Math.max(10, records || 50));
    const pessimisticRecords = maxPagesForJob(records, pageSize, "directory") * pageSize;
    return { labelAr: FAMILY_LABEL_AR.companies, family, records, recordsPerCall: pageSize, dependsOnPrevious: index > 0, pessimisticRecords };
  }
  let extraCalls = 0;
  if (family === "social_comments") {
    const channels = Array.isArray(params.channels) ? params.channels.length : 0;
    const perCall = firstSourceMaxPerCall(slug, "comments");
    const discoverPerCall = firstSourceMaxPerCall(slug, "discover");
    if (channels > 0) {
      // channel -> its videos (one discovery per channel, a page of videos each) -> the comments of every kept video (at least a call each)
      const top = Math.max(1, Math.floor(Number(params.topPerChannel) || 10));
      const videos = channels * top;
      const discoveryCalls = channels * Math.ceil(DISCOVER_VIDEOS_PER_CHANNEL / Math.max(1, discoverPerCall));
      const perVideoRecords = records / Math.max(1, videos);
      const commentCalls = videos * Math.max(1, Math.ceil(perVideoRecords / perCall));
      const baseCalls = Math.ceil(records / perCall);
      extraCalls = discoveryCalls + Math.max(0, commentCalls - baseCalls);
    } else if (params.url) {
      extraCalls = 0;
    } else {
      // videos found by a topic or a feed: one discovery, then at least one call per video
      const videos = Math.max(1, Math.floor(Number(params.videoCount) || Math.ceil(records / Math.max(1, Number(params.perVideo) || 50))));
      const perVideoRecords = records / videos;
      const baseCalls = Math.ceil(records / perCall);
      // A paged search (Facebook posts of a keyword) lists about two posts for each one adopted (ASSUMED, the share the unit price is built on), so it needs twice the pages.
      const listedPerCall = getSocialCapability(slug)?.pagedDiscovery ? discoverPerCall * PAGED_ADOPTION_SHARE : discoverPerCall;
      extraCalls = Math.ceil(videos / Math.max(1, listedPerCall)) + Math.max(0, videos * Math.max(1, Math.ceil(perVideoRecords / perCall)) - baseCalls);
    }
    return { labelAr: FAMILY_LABEL_AR.social_comments, family, records, recordsPerCall: perCall, extraCalls };
  }
  if (family === "social_posts" || family === "social_videos") {
    return { labelAr: FAMILY_LABEL_AR[family], family, records, recordsPerCall: firstSourceMaxPerCall(slug, "discover") };
  }
  return { labelAr: FAMILY_LABEL_AR.other, family: "other", records, recordsPerCall: MAX_PER_CALL_DEFAULT };
}

export function durationStepsFromPlanItems(items: PlanItemLike[]): DurationStep[] {
  return items.map((item, index) => durationStepFromPlanItem(item, index));
}

/* ---------------------------------------------------------------- the words */

/**
 * What the phrasing function may read: seconds and counts. There is deliberately no price, no points and no money field here, so a
 * duration sentence can never carry (or be made to carry) a money value.
 */
export interface DurationPhrasingInput {
  optimisticSeconds: number;
  pessimisticSeconds: number;
  calls: number;
  chunks: number;
  dependentSteps: number;
  basis: "measured" | "default" | "mixed";
  driver: DriverMode;
  /** Names of the sequence, in order («القنوات»، «الفيديوهات»، «التعليقات»), when the mission has dependent steps. */
  sequenceAr?: string[];
}

export interface DurationPhrasing {
  /** «من ١٥ إلى ٣٠ دقيقة» */
  rangeAr: string;
  /** Always «تقديري». */
  labelAr: string;
  /** One line: what drives the duration. */
  driversAr: string;
  /** The notification promise. */
  promiseAr: string;
  /** Present when the mission may take more than a day. */
  longNoteAr?: string;
}

export const DURATION_LABEL_AR = "تقديري";
export const DURATION_PROMISE_AR = "سنبلغك عند الاكتمال.";

const unitWord = (n: number, forms: { one: string; two: string; few: string; many: string }) => (n === 1 ? forms.one : n === 2 ? forms.two : n >= 3 && n <= 10 ? forms.few : forms.many);
const MINUTE = { one: "دقيقة", two: "دقيقتين", few: "دقائق", many: "دقيقة" };
const HOUR = { one: "ساعة", two: "ساعتين", few: "ساعات", many: "ساعة" };
const DAY = { one: "يوم", two: "يومين", few: "أيام", many: "يومًا" };

type UnitForms = { one: string; two: string; few: string; many: string };

/** The first end of a range: 1 and 2 are the unit word («ساعة», «ساعتين»), anything else the digits. */
function startPhrase(n: number, forms: UnitForms): string {
  return n === 1 ? forms.one : n === 2 ? forms.two : toArabicDigits(n);
}

/** The last end of a range, with its unit: «دقيقة», «دقيقتين», «٣ ساعات», «١٥ دقيقة». */
function endPhrase(n: number, forms: UnitForms): string {
  return n === 1 ? forms.one : n === 2 ? forms.two : `${toArabicDigits(n)} ${unitWord(n, forms)}`;
}

function roundMinutesDown(m: number): number {
  if (m <= 10) return Math.max(1, Math.floor(m));
  if (m <= 30) return Math.floor(m / 5) * 5;
  return Math.floor(m / 15) * 15;
}
function roundMinutesUp(m: number): number {
  if (m <= 10) return Math.max(1, Math.ceil(m));
  if (m <= 30) return Math.ceil(m / 5) * 5;
  return Math.ceil(m / 15) * 15;
}

/** The range as a friendly Arabic phrase (digits Arabic-Indic, calm units), never narrower than the data. */
export function durationRangeAr(optimisticSeconds: number, pessimisticSeconds: number): string {
  const opt = Math.max(0, optimisticSeconds);
  const pess = Math.max(opt, pessimisticSeconds);
  if (pess < 60) return "أقل من دقيقة";
  const pessMinutes = pess / 60;
  if (pessMinutes <= 90) {
    const lo = roundMinutesDown(Math.max(1, opt / 60));
    let hi = roundMinutesUp(pessMinutes);
    if (hi <= lo) hi = lo < 10 ? lo + 1 : lo < 30 ? lo + 5 : lo + 15;
    return `من ${startPhrase(lo, MINUTE)} إلى ${endPhrase(hi, MINUTE)}`;
  }
  const pessHours = pess / 3600;
  if (pessHours <= 36) {
    let hi = Math.ceil(pessHours);
    if (opt < 3600) {
      // the optimistic end is under an hour: say it in minutes, never round it up to an hour the data does not show
      const lo = roundMinutesDown(Math.max(1, opt / 60));
      return `من ${endPhrase(lo, MINUTE)} إلى ${endPhrase(hi, HOUR)}`;
    }
    const lo = Math.max(1, Math.floor(opt / 3600));
    if (hi <= lo) hi = lo + 1;
    return `من ${startPhrase(lo, HOUR)} إلى ${endPhrase(hi, HOUR)}`;
  }
  const pessDays = pess / 86400;
  if (pessDays > 14) return "أكثر من أسبوعين";
  let hi = Math.ceil(pessDays);
  if (opt < 86400) {
    const lo = Math.max(1, Math.floor(opt / 3600));
    return `من ${endPhrase(lo, HOUR)} إلى ${endPhrase(hi, DAY)}`;
  }
  const lo = Math.max(1, Math.floor(opt / 86400));
  if (hi <= lo) hi = lo + 1;
  return `من ${startPhrase(lo, DAY)} إلى ${endPhrase(hi, DAY)}`;
}

/** One line about what the duration depends on, built from counts only. */
function driversLineAr(input: DurationPhrasingInput): string {
  const parts: string[] = [];
  const calls = Math.max(1, Math.round(input.calls));
  parts.push(`تتأثر المدة بعدد الطلبات إلى المصدر (حوالي ${toArabicDigits(calls)}) وسرعة استجابته`);
  if (input.dependentSteps > 0 && input.sequenceAr && input.sequenceAr.length > 1) parts.push(`وبأن التنفيذ يمر بخطوات متتابعة: ${input.sequenceAr.join(" ثم ")}`);
  else if (input.dependentSteps > 0) parts.push("وبأن التنفيذ يمر بخطوات متتابعة");
  if (input.basis === "default") parts.push("ولا توجد قياسات كافية بعد لهذا النوع، لذلك المدى واسع");
  else if (input.basis === "mixed") parts.push("وبعض الخطوات ليس لها قياسات كافية بعد");
  return `${parts.join("، ")}.`;
}

/** The sentence block for the plan panel and the calculator. Reads durations and counts only. */
export function phraseDuration(input: DurationPhrasingInput): DurationPhrasing {
  const rangeAr = durationRangeAr(input.optimisticSeconds, input.pessimisticSeconds);
  const day = input.pessimisticSeconds > 24 * 3600;
  return {
    rangeAr,
    labelAr: DURATION_LABEL_AR,
    driversAr: driversLineAr(input),
    promiseAr: DURATION_PROMISE_AR,
    // With the page as the driver («tab») the ONE instruction is «أبقِ الصفحة مفتوحة حتى تكتمل المهمة» (closePageAr): this note says nothing that suggests leaving.
    ...(day ? { longNoteAr: input.driver === "cron" ? "هذه مهمة طويلة قد تستغرق أكثر من يوم؛ تُنفَّذ على دفعات، ويمكنك متابعة تقدمها من صفحة الطلبات." : "هذه مهمة طويلة قد تستغرق أكثر من يوم؛ تُنفَّذ على دفعات." } : {}),
  };
}

export interface MissionDurationView extends DurationPhrasing {
  optimisticSeconds: number;
  pessimisticSeconds: number;
  basis: MissionDuration["basis"];
  driver: DriverMode;
  /** «تقدر تقفل الصفحة» only when the always-on driver is on; otherwise the honest line. */
  closePageAr: string;
}

/** Everything the plan panel needs: the numbers and the words, built from one duration. */
export function durationView(duration: MissionDuration, sequenceAr?: string[]): MissionDurationView {
  const phrasing = phraseDuration({
    optimisticSeconds: duration.optimisticSeconds,
    pessimisticSeconds: duration.pessimisticSeconds,
    calls: duration.calls,
    chunks: duration.chunks,
    dependentSteps: duration.dependentSteps,
    basis: duration.basis,
    driver: duration.driver,
    sequenceAr,
  });
  return { ...phrasing, optimisticSeconds: duration.optimisticSeconds, pessimisticSeconds: duration.pessimisticSeconds, basis: duration.basis, driver: duration.driver, closePageAr: closePageLineAr(duration.driver) };
}

/** The duration view of a plan's items (the one call the chat handler and the calculator make). */
export function missionDurationForPlan(items: PlanItemLike[], driver: DriverMode, measured?: MeasuredTimings, rereadsPriorChunks = true): MissionDurationView | null {
  const steps = durationStepsFromPlanItems(items).filter((step) => step.records > 0);
  if (steps.length === 0) return null;
  const duration = estimateMissionDuration({ steps, driver, measured, rereadsPriorChunks });
  const channelMission = items.some((item) => Array.isArray(item.params?.channels) && item.params!.channels.length > 0);
  const sequence = channelMission ? ["القنوات", "الفيديوهات", "التعليقات"] : steps.length > 1 ? steps.map((step) => step.labelAr) : undefined;
  return durationView(duration, sequence);
}
