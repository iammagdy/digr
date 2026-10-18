import { formatNumber } from "../../lib/honestDisplay";

export type ActivityStepKind = "search_posts" | "collect_comments" | "verify_profile";
export type ActivityCapKind = "post_cap" | "points_cap";

export interface LiveActivitySnapshot {
  currentStepAr?: string;
  currentPostIndex?: number;
  totalPosts?: number;
  currentPostTitleOrUrl?: string;
  lastBatchComments?: number;
  totalItemsCollected?: number;
  spentPoints?: number;
  reservedPoints?: number;
  capReached?: {
    kind: ActivityCapKind;
    limit: number;
    messageAr: string;
  } | null;
}

/** Estimate remaining time only after at least two measured cumulative batches. */
export function estimateRemainingSecondsFromBatches(
  events: Array<{ count?: number; createdAt?: string; kind?: string }>,
  rowsCollected: number,
  requestedRows: number,
): number | null {
  if (!Number.isFinite(rowsCollected) || !Number.isFinite(requestedRows) || requestedRows <= rowsCollected) return null;
  const points = (events || [])
    .filter((event) => event.kind === "progress" && Number.isFinite(event.count) && (event.count || 0) > 0 && event.createdAt)
    .map((event) => ({ rows: Math.min(rowsCollected, Math.floor(event.count!)), at: Date.parse(event.createdAt!) }))
    .filter((point) => Number.isFinite(point.at) && point.rows > 0)
    .sort((a, b) => a.at - b.at);

  const distinct: typeof points = [];
  for (const point of points) {
    const previous = distinct[distinct.length - 1];
    if (previous && point.rows === previous.rows) distinct[distinct.length - 1] = point;
    else if (!previous || point.rows > previous.rows) distinct.push(point);
  }
  const sample = distinct.slice(-4);
  if (sample.length < 2) return null;
  const elapsedSeconds = (sample[sample.length - 1].at - sample[0].at) / 1000;
  const processedRows = sample[sample.length - 1].rows - sample[0].rows;
  if (elapsedSeconds <= 0 || processedRows <= 0) return null;
  const rowsPerSecond = processedRows / elapsedSeconds;
  return Math.max(1, Math.ceil((requestedRows - rowsCollected) / rowsPerSecond));
}

/** Server use: estimate only from at least two real inter-page intervals. */
export function estimateRemainingSecondsFromMeasuredPages(
  events: Array<{ count?: number; createdAt?: string; kind?: string }>,
  rowsCollected: number,
  requestedRows: number,
): number | null {
  if (!Number.isFinite(rowsCollected) || !Number.isFinite(requestedRows) || requestedRows <= rowsCollected) return null;
  const points = (events || [])
    .filter((event) => event.kind === "progress" && Number.isFinite(event.count) && (event.count || 0) > 0 && event.createdAt)
    .map((event) => ({ rows: Math.min(rowsCollected, Math.floor(event.count!)), at: Date.parse(event.createdAt!) }))
    .filter((point) => Number.isFinite(point.at) && point.rows > 0)
    .sort((a, b) => a.at - b.at);
  const distinct: typeof points = [];
  for (const point of points) {
    const previous = distinct[distinct.length - 1];
    if (previous && point.rows === previous.rows) distinct[distinct.length - 1] = point;
    else if (!previous || point.rows > previous.rows) distinct.push(point);
  }
  const sample = distinct.slice(-5);
  if (sample.length < 3) return null;
  const elapsedSeconds = (sample[sample.length - 1].at - sample[0].at) / 1000;
  const processedRows = sample[sample.length - 1].rows - sample[0].rows;
  if (elapsedSeconds <= 0 || processedRows <= 0) return null;
  return Math.max(1, Math.ceil(((requestedRows - rowsCollected) * elapsedSeconds) / processedRows));
}

/**
 * Server-side ETA: remaining batches times the MEASURED duration of this job's own batches.
 *
 * remainingBatches = ceil(remainingRows / pageSize)
 * estimate         = remainingBatches x median(measured batch seconds)
 *
 * Assumption (stated, not measured): the remaining batches take as long as the median of the
 * batches already completed. With no measured batch the function returns null; no number is
 * ever invented. The median keeps one slow cold-start batch from inflating every later estimate.
 */
export function estimateRemainingSecondsFromBatchDurations(input: {
  remainingRows: number;
  pageSize: number;
  measuredBatchSeconds: number[];
}): number | null {
  const remaining = Math.floor(Number(input.remainingRows));
  const pageSize = Math.floor(Number(input.pageSize));
  if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isFinite(pageSize) || pageSize <= 0) return null;
  const measured = (input.measuredBatchSeconds || [])
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    .sort((left, right) => left - right);
  if (!measured.length) return null;
  const middle = Math.floor(measured.length / 2);
  const median = measured.length % 2 ? measured[middle] : (measured[middle - 1] + measured[middle]) / 2;
  return Math.max(1, Math.ceil(Math.ceil(remaining / pageSize) * median));
}

const FORBIDDEN_PROVIDER_TERMS = /\b(?:diffbot|tikhub|scrapecreators|anyapi|brightdata|crawl4ai|justoneapi|treg|apify|socialdata|rapidapi|scrapingbee|zenrows|icypeas|serpapi|openai|anthropic|claude|gpt-[\w.-]*|microusd|usd)\b/gi;
const DOLLAR_AMOUNT_PATTERN = /\$\s*\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s*(?:usd|dollars?|دولار)\b/gi;
const INTERNAL_JOB_ERROR_PATTERN = /\b(?:treg_live|diffbot|tikhub|scrapecreators|anyapi|brightdata|crawl4ai|justoneapi|treg|apify|socialdata|rapidapi|scrapingbee|zenrows|icypeas|serpapi|openai|anthropic|claude|gpt-[\w.-]*|microusd|usd|rate\s*limit|http\s*\d{3})\b|\$\s*\d|\b[a-z0-9_-]+\.(?:x|facebook|tiktok|instagram|youtube|linkedin|reddit|companies|people)\.[a-z0-9_.-]+\b|مزود البيانات|لدى المزود|\(\s*\d{3}\s*\)/i;

/**
 * Scrubs any upstream provider name or dollar figure from activity text.
 * Activity feed must show Arabic and points only.
 */
export function sanitizeActivityText(text: string): string {
  if (!text) return "";
  return text
    .replace(DOLLAR_AMOUNT_PATTERN, "")
    .replace(FORBIDDEN_PROVIDER_TERMS, "المصدر")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Job failures may contain upstream diagnostics, which must never reach the customer UI. */
export function sanitizeActivityError(text: string): string {
  if (!text) return "";
  if (INTERNAL_JOB_ERROR_PATTERN.test(text)) {
    if (/422/.test(text)) return "تعذر معالجة تفاصيل الطلب. راجع المعلومات المطلوبة وحاول مجدداً.";
    if (/429|rate\s*limit/i.test(text)) return "تعذر إكمال البحث حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.";
    return "الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.";
  }
  return sanitizeActivityText(text);
}

/**
 * 1. Current step formatter ("البحث عن المنشورات...", "جمع التعليقات...").
 */
export function formatActivityStep(step: ActivityStepKind | string): string {
  if (step === "search_posts") return "البحث عن المنشورات...";
  if (step === "collect_comments") return "جمع التعليقات...";
  if (step === "verify_profile") return "التحقق من الحساب وجلب المعلومات المتاحة...";
  return sanitizeActivityText(step);
}

/**
 * 2. Current post formatter ("المنشور 3 من 84: <short title or URL>").
 */
export function formatCurrentPostProgress(
  postIndex: number,
  totalPosts: number,
  titleOrUrl: string,
  options?: { arabicNumerals?: boolean }
): string {
  const safeIndex = Math.max(1, Math.floor(postIndex));
  const safeTotal = Math.max(safeIndex, Math.floor(totalPosts));
  const cleanTitle = sanitizeActivityText(titleOrUrl).slice(0, 60).trim() || "منشور عام";
  const idxStr = options?.arabicNumerals ? formatNumber(safeIndex) : String(safeIndex);
  const totalStr = options?.arabicNumerals ? formatNumber(safeTotal) : String(safeTotal);
  return `المنشور ${idxStr} من ${totalStr}: ${cleanTitle}`;
}

/**
 * 3. Items collected formatter ("تم جلب 10 تعليقات - الإجمالي 306").
 */
export function formatItemsCollectedProgress(
  batchCount: number,
  totalCollected: number,
  unitLabelAr: string = "تعليقات",
  options?: { arabicNumerals?: boolean }
): string {
  const safeBatch = Math.max(0, Math.floor(batchCount));
  const safeTotal = Math.max(safeBatch, Math.floor(totalCollected));
  const batchStr = options?.arabicNumerals ? formatNumber(safeBatch) : String(safeBatch);
  const totalStr = options?.arabicNumerals ? formatNumber(safeTotal) : String(safeTotal);
  return `تم جلب ${batchStr} ${sanitizeActivityText(unitLabelAr)} - الإجمالي ${totalStr}`;
}

/**
 * 4. Points spent vs reserved formatter ("المستهلك 38 نقطة من 450").
 */
export function formatPointsSpentVsReserved(
  spentPoints: number,
  reservedPoints: number,
  options?: { arabicNumerals?: boolean }
): string {
  const safeReserved = Math.max(0, Math.floor(reservedPoints));
  const safeSpent = Math.min(safeReserved, Math.max(0, Math.floor(spentPoints)));
  const spentStr = options?.arabicNumerals ? formatNumber(safeSpent) : String(safeSpent);
  const reservedStr = options?.arabicNumerals ? formatNumber(safeReserved) : String(safeReserved);
  return `المستهلك ${spentStr} نقطة من ${reservedStr}`;
}

/**
 * 6. Clean stop message when post cap or points cap is reached.
 */
export function formatCapReachedMessage(
  kind: ActivityCapKind,
  limit: number,
  options?: { arabicNumerals?: boolean }
): string {
  const safeLimit = Math.max(0, Math.floor(limit));
  const limitStr = options?.arabicNumerals ? formatNumber(safeLimit) : String(safeLimit);
  if (kind === "post_cap") {
    return `توقف الجمع بشكل منظم عند الوصول للحد الأقصى لعدد المنشورات (${limitStr} منشور) وحفظ جميع السجلات المجمعة.`;
  }
  return `توقف الجمع بشكل منظم عند الوصول لسقف النقاط المحجوزة (${limitStr} نقطة) وحفظ جميع السجلات المجمعة دون أي خصم إضافي.`;
}

/**
 * Derives structured live activity details from job events and job metadata for display.
 */
export function deriveLiveActivitySnapshot(params: {
  events: Array<{ textAr: string; count?: number; kind?: string; createdAt?: string }>;
  rowsCollected: number;
  chargedCredits?: number;
  reservedCredits?: number;
  status: string;
}): LiveActivitySnapshot {
  const { events, rowsCollected, chargedCredits, reservedCredits } = params;
  const cleanedEvents = (events || []).map((e) => ({
    ...e,
    textAr: sanitizeActivityText(e.textAr),
  }));

  const latestEvent = cleanedEvents.length > 0 ? cleanedEvents[cleanedEvents.length - 1] : null;
  let currentStepAr: string | undefined;
  let currentPostIndex: number | undefined;
  let totalPosts: number | undefined;
  let currentPostTitleOrUrl: string | undefined;
  let lastBatchComments: number | undefined;
  let capReached: LiveActivitySnapshot["capReached"] = null;

  for (const ev of cleanedEvents) {
    const t = ev.textAr;
    if (t.includes("البحث عن المنشورات")) {
      currentStepAr = "البحث عن المنشورات...";
    } else if (t.includes("جمع التعليقات")) {
      currentStepAr = "جمع التعليقات...";
    } else if (!currentStepAr && t) {
      currentStepAr = t;
    }

    const postMatch = t.match(/المنشور\s+([0-9٠-٩]+)\s+من\s+([0-9٠-٩]+)\s*:\s*(.+)$/);
    if (postMatch) {
      currentPostIndex = parseArabicOrWesternInt(postMatch[1]);
      totalPosts = parseArabicOrWesternInt(postMatch[2]);
      currentPostTitleOrUrl = postMatch[3].trim();
    }

    const itemsMatch = t.match(/تم جلب\s+([0-9٠-٩]+)\s+تعليقات?\s*-\s*الإجمالي\s+([0-9٠-٩]+)/);
    if (itemsMatch) {
      lastBatchComments = parseArabicOrWesternInt(itemsMatch[1]);
    }

    if (t.includes("الأقصى لعدد المنشورات")) {
      capReached = {
        kind: "post_cap",
        limit: totalPosts || ev.count || 0,
        messageAr: t,
      };
    } else if (t.includes("النقاط المحجوزة")) {
      capReached = {
        kind: "points_cap",
        limit: reservedCredits || ev.count || 0,
        messageAr: t,
      };
    }
  }

  if (latestEvent && !currentStepAr) {
    currentStepAr = latestEvent.textAr;
  }

  const spentPoints =
    typeof chargedCredits === "number" && Number.isFinite(chargedCredits)
      ? chargedCredits
      : undefined;

  return {
    currentStepAr,
    currentPostIndex,
    totalPosts,
    currentPostTitleOrUrl,
    lastBatchComments,
    totalItemsCollected: rowsCollected,
    spentPoints,
    reservedPoints: reservedCredits,
    capReached,
  };
}

function parseArabicOrWesternInt(raw: string): number {
  const normalized = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[^0-9]/g, "");
  return parseInt(normalized || "0", 10);
}

/**
 * 5. Throttled Progress Emitter:
 * - Throttles progress updates to at most every 2-3 seconds (default 2500ms).
 * - Emits one summary event per search or per post, NEVER one DB row per pagination page.
 * - Stops cleanly at the post cap or points cap with a clear Arabic message.
 */
export interface ThrottledEmitterOptions {
  minIntervalMs?: number;
  maxPostsCap?: number;
  reservedPointsCap?: number;
  nowFn?: () => number;
  writeEventFn: (event: { textAr: string; count: number; kind: "info" | "progress" | "warning" | "error" }) => Promise<void> | void;
}

export class ThrottledActivityEmitter {
  private readonly minIntervalMs: number;
  private readonly maxPostsCap?: number;
  private readonly reservedPointsCap?: number;
  private readonly nowFn: () => number;
  private readonly writeEventFn: ThrottledEmitterOptions["writeEventFn"];
  private lastEmitTimestamp = 0;
  private totalItems = 0;
  private spentPoints = 0;
  private stoppedByCap: ActivityCapKind | null = null;

  constructor(options: ThrottledEmitterOptions) {
    this.minIntervalMs = Math.max(2000, options.minIntervalMs ?? 2500);
    this.maxPostsCap = options.maxPostsCap;
    this.reservedPointsCap = options.reservedPointsCap;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.writeEventFn = options.writeEventFn;
  }

  public isStoppedByCap(): ActivityCapKind | null {
    return this.stoppedByCap;
  }

  public getTotalItems(): number {
    return this.totalItems;
  }

  public getSpentPoints(): number {
    return this.spentPoints;
  }

  /**
   * Emits a step transition (e.g. "البحث عن المنشورات...", "جمع التعليقات...").
   */
  public async emitStep(step: ActivityStepKind | string): Promise<boolean> {
    if (this.stoppedByCap) return false;
    const textAr = formatActivityStep(step);
    await this.writeEventFn({
      textAr,
      count: this.totalItems,
      kind: "progress",
    });
    this.lastEmitTimestamp = this.nowFn();
    return true;
  }

  /**
   * Called on each pagination page inside a post/search.
   * NEVER writes one DB row per page unconditionally: accumulates counts in memory
   * and only writes a throttled progress update if at least `minIntervalMs` (2-3s) has elapsed.
   */
  public async recordPageBatch(batchItemsCount: number, batchPointsDelta: number = 0): Promise<{ emitted: boolean; capReached: ActivityCapKind | null }> {
    if (this.stoppedByCap) {
      return { emitted: false, capReached: this.stoppedByCap };
    }

    this.totalItems += Math.max(0, batchItemsCount);
    this.spentPoints += Math.max(0, batchPointsDelta);

    if (this.reservedPointsCap !== undefined && this.spentPoints >= this.reservedPointsCap) {
      this.spentPoints = this.reservedPointsCap;
      this.stoppedByCap = "points_cap";
      await this.writeEventFn({
        textAr: formatCapReachedMessage("points_cap", this.reservedPointsCap),
        count: this.totalItems,
        kind: "info",
      });
      return { emitted: true, capReached: "points_cap" };
    }

    const now = this.nowFn();
    if (this.lastEmitTimestamp > 0 && now - this.lastEmitTimestamp < this.minIntervalMs) {
      return { emitted: false, capReached: null };
    }

    this.lastEmitTimestamp = now;
    const itemsText = formatItemsCollectedProgress(batchItemsCount, this.totalItems);
    const pointsText =
      this.reservedPointsCap !== undefined
        ? ` · ${formatPointsSpentVsReserved(this.spentPoints, this.reservedPointsCap)}`
        : "";
    await this.writeEventFn({
      textAr: `${itemsText}${pointsText}`,
      count: this.totalItems,
      kind: "progress",
    });
    return { emitted: true, capReached: null };
  }

  /**
   * Emits ONE summary event for a completed post (even if that post took many pages),
   * and checks the post cap and points cap cleanly.
   */
  public async emitPostSummary(params: {
    postIndex: number;
    totalPosts: number;
    titleOrUrl: string;
    postCommentsFetched: number;
    postPointsDelta?: number;
  }): Promise<{ emitted: boolean; capReached: ActivityCapKind | null }> {
    if (this.stoppedByCap) {
      return { emitted: false, capReached: this.stoppedByCap };
    }

    if (this.maxPostsCap !== undefined && params.postIndex > this.maxPostsCap) {
      this.stoppedByCap = "post_cap";
      await this.writeEventFn({
        textAr: formatCapReachedMessage("post_cap", this.maxPostsCap),
        count: this.totalItems,
        kind: "info",
      });
      return { emitted: true, capReached: "post_cap" };
    }

    this.totalItems += Math.max(0, params.postCommentsFetched);
    this.spentPoints += Math.max(0, params.postPointsDelta ?? 0);

    if (this.reservedPointsCap !== undefined && this.spentPoints >= this.reservedPointsCap) {
      this.spentPoints = this.reservedPointsCap;
    }

    const postHeader = formatCurrentPostProgress(params.postIndex, params.totalPosts, params.titleOrUrl);
    const itemsPart = formatItemsCollectedProgress(params.postCommentsFetched, this.totalItems);
    const pointsPart =
      this.reservedPointsCap !== undefined
        ? ` · ${formatPointsSpentVsReserved(this.spentPoints, this.reservedPointsCap)}`
        : "";

    await this.writeEventFn({
      textAr: `${postHeader} — ${itemsPart}${pointsPart}`,
      count: this.totalItems,
      kind: "progress",
    });
    this.lastEmitTimestamp = this.nowFn();

    if (this.reservedPointsCap !== undefined && this.spentPoints >= this.reservedPointsCap) {
      this.stoppedByCap = "points_cap";
      await this.writeEventFn({
        textAr: formatCapReachedMessage("points_cap", this.reservedPointsCap),
        count: this.totalItems,
        kind: "info",
      });
      return { emitted: true, capReached: "points_cap" };
    }

    if (this.maxPostsCap !== undefined && params.postIndex >= this.maxPostsCap) {
      this.stoppedByCap = "post_cap";
      await this.writeEventFn({
        textAr: formatCapReachedMessage("post_cap", this.maxPostsCap),
        count: this.totalItems,
        kind: "info",
      });
      return { emitted: true, capReached: "post_cap" };
    }

    return { emitted: true, capReached: null };
  }
}
