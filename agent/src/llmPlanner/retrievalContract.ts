/**
 * Universal Retrieval Contract & Pagination State Machine (Point 3.1)
 *
 * Provides:
 * 1. Frozen time-window calculations anchored to customer timezone.
 * 2. Deterministic chronological boundary detection (handling pinned posts at index 0).
 * 3. Formal pagination state machine with clean, explicit stop reasons.
 * 4. Deep account timeline scanning contracts with honest shortfall wording.
 *
 * Zero endpoint IDs, zero provider brand names, zero hardcoded network calls.
 */

export type EntityScope = "authored_by" | "about";

export type StopReason =
  | "terminal_cursor"
  | "target_reached"
  | "window_crossed"
  | "budget_reached"
  | "repeated_cursor"
  | "repeated_page";

export interface FrozenTimeWindow {
  startUtc: string; // ISO 8601
  endUtc: string;   // ISO 8601
  customerTz: string;
}

export interface PaginationState {
  endpointId: string;
  provider: string;
  queryHash: string;
  window: FrozenTimeWindow;
  cursor: string | null;
  seenCanonicalIds: Set<string>;
  acceptedCount: number;
  pagesFetched: number;
  stopReason: StopReason | null;
}

/**
 * Freezes the time window once at request or planning initiation.
 * Months are subtracted deterministically from the reference date (or current time).
 */
export function freezeTimeWindow(
  months: number,
  customerTz: string = "Africa/Cairo",
  referenceDate?: Date
): FrozenTimeWindow {
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  if (isNaN(ref.getTime())) {
    throw new Error("Invalid referenceDate passed to freezeTimeWindow");
  }

  const endUtc = ref.toISOString();
  const start = new Date(ref);
  start.setUTCMonth(start.getUTCMonth() - months);
  const startUtc = start.toISOString();

  return {
    startUtc,
    endUtc,
    customerTz,
  };
}

/**
 * Checks whether a single row date falls within the frozen time window [startUtc, endUtc].
 */
export function isRowDateInWindow(
  rowDate: Date | string | number,
  window: FrozenTimeWindow
): boolean {
  let time: number;
  if (rowDate instanceof Date) {
    time = rowDate.getTime();
  } else if (typeof rowDate === "number") {
    time = rowDate;
  } else if (typeof rowDate === "string") {
    time = Date.parse(rowDate);
  } else {
    return false;
  }

  if (isNaN(time)) return false;

  const start = Date.parse(window.startUtc);
  const end = Date.parse(window.endUtc);

  return time >= start && time <= end;
}

/**
 * Chronological feed termination check (Point 3.1).
 *
 * Chronological feeds are served newest-first. Once rows cross the date cutoff (older than startUtc),
 * subsequent rows will be even older.
 *
 * Invariant: Pinned posts!
 * A single old post at index 0 must NOT prematurely terminate the traversal because pinned
 * posts on social platforms can be months or years old while subsequent posts are recent.
 *
 * Termination requires:
 * - At least `minConsecutivePastWindow` (default 2) consecutive posts older than startUtc, OR
 * - When minConsecutivePastWindow is 1 and the post is strictly past index 0 (non-pinned).
 */
export function shouldStopChronologicalScan(
  rowDates: (Date | string | number)[],
  window: FrozenTimeWindow,
  minConsecutivePastWindow: number = 2
): boolean {
  if (!rowDates || rowDates.length === 0) return false;

  const start = Date.parse(window.startUtc);
  let consecutiveOlder = 0;

  for (let i = 0; i < rowDates.length; i++) {
    const raw = rowDates[i];
    let time: number;
    if (raw instanceof Date) time = raw.getTime();
    else if (typeof raw === "number") time = raw;
    else if (typeof raw === "string") time = Date.parse(raw);
    else continue;

    if (isNaN(time)) continue;

    if (time < start) {
      consecutiveOlder++;
      // If we've seen at least minConsecutivePastWindow older posts consecutively,
      // or if minConsecutivePastWindow is 1 and we are past the pinned slot (i > 0)
      if (consecutiveOlder >= minConsecutivePastWindow) {
        return true;
      }
      if (minConsecutivePastWindow === 1 && i > 0) {
        return true;
      }
    } else {
      // In-window post resets the consecutive counter (e.g. pinned post at index 0 followed by recent posts)
      consecutiveOlder = 0;
    }
  }

  return false;
}

export interface InitPaginationOptions {
  endpointId: string;
  provider?: string;
  queryHash?: string;
  window: FrozenTimeWindow;
  initialCursor?: string | null;
}

export function initPaginationState(options: InitPaginationOptions): PaginationState {
  return {
    endpointId: options.endpointId,
    provider: options.provider ?? "",
    queryHash: options.queryHash ?? "",
    window: options.window,
    cursor: options.initialCursor ?? null,
    seenCanonicalIds: new Set<string>(),
    acceptedCount: 0,
    pagesFetched: 0,
    stopReason: null,
  };
}

export interface StepPaginationOptions {
  state: PaginationState;
  nextCursor?: string | null;
  rowDates?: (Date | string | number)[];
  canonicalIds?: string[];
  acceptedRowsCount?: number;
  targetRows?: number;
  maxPages?: number;
  minConsecutivePastWindow?: number;
  hasMore?: boolean;
}

export interface StepPaginationResult {
  state: PaginationState;
  shouldContinue: boolean;
  stopReason: StopReason | null;
}

/**
 * Performs a discrete state transition in the pagination state machine.
 */
export function stepPagination(options: StepPaginationOptions): StepPaginationResult {
  const { state } = options;
  state.pagesFetched++;

  // Ingest canonical IDs with deduplication
  if (options.canonicalIds) {
    for (const id of options.canonicalIds) {
      if (id && typeof id === "string") {
        state.seenCanonicalIds.add(id);
      }
    }
  }

  if (typeof options.acceptedRowsCount === "number" && options.acceptedRowsCount > 0) {
    state.acceptedCount += options.acceptedRowsCount;
  }

  let stopReason: StopReason | null = null;

  // 1. Check repeated cursor (infinite loop prevention)
  if (
    options.nextCursor !== undefined &&
    options.nextCursor !== null &&
    options.nextCursor !== "" &&
    state.cursor !== null &&
    options.nextCursor === state.cursor
  ) {
    stopReason = "repeated_cursor";
  }
  // 2. Check terminal cursor / exhausted source
  else if (
    options.hasMore === false ||
    options.nextCursor === null ||
    options.nextCursor === undefined ||
    options.nextCursor === ""
  ) {
    stopReason = "terminal_cursor";
  }
  // 3. Check target count reached
  else if (typeof options.targetRows === "number" && state.acceptedCount >= options.targetRows) {
    stopReason = "target_reached";
  }
  // 4. Check chronological boundary crossed (newest-first feed)
  else if (
    options.rowDates &&
    options.rowDates.length > 0 &&
    shouldStopChronologicalScan(options.rowDates, state.window, options.minConsecutivePastWindow)
  ) {
    stopReason = "window_crossed";
  }
  // 5. Check budget / page ceiling reached
  else if (typeof options.maxPages === "number" && state.pagesFetched >= options.maxPages) {
    stopReason = "budget_reached";
  }

  state.cursor = options.nextCursor ?? null;
  state.stopReason = stopReason;

  return {
    state,
    shouldContinue: stopReason === null,
    stopReason,
  };
}

/**
 * Deep Account Timeline Scanning Contract (Point 3.1, Megz & COMMANDER D-0198/r7):
 * Generates honest Arabic shortfall question phrasing stating exactly how many posts were examined.
 */
export function buildHonestShortfallQuestion(options: {
  examinedCount: number;
  account: string;
  platform: string;
  noun?: string;
}): string {
  const noun = options.noun ?? "تغريدة";
  return `«جرّبنا البحث في ${options.examinedCount} ${noun} من ${options.account} على ${options.platform} بالشروط التي كتبتها ولم نجد نتائج متطابقة. تحب نسلّمك الموجود، ولا نوسّع البحث؟»`;
}

/**
 * Enforces the rule that shortfall question is forbidden after only 1 page if more posts exist
 * within window and call budget remains.
 */
export function canAskShortfallQuestion(options: {
  pagesRead: number;
  maxBudgetedPages: number;
  hasMore: boolean;
  onTopicMatches: number;
}): boolean {
  if (options.onTopicMatches === 0 && options.hasMore && options.pagesRead < options.maxBudgetedPages) {
    return false;
  }
  return true;
}
